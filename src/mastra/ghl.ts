// Integracao com GoHighLevel (GHL) — substitui evolution.ts.
//
// Webhook: GHL Workflow "Send Webhook" action manda payload com detalhes
// do contato + custom data (body, attachments). O trigger do workflow
// (configurado no GHL, ex: "Customer Replied") garante que so leads
// disparam — nao precisamos detectar fromMe localmente.
//
// Envio: POST https://services.leadconnectorhq.com/conversations/messages
// com Bearer PIT (Private Integration Token). O body precisa de contactId,
// nao telefone — por isso a funcao enviarMensagem faz lookup interno.
//
// Limitacao: GHL nao envia para grupos WhatsApp. Notificacoes ao grupo
// de suporte (SUPORTE_GRUPO_JID) sao logadas mas nao entregues. Pra
// notificar o time, considere outro canal (Slack, email, ou SMS pra
// numero pessoal de admin).

import {
  GHL_PIT_TOKEN,
  GHL_API_VERSION,
  GHL_DEFAULT_TYPE,
  AZURE_OPENAI_RESOURCE_NAME,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_API_VERSION,
  AZURE_OPENAI_DEPLOYMENT_TRANSCRICAO,
} from './config';
import { fetchTimeout } from './http';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';

// =================== Tipos ===================

export interface GhlWebhookPayload {
  contact_id?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  phone?: string;
  email?: string;
  tags?: string | string[];
  country?: string;
  date_created?: string;
  contact_type?: string;
  message?: { type?: number; body?: string };
  customData?: { body?: string; attachments?: string; subject?: string };
  location?: { id?: string; name?: string };
  contact?: any;
  attributionSource?: any;
  workflow?: any;
}

// =================== Helpers de extracao do payload ===================

/** Extrai telefone normalizado (apenas digitos) — remove '+' e nao-digitos. */
export function extrairTelefone(payload: GhlWebhookPayload): string {
  const phone = payload.phone || '';
  return phone.replace(/[^\d]/g, '');
}

/** Retorna o contact_id do GHL (chave primaria pra envio de mensagem). */
export function extrairContactId(payload: GhlWebhookPayload): string {
  return payload.contact_id || '';
}

/** Texto da mensagem — prefere customData.body (mapeado no workflow), fallback message.body. */
export function extrairTexto(payload: GhlWebhookPayload): string {
  return (payload.customData?.body || payload.message?.body || '').trim();
}

/** Nome do contato — full_name > first_name > placeholder. */
export function extrairNome(payload: GhlWebhookPayload): string {
  return payload.full_name || payload.first_name || 'Não identificado';
}

// =================== Fallback API: buscar ultima mensagem ===================
// O Workflow "Send Webhook" do GHL nao popula {{message.attachments}}/{{message.body}}
// pra mensagens de audio do WhatsApp (vem vazio). Quando isso acontecer, buscamos
// a ultima mensagem do contato direto via API pra recuperar attachments + body.

interface UltimaMensagemGhl {
  body: string;
  attachments: string[];
  type: number | string;
  messageType: string;
}

export async function buscarUltimaMensagem(
  contactId: string,
  locationId?: string,
): Promise<UltimaMensagemGhl | null> {
  if (!GHL_PIT_TOKEN || !contactId) return null;

  // Race condition observada em producao: webhook chega antes da mensagem
  // estar persistida com content na API GHL — primeira chamada retorna
  // body="" attachments=[] type=19. Retry com backoff curto cobre o gap.
  const TENTATIVAS = 3;
  const ESPERA_MS = [0, 1500, 3000]; // 0, 1.5s, 3s — total ~4.5s no pior caso

  try {
    // 1. Buscar conversa mais recente do contato (1x — nao precisa retry).
    // /conversations/search aceita locationId obrigatorio em algumas contas.
    const params = new URLSearchParams({ contactId, limit: '1' });
    if (locationId) params.set('locationId', locationId);
    const searchUrl = `${GHL_BASE_URL}/conversations/search?${params.toString()}`;
    const searchRes = await fetchTimeout(searchUrl, {
      headers: {
        'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
        'Version': GHL_API_VERSION,
        'Accept': 'application/json',
      },
    });
    if (!searchRes.ok) {
      console.error(`[ghl][api] search conversations falhou (${searchRes.status}):`, await searchRes.text());
      return null;
    }
    const searchData = await searchRes.json();
    const conversationId = searchData?.conversations?.[0]?.id;
    if (!conversationId) {
      console.warn('[ghl][api] nenhuma conversa encontrada pro contato', contactId);
      return null;
    }

    // 2. Buscar a ultima mensagem com retry — so retenta se body+attachments vazios.
    let ultimo: UltimaMensagemGhl | null = null;
    for (let i = 0; i < TENTATIVAS; i++) {
      if (ESPERA_MS[i] > 0) {
        await new Promise((r) => setTimeout(r, ESPERA_MS[i]));
      }
      const msgsUrl = `${GHL_BASE_URL}/conversations/${conversationId}/messages?limit=1`;
      const msgsRes = await fetchTimeout(msgsUrl, {
        headers: {
          'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
          'Version': GHL_API_VERSION,
          'Accept': 'application/json',
        },
      });
      if (!msgsRes.ok) {
        console.error(`[ghl][api] get messages falhou (${msgsRes.status}):`, await msgsRes.text());
        return null;
      }
      const msgsData = await msgsRes.json();
      // Estrutura: messages.messages[] OU messages[]
      const lastMsg = msgsData?.messages?.messages?.[0] || msgsData?.messages?.[0] || msgsData?.[0];
      if (!lastMsg) {
        console.warn('[ghl][api] resposta sem mensagens:', JSON.stringify(msgsData).slice(0, 300));
        return null;
      }

      const attachmentsRaw = lastMsg.attachments || lastMsg.attachment || [];
      const attachmentsArr = Array.isArray(attachmentsRaw) ? attachmentsRaw : (attachmentsRaw ? [attachmentsRaw] : []);
      ultimo = {
        body: String(lastMsg.body || lastMsg.message || ''),
        attachments: attachmentsArr,
        type: lastMsg.type ?? lastMsg.messageType ?? 'unknown',
        messageType: String(lastMsg.messageType || lastMsg.type || ''),
      };

      // Se conseguiu conteudo, retorna. Se body+attachments vazios, retenta.
      if (ultimo.body || ultimo.attachments.length > 0) {
        if (i > 0) console.log(`[ghl][api] msg recuperada na tentativa ${i + 1}/${TENTATIVAS}`);
        return ultimo;
      }
      console.warn(`[ghl][api] tentativa ${i + 1}/${TENTATIVAS} retornou body+attachments vazios (type=${ultimo.type}), retentando...`);
    }
    // Esgotou tentativas — devolve o ultimo (vazio) pra caller decidir o que fazer.
    return ultimo;
  } catch (e) {
    console.error('[ghl][api] erro ao buscar ultima mensagem:', e);
    return null;
  }
}

// =================== Audio ===================
// GHL Workflow "Send Webhook" mapeou attachments={{message.attachments}}.
// Quando o lead manda audio, attachments contem URL(s) signed (S3/CDN do GHL).
// Lógica: detectar URL de audio -> baixar -> transcrever via Azure Whisper.
//
// IMPORTANTE: pro Workflow, attachments costuma vir vazio em msgs de audio.
// O fallback `buscarUltimaMensagem` (acima) recupera via API direta.

// Helper interno: extrai array de URLs do campo attachments (suporta varias formas).
function extrairAttachmentUrls(payload: GhlWebhookPayload): string[] {
  const att = payload.customData?.attachments;
  if (!att) return [];
  if (Array.isArray(att)) return att.filter((u) => typeof u === 'string') as string[];
  if (typeof att === 'string' && att.trim().length > 0) {
    const trimmed = att.trim();
    // Pode chegar como JSON stringified: '["url1","url2"]'
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.filter((u) => typeof u === 'string');
      } catch {
        // fallthrough — usa como string unica
      }
    }
    // String com 1 URL ou ', '-separated
    if (trimmed.includes(',')) return trimmed.split(/,\s*/).filter(Boolean);
    return [trimmed];
  }
  return [];
}

// Audio formats comuns do WhatsApp: ogg/opus (Android), m4a (iOS), aac. Outros caem fora.
const AUDIO_EXT_REGEX = /\.(ogg|opus|mp3|m4a|wav|webm|aac|amr)(\?|$|#)/i;

export function ehMensagemAudio(payload: GhlWebhookPayload): boolean {
  const urls = extrairAttachmentUrls(payload);
  if (urls.length === 0) return false;
  const tem = urls.some((u) => AUDIO_EXT_REGEX.test(u));
  if (tem) {
    console.log('[ghl][audio] mensagem com audio detectada:', urls);
  } else {
    // Tem attachment mas nao e audio (ex: imagem, video, doc) — log pra debug
    console.log('[ghl][audio-debug] attachments presentes mas nao audio:', urls);
  }
  return tem;
}

export async function baixarAudioBase64(payload: GhlWebhookPayload): Promise<string | null> {
  const urls = extrairAttachmentUrls(payload);
  const audioUrl = urls.find((u) => AUDIO_EXT_REGEX.test(u));
  if (!audioUrl) {
    console.warn('[ghl][audio] sem URL de audio em attachments');
    return null;
  }
  try {
    // GHL signed URLs geralmente sao publicas (S3 presigned). Se vier 401/403,
    // tentamos com Bearer PIT como fallback.
    let res = await fetchTimeout(audioUrl);
    if ((res.status === 401 || res.status === 403) && GHL_PIT_TOKEN) {
      console.log(`[ghl][audio] retry com Bearer PIT (status ${res.status})`);
      res = await fetchTimeout(audioUrl, {
        headers: { 'Authorization': `Bearer ${GHL_PIT_TOKEN}`, 'Version': GHL_API_VERSION },
      });
    }
    if (!res.ok) {
      console.error(`[ghl][audio] falha ao baixar (${res.status}):`, audioUrl);
      return null;
    }
    const buffer = await res.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  } catch (e) {
    console.error('[ghl][audio] erro ao baixar:', e);
    return null;
  }
}

/**
 * Transcreve audio usando Azure OpenAI (deployment `gpt-4o-transcribe-diarize`
 * ou similar configurado em AZURE_OPENAI_DEPLOYMENT_TRANSCRICAO).
 * Endpoint: cognitiveservices.azure.com (mesmo dominio dos outros deployments).
 * Header de auth: 'api-key' (nao 'Authorization: Bearer').
 */
export async function transcreverAudio(base64Audio: string): Promise<string | null> {
  if (!AZURE_OPENAI_RESOURCE_NAME || !AZURE_OPENAI_API_KEY) {
    console.error('[audio] AZURE_OPENAI_RESOURCE_NAME / AZURE_OPENAI_API_KEY nao configurados');
    return null;
  }
  try {
    const audioBuffer = Buffer.from(base64Audio, 'base64');
    // Default mime audio/ogg cobre WhatsApp (Android). iOS m4a tambem aceita
    // pelo Whisper sem precisar mudar Content-Type — o magic byte e detectado.
    const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
    const formData = new FormData();
    formData.append('file', blob, 'audio.ogg');
    formData.append('language', 'pt');

    const url = `https://${AZURE_OPENAI_RESOURCE_NAME}.cognitiveservices.azure.com/openai/deployments/${AZURE_OPENAI_DEPLOYMENT_TRANSCRICAO}/audio/transcriptions?api-version=${AZURE_OPENAI_API_VERSION}`;

    const response = await fetchTimeout(url, {
      method: 'POST',
      headers: { 'api-key': AZURE_OPENAI_API_KEY },
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

// =================== Helpers de mensagem (preservados da Evolution) ===================

function ehMenu(texto: string): boolean {
  const linhas = texto.split('\n');
  const linhasNumeradas = linhas.filter(l => /^\s*(\d️⃣|\d+\s*[-–.)]\s)/.test(l.trim()));
  return linhasNumeradas.length >= 2;
}

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

// Filtro de URL — defesa em profundidade contra Sofia colar link em texto.
const URL_REGEX = /https?:\/\/\S+/gi;

// =================== Lookup telefone -> contactId ===================
// O resto do codigo (sessao, follow-up, tools) usa telefone como chave.
// Pra mandar mensagem via GHL precisamos de contactId. Solucao:
// 1. Sessao guarda ghlContactId quando webhook chega (em metadata.ghl_contact_id)
// 2. enviarMensagem() resolve via getSessao(telefone)
// 3. Fallback: API GHL /contacts/lookup?phoneNumber=...

import { getSessao } from './sessao';

async function buscarContactIdPorTelefone(telefone: string): Promise<string | null> {
  // 1. Cache via sessao em memoria (rapido)
  try {
    const sessao = await getSessao(telefone);
    if (sessao?.ghlContactId) return sessao.ghlContactId;
  } catch {
    // ignore — segue pra fallback
  }

  // 2. Fallback API: lookup por telefone E.164
  if (!GHL_PIT_TOKEN) return null;
  try {
    const phoneE164 = telefone.startsWith('+') ? telefone : `+${telefone}`;
    const url = `${GHL_BASE_URL}/contacts/lookup?phoneNumber=${encodeURIComponent(phoneE164)}`;
    const res = await fetchTimeout(url, {
      headers: {
        'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
        'Version': GHL_API_VERSION,
        'Accept': 'application/json',
      },
    });
    if (!res.ok) {
      console.warn(`[ghl] lookup contactId falhou (${res.status}):`, await res.text());
      return null;
    }
    const data = await res.json();
    return data?.contacts?.[0]?.id || data?.contact?.id || null;
  } catch (e) {
    console.error('[ghl] erro no lookup contactId:', e);
    return null;
  }
}

// =================== Envio ===================

async function enviarMensagemUnica(contactId: string, texto: string): Promise<void> {
  if (!GHL_PIT_TOKEN) {
    console.warn(`[ghl] GHL_PIT_TOKEN nao configurado — mensagem ignorada: "${texto.slice(0, 80)}"`);
    return;
  }

  // Pequeno delay pra simular humano (1-4s proporcional ao tamanho).
  const delay = Math.min(Math.max(texto.length * 15, 1000), 4000);
  await new Promise((resolve) => setTimeout(resolve, delay));

  try {
    const res = await fetchTimeout(`${GHL_BASE_URL}/conversations/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
        'Version': GHL_API_VERSION,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        type: GHL_DEFAULT_TYPE,
        contactId,
        message: texto,
      }),
    });
    if (!res.ok) {
      const erroBody = await res.text();
      console.error(`[ghl] Erro ao enviar mensagem para ${contactId}: ${res.status} - ${erroBody}`);
    }
  } catch (e) {
    console.error(`[ghl] Falha ao enviar mensagem para ${contactId}:`, e);
  }
}

// Detecta se o "telefone" passado e na verdade um JID legacy do WhatsApp (grupo, broadcast)
// GHL nao envia pra esses formatos. Ignora silenciosamente com log claro.
function ehGrupoOuBroadcast(numero: string): boolean {
  return numero.includes('@g.us') || numero.includes('@broadcast');
}

/**
 * Envia mensagem de texto para um contato no GHL.
 * Mantem mesma assinatura da Evolution pra nao quebrar callsites (sessao,
 * follow-up, tools, etc). Internamente faz lookup telefone -> contactId.
 *
 * - quebrar:false envia como mensagem unica (era usado pra grupos no WhatsApp,
 *   no GHL nao tem efeito porque GHL ja entrega como bloco unico).
 * - permitirUrl:true so deve ser passado pela tool enviar-checkout.
 */
export async function enviarMensagem(
  numero: string,
  texto: string,
  opcoes: { quebrar?: boolean; permitirUrl?: boolean } = {},
): Promise<void> {
  const { quebrar = true, permitirUrl = false } = opcoes;

  // Notificacoes ao grupo de suporte (SUPORTE_GRUPO_JID) chegam aqui — GHL
  // nao manda pra grupo, abortar com log explicativo.
  if (ehGrupoOuBroadcast(numero)) {
    console.warn(`[ghl] enviarMensagem para grupo/broadcast nao suportado (${numero}). Texto: "${texto.slice(0, 100)}". Considere outro canal pra notificacoes do time.`);
    return;
  }

  let textoLimpo = texto.trim();

  // Filtro de URL — mesma logica da Evolution.
  if (!permitirUrl && URL_REGEX.test(textoLimpo)) {
    const urlsDetectadas = textoLimpo.match(URL_REGEX);
    console.warn(`[ghl] URL bloqueada na resposta do agente: ${urlsDetectadas?.join(', ')}`);
    textoLimpo = textoLimpo.replace(URL_REGEX, '').replace(/\s+/g, ' ').trim();
  }
  if (textoLimpo.length === 0) return;

  // Resolve contactId pra mandar via API.
  const contactId = await buscarContactIdPorTelefone(numero);
  if (!contactId) {
    console.error(`[ghl] Nao foi possivel resolver contactId pra ${numero} — mensagem nao enviada. Verifique se o webhook chegou primeiro pra cache do contactId.`);
    return;
  }

  const partes = quebrar ? quebrarMensagem(textoLimpo) : [textoLimpo];
  for (const parte of partes) {
    await enviarMensagemUnica(contactId, parte);
  }
}

// =================== Compat: stubs do que vinha de evolution.ts ===================
// Mantemos exports pra nao quebrar imports durante a transicao.

/** Evolution detectava self-loop via fromMe. No GHL o workflow filtra na origem. */
export function foiEnviadaPeloBot(_messageId: string): boolean {
  return false;
}

/**
 * Compat: extrairNumero aceitava JID legacy "5511...@s.whatsapp.net".
 * No GHL recebemos o payload completo. Aceita ambos pra transicao tranquila.
 */
export function extrairNumero(payloadOuJid: any): string {
  if (typeof payloadOuJid === 'string') {
    return payloadOuJid.replace('@s.whatsapp.net', '').replace('@g.us', '').replace(/[^\d]/g, '');
  }
  return extrairTelefone(payloadOuJid as GhlWebhookPayload);
}
