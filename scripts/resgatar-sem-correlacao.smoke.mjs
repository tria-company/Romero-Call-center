#!/usr/bin/env node
// scripts/resgatar-sem-correlacao.smoke.mjs
//
// Smoke determinístico (offline, sem Supabase/ClickUp/Redis/BullMQ reais) do
// resgate REAL dos RECORDs antigos sem correlação (`scripts/resgatar-sem-
// correlacao.mjs`, Fase 19.1 Plano 08, DUR-07). Injeta fakes de
// buscarEventosRecordImpl/buscarEventoCallImpl/buscarTasksPorTelefoneImpl +
// fila/redis (mesmo espírito de `resgatar-record-dlq.smoke.mjs`). Prova:
//   1. Extração de telefone do payload CALL (INCOMING/OUTGOING).
//   2. Casamento por janela de data: achado único -> resgatável; 0 ou >1
//      candidatas -> NÃO-RESGATÁVEL (motivo nao-encontrada/ambigua).
//   3. jobId versionado ÚNICO (timestamps diferentes -> ids diferentes).
//   4. --dry-run NUNCA chama fila.add nem redis.del.
//   5. Elegibilidade (recordElegivel) ignora RECORD não-READY/sem record_url.
//   6. SEM telefone extraível (CALL ausente) -> NAO-RESGATAVEL, nunca chama
//      buscarTasksPorTelefoneImpl.
//   7. Resgate real: limpa a chave de dedup (wh:rec:{callId}) ANTES de
//      re-enfileirar, com taskId resolvido + jobId versionado.
//   8. LGPD: nenhuma linha de log carrega o telefone.
//
// Uso: node --experimental-strip-types scripts/resgatar-sem-correlacao.smoke.mjs

const {
  resgatarSemCorrelacao,
  parseArgs,
  extrairTelefoneDoPayloadCall,
  candidatosTelefoneE164,
  diaUtc,
  casarLigacaoPorJanela,
  montarJobIdResgate,
  recordElegivel,
  chaveDedupRecord,
} = await import('../scripts/resgatar-sem-correlacao.mjs');

const falhas = [];
function checar(condicao, mensagem) {
  if (condicao) {
    console.log('  ✅', mensagem);
  } else {
    console.error('  ❌', mensagem);
    falhas.push(mensagem);
  }
}

const RECEBIDO_EM_ALVO = '2026-08-15T12:00:00.000Z';
const MS_MESMO_DIA = new Date('2026-08-15T20:00:00.000Z').getTime();
const MS_DIA_SEGUINTE = new Date('2026-08-16T01:00:00.000Z').getTime();

function eventoRecordFake({ callId = 'call-1', recordStatus = 'READY', recordUrl = 'https://storage.wavoip.com/rec/x.mp3', recebidoEm = RECEBIDO_EM_ALVO } = {}) {
  return {
    id: `evt-${callId}`,
    whatsapp_call_id: callId,
    payload: { record_status: recordStatus, record_url: recordUrl },
    recebido_em: recebidoEm,
  };
}

/** Fake de fila (BullMQ) — grava as chamadas de add() em memória. */
function criarFilaFake({ falharNoAdd = false } = {}) {
  const chamadas = [];
  return {
    chamadas,
    async add(nome, dados, opts) {
      if (falharNoAdd) throw new Error('fila indisponivel (fake)');
      chamadas.push({ nome, dados, opts });
    },
  };
}

/** Fake de redis (ioredis) — grava as chamadas de del(). */
function criarRedisFake() {
  const chamadasDel = [];
  return {
    chamadasDel,
    async del(chave) {
      chamadasDel.push(chave);
    },
  };
}

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

// ===== Helpers PUROS =====

function testeExtrairTelefone() {
  const incoming = extrairTelefoneDoPayloadCall({ direction: 'INCOMING', caller: '+55 (81) 98404-8278', receiver: '+5511999998888' });
  checar(incoming === '5581984048278', `INCOMING deveria extrair o caller, recebido: ${incoming}`);

  const outgoing = extrairTelefoneDoPayloadCall({ direction: 'OUTGOING', caller: '+5511999998888', receiver: '+5581984048278' });
  checar(outgoing === '5581984048278', `OUTGOING deveria extrair o receiver, recebido: ${outgoing}`);

  const semPayload = extrairTelefoneDoPayloadCall(null);
  checar(semPayload === '', `payload nulo deveria devolver string vazia, recebido: "${semPayload}"`);
}

function testeCandidatosE164() {
  const cands12 = candidatosTelefoneE164('5581984048278'); // 13 digitos, com 9
  checar(cands12.includes('+5581984048278'), `deveria incluir o E.164 literal, recebido: ${JSON.stringify(cands12)}`);
  checar(cands12.includes('+558184048278'), `deveria incluir a variante SEM o 9o digito, recebido: ${JSON.stringify(cands12)}`);

  const cands13 = candidatosTelefoneE164('558184048278'); // 12 digitos, sem 9
  checar(cands13.includes('+558184048278'), `deveria incluir o E.164 literal, recebido: ${JSON.stringify(cands13)}`);
  checar(cands13.includes('+5581984048278'), `deveria incluir a variante COM o 9o digito, recebido: ${JSON.stringify(cands13)}`);

  checar(candidatosTelefoneE164('').length === 0, 'telefone vazio deveria devolver lista vazia');
}

function testeDiaUtc() {
  checar(diaUtc(MS_MESMO_DIA) === '2026-08-15', `diaUtc deveria extrair YYYY-MM-DD, recebido: ${diaUtc(MS_MESMO_DIA)}`);
}

function testeCasamentoUnicoResgatavel() {
  const recebidoEmMs = new Date(RECEBIDO_EM_ALVO).getTime();
  const tasks = [{ id: 'task-1', date_created: String(MS_MESMO_DIA) }];
  const r = casarLigacaoPorJanela(tasks, recebidoEmMs);
  checar(r.resgatavel === true && r.taskId === 'task-1', `1 candidata na janela deveria ser resgatavel, recebido: ${JSON.stringify(r)}`);
}

function testeCasamentoZeroNaoEncontrada() {
  const recebidoEmMs = new Date(RECEBIDO_EM_ALVO).getTime();
  const tasks = [{ id: 'task-fora', date_created: String(MS_DIA_SEGUINTE) }];
  const r = casarLigacaoPorJanela(tasks, recebidoEmMs);
  checar(r.resgatavel === false && r.motivo === 'nao-encontrada', `nenhuma candidata na janela deveria ser NAO-RESGATAVEL/nao-encontrada, recebido: ${JSON.stringify(r)}`);
}

function testeCasamentoAmbiguo() {
  const recebidoEmMs = new Date(RECEBIDO_EM_ALVO).getTime();
  const tasks = [
    { id: 'task-a', date_created: String(MS_MESMO_DIA) },
    { id: 'task-b', date_created: String(MS_MESMO_DIA - 3600_000) },
  ];
  const r = casarLigacaoPorJanela(tasks, recebidoEmMs);
  checar(r.resgatavel === false && r.motivo === 'ambigua' && r.candidatos === 2, `2 candidatas na janela deveria ser NAO-RESGATAVEL/ambigua, recebido: ${JSON.stringify(r)}`);
}

function testeJobIdVersionadoUnico() {
  const a = montarJobIdResgate('call-x', 1000);
  const b = montarJobIdResgate('call-x', 2000);
  checar(a !== b, `timestamps diferentes deveriam gerar jobId diferente, recebido: ${a} vs ${b}`);
  checar(a === 'resgate:call-x:1000', `formato do jobId deveria ser resgate:{callId}:{ts}, recebido: ${a}`);
}

function testeRecordElegivel() {
  const pronto = recordElegivel({ record_status: 'READY', record_url: 'https://x/y.mp3' });
  checar(pronto.elegivel === true, `READY + record_url deveria ser elegivel, recebido: ${JSON.stringify(pronto)}`);

  const semUrl = recordElegivel({ record_status: 'READY', record_url: '' });
  checar(semUrl.elegivel === false, 'READY sem record_url NAO deveria ser elegivel');

  const naoPronto = recordElegivel({ record_status: 'RECORDING', record_url: 'https://x/y.mp3' });
  checar(naoPronto.elegivel === false, 'status != READY NAO deveria ser elegivel');
}

function testeChaveDedup() {
  checar(chaveDedupRecord('abc123') === 'wh:rec:abc123', `chaveDedupRecord deveria prefixar wh:rec:, recebido: ${chaveDedupRecord('abc123')}`);
}

function testeParseArgs() {
  const opts = parseArgs(['--dry-run', '--ids', 'a,b,c', '--desde', '2026-08-13', '--ate', '2026-08-21']);
  checar(opts.dryRun === true, 'parseArgs deveria reconhecer --dry-run');
  checar(opts.ids?.size === 3, `parseArgs --ids deveria montar Set de 3, recebido: ${opts.ids?.size}`);
  checar(opts.desde === new Date('2026-08-13T00:00:00.000Z').getTime(), 'parseArgs --desde deveria virar inicio do dia UTC');
  checar(opts.ate === new Date('2026-08-21T23:59:59.999Z').getTime(), 'parseArgs --ate deveria virar fim do dia UTC');
}

// ===== Orquestração (resgatarSemCorrelacao com seams injetados) =====

async function testeDryRunNaoEnfileiraNemLimpaDedup() {
  const eventos = [eventoRecordFake({ callId: 'call-dry' })];
  const buscarEventosRecordImpl = async () => eventos;
  const buscarEventoCallImpl = async () => ({ direction: 'OUTGOING', receiver: '+5581984048278' });
  const buscarTasksPorTelefoneImpl = async () => [{ id: 'task-dry', date_created: String(MS_MESMO_DIA) }];
  const fila = criarFilaFake();
  const redis = criarRedisFake();

  const resultado = await resgatarSemCorrelacao({
    buscarEventosRecordImpl,
    buscarEventoCallImpl,
    buscarTasksPorTelefoneImpl,
    fila,
    redis,
    dryRun: true,
    espacoMs: 5,
    logger: { log() {}, warn() {}, error() {} },
  });

  checar(resultado.resgatados === 1, `dry-run deveria contar resgatavel=1, recebido: ${resultado.resgatados}`);
  checar(fila.chamadas.length === 0, 'dry-run NUNCA deveria chamar fila.add()');
  checar(redis.chamadasDel.length === 0, 'dry-run NUNCA deveria chamar redis.del()');
}

async function testeResgateRealLimpaDedupEEnfileiraComTaskId() {
  const eventos = [eventoRecordFake({ callId: 'call-real' })];
  const buscarEventosRecordImpl = async () => eventos;
  const buscarEventoCallImpl = async () => ({ direction: 'OUTGOING', receiver: '+5581984048278' });
  const buscarTasksPorTelefoneImpl = async () => [{ id: 'task-real', date_created: String(MS_MESMO_DIA) }];
  const fila = criarFilaFake();
  const redis = criarRedisFake();

  const resultado = await resgatarSemCorrelacao({
    buscarEventosRecordImpl,
    buscarEventoCallImpl,
    buscarTasksPorTelefoneImpl,
    fila,
    redis,
    dryRun: false,
    espacoMs: 5,
    logger: { log() {}, warn() {}, error() {} },
  });

  checar(resultado.resgatados === 1, `resgate real deveria contar resgatados=1, recebido: ${resultado.resgatados}`);
  checar(redis.chamadasDel[0] === 'wh:rec:call-real', `deveria limpar a chave de dedup certa, recebido: ${JSON.stringify(redis.chamadasDel)}`);
  checar(fila.chamadas.length === 1, `deveria enfileirar exatamente 1 job, recebido: ${fila.chamadas.length}`);
  const job = fila.chamadas[0];
  checar(job.nome === 'record', `job deveria ser do tipo record, recebido: ${job.nome}`);
  checar(job.dados.taskId === 'task-real', `job.data.taskId deveria vir resolvido, recebido: ${job.dados.taskId}`);
  checar(job.opts.jobId?.startsWith('resgate:call-real:'), `jobId deveria ser versionado, recebido: ${job.opts.jobId}`);
  checar(job.opts.removeOnFail === false, 'job deveria manter removeOnFail:false (DLQ inspecionavel)');
}

async function testeSemTelefoneNaoConsultaClickUpNemEnfileira() {
  const eventos = [eventoRecordFake({ callId: 'call-sem-tel' })];
  const buscarEventosRecordImpl = async () => eventos;
  const buscarEventoCallImpl = async () => null; // sem evento CALL correlato
  let consultouClickUp = false;
  const buscarTasksPorTelefoneImpl = async () => {
    consultouClickUp = true;
    return [];
  };
  const fila = criarFilaFake();

  const resultado = await resgatarSemCorrelacao({
    buscarEventosRecordImpl,
    buscarEventoCallImpl,
    buscarTasksPorTelefoneImpl,
    fila,
    dryRun: false,
    espacoMs: 5,
    logger: { log() {}, warn() {}, error() {} },
  });

  checar(resultado.semTelefone === 1, `deveria contar semTelefone=1, recebido: ${resultado.semTelefone}`);
  checar(!consultouClickUp, 'sem telefone extraivel NUNCA deveria consultar o ClickUp');
  checar(fila.chamadas.length === 0, 'sem telefone extraivel NUNCA deveria enfileirar');
}

async function testeElegibilidadeIgnoraNaoProntoOuSemUrl() {
  const eventos = [
    eventoRecordFake({ callId: 'call-recording', recordStatus: 'RECORDING' }),
    eventoRecordFake({ callId: 'call-sem-url', recordUrl: '' }),
    eventoRecordFake({ callId: 'call-ok' }),
  ];
  const buscarEventosRecordImpl = async () => eventos;
  const buscarEventoCallImpl = async () => ({ direction: 'OUTGOING', receiver: '+5581984048278' });
  const buscarTasksPorTelefoneImpl = async () => [{ id: 'task-ok', date_created: String(MS_MESMO_DIA) }];
  const fila = criarFilaFake();
  const redis = criarRedisFake();

  const resultado = await resgatarSemCorrelacao({
    buscarEventosRecordImpl,
    buscarEventoCallImpl,
    buscarTasksPorTelefoneImpl,
    fila,
    redis,
    dryRun: false,
    espacoMs: 5,
    logger: { log() {}, warn() {}, error() {} },
  });

  checar(resultado.totalEventos === 3, `deveria contar totalEventos=3, recebido: ${resultado.totalEventos}`);
  checar(resultado.elegiveis === 1, `so 1 dos 3 e elegivel (READY+record_url), recebido: ${resultado.elegiveis}`);
  checar(resultado.resgatados === 1, `so o elegivel deveria ser resgatado, recebido: ${resultado.resgatados}`);
  checar(fila.chamadas.length === 1 && fila.chamadas[0].dados.whatsappCallId === 'call-ok', 'so call-ok deveria ter sido enfileirado');
}

async function testeAmbiguoNaoEnfileira() {
  const eventos = [eventoRecordFake({ callId: 'call-ambiguo' })];
  const buscarEventosRecordImpl = async () => eventos;
  const buscarEventoCallImpl = async () => ({ direction: 'OUTGOING', receiver: '+5581984048278' });
  const buscarTasksPorTelefoneImpl = async () => [
    { id: 'task-a', date_created: String(MS_MESMO_DIA) },
    { id: 'task-b', date_created: String(MS_MESMO_DIA - 1000) },
  ];
  const fila = criarFilaFake();
  const redis = criarRedisFake();

  const resultado = await resgatarSemCorrelacao({
    buscarEventosRecordImpl,
    buscarEventoCallImpl,
    buscarTasksPorTelefoneImpl,
    fila,
    redis,
    dryRun: false,
    espacoMs: 5,
    logger: { log() {}, warn() {}, error() {} },
  });

  checar(resultado.naoResgatavelAmbigua === 1, `deveria contar naoResgatavelAmbigua=1, recebido: ${resultado.naoResgatavelAmbigua}`);
  checar(fila.chamadas.length === 0, 'ambiguo NUNCA deveria enfileirar');
  checar(redis.chamadasDel.length === 0, 'ambiguo NUNCA deveria limpar dedup');
}

async function testeSemPiiNosLogs() {
  const eventos = [eventoRecordFake({ callId: 'call-pii' })];
  const buscarEventosRecordImpl = async () => eventos;
  const buscarEventoCallImpl = async () => ({ direction: 'OUTGOING', receiver: '+5581987654321' });
  const buscarTasksPorTelefoneImpl = async () => [{ id: 'task-pii', date_created: String(MS_MESMO_DIA) }];
  const fila = criarFilaFake();
  const redis = criarRedisFake();

  const linhas = await capturarConsole(async () => {
    await resgatarSemCorrelacao({
      buscarEventosRecordImpl,
      buscarEventoCallImpl,
      buscarTasksPorTelefoneImpl,
      fila,
      redis,
      dryRun: false,
      espacoMs: 5,
    });
  });

  const linhaComTelefone = linhas.find((l) => l.includes('987654321') || l.includes('81987654321'));
  checar(!linhaComTelefone, `nenhum log deveria conter o telefone, recebido: ${JSON.stringify(linhas)}`);
  checar(
    linhas.some((l) => l.includes('call-pii') && l.includes('task-pii')),
    'o log deveria mencionar callId/taskId (sem PII) para auditoria',
  );
}

async function main() {
  testeExtrairTelefone();
  testeCandidatosE164();
  testeDiaUtc();
  testeCasamentoUnicoResgatavel();
  testeCasamentoZeroNaoEncontrada();
  testeCasamentoAmbiguo();
  testeJobIdVersionadoUnico();
  testeRecordElegivel();
  testeChaveDedup();
  testeParseArgs();
  await testeDryRunNaoEnfileiraNemLimpaDedup();
  await testeResgateRealLimpaDedupEEnfileiraComTaskId();
  await testeSemTelefoneNaoConsultaClickUpNemEnfileira();
  await testeElegibilidadeIgnoraNaoProntoOuSemUrl();
  await testeAmbiguoNaoEnfileira();
  await testeSemPiiNosLogs();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
