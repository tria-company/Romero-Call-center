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
  GHL_API_VERSION_V2,
  GHL_DEFAULT_TYPE,
  GHL_PIPELINE_ID,
  GHL_LOCATION_ID,
  GHL_STAGES,
  GHL_STAGES_NAO_REBAIXAR_CALL,
  GHL_OPP_ATENDEU_FIELD_ID,
  GHL_OPP_ATENDEU_FIELD_KEY,
  AZURE_OPENAI_RESOURCE_NAME,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_API_VERSION,
  AZURE_OPENAI_HOST,
  AZURE_OPENAI_DEPLOYMENT_TRANSCRICAO,
  GRAVACAO_HOSTS_PERMITIDOS,
} from './config';
import { fetchTimeout } from './http';
import { removerDuplicacoes } from './sanitize';

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
 * Endpoint: host configuravel via AZURE_OPENAI_HOST (default openai.azure.com,
 * mesmo dominio dos outros deployments — ver config.ts).
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

    const url = `https://${AZURE_OPENAI_RESOURCE_NAME}.${AZURE_OPENAI_HOST}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT_TRANSCRICAO}/audio/transcriptions?api-version=${AZURE_OPENAI_API_VERSION}`;

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
      // LGPD (GRAV-04): NUNCA logar o conteudo da transcricao — este helper e
      // reusado pelo pipeline de gravacao de call, cuja fala pode conter dado
      // de PACIENTE ANTES da anonimizacao. So metadado (tamanho) vai pro log.
      console.log(`[audio] Transcrito (${texto.length} chars)`);
    }
    return texto || null;
  } catch (e) {
    console.error('[audio] Erro ao transcrever:', e);
    return null;
  }
}

// =================== Gravacao de call/ligacao (Fase 3, GRAV-01/GRAV-04) ===================
// Webhook NOVO /api/webhook/gravacao (index.ts) recebe { telefone,
// recordingUrl, tipo } de um Workflow GHL que dispara ao concluir a gravacao
// de uma call/ligacao (Automation -> Workflow -> Webhook). Download aqui
// (anti-SSRF, T-03-02), transcricao reusa transcreverAudio acima, persistencia
// grava a versao JA ANONIMIZADA (nunca a bruta) no custom field certo.

// Limite documentado do transcritor Azure (endpoint /audio/transcriptions):
// ~25MB por arquivo. Gravacoes maiores sao recusadas ANTES do download
// completo (guarda de tamanho, T-03-05/DoS).
const LIMITE_GRAVACAO_BYTES = 25 * 1024 * 1024; // ~25MB

// Familias de dominio DO PROPRIO GHL/LeadConnector (leadconnectorhq.com /
// msgsndr.com) — NAO multi-tenant: um atacante nao consegue hospedar endpoint
// proprio nesses dominios. Usadas (a) como parte do allowlist de download e
// (b) como GATE do retry com Bearer PIT: a credencial-mestre do CRM NUNCA e
// enviada pra host fora do dominio GHL (CR-03 — antes, o retry mandava o PIT
// pra qualquer host que o payload nomeasse, ex: *.execute-api.amazonaws.com).
const GHL_DOMINIO_SUFIXOS = ['.leadconnectorhq.com', '.msgsndr.com'] as const;

function ehHostDominioGhl(host: string): boolean {
  return GHL_DOMINIO_SUFIXOS.some(
    (sufixo) => host === sufixo.slice(1) || host.endsWith(sufixo),
  );
}

/**
 * Valida se `recordingUrl` e https E se o host esta no allowlist: hosts
 * exatos de GRAVACAO_HOSTS_PERMITIDOS (config.ts — default restrito a hosts
 * GHL/LeadConnector; o operador pode ADICIONAR hosts exatos via env) OU a
 * familia de dominios do proprio GHL (ehHostDominioGhl). Qualquer URL fora
 * do allowlist e recusada SEM fazer fetch (anti-SSRF, T-03-02) — nao baixa
 * URL arbitraria vinda do payload de um POST externo.
 *
 * CR-03: o wildcard *.amazonaws.com foi REMOVIDO — aquele sufixo cobre
 * endpoints de computacao controlaveis por atacante (API Gateway, ELB, S3
 * website) que logam headers. Se a gravacao real vier de um bucket S3/GCS
 * especifico, o operador adiciona o HOST EXATO (ex:
 * meu-bucket.s3.sa-east-1.amazonaws.com) em GRAVACAO_HOSTS_PERMITIDOS —
 * ciente de que S3/GCS sao multi-tenant (o allowlist restringe
 * INFRAESTRUTURA, nao PROPRIEDADE do bucket).
 */
function hostGravacaoPermitido(recordingUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(recordingUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (GRAVACAO_HOSTS_PERMITIDOS.includes(host)) return true;
  if (ehHostDominioGhl(host)) return true;
  return false;
}

/**
 * Baixa a gravacao (recordingUrl) em base64 pra transcrever via
 * transcreverAudio. Anti-SSRF (T-03-02): SO baixa se hostGravacaoPermitido
 * validar https + host no allowlist — URL fora do allowlist loga e retorna
 * null SEM fazer fetch. Redirects DESABILITADOS (CR-04, redirect:'error') —
 * o allowlist valida so a URL inicial; um 302 de origem permitida poderia
 * mandar o fetch pra URL interna/arbitraria (metadata endpoint etc). URLs
 * presigned de GHL/S3 sao links diretos, redirect nao e necessario no fluxo
 * legitimo. Retry com Bearer PIT em 401/403 SOMENTE pra host do dominio GHL
 * (CR-03, ehHostDominioGhl) — a credencial-mestre do CRM nunca vaza pra host
 * de terceiro. Guarda de tamanho (T-03-05): Content-Length >
 * LIMITE_GRAVACAO_BYTES recusa sem baixar; e como Content-Length pode faltar
 * ou mentir (chunked), o corpo e lido em STREAMING com teto — aborta o
 * download assim que o total passa do limite (WR-05), sem bufferizar o
 * excedente em RAM.
 */
export async function baixarGravacaoBase64(recordingUrl: string): Promise<string | null> {
  if (!recordingUrl || typeof recordingUrl !== 'string') {
    console.warn('[gravacao] recordingUrl ausente/invalida — nada a baixar');
    return null;
  }
  if (!hostGravacaoPermitido(recordingUrl)) {
    console.error(`[gravacao] recordingUrl recusada (host fora do allowlist ou nao-https): ${recordingUrl}`);
    return null;
  }

  try {
    let res = await fetchTimeout(recordingUrl, { redirect: 'error' });
    const host = new URL(recordingUrl).hostname.toLowerCase();
    if ((res.status === 401 || res.status === 403) && GHL_PIT_TOKEN && ehHostDominioGhl(host)) {
      console.log(`[gravacao] retry com Bearer PIT (status ${res.status}, host GHL)`);
      res = await fetchTimeout(recordingUrl, {
        redirect: 'error',
        headers: { 'Authorization': `Bearer ${GHL_PIT_TOKEN}`, 'Version': GHL_API_VERSION },
      });
    }
    if (!res.ok) {
      console.error(`[gravacao] falha ao baixar (${res.status}): ${recordingUrl}`);
      return null;
    }

    // Rejeicao barata ANTES de ler o corpo quando o servidor declara o
    // tamanho honestamente (content-length presente e acima do teto).
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > LIMITE_GRAVACAO_BYTES) {
      console.error(
        `[gravacao] gravacao excede o limite do transcritor (${contentLength} bytes > ${LIMITE_GRAVACAO_BYTES}) — descartada sem transcrever`,
      );
      return null;
    }

    // WR-05: nao confiar SO no Content-Length (ausente em chunked, falsificavel
    // por origem hostil) — le em streaming e aborta DURANTE o download quando o
    // total acumulado passa do limite, cancelando o reader (nada do excedente
    // fica bufferizado).
    if (!res.body) {
      console.error('[gravacao] resposta sem corpo — nada a transcrever');
      return null;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITE_GRAVACAO_BYTES) {
        await reader.cancel();
        console.error(
          `[gravacao] gravacao excedeu o limite do transcritor DURANTE o download (> ${LIMITE_GRAVACAO_BYTES} bytes) — descartada sem transcrever`,
        );
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('base64');
  } catch (e) {
    console.error('[gravacao] erro ao baixar recordingUrl:', e);
    return null;
  }
}

// Custom fields do playbook (read-lead-ficha.ts CAMPOS_FICHA) — ja existem no
// GHL, nenhuma criacao de campo novo nesta fase.
const CAMPO_TRANSCRICAO_POR_TIPO = {
  sdr_ligacao: 'transcricao_ligacao_sdr',
  closer_call: 'transcricao_call_closer',
} as const;

export type TipoGravacao = keyof typeof CAMPO_TRANSCRICAO_POR_TIPO;

// Limite conservador de comprimento pro custom field (GHL "Large Text"
// custom field aceita textos longos, mas truncamos por seguranca de payload/
// UI do CRM — 9000 chars cobre com folga uma transcricao de call de 45min).
const LIMITE_CUSTOM_FIELD_CHARS = 9000;

/**
 * Persiste a transcricao (JA ANONIMIZADA pelo caller — GRAV-04) no custom
 * field certo do contato, por `tipo`: transcricao_ligacao_sdr (sdr_ligacao)
 * ou transcricao_call_closer (closer_call). Trunca a um comprimento seguro
 * de custom field. NUNCA loga `textoAnon` (so o tamanho e o resultado).
 * Retorna boolean HONESTO (res.ok) — mesmo padrao de update-contact-field.ts.
 */
export async function persistirTranscricaoContato(
  telefone: string,
  tipo: TipoGravacao,
  textoAnon: string,
): Promise<boolean> {
  const chave = CAMPO_TRANSCRICAO_POR_TIPO[tipo];
  if (!chave) {
    console.error(`[gravacao] tipo invalido para persistencia: ${tipo}`);
    return false;
  }
  if (!GHL_PIT_TOKEN) {
    console.error('[gravacao] GHL_PIT_TOKEN nao configurado — persistencia abortada');
    return false;
  }

  const contactId = await buscarContactIdPorTelefone(telefone);
  if (!contactId) {
    console.error(`[gravacao] nao foi possivel resolver contactId para ${telefone} — persistencia abortada`);
    return false;
  }

  const valor = textoAnon.length > LIMITE_CUSTOM_FIELD_CHARS
    ? textoAnon.slice(0, LIMITE_CUSTOM_FIELD_CHARS)
    : textoAnon;

  try {
    const res = await fetchTimeout(`${GHL_BASE_URL}/contacts/${contactId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
        'Version': GHL_API_VERSION,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ customFields: [{ key: chave, value: valor }] }),
    });
    if (!res.ok) {
      console.error(`[gravacao] PUT /contacts/${contactId} falhou (${res.status}) ao gravar ${chave}`);
      return false;
    }
    console.log(`[gravacao] ${telefone} (${contactId}) <- ${chave} (${valor.length} chars anonimizados)`);
    return true;
  } catch (e) {
    console.error(`[gravacao] erro ao persistir ${chave} para ${telefone}:`, e);
    return false;
  }
}

// =================== WAVOIP — oportunidade + nota (rastreador de ligacao) ===================

// Resolve a opportunity ATIVA do contato no pipeline COMERCIAL USI (mesma logica
// da tool move-pipeline-stage). Retorna id + stage atual pra decidir o guard.
async function buscarOpportunityCall(contactId: string): Promise<{ id: string; pipelineStageId: string } | null> {
  const url = `${GHL_BASE_URL}/opportunities/search?contact_id=${encodeURIComponent(contactId)}&pipeline_id=${encodeURIComponent(GHL_PIPELINE_ID)}`;
  const res = await fetchTimeout(url, {
    headers: {
      'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
      'Version': GHL_API_VERSION_V2,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    console.error(`[wavoip] GET /opportunities/search falhou (${res.status})`);
    return null;
  }
  const data = await res.json();
  const opp = data?.opportunities?.[0];
  if (!opp?.id) return null;
  return { id: opp.id, pipelineStageId: opp.pipelineStageId };
}

/**
 * Preenche, na oportunidade COMERCIAL USI do lead, o resultado de uma ligacao
 * Wavoip: campo custom `atendeu` = "Sim"/"Não" e — se atendida — move o card
 * pra CALL REALIZADA (num unico PUT). Guard anti-regressao: NAO move se o card
 * ja esta em CALL REALIZADA/NO-SHOW/NEGOCIACAO/GANHO/PERDIDO (so atualiza o
 * campo). Retorna boolean honesto (res.ok).
 */
export async function atualizarOportunidadeCall(telefone: string, atendeu: boolean): Promise<boolean> {
  if (!GHL_PIT_TOKEN) {
    console.error('[wavoip] GHL_PIT_TOKEN nao configurado — update de oportunidade abortado');
    return false;
  }

  const contactId = await buscarContactIdPorTelefone(telefone);
  if (!contactId) {
    console.error(`[wavoip] nao foi possivel resolver contactId para ${telefone}`);
    return false;
  }

  const opportunity = await buscarOpportunityCall(contactId);
  if (!opportunity) {
    console.error(`[wavoip] nenhuma opportunity para contato ${contactId} no pipeline COMERCIAL USI`);
    return false;
  }

  const body: Record<string, unknown> = {
    customFields: [
      { id: GHL_OPP_ATENDEU_FIELD_ID, key: GHL_OPP_ATENDEU_FIELD_KEY, field_value: atendeu ? 'Sim' : 'Não' },
    ],
  };

  // Move p/ CALL REALIZADA so quando atendida E o guard anti-regressao permite.
  const jaEmStageAvancada = (GHL_STAGES_NAO_REBAIXAR_CALL as readonly string[]).includes(opportunity.pipelineStageId);
  const vaiMover = atendeu && !jaEmStageAvancada;
  if (vaiMover) {
    body.pipelineId = GHL_PIPELINE_ID;
    body.pipelineStageId = GHL_STAGES.CALL_REALIZADA;
  }

  try {
    const res = await fetchTimeout(`${GHL_BASE_URL}/opportunities/${opportunity.id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
        'Version': GHL_API_VERSION_V2,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[wavoip] PUT /opportunities/${opportunity.id} falhou (${res.status}) ao gravar atendeu/stage`);
      return false;
    }
    console.log(`[wavoip] ${telefone} (${contactId}) <- atendeu=${atendeu ? 'Sim' : 'Não'}${vaiMover ? ' + stage CALL REALIZADA' : ''}`);
    return true;
  } catch (e) {
    console.error(`[wavoip] erro ao atualizar oportunidade de ${telefone}:`, e);
    return false;
  }
}

// Limite conservador da nota (aparece como "Observacoes" no card). Notas do GHL
// aceitam texto longo; truncamos por seguranca de payload/UI.
const LIMITE_NOTA_OBSERVACAO_CHARS = 20000;

/**
 * Registra a transcricao (JA ANONIMIZADA pelo caller — LGPD) como NOTA no
 * contato (`POST /contacts/{id}/notes`) — e o que aparece como "Observacoes" no
 * card da oportunidade (o GHL nao tem notas de oportunidade via API). NUNCA loga
 * o conteudo da nota (so o tamanho). Retorna boolean honesto (res.ok).
 */
export async function registrarNotaObservacao(telefone: string, texto: string): Promise<boolean> {
  if (!GHL_PIT_TOKEN) {
    console.error('[wavoip] GHL_PIT_TOKEN nao configurado — nota abortada');
    return false;
  }

  const contactId = await buscarContactIdPorTelefone(telefone);
  if (!contactId) {
    console.error(`[wavoip] nao foi possivel resolver contactId para ${telefone} — nota abortada`);
    return false;
  }

  const corpo = texto.length > LIMITE_NOTA_OBSERVACAO_CHARS ? texto.slice(0, LIMITE_NOTA_OBSERVACAO_CHARS) : texto;

  try {
    const res = await fetchTimeout(`${GHL_BASE_URL}/contacts/${contactId}/notes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
        'Version': GHL_API_VERSION,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ body: corpo }),
    });
    if (!res.ok) {
      console.error(`[wavoip] POST /contacts/${contactId}/notes falhou (${res.status})`);
      return false;
    }
    console.log(`[wavoip] ${telefone} (${contactId}) <- nota observacao (${corpo.length} chars anonimizados)`);
    return true;
  } catch (e) {
    console.error(`[wavoip] erro ao registrar nota para ${telefone}:`, e);
    return false;
  }
}

// =================== DISCADOR — leads qualificados (PWA) ===================

export interface LeadQualificado {
  nome: string;
  telefone: string; // E.164 (ex: +5599991442003)
}

/**
 * Busca leads no stage QUALIFICADO do COMERCIAL USI (nome + telefone E.164) pro
 * PWA discador. Suporta busca por nome (q) e paginacao (startAfter/startAfterId
 * do GHL). So retorna leads COM telefone.
 */
export async function buscarQualificados(
  opts: { q?: string; limit?: number; startAfter?: string; startAfterId?: string } = {},
): Promise<{ leads: LeadQualificado[]; startAfter?: string; startAfterId?: string; total?: number }> {
  if (!GHL_PIT_TOKEN) return { leads: [] };
  const limit = Math.min(Math.max(opts.limit || 30, 1), 100);
  const params = new URLSearchParams({
    location_id: GHL_LOCATION_ID,
    pipeline_id: GHL_PIPELINE_ID,
    pipeline_stage_id: GHL_STAGES.QUALIFICADO,
    status: 'open',
    limit: String(limit),
  });
  if (opts.q) params.set('q', opts.q);
  if (opts.startAfter) params.set('startAfter', opts.startAfter);
  if (opts.startAfterId) params.set('startAfterId', opts.startAfterId);
  try {
    const res = await fetchTimeout(`${GHL_BASE_URL}/opportunities/search?${params.toString()}`, {
      headers: {
        'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
        'Version': GHL_API_VERSION_V2,
        'Accept': 'application/json',
      },
    });
    if (!res.ok) {
      console.error(`[discador] GET /opportunities/search falhou (${res.status})`);
      return { leads: [] };
    }
    const data = await res.json();
    const leads: LeadQualificado[] = (data?.opportunities || [])
      .map((o: any) => {
        const c = o.contact || o.relations?.[0] || {};
        return {
          nome: String(c.name || c.contactName || c.fullName || o.name || '').trim(),
          telefone: String(c.phone || '').trim(),
        };
      })
      .filter((l: LeadQualificado) => l.telefone);
    return {
      leads,
      startAfter: data?.meta?.startAfter != null ? String(data.meta.startAfter) : undefined,
      startAfterId: data?.meta?.startAfterId,
      total: data?.meta?.total,
    };
  } catch (e) {
    console.error('[discador] erro buscarQualificados:', e);
    return { leads: [] };
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

/**
 * Checa se um contato do GHL tem uma tag especifica (case-insensitive).
 * Usado pra pausar a IA por tag (ex: 'pausar-agente'). FAIL-OPEN: se a leitura
 * falhar (GHL fora, token invalido, rede), retorna false — um erro de leitura
 * NAO deve silenciar a IA pra todos os leads; a pausa e a excecao, nao o default.
 */
export async function contatoTemTag(contactId: string, tag: string): Promise<boolean> {
  if (!GHL_PIT_TOKEN || !contactId) return false;
  const alvo = tag.trim().toLowerCase();
  try {
    const res = await fetchTimeout(`${GHL_BASE_URL}/contacts/${contactId}`, {
      headers: {
        'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
        'Version': GHL_API_VERSION,
        'Accept': 'application/json',
      },
    });
    if (!res.ok) {
      console.warn(`[tag-pausa] GET /contacts/${contactId} falhou (${res.status}) — fail-open (IA segue ativa)`);
      return false;
    }
    const data = await res.json();
    const tags = (data && data.contact && data.contact.tags) || [];
    return Array.isArray(tags) && tags.some((t: unknown) => String(t).trim().toLowerCase() === alvo);
  } catch (e) {
    console.warn(`[tag-pausa] erro ao ler tags de ${contactId} — fail-open:`, e);
    return false;
  }
}

export async function buscarContactIdPorTelefone(telefone: string): Promise<string | null> {
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

// CR-03: retorna boolean HONESTO (true = GHL aceitou o POST). Antes retornava
// void e engolia !res.ok/excecao — callers marcavam toques como entregues
// (gate *_sent_at) sem nenhuma confirmacao de entrega ("fake success").
async function enviarMensagemUnica(contactId: string, texto: string): Promise<boolean> {
  if (!GHL_PIT_TOKEN) {
    console.warn(`[ghl] GHL_PIT_TOKEN nao configurado — mensagem ignorada: "${texto.slice(0, 80)}"`);
    return false;
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
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[ghl] Falha ao enviar mensagem para ${contactId}:`, e);
    return false;
  }
}

// Detecta se o "telefone" passado e na verdade um JID legacy do WhatsApp (grupo, broadcast)
// GHL nao envia pra esses formatos. Ignora silenciosamente com log claro.
function ehGrupoOuBroadcast(numero: string): boolean {
  return numero.includes('@g.us') || numero.includes('@broadcast');
}

/**
 * Envia mensagem de texto para um contato no GHL.
 * Mantem mesma assinatura de parametros da Evolution pra nao quebrar
 * callsites (sessao, follow-up, tools, etc). Internamente faz lookup
 * telefone -> contactId.
 *
 * CR-03: retorna boolean HONESTO — `true` somente quando TODAS as partes
 * foram aceitas pelo GHL (res.ok). Grupo/broadcast, contactId nao resolvido,
 * texto vazio pos-filtros ou qualquer parte rejeitada -> `false`. Callers
 * legados que tratavam como void continuam funcionando; caminhos com gate de
 * idempotencia (lembretes.ts, schedule-reminder.ts) DEVEM checar o retorno
 * antes de marcar *_sent_at.
 *
 * - quebrar:false envia como mensagem unica (era usado pra grupos no WhatsApp,
 *   no GHL nao tem efeito porque GHL ja entrega como bloco unico).
 * - permitirUrl:true so deve ser passado pela tool enviar-checkout.
 */
export async function enviarMensagem(
  numero: string,
  texto: string,
  opcoes: { quebrar?: boolean; permitirUrl?: boolean } = {},
): Promise<boolean> {
  const { quebrar = true, permitirUrl = false } = opcoes;

  // Notificacoes ao grupo de suporte (SUPORTE_GRUPO_JID) chegam aqui — GHL
  // nao manda pra grupo, abortar com log explicativo.
  if (ehGrupoOuBroadcast(numero)) {
    console.warn(`[ghl] enviarMensagem para grupo/broadcast nao suportado (${numero}). Texto: "${texto.slice(0, 100)}". Considere outro canal pra notificacoes do time.`);
    return false;
  }

  // Defesa em profundidade: GPT-4.1 ocasionalmente duplica o texto inteiro
  // ou frases longas dentro do mesmo `text` da resposta. Detectamos e removemos
  // antes do envio. So afeta duplicatas literais (>50 chars / >30 chars/frase).
  let textoLimpo = removerDuplicacoes(texto).trim();

  // Filtro de URL — mesma logica da Evolution.
  if (!permitirUrl && URL_REGEX.test(textoLimpo)) {
    const urlsDetectadas = textoLimpo.match(URL_REGEX);
    console.warn(`[ghl] URL bloqueada na resposta do agente: ${urlsDetectadas?.join(', ')}`);
    textoLimpo = textoLimpo.replace(URL_REGEX, '').replace(/\s+/g, ' ').trim();
  }
  if (textoLimpo.length === 0) return false;

  // Resolve contactId pra mandar via API.
  const contactId = await buscarContactIdPorTelefone(numero);
  if (!contactId) {
    console.error(`[ghl] Nao foi possivel resolver contactId pra ${numero} — mensagem nao enviada. Verifique se o webhook chegou primeiro pra cache do contactId.`);
    return false;
  }

  const partes = quebrar ? quebrarMensagem(textoLimpo) : [textoLimpo];
  let todasOk = true;
  for (const parte of partes) {
    const ok = await enviarMensagemUnica(contactId, parte);
    if (!ok) todasOk = false;
  }
  return todasOk;
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
