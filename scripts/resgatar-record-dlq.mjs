#!/usr/bin/env node
// scripts/resgatar-record-dlq.mjs
//
// Utilitário OPERACIONAL (bate em serviços reais — rodar à mão com env, molde
// de scripts/CONTEXT.md) — o passo final da Fase 19.1 (DUR-07): resgata as 18
// transcrições presas em jobs `record` na DLQ de prod (13–21/08/2026), cujas
// gravações AINDA EXISTEM no storage da Wavoip (HTTP 200 verificado em
// 22/08 — ver 19.1-CONTEXT.md).
//
// NOTA: com o re-drive automático (`src/mastra/redrive-dlq.ts`, plano 19.1-05)
// no ar, os `record` TRANSITÓRIOS já são re-drivados sozinhos, periodicamente,
// rate-spaced. Este script é o gatilho/rede-de-segurança ALVO das 18 — com
// filtro (--ids/--desde/--ate) e --dry-run para o operador conduzir com
// controle, em vez de esperar a próxima varredura automática (ou confirmar
// que ela já resolveu tudo).
//
// Fluxo por job `record` da DLQ:
//   1. Confirma que a gravação ainda existe: HEAD na `recordUrl` do
//      `job.data` → HTTP 200. Reporta SÓ host+status (nunca a URL completa,
//      que pode ter assinatura, nem o telefone do job.data — LGPD).
//   2. Se a gravação sumiu (HEAD != 200): PULA e reporta (não força retry às
//      cegas — o worker rewired do plano 19.1-03 falharia de novo e o
//      operador já sabe, pela contagem, que aquele job precisa de decisão
//      humana em separado).
//   3. Se a gravação está viva: `job.retry()` — move o job de volta pra fila,
//      o worker endurecido (planos 03/04) baixa pra NOSSA cópia e transcreve
//      dali. Serializado com espaçamento `DLQ_REDRIVE_ESPACO_MS` entre cada
//      retry — não estoura o balde de ~90/min do ClickUp (o re-drive manual
//      de 22/08 foi uma rajada de 25 jobs seguidos e disparou fail-opens).
//
// Idempotente: re-rodar não duplica trabalho. `job.retry()` num job que já
// saiu do set `failed` (re-drivado por este mesmo script numa execução
// anterior, OU pelo re-drive automático do plano 05, OU por um humano) LANÇA
// do lado do BullMQ — capturado e contado como no-op, nunca tratado como
// falha fatal do script.
//
// --dry-run: só lista/confirma gravação, nunca chama job.retry().
// --ids id1,id2,...: alvo explícito (subconjunto dos 18) por job.id.
// --desde/--ate AAAA-MM-DD: janela de data (job.timestamp, UTC) — ex. a
//   janela do incidente é --desde 2026-08-13 --ate 2026-08-21.
//
// Uso:
//   node --env-file=.env --experimental-strip-types scripts/resgatar-record-dlq.mjs --dry-run
//   node --env-file=.env --experimental-strip-types scripts/resgatar-record-dlq.mjs \
//     --desde 2026-08-13 --ate 2026-08-21
//
// LGPD: NUNCA imprime telefone (`job.data.telefone`) nem a `recordUrl`
// completa (pode ter assinatura) — só host/status/contagens/ids de job.

import { Queue } from 'bullmq';

import { NOME_FILA, conexaoFila, modoFila } from '../src/mastra/fila.ts';
import { DLQ_REDRIVE_ESPACO_MS } from '../src/mastra/config.ts';
import { fetchTimeout } from '../src/mastra/http.ts';

/** Tamanho da página de leitura do set `failed` (BullMQ getFailed, índice inclusivo estilo ZRANGE) — o set tem outros job.name além de 'record', paginamos até esgotar. */
const PAGINA_FAILED = 500;

const fetchPadrao = (url, options) => fetchTimeout(url, options ?? {});

/** Host da URL para log seguro — nunca a URL completa (pode ter assinatura, LGPD). Mesmo padrão de gravacao-store.ts/redrive-dlq.ts. */
function hostSeguro(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalido';
  }
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parser de flags — mesmo molde de gerar-lote.mjs/reprocessar-eventos.mjs (process.argv, sem dependência externa). */
export function parseArgs(argv) {
  const opts = { dryRun: false, ids: null, desde: null, ate: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--ids') {
      const valor = String(argv[++i] || '');
      opts.ids = new Set(valor.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg === '--desde') {
      const data = new Date(`${argv[++i]}T00:00:00.000Z`);
      opts.desde = Number.isNaN(data.getTime()) ? null : data.getTime();
    } else if (arg === '--ate') {
      const data = new Date(`${argv[++i]}T23:59:59.999Z`);
      opts.ate = Number.isNaN(data.getTime()) ? null : data.getTime();
    }
  }
  return opts;
}

/** Filtra só jobs `record`, opcionalmente por lista de ids e/ou janela de data (job.timestamp, ms epoch) — PURO, testável isolado. */
export function filtrarRecords(jobs, { ids = null, desde = null, ate = null } = {}) {
  return (jobs || []).filter((job) => {
    if (!job || job.name !== 'record') return false;
    if (ids && ids.size > 0 && !ids.has(String(job.id))) return false;
    const timestamp = job.timestamp ?? job.finishedOn ?? 0;
    if (desde !== null && timestamp < desde) return false;
    if (ate !== null && timestamp > ate) return false;
    return true;
  });
}

/** Lê TODO o set `failed` (paginado) — a DLQ pode ter outros job.name além de 'record', então lemos tudo antes de filtrar. */
async function lerTodosFailed(fila, paginaTamanho = PAGINA_FAILED) {
  const todos = [];
  let offset = 0;
  for (;;) {
    const pagina = await fila.getFailed(offset, offset + paginaTamanho - 1);
    if (!pagina || pagina.length === 0) break;
    todos.push(...pagina);
    if (pagina.length < paginaTamanho) break;
    offset += paginaTamanho;
  }
  return todos;
}

/**
 * Confirma se a gravação ainda existe: HEAD na recordUrl → HTTP 200. Nunca
 * loga/retorna a URL completa (LGPD) — só host+status, para o caller
 * reportar sem PII.
 */
export async function confirmarGravacaoViva(recordUrl, fetchImpl = fetchPadrao) {
  const host = hostSeguro(recordUrl);
  if (!recordUrl) return { viva: false, status: undefined, host: 'sem-url' };
  try {
    const res = await fetchImpl(recordUrl, { method: 'HEAD' });
    return { viva: res.status === 200, status: res.status, host };
  } catch {
    return { viva: false, status: undefined, host };
  }
}

/**
 * Orquestração principal — seam injetável (`fila`/`fetchImpl`) para o smoke
 * offline exercitar a lógica real sem Redis/rede. Em produção, `main()`
 * chama com a Queue BullMQ real e `fetchTimeout`.
 */
export async function resgatarRecordDLQ({
  fila,
  fetchImpl = fetchPadrao,
  dryRun = false,
  ids = null,
  desde = null,
  ate = null,
  espacoMs = DLQ_REDRIVE_ESPACO_MS,
  logger = console,
} = {}) {
  const resultado = {
    totalRecord: 0,
    comGravacaoViva: 0,
    semGravacao: 0,
    redrivados: 0,
    jaRedrivadoOuNoOp: 0,
  };

  const todosFailed = await lerTodosFailed(fila);
  const alvos = filtrarRecords(todosFailed, { ids, desde, ate });
  resultado.totalRecord = alvos.length;

  logger.log(`[resgatar-record-dlq] ${alvos.length} job(s) 'record' encontrados na DLQ (apos filtro)`);

  for (const job of alvos) {
    const recordUrl = String(job.data?.recordUrl || '');
    const check = await confirmarGravacaoViva(recordUrl, fetchImpl);

    if (!check.viva) {
      resultado.semGravacao++;
      logger.warn(
        `[resgatar-record-dlq] job=record id=${job.id ?? 'n/a'} host=${check.host} status=${check.status ?? 'erro'} gravacao=morta -> PULADO`,
      );
      continue;
    }
    resultado.comGravacaoViva++;

    if (dryRun) {
      logger.log(
        `[resgatar-record-dlq] job=record id=${job.id ?? 'n/a'} host=${check.host} status=${check.status} gravacao=viva -> (dry-run, nao re-drivado)`,
      );
      continue;
    }

    try {
      await job.retry();
      resultado.redrivados++;
      logger.log(
        `[resgatar-record-dlq] job=record id=${job.id ?? 'n/a'} host=${check.host} status=${check.status} gravacao=viva -> REDRIVADO`,
      );
      // Rate-spacing: serializa o re-drive p/ nao estourar o balde do ClickUp
      // (aconteceu no re-drive manual de 22/08, rajada de 25 jobs seguidos).
      await esperar(espacoMs);
    } catch (e) {
      // Idempotente: job ja nao esta mais em `failed` (re-drivado por este
      // mesmo script numa execucao anterior, pelo re-drive automatico do
      // plano 05, ou por um humano) -> no-op, NAO e falha fatal.
      resultado.jaRedrivadoOuNoOp++;
      logger.warn(
        `[resgatar-record-dlq] job=record id=${job.id ?? 'n/a'} retry no-op (provavelmente ja re-drivado): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return resultado;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (modoFila() !== 'bullmq') {
    console.error(
      '[resgatar-record-dlq] REDIS_URL ausente — sem fila BullMQ (modo inline nao tem DLQ pra resgatar)',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[resgatar-record-dlq] iniciando: dry-run=${opts.dryRun}` +
      (opts.ids ? ` ids=${opts.ids.size}` : '') +
      (opts.desde !== null ? ` desde=${new Date(opts.desde).toISOString().slice(0, 10)}` : '') +
      (opts.ate !== null ? ` ate=${new Date(opts.ate).toISOString().slice(0, 10)}` : ''),
  );

  const fila = new Queue(NOME_FILA, { connection: conexaoFila() });
  fila.on('error', (e) => {
    console.error('[resgatar-record-dlq] erro de conexao Redis:', e instanceof Error ? e.message : String(e));
  });

  try {
    const resultado = await resgatarRecordDLQ({
      fila,
      dryRun: opts.dryRun,
      ids: opts.ids,
      desde: opts.desde,
      ate: opts.ate,
    });
    console.log(
      `[resgatar-record-dlq] RESUMO: total-record=${resultado.totalRecord} ` +
        `com-gravacao-viva=${resultado.comGravacaoViva} sem-gravacao=${resultado.semGravacao} ` +
        `redrivados=${resultado.redrivados} ja-redrivado-noop=${resultado.jaRedrivadoOuNoOp}` +
        (opts.dryRun ? ' (dry-run — nenhum job foi re-drivado de fato)' : ''),
    );
  } finally {
    await fila.close();
  }
}

const chamadoDiretamente = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (chamadoDiretamente) {
  main().catch((e) => {
    console.error('[resgatar-record-dlq] falha fatal:', e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
