// Funcoes para enviar/receber mensagens via Evolution API

import {
  EVOLUTION_API_URL,
  EVOLUTION_API_KEY,
  EVOLUTION_INSTANCE,
  AZURE_OPENAI_RESOURCE_NAME,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_API_VERSION,
  AZURE_OPENAI_DEPLOYMENT_TRANSCRICAO,
} from './config';

// IDs de mensagens enviadas pelo bot — distingue de mensagens humanas no webhook (fromMe)
// Usa Map com timestamp pra limpeza periodica (mais eficiente que setTimeout por entry)
const botMessageIds = new Map<string, number>();
const BOT_MSG_TTL = 10 * 60 * 1000; // 10 minutos

// Limpa IDs expirados a cada 2 minutos
setInterval(() => {
  const agora = Date.now();
  for (const [id, ts] of botMessageIds) {
    if (agora - ts > BOT_MSG_TTL) botMessageIds.delete(id);
  }
}, 2 * 60 * 1000);

// Simula digitacao no WhatsApp (o cliente ve "digitando...")
async function simularDigitacao(numero: string): Promise<void> {
  try {
    const url = `${EVOLUTION_API_URL}/chat/sendPresence/${EVOLUTION_INSTANCE}`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVOLUTION_API_KEY,
      },
      body: JSON.stringify({
        number: numero,
        presence: 'composing',
        delay: 3000,
      }),
    });
  } catch (e) {
    // Nao bloqueia se falhar
  }
}

// Detecta se o texto e um menu com opcoes numeradas (nao deve ser quebrado)
function ehMenu(texto: string): boolean {
  const linhas = texto.split('\n');
  const linhasNumeradas = linhas.filter(l => /^\s*(\d️⃣|\d+\s*[-–.)]\s)/.test(l.trim()));
  return linhasNumeradas.length >= 2;
}

// Quebra mensagem longa em partes de ate ~90 caracteres, respeitando quebras de linha.
// Menus com opcoes numeradas sao enviados inteiros.
// Faz trim de cada parte para evitar leading/trailing newlines/espacos
// (LLM as vezes gera "\n\noi" no inicio, que aparece como quebra estranha no WhatsApp).
function quebrarMensagem(texto: string, limite: number = 90): string[] {
  const textoLimpo = texto.trim();
  if (textoLimpo.length === 0) return [];
  if (textoLimpo.length <= limite) return [textoLimpo];
  if (ehMenu(textoLimpo)) return [textoLimpo];

  const linhas = textoLimpo.split('\n');
  const partes: string[] = [];
  let atual = '';

  for (const linha of linhas) {
    const separador = atual ? '\n' : '';
    if ((atual + separador + linha).length <= limite) {
      atual += separador + linha;
    } else {
      if (atual) partes.push(atual);
      atual = linha;
    }
  }
  if (atual) partes.push(atual);

  return partes.map(p => p.trim()).filter(p => p.length > 0);
}

// Envia uma unica mensagem de texto pelo WhatsApp
async function enviarMensagemUnica(numero: string, texto: string): Promise<void> {
  // Simula digitacao antes de enviar
  await simularDigitacao(numero);

  // Aguarda um tempo proporcional ao tamanho da mensagem (min 1s, max 4s)
  const delay = Math.min(Math.max(texto.length * 15, 1000), 4000);
  await new Promise(resolve => setTimeout(resolve, delay));

  const url = `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': EVOLUTION_API_KEY,
    },
    body: JSON.stringify({
      number: numero,
      text: texto,
    }),
  });

  if (!response.ok) {
    const erro = await response.text();
    console.error(`Erro ao enviar mensagem para ${numero}: ${response.status} - ${erro}`);
    return;
  }

  // Registra ID da mensagem para distinguir de mensagens humanas no webhook
  try {
    const data = await response.json();
    const messageId = data?.key?.id;
    if (messageId) {
      botMessageIds.set(messageId, Date.now());
    }
  } catch {
    // Nao bloqueia o fluxo se nao conseguir parsear
  }
}

// Envia mensagem de texto para um numero no WhatsApp.
// Por padrao quebra mensagens longas em varias menores (limite 90 chars).
// Para enviar como mensagem unica (ex: aviso ao grupo de suporte), passe { quebrar: false }.
// Sempre faz trim() para evitar quebras/espacos invisiveis vindos do LLM.
export async function enviarMensagem(
  numero: string,
  texto: string,
  opcoes: { quebrar?: boolean } = {},
): Promise<void> {
  const { quebrar = true } = opcoes;
  const textoLimpo = texto.trim();
  if (textoLimpo.length === 0) return;
  const partes = quebrar ? quebrarMensagem(textoLimpo) : [textoLimpo];

  for (const parte of partes) {
    await enviarMensagemUnica(numero, parte);
  }
}

// Tipo do webhook que a Evolution API envia quando recebe uma mensagem
export interface EvolutionWebhookPayload {
  event: string;
  instance: string;
  data: {
    key: {
      remoteJid: string; // numero@s.whatsapp.net
      fromMe: boolean;
      id: string;
    };
    pushName: string; // nome do contato
    message: {
      conversation?: string; // mensagem de texto simples
      extendedTextMessage?: {
        text: string; // mensagem com formatacao
      };
      audioMessage?: {
        url?: string;
        mimetype?: string;
        seconds?: number;
        ptt?: boolean; // push-to-talk (audio gravado no WhatsApp)
      };
      listResponseMessage?: {
        title: string;
        singleSelectReply: {
          selectedRowId: string;
        };
      };
      buttonsResponseMessage?: {
        selectedButtonId: string;
        selectedDisplayText: string;
      };
    };
    messageType: string;
    messageTimestamp: number;
  };
}

// Extrai o numero limpo do JID (remove @s.whatsapp.net)
export function extrairNumero(jid: string): string {
  return jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
}

// Extrai o texto da mensagem (independente do tipo)
export function extrairTexto(payload: EvolutionWebhookPayload): string {
  const msg = payload.data.message;
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
    msg.buttonsResponseMessage?.selectedDisplayText ||
    ''
  );
}

/**
 * Verifica se uma mensagem foi enviada pelo bot.
 * Usado no webhook para distinguir mensagens do bot de mensagens de humanos.
 */
export function foiEnviadaPeloBot(messageId: string): boolean {
  return botMessageIds.has(messageId);
}

/**
 * Verifica se a mensagem do webhook e um audio.
 */
export function ehMensagemAudio(payload: EvolutionWebhookPayload): boolean {
  return !!payload.data.message?.audioMessage;
}

/**
 * Baixa o audio da mensagem via Evolution API (retorna base64).
 * Usa o endpoint getBase64FromMediaMessage da Evolution API.
 */
export async function baixarAudioBase64(payload: EvolutionWebhookPayload): Promise<string | null> {
  try {
    const url = `${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVOLUTION_API_KEY,
      },
      body: JSON.stringify({
        message: {
          key: payload.data.key,
        },
      }),
    });

    if (!response.ok) {
      console.error(`[audio] Erro ao baixar audio: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data?.base64 || null;
  } catch (e) {
    console.error('[audio] Erro ao baixar audio:', e);
    return null;
  }
}

/**
 * Transcreve audio usando Azure OpenAI Whisper.
 * Endpoint diferente do OpenAI direto:
 *   https://<resource>.openai.azure.com/openai/deployments/<deployment>/audio/transcriptions?api-version=<version>
 * Header de auth: 'api-key' (nao 'Authorization: Bearer').
 */
export async function transcreverAudio(base64Audio: string): Promise<string | null> {
  if (!AZURE_OPENAI_RESOURCE_NAME || !AZURE_OPENAI_API_KEY) {
    console.error('[audio] AZURE_OPENAI_RESOURCE_NAME / AZURE_OPENAI_API_KEY nao configurados');
    return null;
  }

  try {
    // Converte base64 para Buffer
    const audioBuffer = Buffer.from(base64Audio, 'base64');

    // Monta FormData com o arquivo de audio.
    // Azure ignora o campo 'model' (usa o deployment via URL), mas mantemos por compatibilidade.
    const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
    const formData = new FormData();
    formData.append('file', blob, 'audio.ogg');
    formData.append('language', 'pt');

    const url = `https://${AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/deployments/${AZURE_OPENAI_DEPLOYMENT_TRANSCRICAO}/audio/transcriptions?api-version=${AZURE_OPENAI_API_VERSION}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'api-key': AZURE_OPENAI_API_KEY,
      },
      body: formData,
    });

    if (!response.ok) {
      const erro = await response.text();
      console.error(`[audio] Erro Whisper Azure: ${response.status} - ${erro}`);
      return null;
    }

    const data = await response.json();
    const texto = data?.text?.trim();
    if (texto) {
      console.log(`[audio] Transcrito: "${texto.substring(0, 80)}${texto.length > 80 ? '...' : ''}"`);
    }
    return texto || null;
  } catch (e) {
    console.error('[audio] Erro ao transcrever:', e);
    return null;
  }
}
