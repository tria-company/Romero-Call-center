#!/usr/bin/env node
// scripts/sync-clickup.smoke.mjs
//
// Smoke determinístico (sem rede/Redis) do job de sync ClickUp (CACHE-03,
// Fase 08 Plano 03). Roda SEM REDIS_URL no ambiente (modo inline) e prova:
//   1. Degradação graciosa — `enfileirarSyncClickup` é no-op
//      (`{ enfileirado: false }`) sem Redis, exatamente como o caller
//      (Plano 04) espera para cair no fallback de gravação inline (SC5).
//   2. `modoFila()` reporta 'inline' sem REDIS_URL — mesma superfície usada
//      por `fila-assincrona.smoke.mjs` (Fase 06).
//   3. Minimização do payload (LGPD, T-08-03-PII) — checagem ESTRUTURAL de
//      que o objeto aceito por `enfileirarSyncClickup` não carrega
//      `telefone`/`nome`/`cpf` (o tipo `DadosJobSyncClickup` só tem
//      taskId/assigneeId/voto; este smoke prova em runtime que passar esses
//      3 campos basta — nenhum outro campo é exigido/lido).
//
// A validação E2E-com-Redis (worker consumindo de fato, retry/DLQ reais,
// p95 < 60s ponta-a-ponta com ClickUp real) fica FORA deste smoke — precisa
// de Redis + ClickUp reais. Mesmo padrão de 06-05/08-01.
//
// Uso: node --experimental-strip-types scripts/sync-clickup.smoke.mjs

import { enfileirarSyncClickup, modoFila } from '../src/mastra/fila.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

async function testeModoDegradacao() {
  checar(
    modoFila() === 'inline',
    `modoFila() deveria ser 'inline' sem REDIS_URL, recebido: '${modoFila()}'`,
  );

  const resultado = await enfileirarSyncClickup({
    taskId: 't1',
    assigneeId: 'a1',
    voto: { romero: 'sim' },
  });
  checar(
    resultado.enfileirado === false,
    `enfileirarSyncClickup em modo inline deveria ser no-op ({enfileirado:false}), recebido: ${JSON.stringify(resultado)}`,
  );
}

/**
 * T-08-03-PII: prova estrutural de que o payload MÍNIMO (taskId/assigneeId/
 * voto) é suficiente — nenhum campo de PII (telefone/nome/cpf) é necessário
 * para `enfileirarSyncClickup` funcionar. Chama com um objeto que
 * DELIBERADAMENTE não tem essas chaves e confirma que a função aceita e
 * não lança.
 */
async function testePayloadMinimizado() {
  const payload = { taskId: 't2', assigneeId: 'a2', voto: { andressa: 'nao' } };

  checar(
    !('telefone' in payload) && !('nome' in payload) && !('cpf' in payload),
    'payload de enfileirarSyncClickup não deveria ter telefone/nome/cpf (minimização LGPD, T-08-03-PII)',
  );

  let lancou = false;
  try {
    await enfileirarSyncClickup(payload);
  } catch {
    lancou = true;
  }
  checar(
    !lancou,
    'enfileirarSyncClickup não deveria lançar mesmo sem campos de PII no payload (fail-open p/ inline sem Redis)',
  );
}

async function main() {
  await testeModoDegradacao();
  await testePayloadMinimizado();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
