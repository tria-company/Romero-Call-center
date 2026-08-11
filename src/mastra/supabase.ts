// Integracao com a instancia Supabase self-hosted (D-P4-10) — base de
// militantes/triagem/follow-ups do dossie 360 (DOSS-01/02, Fase 04 Plano 01).
//
// Autenticacao: REST (PostgREST) via headers `apikey` + `Authorization: Bearer`
// com SUPABASE_SERVICE_KEY (server-side only — D-P4-11). NUNCA logar/expor a
// key: mensagens de erro citam so o NOME da env faltando, nunca o valor.
//
// Padrao de erro: TODAS as funcoes deste modulo LANCAM em falha de config/
// infra/HTTP (WR-03, molde de clickup.ts) — nunca mascaram erro como
// resultado vazio. `null` fica reservado a "nao encontrado" legitimo
// (ex: buscarMilitante sem match), distinto de erro.
//
// Esquema (nomes de tabela/coluna) e PARAMETRIZAVEL via config.ts — nunca
// hardcoded aqui. Os valores reais sao descobertos por
// scripts/descobrir-supabase-ghl.mjs (checkpoint 04-05), nunca adivinhados.

import {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUPABASE_TABLE_MILITANTES,
  SUPABASE_TABLE_FOLLOWUPS,
  SUPABASE_COL_ID,
  SUPABASE_COL_CPF,
  SUPABASE_COL_TELEFONE,
  SUPABASE_COL_FOLLOWUP_REF,
} from './config.ts';
import { fetchTimeout } from './http.ts';

// Endpoint REST montado do env — instancia self-hosted, nunca hardcoded (D-P4-11).
export const SUPABASE_REST_URL = `${SUPABASE_URL}/rest/v1`;

function headers(): Record<string, string> {
  return {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

/** Lanca erro claro de config ausente (WR-03/D-P4-11) — nunca resolve vazio. */
function checarConfig(): void {
  if (!SUPABASE_URL) {
    throw new Error('[supabase] SUPABASE_URL ausente — nao da para ler a base self-hosted');
  }
  if (!SUPABASE_SERVICE_KEY) {
    throw new Error('[supabase] SUPABASE_SERVICE_KEY ausente — nao da para autenticar na base self-hosted');
  }
}

export interface TabelaDescoberta {
  tabela: string;
  colunas: string[];
}

/**
 * Descobre o esquema real da base (D-P4-11) — GET na raiz do PostgREST, que
 * devolve o spec OpenAPI com `definitions`/`paths` (tabelas e colunas).
 * Usado por scripts/descobrir-supabase-ghl.mjs ANTES de qualquer mapeamento
 * de ingestao/dossie ser fixado no .env. Erro de config/rede/HTTP LANCA
 * (WR-03) — nunca retorna lista vazia mascarando falha.
 */
export async function descobrirEsquema(): Promise<TabelaDescoberta[]> {
  checarConfig();
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/`, { headers: headers() });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao descobrir o esquema: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] GET ${SUPABASE_REST_URL}/ falhou (${res.status})`);
  }
  const data = await res.json();
  const definitions: Record<string, { properties?: Record<string, unknown> }> = data?.definitions || {};
  return Object.entries(definitions).map(([tabela, def]) => ({
    tabela,
    colunas: Object.keys(def?.properties || {}),
  }));
}

export interface OpcoesListarTabela {
  limit?: number;
  offset?: number;
  select?: string;
  filtros?: Record<string, string>;
}

/**
 * Leitura paginada de uma tabela via PostgREST (`?limit=&offset=`, filtros
 * `coluna=eq.valor`). Erro de config/rede/HTTP LANCA (WR-03) — o caller
 * (ingestao/dossie) decide como reagir; nunca mascara falha como lista vazia.
 */
export async function listarTabela(
  tabela: string,
  opts: OpcoesListarTabela = {},
): Promise<Record<string, unknown>[]> {
  checarConfig();
  const params = new URLSearchParams({
    limit: String(opts.limit ?? 100),
    offset: String(opts.offset ?? 0),
  });
  params.set('select', opts.select || '*');
  for (const [coluna, valor] of Object.entries(opts.filtros ?? {})) {
    params.set(coluna, valor);
  }
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${tabela}?${params.toString()}`, { headers: headers() });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao listar a tabela ${tabela}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] GET /${tabela} falhou (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Lookup por eq-filter na tabela de militantes (SUPABASE_TABLE_MILITANTES,
 * cascata id -> cpf -> telefone, D-P4-08). `null` = nao encontrado (legitimo),
 * distinto de erro de infra/config (LANCA — WR-03).
 */
export async function buscarMilitante(
  opts: { idSupabase?: string; cpf?: string; telefone?: string },
): Promise<Record<string, unknown> | null> {
  checarConfig();
  if (!SUPABASE_TABLE_MILITANTES) {
    throw new Error('[supabase] SUPABASE_TABLE_MILITANTES ausente — nao da para buscar militante');
  }
  const filtros: Record<string, string> = {};
  if (opts.idSupabase) filtros[SUPABASE_COL_ID] = `eq.${opts.idSupabase}`;
  else if (opts.cpf) filtros[SUPABASE_COL_CPF] = `eq.${opts.cpf}`;
  else if (opts.telefone) filtros[SUPABASE_COL_TELEFONE] = `eq.${opts.telefone}`;
  else {
    throw new Error('[supabase] buscarMilitante chamado sem idSupabase/cpf/telefone');
  }
  const linhas = await listarTabela(SUPABASE_TABLE_MILITANTES, { limit: 1, filtros });
  return linhas[0] ?? null;
}

/**
 * Monta o filtro PostgREST da tabela de follow-ups a partir da FK dedicada
 * (SUPABASE_COL_FOLLOWUP_REF), NUNCA das colunas de identidade da tabela de
 * MILITANTES (SUPABASE_COL_ID/CPF/TELEFONE) — fecha CR-02 (04-VERIFICATION.md):
 * a tabela de follow-ups tem sua PRÓPRIA PK `id`, distinta da FK que aponta
 * pro militante dono do follow-up; filtrar pela coluna errada arrisca trazer
 * o follow-up de OUTRA PESSOA pro dossiê do lead (contaminação cruzada de
 * PII, violação LGPD). Função PURA (sem I/O) — testável por smoke sem rede.
 *
 * LANCA (nunca retorna filtro vazio/parcial):
 *  - `colFollowupRef` vazio -> "configuração de follow-ups ausente" (env não configurada).
 *  - `opts.refMilitante` vazio -> "referência do militante ausente" (sem chave, sem filtro).
 */
export function montarFiltroFollowUps(
  opts: { refMilitante?: string },
  colFollowupRef: string,
): Record<string, string> {
  if (!colFollowupRef) {
    throw new Error(
      '[supabase] configuração de follow-ups ausente — SUPABASE_COL_FOLLOWUP_REF não configurada ' +
        '(não dá para filtrar follow-ups por militante sem arriscar misturar identidade de outra ' +
        'pessoa — LGPD)',
    );
  }
  if (!opts.refMilitante) {
    throw new Error('[supabase] referência do militante ausente — montarFiltroFollowUps chamado sem refMilitante');
  }
  return { [colFollowupRef]: `eq.${opts.refMilitante}` };
}

/**
 * Le os follow-ups (SUPABASE_TABLE_FOLLOWUPS) filtrando pela FK dedicada do
 * militante (SUPABASE_COL_FOLLOWUP_REF via `montarFiltroFollowUps`) — NUNCA
 * pelas colunas de identidade da tabela de MILITANTES (SUPABASE_COL_ID/CPF/
 * TELEFONE, usadas só por `buscarMilitante` acima). Fecha CR-02
 * (04-VERIFICATION.md): a FK de follow-ups é uma coluna distinta da PK da
 * própria tabela de follow-ups e das colunas de identidade de militantes.
 * Erro de config/rede/HTTP LANCA (WR-03); lista vazia e resultado legitimo
 * (sem follow-up para aquele militante).
 */
export async function listarFollowUps(
  opts: { refMilitante?: string },
): Promise<Record<string, unknown>[]> {
  checarConfig();
  if (!SUPABASE_TABLE_FOLLOWUPS) {
    throw new Error('[supabase] SUPABASE_TABLE_FOLLOWUPS ausente — nao da para listar follow-ups');
  }
  const filtros = montarFiltroFollowUps(opts, SUPABASE_COL_FOLLOWUP_REF);
  return listarTabela(SUPABASE_TABLE_FOLLOWUPS, { filtros });
}
