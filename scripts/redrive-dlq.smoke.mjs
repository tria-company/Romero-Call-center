#!/usr/bin/env node
// scripts/redrive-dlq.smoke.mjs
//
// Smoke determinístico (offline, sem Redis, sem importar worker.ts — que faz
// process.exit em modo inline) da varredura de re-drive automático da DLQ
// (`src/mastra/redrive-dlq.ts`, Fase 19.1 Plano 05, DUR-03). Injeta um seam
// FAKE de `getFailed`/`job.retry` (o `FilaComoDLQ` exportado pelo próprio
// módulo) em vez de instanciar uma Queue BullMQ real — mesmo espírito de
// `fetchImpl` em gravacao-store.smoke.mjs. Prova:
//   1. Job com failedReason TRANSITÓRIO é re-drivado (job.retry() chamado),
//      com espaçamento (DLQ_REDRIVE_ESPACO_MS) entre cada re-add.
//   2. Job com failedReason PERMANENTE NÃO é re-drivado (job.retry() nunca
//      chamado) — fica estacionado.
//   3. A varredura respeita o lote máximo DLQ_REDRIVE_LOTE — nunca lê/re-driva
//      mais jobs do que o configurado numa única passada.
//   4. Job antigo (idade > DLQ_AGE_ALERTA_MS) dispara alerta de idade UMA
//      única vez (dedup edge-trigger) — mesmo se continuar velho na próxima
//      varredura; volta a alertar só se sumir do failed e reaparecer.
//   5. LGPD: nenhum log/alerta carrega o failedReason cru (pode ter PII).
//
// Env de teste (intervalos pequenos p/ o smoke rodar rápido) definido ANTES
// do import — config.ts lê process.env na carga do módulo, mesmo padrão de
// gravacao-store.smoke.mjs.
//
// Uso: node --experimental-strip-types scripts/redrive-dlq.smoke.mjs

process.env.DLQ_REDRIVE_ESPACO_MS ||= '15';
process.env.DLQ_REDRIVE_LOTE ||= '3';
process.env.DLQ_AGE_ALERTA_MS ||= '1000';
process.env.DLQ_REDRIVE_INTERVALO_MS ||= '999999999'; // não deixa o setInterval real disparar durante o smoke

const { varrerDLQUmaVez, iniciarRedriveDLQ, fecharRedriveDLQ } = await import('../src/mastra/redrive-dlq.ts');
const { DLQ_REDRIVE_ESPACO_MS, DLQ_REDRIVE_LOTE, DLQ_AGE_ALERTA_MS } = await import('../src/mastra/config.ts');

const falhas = [];
function checar(condicao, mensagem) {
  if (condicao) {
    console.log('  ✅', mensagem);
  } else {
    console.error('  ❌', mensagem);
    falhas.push(mensagem);
  }
}

/** Cria um job fake conforme JobFailedLike (id/name/failedReason/finishedOn/timestamp/retry). */
function criarJobFake({ id, failedReason, idadeMs = 0, telefoneNoErro }) {
  const agora = Date.now();
  const razao = telefoneNoErro ? `${failedReason} telefone=+5511999998888` : failedReason;
  return {
    id,
    name: 'record',
    failedReason: razao,
    finishedOn: agora - idadeMs,
    timestamp: agora - idadeMs,
    chamadasRetry: 0,
    async retry() {
      this.chamadasRetry++;
    },
  };
}

/** Fake de Queue (FilaComoDLQ) — getFailed(start,end) fatia o "banco" em memória, mesmo espírito de ZRANGE inclusivo do Redis. */
function criarFilaFake(jobs) {
  const chamadas = [];
  return {
    jobs,
    chamadas,
    async getFailed(start, end) {
      chamadas.push([start, end]);
      return jobs.slice(start, end + 1);
    },
  };
}

/** Captura console.error durante a execução de fn — usado para inspecionar alertas sem rede (ALERT_WEBHOOK_URL vazio no smoke). */
async function capturarConsoleError(fn) {
  const original = console.error;
  const linhas = [];
  console.error = (...args) => {
    linhas.push(args.map((a) => String(a)).join(' '));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return linhas;
}

async function testeTransitorioRedrivadoComEspacamento() {
  const jobA = criarJobFake({ id: 'job-transitorio-1', failedReason: 'ECONNRESET' });
  const jobB = criarJobFake({ id: 'job-transitorio-2', failedReason: 'fetch failed' });
  const fila = criarFilaFake([jobA, jobB]);

  const inicio = Date.now();
  const resultado = await varrerDLQUmaVez(fila);
  const duracao = Date.now() - inicio;

  checar(jobA.chamadasRetry === 1, `job transitório A deveria ter job.retry() chamado 1x, recebido: ${jobA.chamadasRetry}`);
  checar(jobB.chamadasRetry === 1, `job transitório B deveria ter job.retry() chamado 1x, recebido: ${jobB.chamadasRetry}`);
  checar(resultado.redrivados === 2, `resultado.redrivados deveria ser 2, recebido: ${resultado.redrivados}`);
  checar(resultado.estacionados === 0, `resultado.estacionados deveria ser 0 (nenhum permanente), recebido: ${resultado.estacionados}`);
  // Espaçamento entre os 2 re-adds: pelo menos 1x DLQ_REDRIVE_ESPACO_MS
  // decorrido (serializado, não em paralelo) — tolerância pequena p/ jitter.
  checar(
    duracao >= DLQ_REDRIVE_ESPACO_MS - 5,
    `varredura de 2 jobs transitórios deveria levar >= ${DLQ_REDRIVE_ESPACO_MS}ms (rate-spacing serializado), recebido: ${duracao}ms`,
  );
}

async function testePermanenteNaoRedrivado() {
  const jobPermanente = criarJobFake({ id: 'job-permanente-1', failedReason: '(404) task not found' });
  const fila = criarFilaFake([jobPermanente]);

  const resultado = await varrerDLQUmaVez(fila);

  checar(jobPermanente.chamadasRetry === 0, `job permanente NUNCA deveria ter job.retry() chamado, recebido: ${jobPermanente.chamadasRetry}`);
  checar(resultado.redrivados === 0, `resultado.redrivados deveria ser 0 (só o permanente na fila), recebido: ${resultado.redrivados}`);
  checar(resultado.estacionados === 1, `resultado.estacionados deveria ser 1, recebido: ${resultado.estacionados}`);
}

async function testeRespeitaLoteMaximo() {
  // DLQ_REDRIVE_LOTE=3 (env do smoke) — banco fake tem 6 jobs transitórios;
  // uma única varredura NUNCA pode processar todos os 6.
  const totalNoBanco = 6;
  const jobs = Array.from({ length: totalNoBanco }, (_, i) =>
    criarJobFake({ id: `job-lote-${i}`, failedReason: 'ETIMEDOUT' }),
  );
  const fila = criarFilaFake(jobs);

  const resultado = await varrerDLQUmaVez(fila);

  checar(
    fila.chamadas.length === 1 && fila.chamadas[0][1] === DLQ_REDRIVE_LOTE,
    `getFailed deveria ser chamado com end=DLQ_REDRIVE_LOTE (${DLQ_REDRIVE_LOTE}), recebido: ${JSON.stringify(fila.chamadas)}`,
  );
  const totalProcessado = resultado.redrivados + resultado.estacionados;
  checar(
    totalProcessado <= DLQ_REDRIVE_LOTE + 1,
    `uma varredura NÃO deveria processar mais do que o lote configurado (~${DLQ_REDRIVE_LOTE}), recebido: ${totalProcessado} de ${totalNoBanco} no banco`,
  );
  checar(
    totalProcessado < totalNoBanco,
    `com banco (${totalNoBanco}) maior que o lote (${DLQ_REDRIVE_LOTE}), a varredura deveria deixar jobs de fora desta passada, processou: ${totalProcessado}`,
  );
}

async function testeAlertaDeIdadeComDedupEdgeTrigger() {
  // DLQ_AGE_ALERTA_MS=1000 (env do smoke) — job "velho" (idade 5000ms > limite).
  const jobVelho = criarJobFake({ id: 'job-velho-1', failedReason: '(404) task not found', idadeMs: 5000 });

  // 1ª varredura: job velho ainda presente na DLQ — deveria alertar 1x.
  const filaPrimeiraVarredura = criarFilaFake([jobVelho]);
  let resultado1;
  const linhas1 = await capturarConsoleError(async () => {
    resultado1 = await varrerDLQUmaVez(filaPrimeiraVarredura);
  });
  const alertasIdade1 = linhas1.filter((l) => l.includes('[ALERTA][THRESHOLD]') && l.includes(jobVelho.id));
  checar(resultado1.alertados === 1, `1ª varredura: job velho deveria disparar 1 alerta de idade, recebido resultado.alertados=${resultado1.alertados}`);
  checar(alertasIdade1.length === 1, `1ª varredura: deveria haver exatamente 1 linha de log [ALERTA][THRESHOLD] para o job velho, recebido: ${alertasIdade1.length}`);

  // 2ª varredura: MESMO job (mesmo id) ainda presente e ainda velho — dedup
  // edge-trigger NÃO deveria alertar de novo.
  const filaSegundaVarredura = criarFilaFake([jobVelho]);
  let resultado2;
  const linhas2 = await capturarConsoleError(async () => {
    resultado2 = await varrerDLQUmaVez(filaSegundaVarredura);
  });
  const alertasIdade2 = linhas2.filter((l) => l.includes('[ALERTA][THRESHOLD]') && l.includes(jobVelho.id));
  checar(resultado2.alertados === 0, `2ª varredura (mesmo job ainda velho): NÃO deveria re-alertar (dedup edge-trigger), recebido resultado.alertados=${resultado2.alertados}`);
  checar(alertasIdade2.length === 0, `2ª varredura: não deveria haver nova linha [ALERTA][THRESHOLD] para o mesmo job, recebido: ${alertasIdade2.length}`);

  // 3ª varredura: job sumiu do failed (foi re-drivado/removido por humano) —
  // dedup libera a chave. Um NOVO job velho com o MESMO id reaparecendo
  // deveria poder alertar de novo (edge-trigger).
  const filaTerceiraVarreduraSemJob = criarFilaFake([]); // banco vazio -> libera o dedup do job-velho-1
  await varrerDLQUmaVez(filaTerceiraVarreduraSemJob);

  const jobVelhoReaparecido = criarJobFake({ id: 'job-velho-1', failedReason: '(404) task not found', idadeMs: 5000 });
  const filaQuartaVarredura = criarFilaFake([jobVelhoReaparecido]);
  let resultado4;
  const linhas4 = await capturarConsoleError(async () => {
    resultado4 = await varrerDLQUmaVez(filaQuartaVarredura);
  });
  const alertasIdade4 = linhas4.filter((l) => l.includes('[ALERTA][THRESHOLD]') && l.includes(jobVelhoReaparecido.id));
  checar(resultado4.alertados === 1, `job de mesmo id reaparecendo após sumir do failed deveria poder alertar de novo, recebido resultado.alertados=${resultado4.alertados}`);
  checar(alertasIdade4.length === 1, `deveria haver 1 nova linha [ALERTA][THRESHOLD] para o job reaparecido, recebido: ${alertasIdade4.length}`);
}

async function testeSemPiiNosLogsEAlertas() {
  const jobComTelefoneNoErro = criarJobFake({
    id: 'job-pii-1',
    failedReason: 'timeout ao gravar',
    idadeMs: 5000,
    telefoneNoErro: true,
  });
  const fila = criarFilaFake([jobComTelefoneNoErro]);

  const linhas = await capturarConsoleError(async () => {
    await varrerDLQUmaVez(fila);
  });

  const linhaComTelefone = linhas.find((l) => l.includes('999998888'));
  checar(!linhaComTelefone, `nenhum log/alerta deveria conter o telefone cru do failedReason, recebido: ${JSON.stringify(linhas)}`);
}

async function testeIniciarFecharIdempotenteNaoLanca() {
  let lancou = false;
  try {
    iniciarRedriveDLQ(); // modo inline no smoke (sem REDIS_URL) -> no-op
    iniciarRedriveDLQ(); // idempotente
    await fecharRedriveDLQ();
    await fecharRedriveDLQ(); // segunda chamada — no-op, não deve lançar
  } catch {
    lancou = true;
  }
  checar(!lancou, 'iniciarRedriveDLQ()/fecharRedriveDLQ() não deveriam lançar mesmo chamados 2x (idempotência)');
}

async function main() {
  await testeTransitorioRedrivadoComEspacamento();
  await testePermanenteNaoRedrivado();
  await testeRespeitaLoteMaximo();
  await testeAlertaDeIdadeComDedupEdgeTrigger();
  await testeSemPiiNosLogsEAlertas();
  await testeIniciarFecharIdempotenteNaoLanca();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
