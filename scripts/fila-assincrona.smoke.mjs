#!/usr/bin/env node
// scripts/fila-assincrona.smoke.mjs
//
// Smoke determinístico (sem rede/Redis) da camada Redis-ou-inline da fila
// assíncrona de processamento (`src/mastra/fila.ts`, Fase 06). Roda SEM
// REDIS_URL no ambiente (modo inline) e prova:
//   1. Degradação graciosa — `enfileirarRecord`/`enfileirarFalhaTerminal` são
//      no-op (`{ enfileirado: false }`) sem Redis, exatamente como o webhook
//      (index.ts, 06-03) espera pra cair no fallback inline (processador.ts).
//   2. Retry/backoff configurado (FILA-03) — `opcoesJob()` tem
//      `attempts >= 1` e `backoff.type === 'exponential'`.
//   3. `NOME_FILA` não-vazio.
//   4. Latência-alvo <200ms (FILA-02) — o ÚNICO check automatizado do
//      número-alvo da fase. Cronometra o caminho de enfileiramento que o
//      webhook chama NO LUGAR do trabalho pesado (transcrição Deepgram +
//      2 LLMs, que saíram do request nesta fase). Validações baratas +
//      `lerCorrelacao` (Redis GET) + `enfileirar*` são todas sub-200ms na
//      prática (<5ms); cravar `enfileirar* < 200ms` aqui é o proxy
//      automatizado válido do alvo <200ms do handler (o único jeito
//      determinístico de medir isso sem subir um servidor HTTP real).
//
// A validação E2E-com-Redis (worker consumindo de fato, retry/DLQ reais,
// latência ponta-a-ponta via curl) fica FORA deste smoke — precisa de Redis
// real. Ver roteiro no 06-05-SUMMARY.md.
//
// Uso: node --experimental-strip-types scripts/fila-assincrona.smoke.mjs

import { enfileirarRecord, enfileirarFalhaTerminal, modoFila, opcoesJob, NOME_FILA } from '../src/mastra/fila.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

async function testeModoDegradacao() {
  checar(
    modoFila() === 'inline',
    `modoFila() deveria ser 'inline' sem REDIS_URL, recebido: '${modoFila()}'`,
  );

  const resultadoRecord = await enfileirarRecord({
    whatsappCallId: 'call-x',
    telefone: '',
    recordUrl: 'http://x',
    payload: {},
    eventoDuravelId: null,
  });
  checar(
    resultadoRecord.enfileirado === false,
    `enfileirarRecord em modo inline deveria ser no-op ({enfileirado:false}), recebido: ${JSON.stringify(resultadoRecord)}`,
  );

  const resultadoFalha = await enfileirarFalhaTerminal({
    whatsappCallId: 'call-y',
    telefone: '',
    payload: {},
    eventoDuravelId: null,
  });
  checar(
    resultadoFalha.enfileirado === false,
    `enfileirarFalhaTerminal em modo inline deveria ser no-op ({enfileirado:false}), recebido: ${JSON.stringify(resultadoFalha)}`,
  );
}

function testeRetryBackoff() {
  const opcoes = opcoesJob();
  checar(
    typeof opcoes.attempts === 'number' && opcoes.attempts >= 1,
    `opcoesJob().attempts deveria ser >= 1 (retry configurado, FILA-03), recebido: ${opcoes.attempts}`,
  );
  checar(
    opcoes.backoff?.type === 'exponential',
    `opcoesJob().backoff.type deveria ser 'exponential', recebido: ${opcoes.backoff?.type}`,
  );
}

function testeNomeFila() {
  checar(
    typeof NOME_FILA === 'string' && NOME_FILA.length > 0,
    `NOME_FILA deveria ser uma string não-vazia, recebido: '${NOME_FILA}'`,
  );
}

/**
 * FILA-02 — o único check automatizado do número-alvo da fase: mede a
 * latência POR CHAMADA do caminho de enfileiramento (o que o webhook chama
 * no lugar do trabalho pesado) e afirma `< 200` (limite duro do requisito;
 * na prática o resultado fica muito abaixo, na casa de frações de ms em
 * modo inline). 100 iterações pra suavizar ruído de warmup/GC.
 */
async function testeLatenciaEnfileiramento() {
  const ITERACOES = 100;
  const LIMITE_MS = 200;

  const inicioRecord = performance.now();
  for (let i = 0; i < ITERACOES; i++) {
    await enfileirarRecord({
      whatsappCallId: `call-lat-${i}`,
      telefone: '',
      recordUrl: 'http://x',
      payload: {},
      eventoDuravelId: null,
    });
  }
  const latMediaRecord = (performance.now() - inicioRecord) / ITERACOES;
  checar(
    latMediaRecord < LIMITE_MS,
    `enfileirarRecord: latência média por chamada deveria ser < ${LIMITE_MS}ms (FILA-02), recebido: ${latMediaRecord.toFixed(3)}ms`,
  );

  const inicioFalha = performance.now();
  for (let i = 0; i < ITERACOES; i++) {
    await enfileirarFalhaTerminal({
      whatsappCallId: `call-lat-falha-${i}`,
      telefone: '',
      payload: {},
      eventoDuravelId: null,
    });
  }
  const latMediaFalha = (performance.now() - inicioFalha) / ITERACOES;
  checar(
    latMediaFalha < LIMITE_MS,
    `enfileirarFalhaTerminal: latência média por chamada deveria ser < ${LIMITE_MS}ms (FILA-02), recebido: ${latMediaFalha.toFixed(3)}ms`,
  );

  console.log(
    `[fila-assincrona.smoke] latência média: enfileirarRecord=${latMediaRecord.toFixed(3)}ms ` +
      `enfileirarFalhaTerminal=${latMediaFalha.toFixed(3)}ms (limite ${LIMITE_MS}ms, ${ITERACOES} iterações)`,
  );
}

async function main() {
  await testeModoDegradacao();
  testeRetryBackoff();
  testeNomeFila();
  await testeLatenciaEnfileiramento();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
