// outbox-repo.ts — repositório do transactional outbox (Fase B, Phase 19
// Plano 03, .planning/arquitetura/inversao-supabase-fonte-da-verdade.md §2.4/
// §3.2). Lido/escrito pelo worker de dreno (src/mastra/drenar-outbox.ts): lê
// as linhas pendentes de UM aggregate por vez EM ORDEM DE SEQ
// (ix_outbox_ordem/ix_outbox_drain, sql/escala/09_clickup_outbox.sql), resolve
// e grava o back-fill de `clickup_task_id` em `ligacoes`, e marca cada linha
// enviada — NULANDO o payload nesse momento (scrub de PII pós-drain, LGPD-03/
// Riscos R13: o payload pode ter telefone/voto/motivo em repouso até o dreno).
//
// Molde EXATO de I/O self-contido de src/mastra/supabase.ts (SUPABASE_REST_URL
// + headers() com apikey/Authorization Bearer + checarConfig) e do mesmo
// racional de src/mastra/outbox-rpc.ts: módulo PRÓPRIO, importa só
// SUPABASE_URL/SUPABASE_SERVICE_KEY/SUPABASE_TABLE_CLICKUP_OUTBOX/
// SUPABASE_TABLE_LIGACOES de config.ts e fetchTimeout de http.ts — NUNCA
// importa supabase.ts (preserva testabilidade standalone via
// `node --experimental-strip-types`, sem puxar o grafo de imports do módulo
// maior).
//
// LGPD/segurança (WR-03, mesmo padrão do resto do projeto): NUNCA loga
// payload/telefone/URL — mensagens de erro citam só o NOME da env faltando,
// a operação em si (ex.: "marcarEnviado id=42") ou o status HTTP, nunca o
// corpo da linha do outbox.

import {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUPABASE_TABLE_CLICKUP_OUTBOX,
  SUPABASE_TABLE_LIGACOES,
} from './config.ts';
import { fetchTimeout } from './http.ts';

// Endpoint REST montado do env — instância self-hosted, nunca hardcoded (D-P4-11).
export const SUPABASE_REST_URL = `${SUPABASE_URL}/rest/v1`;

function headers(): Record<string, string> {
  return {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

/** Lança erro claro de config ausente (WR-03) — nunca resolve vazio nem faz I/O. */
function checarConfig(): void {
  if (!SUPABASE_URL) {
    throw new Error('[outbox-repo] SUPABASE_URL ausente — não dá para ler/escrever o outbox do ClickUp');
  }
  if (!SUPABASE_SERVICE_KEY) {
    throw new Error('[outbox-repo] SUPABASE_SERVICE_KEY ausente — não dá para autenticar no outbox do ClickUp');
  }
}

/** Uma linha de `clickup_outbox` (sql/escala/09_clickup_outbox.sql). */
export interface LinhaOutbox {
  id: number;
  aggregate: string;
  aggregate_id: number;
  op: string;
  bloqueante: boolean;
  payload: Record<string, unknown> | null;
  dedup_key: string;
  seq: number;
  status: string;
  tentativas: number;
}

/**
 * Linhas PENDENTES (ou em retry: `erro` com `proxima_em` já vencido) de UM
 * aggregate, EM ORDEM DE SEQ (ix_outbox_ordem/ix_outbox_drain) — o worker de
 * dreno nunca reordena, só consome esta lista na ordem devolvida. LANÇA em
 * config ausente/erro de rede/HTTP (WR-03); nunca mascara falha como lista
 * vazia.
 */
export async function proximasPendentes(aggregateId: number): Promise<LinhaOutbox[]> {
  checarConfig();
  const agora = new Date().toISOString();
  const url =
    `${SUPABASE_REST_URL}/${SUPABASE_TABLE_CLICKUP_OUTBOX}` +
    `?aggregate_id=eq.${aggregateId}&status=in.(pendente,erro)` +
    `&proxima_em=lte.${encodeURIComponent(agora)}&order=seq.asc`;
  let res: Response;
  try {
    res = await fetchTimeout(url, { headers: headers() });
  } catch (e) {
    throw new Error(
      `[outbox-repo] falha de rede ao ler proximasPendentes: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[outbox-repo] HTTP ${res.status} ao ler proximasPendentes`);
  }
  return (await res.json()) as LinhaOutbox[];
}

/**
 * Resolve o `clickup_task_id` JÁ gravado do aggregate (o back-fill de
 * `criar_task` grava aqui; ops seguintes leem daqui). Só o aggregate
 * `'ligacao'` é suportado nesta fase (as tabelas de `lead`/`audio`/`nota`
 * ainda não existem — débito de fases futuras); qualquer outro aggregate
 * LANÇA (nunca finge resolver). `null` é resultado LEGÍTIMO ("ainda não
 * criada"), distinto de erro (WR-03).
 */
export async function resolverClickupTaskId(aggregate: string, aggregateId: number): Promise<string | null> {
  checarConfig();
  if (aggregate !== 'ligacao') {
    throw new Error(`[outbox-repo] resolverClickupTaskId: aggregate '${aggregate}' ainda não suportado`);
  }
  const url = `${SUPABASE_REST_URL}/${SUPABASE_TABLE_LIGACOES}?id=eq.${aggregateId}&select=clickup_task_id`;
  let res: Response;
  try {
    res = await fetchTimeout(url, { headers: headers() });
  } catch (e) {
    throw new Error(
      `[outbox-repo] falha de rede ao resolver clickup_task_id: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[outbox-repo] HTTP ${res.status} ao resolver clickup_task_id`);
  }
  const linhas = (await res.json()) as Array<{ clickup_task_id?: string | null }>;
  return linhas?.[0]?.clickup_task_id ?? null;
}

/**
 * Grava o `clickup_task_id` resolvido pelo `criar_task` na linha de
 * `ligacoes` — SÓ quando ainda `null` (`&clickup_task_id=is.null` no
 * filtro): nunca sobrescreve um id já gravado (idempotência do back-fill,
 * reprocesso do mesmo `criar_task` não troca o id existente). LANÇA em
 * config ausente/erro de rede/HTTP (WR-03).
 */
export async function backfillClickupTaskId(aggregateId: number, taskId: string): Promise<void> {
  checarConfig();
  const url = `${SUPABASE_REST_URL}/${SUPABASE_TABLE_LIGACOES}?id=eq.${aggregateId}&clickup_task_id=is.null`;
  let res: Response;
  try {
    res = await fetchTimeout(url, {
      method: 'PATCH',
      headers: { ...headers(), Prefer: 'return=minimal' },
      body: JSON.stringify({ clickup_task_id: taskId }),
    });
  } catch (e) {
    throw new Error(
      `[outbox-repo] falha de rede ao fazer backfillClickupTaskId: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[outbox-repo] HTTP ${res.status} ao fazer backfillClickupTaskId (aggregateId=${aggregateId})`);
  }
}

/**
 * Marca a linha `id` como `enviado` e NULA o `payload` — o SCRUB DE PII
 * pós-drain (LGPD-03/Riscos R13): o payload pode conter telefone/voto/motivo
 * em repouso até este ponto. LANÇA em config ausente/erro de rede/HTTP
 * (WR-03) — o caller (drenar-outbox.ts) decide como reagir (a linha
 * continua `pendente`/`erro` até isto suceder, nunca fica "enviada" sem o
 * scrub).
 */
export async function marcarEnviado(id: number): Promise<void> {
  checarConfig();
  const url = `${SUPABASE_REST_URL}/${SUPABASE_TABLE_CLICKUP_OUTBOX}?id=eq.${id}`;
  let res: Response;
  try {
    res = await fetchTimeout(url, {
      method: 'PATCH',
      headers: { ...headers(), Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'enviado', enviado_em: new Date().toISOString(), payload: null }),
    });
  } catch (e) {
    throw new Error(`[outbox-repo] falha de rede ao marcarEnviado id=${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[outbox-repo] HTTP ${res.status} ao marcarEnviado id=${id}`);
  }
}

/**
 * Marca a linha `id` como `erro` com backoff (`tentativas`/`proximaEm`) — o
 * worker de dreno decide o agendamento; aqui só persiste. `erroTruncado`
 * NUNCA deve conter payload/telefone/URL cru (o caller trunca/sanitiza antes
 * de chamar — mesmo contrato de `ultimo_erro`, sql/escala/09). LANÇA em
 * config ausente/erro de rede/HTTP (WR-03).
 */
export async function marcarErro(
  id: number,
  tentativas: number,
  proximaEm: string,
  erroTruncado: string,
): Promise<void> {
  checarConfig();
  const url = `${SUPABASE_REST_URL}/${SUPABASE_TABLE_CLICKUP_OUTBOX}?id=eq.${id}`;
  let res: Response;
  try {
    res = await fetchTimeout(url, {
      method: 'PATCH',
      headers: { ...headers(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'erro',
        tentativas,
        proxima_em: proximaEm,
        ultimo_erro: erroTruncado.slice(0, 500),
      }),
    });
  } catch (e) {
    throw new Error(`[outbox-repo] falha de rede ao marcarErro id=${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[outbox-repo] HTTP ${res.status} ao marcarErro id=${id}`);
  }
}

// ===== Fase B, Phase 19 Plano 06 — head-of-line + DLQ por-linha (ESCRITA-03,
// design §3.2/Riscos R6) =====
//
// Um `criar_task` que falha para sempre (task deletada, lista movida, payload
// rejeitado) bloqueava indefinidamente TODO `set_campo`/`set_status`/`fechar`
// posterior daquele aggregate (o `clickup_task_id` nunca resolve) — o espelho
// ClickUp apodrecia SEM SINAL. As funções abaixo dão o alarme (idade da
// cabeça) e o escape de operador (orphan) para esse cenário, mais a DLQ
// por-linha das ops não-bloqueantes (`comentar`/`anexar`).

/** Uma cabeça de aggregate presa no outbox (a linha pendente/erro mais antiga daquele aggregate). */
export interface CabecaOutbox {
  aggregate: string;
  aggregate_id: number;
  idade_ms: number;
}

/**
 * A CABEÇA (linha `pendente`/`erro` mais antiga) de CADA aggregate no
 * outbox, com sua idade em ms — consumido por `alertas.ts::avaliarThresholdsOutbox`
 * (monitor de idade da cabeça, `ix_outbox_head_age`, R6). Lê TODAS as linhas
 * pendentes/erro ordenadas por `criado_em` ascendente e reduz por
 * `(aggregate, aggregate_id)`: como a lista inteira já vem ordenada, a
 * PRIMEIRA ocorrência de cada par é, por definição, a mais antiga daquele
 * grupo — não precisa de agregação no banco (PostgREST não tem GROUP BY na
 * REST v1). LANÇA em config ausente/erro de rede/HTTP (WR-03).
 */
export async function cabecaMaisAntiga(): Promise<CabecaOutbox[]> {
  checarConfig();
  const url =
    `${SUPABASE_REST_URL}/${SUPABASE_TABLE_CLICKUP_OUTBOX}` +
    `?status=in.(pendente,erro)&select=aggregate,aggregate_id,criado_em&order=criado_em.asc`;
  let res: Response;
  try {
    res = await fetchTimeout(url, { headers: headers() });
  } catch (e) {
    throw new Error(
      `[outbox-repo] falha de rede ao ler cabecaMaisAntiga: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[outbox-repo] HTTP ${res.status} ao ler cabecaMaisAntiga`);
  }
  const linhas = (await res.json()) as Array<{ aggregate: string; aggregate_id: number; criado_em: string }>;
  const agora = Date.now();
  const vistos = new Set<string>();
  const cabecas: CabecaOutbox[] = [];
  for (const linha of linhas) {
    const chave = `${linha.aggregate}:${linha.aggregate_id}`;
    if (vistos.has(chave)) continue; // a lista vem ordenada por criado_em asc — a 1a ocorrencia JA e a mais antiga do grupo
    vistos.add(chave);
    cabecas.push({
      aggregate: linha.aggregate,
      aggregate_id: linha.aggregate_id,
      idade_ms: agora - new Date(linha.criado_em).getTime(),
    });
  }
  return cabecas;
}

/**
 * AÇÃO DE OPERADOR (R6/SC4) — descarta as ops PRESAS (`pendente`/`erro`) de
 * um aggregate: viram `status='orphan'`, nunca mais retentadas. O Supabase
 * segue como SoT; o espelho ClickUp fica reconhecidamente incompleto para
 * aquele item (é isso ou o aggregate travado para sempre bloqueando as ops
 * seguintes). Invocada pelo CLI `scripts/outbox-orphan.mjs` — nunca
 * automática. Retorna quantas linhas foram descartadas (0 = nada preso).
 * LANÇA em config ausente/erro de rede/HTTP (WR-03).
 */
export async function marcarOrphan(aggregate: string, aggregateId: number): Promise<number> {
  checarConfig();
  const url =
    `${SUPABASE_REST_URL}/${SUPABASE_TABLE_CLICKUP_OUTBOX}` +
    `?aggregate=eq.${encodeURIComponent(aggregate)}&aggregate_id=eq.${aggregateId}&status=in.(pendente,erro)`;
  let res: Response;
  try {
    res = await fetchTimeout(url, {
      method: 'PATCH',
      headers: { ...headers(), Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'orphan' }),
    });
  } catch (e) {
    throw new Error(
      `[outbox-repo] falha de rede ao marcarOrphan (aggregate=${aggregate}, aggregateId=${aggregateId}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[outbox-repo] HTTP ${res.status} ao marcarOrphan (aggregate=${aggregate}, aggregateId=${aggregateId})`);
  }
  const linhas = (await res.json()) as unknown[];
  return Array.isArray(linhas) ? linhas.length : 0;
}

/**
 * DLQ por-linha (R6) — marca a linha `id` como `dlq` com o erro truncado
 * (sem PII, mesmo contrato de `marcarErro`). Usada pelo worker de dreno
 * (`drenar-outbox.ts`) SÓ para ops NÃO-bloqueantes (`bloqueante=false`,
 * `comentar`/`anexar`) que falharam: a linha some da lista de pendentes sem
 * travar o `seq` das ops bloqueantes daquele aggregate. LANÇA em config
 * ausente/erro de rede/HTTP (WR-03) — o caller decide como reagir a essa
 * falha secundária.
 */
export async function marcarDlqLinha(id: number, erroTruncado: string): Promise<void> {
  checarConfig();
  const url = `${SUPABASE_REST_URL}/${SUPABASE_TABLE_CLICKUP_OUTBOX}?id=eq.${id}`;
  let res: Response;
  try {
    res = await fetchTimeout(url, {
      method: 'PATCH',
      headers: { ...headers(), Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'dlq', ultimo_erro: erroTruncado.slice(0, 500) }),
    });
  } catch (e) {
    throw new Error(`[outbox-repo] falha de rede ao marcarDlqLinha id=${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[outbox-repo] HTTP ${res.status} ao marcarDlqLinha id=${id}`);
  }
}

/**
 * Contagem total de linhas `pendente`/`erro` no outbox — a métrica de
 * PROFUNDIDADE consumida por `alertas.ts::avaliarThresholdsOutbox`. Usa
 * `Prefer: count=exact` + `Range: 0-0` (PostgREST devolve o total em
 * `Content-Range`, sem baixar as linhas) — mesmo padrão leve de
 * `profundidadeFila` (fila.ts). LANÇA em config ausente/erro de rede/HTTP ou
 * `Content-Range` ausente (WR-03) — nunca finge profundidade zero em erro.
 */
export async function profundidadeOutbox(): Promise<number> {
  checarConfig();
  const url = `${SUPABASE_REST_URL}/${SUPABASE_TABLE_CLICKUP_OUTBOX}?status=in.(pendente,erro)&select=id`;
  let res: Response;
  try {
    res = await fetchTimeout(url, {
      headers: { ...headers(), Prefer: 'count=exact', Range: '0-0' },
    });
  } catch (e) {
    throw new Error(
      `[outbox-repo] falha de rede ao ler profundidadeOutbox: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[outbox-repo] HTTP ${res.status} ao ler profundidadeOutbox`);
  }
  const contentRange = res.headers.get('content-range'); // formato "0-0/123"
  const total = contentRange?.split('/')[1];
  if (!total || total === '*') {
    throw new Error('[outbox-repo] profundidadeOutbox: Content-Range ausente/indeterminado na resposta do PostgREST');
  }
  return Number(total);
}
