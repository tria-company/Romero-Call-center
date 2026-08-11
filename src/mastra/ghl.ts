// Integracao com GoHighLevel (GHL) — enxuto para o discador Wavoip.
//
// Responsabilidade original: listar os leads do stage QUALIFICADO do pipeline
// COMERCIAL USI (nome + telefone E.164 + respostas do formulario) para o PWA
// discador. Leitura pura via GET /opportunities/search com Bearer PIT.
//
// Extensao (DOSS-01, Fase 04 Plano 01, D-P4-12): leituras de conversas
// WhatsApp + oportunidades para o dossie 360 (secoes 2/3/4). Estas leituras
// DEGRADAM em vez de LANCAR (D-P4-06) — token ausente/rede/`!res.ok` sempre
// retornam vazio + `console.error`; uma falha de escopo/rede numa secao nao
// pode abortar o dossie inteiro do lead. Quem decide se a secao fica marcada
// "indisponivel" e o caller (montagem do dossie), nunca esta camada.

import {
  GHL_PIT_TOKEN,
  GHL_API_VERSION,
  GHL_API_VERSION_V2,
  GHL_PIPELINE_ID,
  GHL_LOCATION_ID,
  GHL_STAGES,
} from './config.ts';
import { fetchTimeout } from './http.ts';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';

// Nota da transcricao no contato (o GHL trunca notas muito longas).
const LIMITE_NOTA_OBSERVACAO_CHARS = 20000;

export interface CampoFormulario {
  label: string;
  valor: string;
}
export interface LeadQualificado {
  nome: string;
  telefone: string; // E.164 (ex: +5599991442003)
  resumo?: string; // analise_do_formulario (resumo BANT/analise)
  formulario?: CampoFormulario[]; // respostas do form 14q, rotuladas
}

// Custom fields da OPORTUNIDADE que sao respostas do formulario 14q (id -> label
// legivel, na ordem de exibicao). Ids descobertos via GET
// /locations/{id}/customFields?model=opportunity. analise_do_formulario vira `resumo`.
const FORM_OPP_CAMPOS: Array<{ id: string; label: string }> = [
  { id: 'sQpp8xAdqGSLFtpZFgmX', label: 'Formação' },
  { id: 'CP5ksZXpxAswBdKEPJh7', label: 'Tempo de atuação' },
  { id: 'k3JIXEgFRy9q47IMVqy9', label: 'Área de foco' },
  { id: 'y2Krtc9tlzX5WhxZEyfZ', label: 'Quer aprofundar' },
  { id: 'llGGClaLAciLvZiPmZOi', label: 'Modelo de atendimento' },
  { id: 'rz3upRa2AQN5xzB8XPC3', label: 'Canal' },
  { id: 'm5kfKFuhzNyXWJglF0d3', label: 'Pacientes/semana' },
  { id: 'fVbRBbPSqfbGy4OUPbx6', label: 'Ticket médio' },
  { id: 'SNnlPovD4gem8uGFb5k2', label: 'Tamanho da clínica' },
  { id: 'TvzqREEZ3kX73SHE0sKE', label: 'Já aplica ADS' },
  { id: 'W4Ckck9WfaODSMmVtSh7', label: 'Módulo com resultado' },
  { id: 'ny4kuIdXh9eI7D8hVs2c', label: 'Maior dificuldade' },
  { id: 'mzz23c8yYzYRHWXd6FTG', label: 'Mudaria no curso' },
  { id: 'Q43qdXelZhY0t43wNDmo', label: 'Já indicou' },
  { id: 'ItxxS6cCOkSu9l8xprui', label: 'Congresso SP' },
];
const RESUMO_OPP_CAMPO = '9vTUlbYPfOmOU3MNnrqm'; // analise_do_formulario

function valorCampoOpp(cf: any): string {
  const v = cf?.fieldValueString ?? cf?.fieldValue ?? cf?.value ?? '';
  return typeof v === 'string' ? v : String(v ?? '');
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
        const porId = new Map<string, string>();
        for (const cf of (Array.isArray(o.customFields) ? o.customFields : [])) {
          if (cf?.id) porId.set(cf.id, valorCampoOpp(cf));
        }
        const formulario: CampoFormulario[] = FORM_OPP_CAMPOS
          .map((f) => ({ label: f.label, valor: (porId.get(f.id) || '').trim() }))
          .filter((x) => x.valor);
        return {
          nome: String(c.name || c.contactName || c.fullName || o.name || '').trim(),
          telefone: String(c.phone || '').trim(),
          resumo: (porId.get(RESUMO_OPP_CAMPO) || '').trim() || undefined,
          formulario: formulario.length ? formulario : undefined,
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

// =================== Transcricao da call: nota no contato ===================

/** Resolve o contactId do GHL a partir do telefone (POST /contacts/search). */
export async function buscarContactIdPorTelefone(telefone: string): Promise<string | null> {
  if (!GHL_PIT_TOKEN) return null;
  try {
    const phoneE164 = telefone.startsWith('+') ? telefone : `+${telefone}`;
    const res = await fetchTimeout(`${GHL_BASE_URL}/contacts/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
        'Version': GHL_API_VERSION_V2,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID,
        pageLimit: 1,
        filters: [{ field: 'phone', operator: 'eq', value: phoneE164 }],
      }),
    });
    if (!res.ok) {
      console.warn(`[ghl] busca contactId por telefone falhou (${res.status})`);
      return null;
    }
    const data = await res.json();
    return data?.contacts?.[0]?.id || null;
  } catch (e) {
    console.error('[ghl] erro na busca de contactId por telefone:', e);
    return null;
  }
}

/**
 * Registra a transcricao da call como nota no contato do GHL (visivel pro
 * closer no CRM). Resolve o contactId pelo telefone. Retorna true se o GHL
 * aceitou o POST.
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
    console.log(`[wavoip] ${telefone} (${contactId}) <- nota com transcricao (${corpo.length} chars)`);
    return true;
  } catch (e) {
    console.error(`[wavoip] erro ao registrar nota para ${telefone}:`, e);
    return false;
  }
}

// =================== Dossie 360: conversas WhatsApp + oportunidades ===================
// (DOSS-01, Fase 04 Plano 01, D-P4-12 — leituras que DEGRADAM, nunca LANCAM)

export interface MensagemConversaGhl {
  direcao: string; // 'inbound' | 'outbound' (conforme a API do GHL)
  texto: string;
  data?: string;
}

/**
 * Busca as mensagens da conversa WhatsApp do contato (secao 3 "Ultima
 * interacao" do dossie, D-P4-12). Aceita `contactId` ja resolvido pelo
 * caller (mesmo racional de `registrarNotaObservacao` — nao re-resolve
 * internamente). Usa GHL_API_VERSION_V2 (conversas sao v2). Mesmo shape de
 * degradacao graciosa de `buscarQualificados` — token ausente/rede/
 * `!res.ok` retornam array vazio + `console.error`, nunca LANCA (D-P4-06).
 */
export async function buscarConversasWhatsApp(contactId: string): Promise<MensagemConversaGhl[]> {
  if (!GHL_PIT_TOKEN) return [];
  try {
    const paramsBusca = new URLSearchParams({ locationId: GHL_LOCATION_ID, contactId });
    const resBusca = await fetchTimeout(`${GHL_BASE_URL}/conversations/search?${paramsBusca.toString()}`, {
      headers: {
        'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
        'Version': GHL_API_VERSION_V2,
        'Accept': 'application/json',
      },
    });
    if (!resBusca.ok) {
      console.error(`[discador] GET /conversations/search falhou (${resBusca.status})`);
      return [];
    }
    const dataBusca = await resBusca.json();
    const conversationId = dataBusca?.conversations?.[0]?.id;
    if (!conversationId) return [];

    const resMsgs = await fetchTimeout(`${GHL_BASE_URL}/conversations/${conversationId}/messages`, {
      headers: {
        'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
        'Version': GHL_API_VERSION_V2,
        'Accept': 'application/json',
      },
    });
    if (!resMsgs.ok) {
      console.error(`[discador] GET /conversations/${conversationId}/messages falhou (${resMsgs.status})`);
      return [];
    }
    const dataMsgs = await resMsgs.json();
    const mensagens: any[] = dataMsgs?.messages?.messages || dataMsgs?.messages || [];
    return mensagens
      .map((m) => ({
        direcao: String(m?.direction || '').trim(),
        texto: String(m?.body || '').trim(),
        data: m?.dateAdded ? String(m.dateAdded) : undefined,
      }))
      .filter((m) => m.texto);
  } catch (e) {
    console.error('[discador] erro buscarConversasWhatsApp:', e);
    return [];
  }
}

export interface OportunidadeGhl {
  nome: string;
  stage: string;
  status: string;
  valor?: string;
  campos?: CampoFormulario[];
}

/**
 * Busca as oportunidades do contato (secoes 2/4 do dossie, D-P4-12), reusando
 * FORM_OPP_CAMPOS/valorCampoOpp para extrair as respostas do formulario 14q.
 * Aceita `contactId` ja resolvido pelo caller. Mesmo shape de degradacao
 * graciosa de `buscarQualificados` (D-P4-06) — nunca LANCA.
 */
export async function buscarOportunidades(contactId: string): Promise<OportunidadeGhl[]> {
  if (!GHL_PIT_TOKEN) return [];
  try {
    const params = new URLSearchParams({ location_id: GHL_LOCATION_ID, contact_id: contactId });
    const res = await fetchTimeout(`${GHL_BASE_URL}/opportunities/search?${params.toString()}`, {
      headers: {
        'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
        'Version': GHL_API_VERSION_V2,
        'Accept': 'application/json',
      },
    });
    if (!res.ok) {
      console.error(`[discador] GET /opportunities/search (contato ${contactId}) falhou (${res.status})`);
      return [];
    }
    const data = await res.json();
    return (data?.opportunities || []).map((o: any) => {
      const porId = new Map<string, string>();
      for (const cf of Array.isArray(o.customFields) ? o.customFields : []) {
        if (cf?.id) porId.set(cf.id, valorCampoOpp(cf));
      }
      const campos: CampoFormulario[] = FORM_OPP_CAMPOS
        .map((f) => ({ label: f.label, valor: (porId.get(f.id) || '').trim() }))
        .filter((x) => x.valor);
      return {
        nome: String(o.name || '').trim(),
        stage: String(o.pipelineStageId || o.stage || '').trim(),
        status: String(o.status || '').trim(),
        valor: o.monetaryValue != null ? String(o.monetaryValue) : undefined,
        campos: campos.length ? campos : undefined,
      };
    });
  } catch (e) {
    console.error(`[discador] erro buscarOportunidades (contato ${contactId}):`, e);
    return [];
  }
}
