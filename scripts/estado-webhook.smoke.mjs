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
  guardarCorrelacaoDevice,
  lerCorrelacaoDevice,
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

// DEVICE-03: correlação de device (call->deviceId) — separada da correlação
// de telefone (guardarCorrelacao/lerCorrelacao, testada acima).
async function testeCorrelacaoDevice() {
  await guardarCorrelacaoDevice('call1', 'dev1');
  checar(
    (await lerCorrelacaoDevice('call1')) === 'dev1',
    'lerCorrelacaoDevice deveria devolver o deviceId guardado pra call1',
  );
  checar(
    (await lerCorrelacaoDevice('nao-existe')) === null,
    'lerCorrelacaoDevice de um callId inexistente deveria ser null (miss)',
  );
}

// DEVICE-03/DD-07-12: o núcleo da desambiguação — 2 devices ligando pro
// MESMO telefone ao mesmo tempo não podem embaralhar a task ativa um do
// outro. lerTaskAtiva SEM deviceId ainda resolve (fallback telefone-só,
// best-effort, DD-07-13).
async function testeDesambiguacaoPorDevice() {
  const tel = '5511988887777';
  await guardarTaskAtiva(tel, 'taskA', 'dev1');
  await guardarTaskAtiva(tel, 'taskB', 'dev2');
  checar(
    (await lerTaskAtiva(tel, 'dev1')) === 'taskA',
    'lerTaskAtiva(tel, dev1) deveria resolver taskA — não deveria embaralhar com dev2',
  );
  checar(
    (await lerTaskAtiva(tel, 'dev2')) === 'taskB',
    'lerTaskAtiva(tel, dev2) deveria resolver taskB — não deveria embaralhar com dev1',
  );
  checar(
    (await lerTaskAtiva(tel)) !== null,
    'lerTaskAtiva(tel) SEM deviceId ainda deveria resolver (cai na chave telefone-só, best-effort)',
  );
  await limparTaskAtiva(tel, 'dev2');
  checar(
    (await lerTaskAtiva(tel, 'dev2')) === null,
    'lerTaskAtiva(tel, dev2) depois de limparTaskAtiva(tel, dev2) deveria ser null (chave composta limpa)',
  );
}

async function main() {
  testeModo();
  await testeCorrelacao();
  await testeCorrelacaoDevice();
  await testeTaskAtivaComNormalizacao();
  await testeDesambiguacaoPorDevice();
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
