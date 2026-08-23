#!/usr/bin/env node
// scripts/resgatar-record-dlq.smoke.mjs
//
// Smoke determinístico (offline, sem Redis, sem rede real) do utilitário de
// resgate alvo dos `record` presos na DLQ (`scripts/resgatar-record-dlq.mjs`,
// Fase 19.1 Plano 07, DUR-07). Injeta um fake de Queue (`getFailed`/
// `job.retry`) e um `fetchImpl` fake (HEAD) — mesmo espírito de
// `redrive-dlq.smoke.mjs`/`gravacao-store.smoke.mjs`. Prova:
//   1. Filtra SÓ jobs `record` (ignora sync-clickup/falha-terminal na DLQ).
//   2. Respeita --dry-run (parseArgs) e resgatarRecordDLQ({dryRun:true}) —
//      confirma a gravação mas NUNCA chama job.retry().
//   3. Espaça os re-adds (DLQ_REDRIVE_ESPACO_MS) entre cada job.retry() real.
//   4. Pula job cuja gravação não existe mais (HEAD != 200), reportando em
//      `semGravacao` — sem chamar job.retry().
//   5. Idempotente: job.retry() que lança (job já fora do `failed`) conta
//      como no-op, não derruba a varredura nem falha o smoke.
//   6. Filtros --ids / --desde--ate (parseArgs + filtrarRecords) funcionam.
//   7. LGPD: nenhuma linha de log carrega telefone ou a recordUrl completa —
//      só host.
//
// Env de teste ANTES do import (config.ts lê process.env na carga do módulo,
// mesmo padrão de redrive-dlq.smoke.mjs).
//
// Uso: node --experimental-strip-types scripts/resgatar-record-dlq.smoke.mjs

process.env.DLQ_REDRIVE_ESPACO_MS ||= '15';

const { resgatarRecordDLQ, filtrarRecords, confirmarGravacaoViva, parseArgs } = await import(
  '../scripts/resgatar-record-dlq.mjs'
);
const { DLQ_REDRIVE_ESPACO_MS } = await import('../src/mastra/config.ts');

const falhas = [];
function checar(condicao, mensagem) {
  if (condicao) {
    console.log('  ✅', mensagem);
  } else {
    console.error('  ❌', mensagem);
    falhas.push(mensagem);
  }
}

/** Job fake de fila 'failed' — subset relevante (id/name/data/timestamp/retry). */
function criarJobFake({ id, name = 'record', recordUrl = 'https://storage.wavoip.com/rec/abc.mp3', telefone = '+5511999998888', timestamp = Date.now(), falharAoRetentar = false }) {
  return {
    id,
    name,
    data: { whatsappCallId: id, telefone, recordUrl, payload: {}, eventoDuravelId: null },
    timestamp,
    chamadasRetry: 0,
    async retry() {
      if (falharAoRetentar) {
        throw new Error("Couldn't retry job: job is not in a failed state");
      }
      this.chamadasRetry++;
    },
  };
}

/** Fake de Queue (getFailed(start,end) fatia em memória, índice inclusivo estilo ZRANGE). */
function criarFilaFake(jobs) {
  return {
    jobs,
    async getFailed(start, end) {
      return jobs.slice(start, end + 1);
    },
  };
}

/** Fake de fetchImpl — HEAD por URL, mapa url->status (default 200 = viva). */
function criarFetchFake(statusPorUrl = {}) {
  const chamadas = [];
  const fetchFake = async (url, options) => {
    chamadas.push({ url, method: options?.method });
    const status = statusPorUrl[url] ?? 200;
    return { status, ok: status >= 200 && status < 300 };
  };
  fetchFake.chamadas = chamadas;
  return fetchFake;
}

/** Captura console.log/warn/error durante fn — pra inspecionar saída sem PII e as decisões tomadas. */
async function capturarConsole(fn) {
  const originais = { log: console.log, warn: console.warn, error: console.error };
  const linhas = [];
  console.log = (...args) => linhas.push(args.map(String).join(' '));
  console.warn = (...args) => linhas.push(args.map(String).join(' '));
  console.error = (...args) => linhas.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, originais);
  }
  return linhas;
}

async function testeFiltraSoRecord() {
  const jobs = [
    criarJobFake({ id: 'rec-1' }),
    { id: 'sync-1', name: 'sync-clickup', data: {}, timestamp: Date.now() },
    { id: 'falha-1', name: 'falha-terminal', data: {}, timestamp: Date.now() },
    criarJobFake({ id: 'rec-2' }),
  ];

  const filtrados = filtrarRecords(jobs);
  checar(filtrados.length === 2, `filtrarRecords deveria manter so os 2 'record', recebido: ${filtrados.length}`);
  checar(
    filtrados.every((j) => j.name === 'record'),
    'filtrarRecords nao deveria deixar passar nenhum job.name != record',
  );

  const fila = criarFilaFake(jobs);
  const fetchFake = criarFetchFake();
  const resultado = await resgatarRecordDLQ({ fila, fetchImpl: fetchFake, dryRun: true, logger: { log() {}, warn() {}, error() {} } });
  checar(resultado.totalRecord === 2, `resgatarRecordDLQ deveria contar totalRecord=2 (ignorando sync/falha-terminal), recebido: ${resultado.totalRecord}`);
}

async function testeDryRunNaoRedriva() {
  const jobs = [criarJobFake({ id: 'rec-dry-1' }), criarJobFake({ id: 'rec-dry-2' })];
  const fila = criarFilaFake(jobs);
  const fetchFake = criarFetchFake();

  const resultado = await resgatarRecordDLQ({ fila, fetchImpl: fetchFake, dryRun: true, logger: { log() {}, warn() {}, error() {} } });

  checar(resultado.comGravacaoViva === 2, `dry-run deveria confirmar gravacao viva=2, recebido: ${resultado.comGravacaoViva}`);
  checar(resultado.redrivados === 0, `dry-run NUNCA deveria re-drivar, recebido redrivados=${resultado.redrivados}`);
  checar(jobs.every((j) => j.chamadasRetry === 0), 'dry-run NUNCA deveria chamar job.retry() em nenhum job');
}

async function testeEspacamentoEntreRedrives() {
  const jobs = [criarJobFake({ id: 'rec-espaco-1' }), criarJobFake({ id: 'rec-espaco-2' })];
  const fila = criarFilaFake(jobs);
  const fetchFake = criarFetchFake();

  const inicio = Date.now();
  const resultado = await resgatarRecordDLQ({ fila, fetchImpl: fetchFake, dryRun: false, logger: { log() {}, warn() {}, error() {} } });
  const duracao = Date.now() - inicio;

  checar(resultado.redrivados === 2, `2 jobs com gravacao viva deveriam ser redrivados, recebido: ${resultado.redrivados}`);
  checar(jobs.every((j) => j.chamadasRetry === 1), 'cada job deveria ter job.retry() chamado exatamente 1x');
  checar(
    duracao >= DLQ_REDRIVE_ESPACO_MS - 5,
    `2 redrives deveriam levar >= ${DLQ_REDRIVE_ESPACO_MS}ms (rate-spacing serializado), recebido: ${duracao}ms`,
  );
}

async function testePulaGravacaoMorta() {
  const jobVivo = criarJobFake({ id: 'rec-viva-1', recordUrl: 'https://storage.wavoip.com/rec/viva.mp3' });
  const jobMorto = criarJobFake({ id: 'rec-morta-1', recordUrl: 'https://storage.wavoip.com/rec/morta.mp3' });
  const fila = criarFilaFake([jobVivo, jobMorto]);
  const fetchFake = criarFetchFake({ 'https://storage.wavoip.com/rec/morta.mp3': 404 });

  const resultado = await resgatarRecordDLQ({ fila, fetchImpl: fetchFake, dryRun: false, logger: { log() {}, warn() {}, error() {} } });

  checar(resultado.semGravacao === 1, `job com HEAD!=200 deveria contar em semGravacao=1, recebido: ${resultado.semGravacao}`);
  checar(resultado.redrivados === 1, `so o job vivo deveria ser redrivado, recebido redrivados=${resultado.redrivados}`);
  checar(jobMorto.chamadasRetry === 0, 'job com gravacao morta NUNCA deveria ter job.retry() chamado');
  checar(jobVivo.chamadasRetry === 1, 'job com gravacao viva deveria ter job.retry() chamado 1x');
}

async function testeIdempotenteRetryNoOp() {
  const jobJaRedrivado = criarJobFake({ id: 'rec-noop-1', falharAoRetentar: true });
  const fila = criarFilaFake([jobJaRedrivado]);
  const fetchFake = criarFetchFake();

  let resultado;
  let lancou = false;
  try {
    resultado = await resgatarRecordDLQ({ fila, fetchImpl: fetchFake, dryRun: false, logger: { log() {}, warn() {}, error() {} } });
  } catch {
    lancou = true;
  }

  checar(!lancou, 'job.retry() lancando (ja fora do failed) NAO deveria derrubar a varredura');
  checar(resultado?.jaRedrivadoOuNoOp === 1, `deveria contar jaRedrivadoOuNoOp=1, recebido: ${resultado?.jaRedrivadoOuNoOp}`);
  checar(resultado?.redrivados === 0, `nao deveria contar como redrivado de fato, recebido redrivados=${resultado?.redrivados}`);
}

async function testeFiltrosIdsEDatas() {
  const t13 = new Date('2026-08-13T10:00:00.000Z').getTime();
  const t20 = new Date('2026-08-20T10:00:00.000Z').getTime();
  const t22 = new Date('2026-08-22T10:00:00.000Z').getTime(); // fora da janela do incidente (13-21/08)

  const jobs = [
    criarJobFake({ id: 'rec-a', timestamp: t13 }),
    criarJobFake({ id: 'rec-b', timestamp: t20 }),
    criarJobFake({ id: 'rec-c', timestamp: t22 }),
  ];

  const filtradosPorData = filtrarRecords(jobs, {
    desde: new Date('2026-08-13T00:00:00.000Z').getTime(),
    ate: new Date('2026-08-21T23:59:59.999Z').getTime(),
  });
  checar(
    filtradosPorData.length === 2 && filtradosPorData.every((j) => j.id !== 'rec-c'),
    `janela de data deveria manter so rec-a/rec-b (fora rec-c de 22/08), recebido: ${filtradosPorData.map((j) => j.id).join(',')}`,
  );

  const filtradosPorId = filtrarRecords(jobs, { ids: new Set(['rec-b']) });
  checar(
    filtradosPorId.length === 1 && filtradosPorId[0].id === 'rec-b',
    `--ids deveria restringir a exatamente rec-b, recebido: ${filtradosPorId.map((j) => j.id).join(',')}`,
  );

  const argsParseados = parseArgs(['--dry-run', '--ids', 'rec-a,rec-b', '--desde', '2026-08-13', '--ate', '2026-08-21']);
  checar(argsParseados.dryRun === true, 'parseArgs deveria reconhecer --dry-run');
  checar(
    argsParseados.ids?.size === 2 && argsParseados.ids.has('rec-a') && argsParseados.ids.has('rec-b'),
    `parseArgs deveria montar o Set de ids a partir de --ids, recebido: ${[...(argsParseados.ids ?? [])].join(',')}`,
  );
  checar(
    argsParseados.desde === new Date('2026-08-13T00:00:00.000Z').getTime(),
    'parseArgs --desde deveria virar inicio do dia UTC em ms',
  );
  checar(
    argsParseados.ate === new Date('2026-08-21T23:59:59.999Z').getTime(),
    'parseArgs --ate deveria virar fim do dia UTC em ms',
  );
}

async function testeSemPiiNosLogs() {
  const recordUrlComAssinatura = 'https://storage.wavoip.com/rec/xyz.mp3?sig=segredo123';
  const job = criarJobFake({ id: 'rec-pii-1', recordUrl: recordUrlComAssinatura, telefone: '+5511987654321' });
  const fila = criarFilaFake([job]);
  const fetchFake = criarFetchFake();

  const linhas = await capturarConsole(async () => {
    await resgatarRecordDLQ({ fila, fetchImpl: fetchFake, dryRun: false });
  });

  const linhaComTelefone = linhas.find((l) => l.includes('987654321'));
  const linhaComUrlCompleta = linhas.find((l) => l.includes('sig=segredo123'));
  checar(!linhaComTelefone, `nenhum log deveria conter o telefone do job.data, recebido: ${JSON.stringify(linhas)}`);
  checar(!linhaComUrlCompleta, `nenhum log deveria conter a recordUrl completa (assinatura), recebido: ${JSON.stringify(linhas)}`);
  checar(
    linhas.some((l) => l.includes('storage.wavoip.com')),
    'o log deveria mencionar o host (storage.wavoip.com) mesmo sem a URL completa',
  );
}

async function testeConfirmarGravacaoVivaIsolada() {
  const fetchFakeViva = criarFetchFake({ 'https://storage.wavoip.com/rec/a.mp3': 200 });
  const checkViva = await confirmarGravacaoViva('https://storage.wavoip.com/rec/a.mp3', fetchFakeViva);
  checar(checkViva.viva === true && checkViva.status === 200, 'confirmarGravacaoViva deveria reportar viva=true/status=200 em HEAD 200');
  checar(checkViva.host === 'storage.wavoip.com', `confirmarGravacaoViva deveria extrair o host, recebido: ${checkViva.host}`);

  const fetchFakeMorta = criarFetchFake({ 'https://storage.wavoip.com/rec/b.mp3': 404 });
  const checkMorta = await confirmarGravacaoViva('https://storage.wavoip.com/rec/b.mp3', fetchFakeMorta);
  checar(checkMorta.viva === false, 'confirmarGravacaoViva deveria reportar viva=false em HEAD 404');

  const fetchFakeErroRede = async () => {
    throw new Error('network error');
  };
  const checkErro = await confirmarGravacaoViva('https://storage.wavoip.com/rec/c.mp3', fetchFakeErroRede);
  checar(checkErro.viva === false, 'confirmarGravacaoViva deveria reportar viva=false em falha de rede (nao lancar)');
}

async function main() {
  await testeFiltraSoRecord();
  await testeDryRunNaoRedriva();
  await testeEspacamentoEntreRedrives();
  await testePulaGravacaoMorta();
  await testeIdempotenteRetryNoOp();
  await testeFiltrosIdsEDatas();
  await testeSemPiiNosLogs();
  await testeConfirmarGravacaoVivaIsolada();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
