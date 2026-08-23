#!/usr/bin/env node
// scripts/retry-durabilidade.smoke.mjs
//
// Smoke determinístico (sem rede/Redis, sem importar worker.ts — que faz
// process.exit em modo inline) da durabilidade do pipeline BullMQ (Fase 19.1
// Plano 04, DUR-01/DUR-02/DUR-04). Cobre TUDO que é testável offline:
//   1. opcoesJob() — attempts grande (retry-infinito) + backoff.type==='capado'
//      (estratégia nomeada, registrada no Worker/19.1-04 — não testável aqui).
//   2. calcularBackoffCapado() — curva exponencial pura, satura no cap e
//      NUNCA ultrapassa.
//   3. classificarErro() — decide transitório×permanente (o que o wrapper do
//      worker usa para re-tentar vs. estacionar).
//   4. C6 — jobIdVoto(): dois votos de CONTEÚDO diferente pro MESMO taskId
//      geram jobIds diferentes (não bloqueia re-voto); um re-enqueue
//      IDÊNTICO gera o MESMO jobId (continua coalescendo).
//
// Uso: node --experimental-strip-types scripts/retry-durabilidade.smoke.mjs

import { calcularBackoffCapado, opcoesJob, jobIdVoto } from '../src/mastra/fila.ts';
import { classificarErro } from '../src/mastra/classificar-erro.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function testeOpcoesJob() {
  const opcoes = opcoesJob();
  checar(
    typeof opcoes.attempts === 'number' && opcoes.attempts >= 100_000,
    `opcoesJob().attempts deveria ser um teto grande (retry-infinito na prática, DUR-01), recebido: ${opcoes.attempts}`,
  );
  checar(
    opcoes.backoff?.type === 'capado',
    `opcoesJob().backoff.type deveria ser 'capado' (estratégia nomeada, registrada no Worker), recebido: ${opcoes.backoff?.type}`,
  );
  checar(
    opcoes.removeOnFail === false,
    `opcoesJob().removeOnFail deveria continuar false (DLQ inspecionável, FILA-04), recebido: ${opcoes.removeOnFail}`,
  );
}

function testeBackoffCapado() {
  // Curva exponencial a partir de 5s (FILA_BACKOFF_MS default), dobrando a
  // cada tentativa: 5s -> 10s -> 20s -> 40s -> ... -> satura no cap (1h,
  // FILA_BACKOFF_CAP_MS default) e nunca ultrapassa.
  const primeira = calcularBackoffCapado(1);
  checar(primeira === 5000, `calcularBackoffCapado(1) deveria ser 5000ms (5s), recebido: ${primeira}`);

  let anterior = primeira;
  let cresceuAlgumaVez = false;
  let atingiuCap = false;
  const CAP_MS = 3_600_000;

  for (let tentativa = 2; tentativa <= 30; tentativa++) {
    const valor = calcularBackoffCapado(tentativa);
    checar(
      valor <= CAP_MS,
      `calcularBackoffCapado(${tentativa}) NUNCA deveria ultrapassar o cap (${CAP_MS}ms), recebido: ${valor}`,
    );
    checar(
      valor >= anterior,
      `calcularBackoffCapado deveria ser monotônico não-decrescente — tentativa ${tentativa} (${valor}) < tentativa anterior (${anterior})`,
    );
    if (valor > anterior) cresceuAlgumaVez = true;
    if (valor === CAP_MS) atingiuCap = true;
    anterior = valor;
  }

  checar(cresceuAlgumaVez, 'calcularBackoffCapado deveria crescer (exponencial) em algum ponto da curva testada');
  checar(atingiuCap, `calcularBackoffCapado deveria SATURAR no cap (${CAP_MS}ms) até a tentativa 30, recebido no fim: ${anterior}`);

  // attemptsMade não-positivo não pode gerar valor negativo/menor que a base.
  checar(
    calcularBackoffCapado(0) === 5000,
    `calcularBackoffCapado(0) deveria clampar pra base (5000ms), recebido: ${calcularBackoffCapado(0)}`,
  );
}

function testeClassificarErroIntegracao() {
  // Prova que o worker (19.1-04) tem o que precisa pra decidir a política —
  // a matriz completa já é coberta por classificar-erro.smoke.mjs (Plano 01);
  // aqui só confirmamos que a decisão certa chega pro caller deste smoke.
  const transitorio = classificarErro(new Error('ECONNRESET'));
  checar(transitorio.tipo === 'transitorio', `erro de rede deveria classificar 'transitorio', recebido: ${JSON.stringify(transitorio)}`);

  const permanente = classificarErro('(404) task not found');
  checar(permanente.tipo === 'permanente', `404 deveria classificar 'permanente', recebido: ${JSON.stringify(permanente)}`);
}

function testeC6JobIdVoto() {
  const taskId = 'task-c6-123';

  const votoA = { romero: 'sim', andressa: 'naoDeclarou' };
  const votoB = { romero: 'nao', andressa: 'naoDeclarou' }; // conteúdo DIFERENTE, mesmo taskId

  const jobIdA1 = jobIdVoto(taskId, votoA);
  const jobIdA2 = jobIdVoto(taskId, votoA); // re-enqueue IDÊNTICO
  const jobIdB = jobIdVoto(taskId, votoB); // re-voto de CONTEÚDO diferente

  checar(
    jobIdA1 === jobIdA2,
    `C6: re-enqueue idêntico (mesmo taskId+voto) deveria gerar o MESMO jobId (continua coalescendo), recebido A1=${jobIdA1} A2=${jobIdA2}`,
  );
  checar(
    jobIdA1 !== jobIdB,
    `C6: um re-voto de CONTEÚDO diferente pro mesmo taskId deveria gerar jobId DIFERENTE (não bloqueado pelo job morto do voto anterior), recebido A=${jobIdA1} B=${jobIdB}`,
  );
  checar(
    jobIdA1.startsWith(`sync:voto:${taskId}:`),
    `jobIdVoto deveria manter o prefixo 'sync:voto:{taskId}:' (correlação/legibilidade), recebido: ${jobIdA1}`,
  );

  // taskId diferente, mesmo voto -> jobId diferente (nunca cruza leads).
  const jobIdOutroLead = jobIdVoto('task-c6-outro', votoA);
  checar(
    jobIdOutroLead !== jobIdA1,
    `jobIdVoto de taskIds diferentes NUNCA deveria colidir, recebido: ${jobIdOutroLead} vs ${jobIdA1}`,
  );

  // voto vazio (nem romero nem andressa) não deve lançar e ainda produz um
  // jobId estável/determinístico.
  const jobIdVazio1 = jobIdVoto(taskId, {});
  const jobIdVazio2 = jobIdVoto(taskId, {});
  checar(
    jobIdVazio1 === jobIdVazio2,
    `jobIdVoto({}) deveria ser determinístico, recebido: ${jobIdVazio1} vs ${jobIdVazio2}`,
  );
}

function main() {
  testeOpcoesJob();
  testeBackoffCapado();
  testeClassificarErroIntegracao();
  testeC6JobIdVoto();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
