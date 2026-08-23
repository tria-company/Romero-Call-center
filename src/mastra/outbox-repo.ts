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
  SUPABASE_TABLE_AUDIOS_ENVIOS,
} from './config.ts';
import { fetchTimeout } from './http.ts';

// ===== Fase C, Phase 20 Plano 02 — generalização multi-agregado =====
//
// Só 'ligacao' e 'audio' têm `criar_task`+back-fill (a task-alvo AINDA NÃO
// existe, o dreno cria e persiste o `clickup_task_id` de volta). 'lead' e
// 'nota' NUNCA criam task nova — a lead/ligação já existe no ClickUp, o alvo
// vem de `payload.clickup_task_id` (drenar-outbox.ts resolve isso, não este
// módulo). `TABELA_DO_AGREGADO` é privado — só os dois agregados com
// back-fill entram aqui; qualquer outro aggregate passado a
// `resolverClickupTaskId`/`backfillClickupTaskId` LANÇA.
const TABELA_DO_AGREGADO: Record<string, string> = {
  ligacao: SUPABASE_TABLE_LIGACOES,
  audio: SUPABASE_TABLE_AUDIOS_ENVIOS,
};

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
 * `criar_task` grava aqui; ops seguintes leem daqui). Suporta `'ligacao'`
 * e `'audio'` (Fase C, Phase 20 Plano 02) — os únicos dois agregates com
 * `criar_task`+back-fill. `'lead'`/`'nota'` NUNCA resolvem por tabela — a
 * task-alvo delas já existe e vem de `payload.clickup_task_id`
 * (drenar-outbox.ts); chamar isto para esses dois LANÇA (nunca finge
 * resolver). `null` é resultado LEGÍTIMO ("ainda não criada"), distinto de
 * erro (WR-03).
 */
export async function resolverClickupTaskId(aggregate: string, aggregateId: number): Promise<string | null> {
  checarConfig();
  const tabela = TABELA_DO_AGREGADO[aggregate];
  if (!tabela) {
    throw new Error(
      `[outbox-repo] resolverClickupTaskId: aggregate '${aggregate}' não resolve por tabela — a task-alvo vem do payload (clickup_task_id já existente)`,
    );
  }
  const url = `${SUPABASE_REST_URL}/${tabela}?id=eq.${aggregateId}&select=clickup_task_id`;
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
 * Grava o `clickup_task_id` resolvido pelo `criar_task` na linha da tabela
 * do aggregate (`'ligacao'`→`ligacoes`, `'audio'`→`audios_envios`, Fase C
 * Phase 20 Plano 02) — SÓ quando ainda `null` (`&clickup_task_id=is.null` no
 * filtro): nunca sobrescreve um id já gravado (idempotência do back-fill,
 * reprocesso do mesmo `criar_task` não troca o id existente). LANÇA em
 * aggregate sem tabela de back-fill (`'lead'`/`'nota'`) ou em config
 * ausente/erro de rede/HTTP (WR-03).
 */
export async function backfillClickupTaskId(aggregate: string, aggregateId: number, taskId: string): Promise<void> {
  checarConfig();
  const tabela = TABELA_DO_AGREGADO[aggregate];
  if (!tabela) {
    throw new Error(`[outbox-repo] backfillClickupTaskId: aggregate '${aggregate}' não tem tabela de back-fill`);
  }
  const url = `${SUPABASE_REST_URL}/${tabela}?id=eq.${aggregateId}&clickup_task_id=is.null`;
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
 * WR-A (19-13, 19-REVIEW-2.md) — CLAIM por compare-and-set: reivindica a linha
 * `id` movendo `status` de `pendente`/`erro` para `enviando` ATOMICAMENTE (o
 * filtro `status=in.(pendente,erro)` no PATCH é o CAS — o PostgREST só troca a
 * linha se ela ainda estiver nesse conjunto). Retorna a linha reivindicada
 * (`return=representation`) ou `null` se OUTRA passada/réplica já a tirou de
 * `pendente`/`erro` (0 linhas afetadas). O dreno reivindica a linha de
 * `criar_task` ANTES de `criarTask`: se o processo morre entre `criarTask` e o
 * back-fill do id, a linha fica `enviando` (não volta a `pendente`) — a
 * re-execução NÃO a vê em `proximasPendentes` (que lê só `pendente`/`erro`) e
 * portanto NUNCA re-cria a task (fecha a janela residual de duplicata). LANÇA
 * em config ausente/erro de rede/HTTP (WR-03). NUNCA loga payload.
 */
export async function claimLinha(id: number): Promise<LinhaOutbox | null> {
  checarConfig();
  const url = `${SUPABASE_REST_URL}/${SUPABASE_TABLE_CLICKUP_OUTBOX}?id=eq.${id}&status=in.(pendente,erro)`;
  let res: Response;
  try {
    res = await fetchTimeout(url, {
      method: 'PATCH',
      headers: { ...headers(), Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'enviando' }),
    });
  } catch (e) {
    throw new Error(`[outbox-repo] falha de rede ao claimLinha id=${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[outbox-repo] HTTP ${res.status} ao claimLinha id=${id}`);
  }
  const linhas = (await res.json()) as LinhaOutbox[];
  return Array.isArray(linhas) && linhas.length > 0 ? linhas[0] : null;
}

/**
 * WR-A (19-13) — LIBERA o claim: devolve a linha `id` de `enviando` para
 * `pendente` (CAS por `status=eq.enviando`). Usada pelo dreno SÓ quando
 * `criarTask` FALHA (lança) DENTRO do mesmo processo (sem crash) — a task NÃO
 * foi criada no ClickUp, então re-abrir a linha para retry é seguro e preserva
 * a semântica de retry pré-WR-A (a linha continua `pendente`, o BullMQ/inline
 * re-tenta). Um CRASH de verdade não chega aqui — a linha fica `enviando` e é
 * reconciliada como órfã na próxima passada (`marcarOrphanEnviando`). LANÇA em
 * config ausente/erro de rede/HTTP (WR-03).
 */
export async function liberarLinha(id: number): Promise<void> {
  checarConfig();
  const url = `${SUPABASE_REST_URL}/${SUPABASE_TABLE_CLICKUP_OUTBOX}?id=eq.${id}&status=eq.enviando`;
  let res: Response;
  try {
    res = await fetchTimeout(url, {
      method: 'PATCH',
      headers: { ...headers(), Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'pendente' }),
    });
  } catch (e) {
    throw new Error(`[outbox-repo] falha de rede ao liberarLinha id=${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[outbox-repo] HTTP ${res.status} ao liberarLinha id=${id}`);
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
 * WR-A (19-13) — linhas de `criar_task` PRESAS em `enviando` de UM
 * `(aggregate, aggregateId)`. Uma linha aqui significa que o dreno
 * reivindicou a linha (claim, `pendente`→`enviando`) e MORREU antes do
 * back-fill do `clickup_task_id` (crash na janela `criarTask`→
 * `backfillClickupTaskId`). `proximasPendentes` NÃO as devolve (lê só
 * `pendente`/`erro`), então esta leitura é o único jeito de o dreno
 * detectá-las e roteá-las para reconciliação — NUNCA re-criar. O `aggregate`
 * passado por PARÂMETRO (Fase C, Phase 20 Plano 02 — antes hardcoded
 * `'ligacao'`) protege contra colisão numérica de `aggregate_id` entre
 * tabelas (`ligacoes.id` vs `audios_envios.id` são sequências
 * INDEPENDENTES). LANÇA em config ausente/erro de rede/HTTP (WR-03).
 */
export async function linhasPresasEnviando(aggregate: string, aggregateId: number): Promise<LinhaOutbox[]> {
  checarConfig();
  const url =
    `${SUPABASE_REST_URL}/${SUPABASE_TABLE_CLICKUP_OUTBOX}` +
    `?aggregate=eq.${encodeURIComponent(aggregate)}&aggregate_id=eq.${aggregateId}&op=eq.criar_task&status=eq.enviando&order=seq.asc`;
  let res: Response;
  try {
    res = await fetchTimeout(url, { headers: headers() });
  } catch (e) {
    throw new Error(
      `[outbox-repo] falha de rede ao ler linhasPresasEnviando (aggregateId=${aggregateId}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[outbox-repo] HTTP ${res.status} ao ler linhasPresasEnviando (aggregateId=${aggregateId})`);
  }
  return (await res.json()) as LinhaOutbox[];
}

/**
 * WR-A (19-13) — reconciliação: converte as linhas `criar_task` presas em
 * `enviando` de UM `(aggregate, aggregateId)` em `orphan` (CAS por
 * `status=eq.enviando`). Chamada pelo dreno quando detecta um crash na
 * janela `criarTask`→back-fill SEM `clickup_task_id` resolvido: a task PODE
 * ter sido criada no ClickUp mas ficou descorrelacionada — a linha vira um
 * ÓRFÃO DETECTÁVEL (reconciliável pelo scanner/alerta do 19-06), NUNCA uma
 * DUPLICATA. Converge com o mesmo estado terminal de `marcarOrphan` (a ação
 * de operador do 19-06), mas partindo de `enviando` (aquela parte de
 * `pendente`/`erro`). `aggregate` por PARÂMETRO (Fase C, Phase 20 Plano 02 —
 * antes hardcoded `'ligacao'`), mesmo racional de `linhasPresasEnviando`.
 * Retorna quantas linhas foram convertidas. LANÇA em config ausente/erro de
 * rede/HTTP (WR-03).
 */
export async function marcarOrphanEnviando(aggregate: string, aggregateId: number): Promise<number> {
  checarConfig();
  const url =
    `${SUPABASE_REST_URL}/${SUPABASE_TABLE_CLICKUP_OUTBOX}` +
    `?aggregate=eq.${encodeURIComponent(aggregate)}&aggregate_id=eq.${aggregateId}&op=eq.criar_task&status=eq.enviando`;
  let res: Response;
  try {
    res = await fetchTimeout(url, {
      method: 'PATCH',
      headers: { ...headers(), Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'orphan' }),
    });
  } catch (e) {
    throw new Error(
      `[outbox-repo] falha de rede ao marcarOrphanEnviando (aggregateId=${aggregateId}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[outbox-repo] HTTP ${res.status} ao marcarOrphanEnviando (aggregateId=${aggregateId})`);
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
