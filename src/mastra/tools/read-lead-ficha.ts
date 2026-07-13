import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GHL_PIT_TOKEN, GHL_API_VERSION, GHL_API_VERSION_V2, GHL_LOCATION_ID } from '../config';
import { fetchTimeout } from '../http';
import { buscarContactIdPorTelefone } from '../ghl';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';

// Custom fields relevantes do playbook SDR AUTON (secao 10 — Estrutura GHL).
// So esses (normalizados sem o prefixo "contact.") entram no objeto `ficha`.
const CAMPOS_FICHA = [
  'bant_budget', 'bant_authority', 'bant_need', 'bant_timing', 'bant_total',
  'spin_stage', 'plano_sugerido', 'ancora_abordagem', 'aplicou_ads', 'indicou_curso',
  'congresso_sp', 'transcricao_ligacao_sdr', 'transcricao_call_closer', 'resumo_ultima_ligacao',
  'objecao_ativa', 'sinal_compra_ultimo_toque', 'alerta_desistencia', 'numero_no_shows', 'motivo_perdido',
] as const;

interface DefinicaoCustomField {
  id: string;
  key?: string;
  fieldKey?: string;
  name?: string;
}

// GET /contacts/{id} (V1) so devolve customFields como [{ id, value }] — sem a
// chave legivel. Pra normalizar (bant_total, spin_stage, ...) resolvemos o mapa
// id -> chave uma vez via /locations/{id}/customFields (V2) e cacheamos em memoria.
let cacheDefs: Map<string, string> | null = null;

function normalizarChave(bruta: string): string {
  // GHL prefixa a fieldKey com o tipo do objeto (ex: "contact.bant_total").
  const semPrefixo = bruta.includes('.') ? bruta.split('.').pop()! : bruta;
  return semPrefixo.toLowerCase();
}

async function buscarMapaCustomFields(): Promise<Map<string, string>> {
  if (cacheDefs) return cacheDefs;
  const mapa = new Map<string, string>();
  if (!GHL_PIT_TOKEN) return mapa;
  try {
    const url = `${GHL_BASE_URL}/locations/${GHL_LOCATION_ID}/customFields`;
    const res = await fetchTimeout(url, {
      headers: {
        'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
        'Version': GHL_API_VERSION_V2,
        'Accept': 'application/json',
      },
    });
    if (!res.ok) {
      console.error(`[read-lead-ficha] busca de definicoes de custom fields falhou (${res.status}):`, await res.text());
      return mapa;
    }
    const data = await res.json();
    const defs: DefinicaoCustomField[] = data?.customFields || [];
    for (const def of defs) {
      const chaveBruta = def.fieldKey || def.key || def.name || '';
      if (def.id && chaveBruta) mapa.set(def.id, normalizarChave(chaveBruta));
    }
    cacheDefs = mapa;
  } catch (e) {
    console.error('[read-lead-ficha] erro ao buscar definicoes de custom fields:', e);
  }
  return mapa;
}

export const readLeadFicha = createTool({
  id: 'read-lead-ficha',
  description:
    'Le a ficha do lead no GHL: dados basicos (nome) + custom fields do playbook (BANT, SPIN, ancora de abordagem, sinais de compra, motivo de perdido, etc). Chame no inicio da conversa ou quando precisar reler o contexto do lead.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    contactId: z.string().optional().describe('contactId do GHL, se ja conhecido (evita lookup)'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
    contactId: z.string().optional(),
    nome: z.string().optional(),
    telefone: z.string().optional(),
    ficha: z.record(z.string(), z.string()).optional().describe('Custom fields normalizados (bant_total, spin_stage, ancora_abordagem, ...)'),
  }),
  execute: async ({ telefone, contactId: contactIdInformado }) => {
    if (!GHL_PIT_TOKEN) {
      console.error('[read-lead-ficha] GHL_PIT_TOKEN nao configurado');
      return { sucesso: false };
    }

    const contactId = contactIdInformado || (await buscarContactIdPorTelefone(telefone));
    if (!contactId) {
      console.error(`[read-lead-ficha] nao foi possivel resolver contactId para ${telefone}`);
      return { sucesso: false };
    }

    try {
      const url = `${GHL_BASE_URL}/contacts/${contactId}`;
      const res = await fetchTimeout(url, {
        headers: {
          'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
          'Version': GHL_API_VERSION,
          'Accept': 'application/json',
        },
      });
      if (!res.ok) {
        console.error(`[read-lead-ficha] GET /contacts/${contactId} falhou (${res.status}):`, await res.text());
        return { sucesso: false, contactId };
      }

      const data = await res.json();
      const contato = data?.contact || data;
      const mapaChaves = await buscarMapaCustomFields();

      const ficha: Record<string, string> = {};
      const customFieldsBrutos: Array<{ id?: string; key?: string; value?: unknown }> = contato?.customFields || [];
      for (const campo of customFieldsBrutos) {
        const chave = (campo.id && mapaChaves.get(campo.id)) || (campo.key ? normalizarChave(campo.key) : undefined);
        if (chave && (CAMPOS_FICHA as readonly string[]).includes(chave) && campo.value !== undefined && campo.value !== null) {
          ficha[chave] = String(campo.value);
        }
      }

      const nome =
        contato?.contactName ||
        [contato?.firstName, contato?.lastName].filter(Boolean).join(' ') ||
        undefined;

      console.log(`[read-lead-ficha] ${telefone} (${contactId}) -> ${Object.keys(ficha).length} campos lidos`);
      return { sucesso: true, contactId, nome, telefone, ficha };
    } catch (e) {
      console.error('[read-lead-ficha] erro:', e);
      return { sucesso: false, contactId };
    }
  },
});
