#!/usr/bin/env node
// scripts/estado-webhook.smoke.mjs
//
// Smoke determinístico (sem rede) da camada Redis-ou-memória do estado do
// webhook Wavoip (Fase 05, escala-150-atendentes). Roda SEM `--env-file`
// (REDIS_URL vazio) e prova que o modo MEMÓRIA tem semântica IDÊNTICA à dos 4
// Maps/Sets que existiam antes desta fase: correlação round-trip, task ativa
// com normalização só-dígitos + limpar, dedup de RECORD (marcar/liberar) e
// dedup de falha terminal (marcar + callId vazio sempre processa).
//
// A validação E2E-com-Redis (2 processos lendo a mesma correlação; RECORD não
// duplica sob restart) fica FORA deste smoke — precisa de um Redis real, que
// não existe nesta sessão ("construir código primeiro"). Ver roteiro no
// 05-04-SUMMARY.md.
//
// Uso: node --experimental-strip-types scripts/estado-webhook.smoke.mjs

import {
  guardarCorrelacao,
  lerCorrelacao,
  guardarTaskAtiva,
  lerTaskAtiva,
  limparTaskAtiva,
  marcarRecordProcessado,
  liberarRecordProcessado,
  marcarCallFalhaProcessada,
  modoEstadoWebhook,
  fecharEstadoWebhook,
} from '../src/mastra/estado-webhook.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function testeModo() {
  checar(
    modoEstadoWebhook() === 'memoria',
    `modoEstadoWebhook() deveria ser 'memoria' sem REDIS_URL, recebido: '${modoEstadoWebhook()}'`,
  );
}

async function testeCorrelacao() {
  await guardarCorrelacao('call-1', '5511999998888');
  checar(
    (await lerCorrelacao('call-1')) === '5511999998888',
    'lerCorrelacao deveria devolver o telefone guardado pra call-1',
  );
  checar(
    (await lerCorrelacao('nao-existe')) === null,
    'lerCorrelacao de um callId inexistente deveria ser null (miss)',
  );
}

async function testeTaskAtivaComNormalizacao() {
  await guardarTaskAtiva('+55 11 99999-8888', 'task-9');
  checar(
    (await lerTaskAtiva('5511999998888')) === 'task-9',
    'lerTaskAtiva por telefone só-dígitos deveria achar a task guardada com telefone cru',
  );
  checar(
    (await lerTaskAtiva('+55 11 99999-8888')) === 'task-9',
    'lerTaskAtiva pelo mesmo telefone cru (normalizado igual) deveria achar a mesma task',
  );
  await limparTaskAtiva('5511999998888');
  checar(
    (await lerTaskAtiva('5511999998888')) === null,
    'lerTaskAtiva depois de limparTaskAtiva deveria ser null',
  );
}

async function testeDedupRecord() {
  checar(
    (await marcarRecordProcessado('rec-1')) === true,
    'marcarRecordProcessado deveria ser true na 1a vez (recém-marcado)',
  );
  checar(
    (await marcarRecordProcessado('rec-1')) === false,
    'marcarRecordProcessado deveria ser false na 2a vez (já processado — duplicado)',
  );
  await liberarRecordProcessado('rec-1');
  checar(
    (await marcarRecordProcessado('rec-1')) === true,
    'marcarRecordProcessado deveria voltar a ser true depois de liberarRecordProcessado (permite retry)',
  );
}

async function testeDedupFalhaTerminal() {
  checar(
    (await marcarCallFalhaProcessada('c-1')) === true,
    'marcarCallFalhaProcessada deveria ser true na 1a vez',
  );
  checar(
    (await marcarCallFalhaProcessada('c-1')) === false,
    'marcarCallFalhaProcessada deveria ser false na 2a vez (já processado)',
  );
  checar(
    (await marcarCallFalhaProcessada('')) === true,
    'marcarCallFalhaProcessada("") deveria ser SEMPRE true (sem callId não há chave de dedup)',
  );
  checar(
    (await marcarCallFalhaProcessada('')) === true,
    'marcarCallFalhaProcessada("") repetido continua true — callId vazio processa sempre',
  );
}

async function testeIsolamentoEntreConteineres() {
  await marcarRecordProcessado('k');
  checar(
    (await marcarCallFalhaProcessada('k')) === true,
    'uma chave marcada em records não deveria afetar o dedup de falha terminal (containers isolados)',
  );
}

async function main() {
  testeModo();
  await testeCorrelacao();
  await testeTaskAtivaComNormalizacao();
  await testeDedupRecord();
  await testeDedupFalhaTerminal();
  await testeIsolamentoEntreConteineres();

  await fecharEstadoWebhook();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
