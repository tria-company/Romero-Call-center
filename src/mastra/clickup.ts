// Integracao com ClickUp — store operacional do RomeroCall (Listas 01 LEADS /
// 02 LIGACOES). Substitui o GHL como fonte da verdade operacional (FUND-01/02).
//
// Autenticacao: Personal API Token via REST v2 (D-01), header `Authorization`
// RAW (SEM "Bearer") com o token de `config.ts`. NAO usar o MCP do ClickUp em
// runtime (D-01/D-02 — o MCP desta sessao nao enxerga a workspace do usuario).
//
// Os custom fields das duas listas JA EXISTEM (D-05) — este modulo nunca cria
// lista/campo, so le/escreve. Escrita de custom field e SEMPRE por field_id
// (nunca por nome — D-07), usando os mapas CAMPOS_LEADS/CAMPOS_LIGACOES abaixo.

import { CLICKUP_API_TOKEN, CLICKUP_LIST_LEADS, CLICKUP_LIST_LIGACOES } from './config';
import { fetchTimeout } from './http';

const CLICKUP_BASE_URL = 'https://api.clickup.com/api/v2';

// Mapa nome logico -> field_id na Lista 01 LEADS (1000320000002833). IDs
// copiados de 01-CONTEXT.md (D-05). NUNCA resolver por nome em runtime (D-07).
export const CAMPOS_LEADS = {
  NOME: '8fdbb2ca-b3e7-4b51-999d-8aa802d5bc4f',
  TELEFONE: 'e29b4882-bbb9-402e-8ba9-dda2d8418b4b',
  CPF: '3f460797-b9c1-4d47-9f5d-bdf4d3fc54fb',
  ID_SUPABASE: '0852f523-07bd-47e8-a53b-55ac88b1e7f6',
  ID_LEAD_GHL: 'f9efe4d9-bfbd-452d-85c1-d88462b28462',
  ORIGEM: '94a1b44b-3f11-46dd-821c-e79eee903615',
  SCORE: 'b7052e83-626a-4c74-8062-583a0a18d429',
  MILITANTE: 'de5ba650-caf1-4f17-8ec7-4dfa5ee128e9',
  QTD_TENTATIVAS: '037da11d-c6ca-438f-aa22-74f24cd9d985',
  QTD_ATENDIMENTOS: 'e00ef795-e256-4337-84a4-5f3994fc2bce',
  QTD_NAO_ATENDIMENTOS: '2aa46fdb-4539-4adc-ab85-1fc952879e83',
  PROXIMO_CONTATO: '49a81d89-6ae3-43bd-926b-4fef1ac07ea8',
  ULTIMO_CONTATO: '91f3a8cc-5549-41a5-820a-8a6125abf3eb',
  ULTIMO_ATENDIMENTO: '745ae39c-e1b5-41ea-a4ec-f05304343cdc',
  ULTIMO_RESULTADO: 'f516c0ef-109a-4117-a36d-49deda865a4f',
  OBSERVACAO_CONSOLIDADA: 'd2993d89-c700-4315-a2cf-f7258eb3c504',
  UF: '4a8dc202-2e7e-4c78-9c74-bfb81f9abf45',
  CIDADE: 'fad71df5-26c2-442d-bd3c-d8b280b17bb6',
  BAIRRO: '482d4d68-5006-410f-8042-77306981e5f9',
  LOGRADOURO: 'e632730d-3927-4108-95c2-e5e7138fc941',
  NUMERO: '6fd9fd47-5312-469e-bb2a-7e8f7d1809f3',
  COMPLEMENTO: '01e22870-7d41-49f8-b190-ee177153acbf',
  CEP: 'db8d704e-0b6a-4397-b4bc-60a5f0eb1f61',
  CONFIRMOU_VOTO_ROMERO: 'e2b6558f-7d6e-4af6-93b7-d0adde65b79b',
  CONFIRMOU_VOTO_ANDRESSA: '0e6bf825-be20-4bf4-a967-986c2e46ea26',
} as const;

// Mapa nome logico -> field_id na Lista 02 LIGACOES (1000320000002834). D-05/D-07.
// SCRIPT_LIGACAO e ADERENCIA_SCRIPT ainda NAO EXISTEM — criados no plano 01-03.
export const CAMPOS_LIGACOES = {
  LEAD_REL: '381d4565-aeae-4abb-a4f7-38322a1c71f8',
  TELEFONE: 'e29b4882-bbb9-402e-8ba9-dda2d8418b4b',
  ID_LEAD: 'f9efe4d9-bfbd-452d-85c1-d88462b28462',
  OPERADOR: '7fe613d6-8170-43e9-a422-7b5f9dd45a99',
  ATENDEU: '68daf21b-6420-4ceb-9c8c-bc67d6f7a2ef',
  INICIO: 'c5eadc11-bd39-4b5c-b46c-3b3fddf49e89',
  FIM: '3b3882f0-42d0-4f21-9e4d-5d7ec8eadfeb',
  DURACAO: '8e1279d2-5095-41d7-a071-8d9c58e4e137',
  MOTIVO_FALHA: 'a64b2318-2640-4d15-9f1f-57861ad32b6a',
  URL_GRAVACAO: '8554090f-5966-4853-b39d-d492cccc00a3',
  TRANSCRICAO: '82392243-3ef9-46a8-abf6-3dfcefd7c16c',
  ANALISE_IA: 'dfb8e194-b453-4501-91fe-0e214aaca14e',
  OBSERVACOES_EXTRAIDAS: '6dbddd74-0df0-4e2b-9f50-5d1abf78cf0f',
  NECESSITA_REVISAO: 'a666fb85-e76d-43e5-91a2-62a2a005cfbb',
  RETORNO_NECESSARIO: '1b27b754-0cc3-4500-a0ae-a57de2d07243',
  DATA_RETORNO: '1202faf9-13ff-492d-b3d4-fb9ff78bd827',
  SCRIPT_LIGACAO: '', // preenchido no 01-03 (campo "Script da ligação" a criar)
  ADERENCIA_SCRIPT: '', // preenchido no 01-03 (campo "Aderência ao script" a criar)
} as const;

export interface CustomFieldClickUp {
  id: string;
  name?: string;
  value?: unknown;
}

export interface TaskClickUp {
  id: string;
  name: string;
  status?: { status: string } | string;
  custom_fields?: CustomFieldClickUp[];
}

function headers(): Record<string, string> {
  return {
    'Authorization': CLICKUP_API_TOKEN,
    'Content-Type': 'application/json',
  };
}

/**
 * Lista as tasks de uma lista (D-01). Suporta paginacao por `page` (0-based,
 * padrao da API ClickUp). Retorna tasks com custom_fields inclusos.
 */
export async function listarTasks(
  listId: string,
  opts: { page?: number; includeClosed?: boolean } = {},
): Promise<{ tasks: TaskClickUp[]; lastPage: boolean }> {
  if (!CLICKUP_API_TOKEN) return { tasks: [], lastPage: true };
  const params = new URLSearchParams({
    page: String(opts.page ?? 0),
    include_closed: String(opts.includeClosed ?? true),
  });
  try {
    const res = await fetchTimeout(`${CLICKUP_BASE_URL}/list/${listId}/task?${params.toString()}`, {
      headers: headers(),
    });
    if (!res.ok) {
      console.error(`[clickup] GET /list/${listId}/task falhou (${res.status})`);
      return { tasks: [], lastPage: true };
    }
    const data = await res.json();
    return { tasks: data?.tasks || [], lastPage: Boolean(data?.last_page) };
  } catch (e) {
    console.error(`[clickup] erro ao listar tasks da lista ${listId}:`, e);
    return { tasks: [], lastPage: true };
  }
}

/** Le uma task por ID (com custom_fields). */
export async function lerTask(taskId: string): Promise<TaskClickUp | null> {
  if (!CLICKUP_API_TOKEN) return null;
  try {
    const res = await fetchTimeout(`${CLICKUP_BASE_URL}/task/${taskId}`, { headers: headers() });
    if (!res.ok) {
      console.error(`[clickup] GET /task/${taskId} falhou (${res.status})`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error(`[clickup] erro ao ler task ${taskId}:`, e);
    return null;
  }
}

/**
 * Cria uma task numa lista (D-05 — a lista ja existe, nao cria lista/campo).
 * `customFields` aceita `{ id, value }` — o caller deve resolver o id via
 * CAMPOS_LEADS/CAMPOS_LIGACOES (D-07).
 */
export async function criarTask(
  listId: string,
  payload: { name: string; custom_fields?: Array<{ id: string; value: unknown }> },
): Promise<TaskClickUp | null> {
  if (!CLICKUP_API_TOKEN) return null;
  try {
    const res = await fetchTimeout(`${CLICKUP_BASE_URL}/list/${listId}/task`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[clickup] POST /list/${listId}/task falhou (${res.status})`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error(`[clickup] erro ao criar task na lista ${listId}:`, e);
    return null;
  }
}

/** Atualiza campos "nativos" da task (name, status, etc — nao custom fields). */
export async function atualizarTask(
  taskId: string,
  patch: Record<string, unknown>,
): Promise<TaskClickUp | null> {
  if (!CLICKUP_API_TOKEN) return null;
  try {
    const res = await fetchTimeout(`${CLICKUP_BASE_URL}/task/${taskId}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      console.error(`[clickup] PUT /task/${taskId} falhou (${res.status})`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error(`[clickup] erro ao atualizar task ${taskId}:`, e);
    return null;
  }
}

/**
 * Seta um custom field por ID numa task (D-07 — sempre por ID, nunca por
 * nome). `fieldId` deve vir de CAMPOS_LEADS/CAMPOS_LIGACOES.
 */
export async function setCustomField(taskId: string, fieldId: string, value: unknown): Promise<boolean> {
  if (!CLICKUP_API_TOKEN) return false;
  if (!fieldId) {
    console.error(`[clickup] setCustomField chamado sem fieldId para a task ${taskId}`);
    return false;
  }
  try {
    const res = await fetchTimeout(`${CLICKUP_BASE_URL}/task/${taskId}/field/${fieldId}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ value }),
    });
    if (!res.ok) {
      console.error(`[clickup] POST /task/${taskId}/field/${fieldId} falhou (${res.status})`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[clickup] erro ao setar custom field ${fieldId} na task ${taskId}:`, e);
    return false;
  }
}

// Re-exporta os IDs de lista do config para consumo conveniente por quem
// importa so `clickup.ts` (ex: fases 2/3/4).
export { CLICKUP_LIST_LEADS, CLICKUP_LIST_LIGACOES };
