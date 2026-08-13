#!/usr/bin/env node
// scripts/cache-fila.smoke.mjs
//
// Smoke determinístico (sem rede) do cache-aside da fila/script do discador
// (Fase 08, escala-150-atendentes, CACHE-01). Roda SEM `--env-file`
// (REDIS_URL vazio) e prova que, em MODO memoria: (1) `modoCacheFila()` é
// 'memoria'; (2) os getters retornam `null` (degradação DIRETA ao ClickUp,
// D-02/SC5 — NÃO um cache in-process); (3) os setters/invalidadores/
// warm-on-write são no-op e NUNCA lançam.
//
// A validação E2E do hit/round-trip real do cache (TTL, isolamento por
// operador com dois assigneeIds, warm de fato) só é verificável com um Redis
// real — diferida (mesmo padrão de 05-04/06-05/08-01 SUMMARY).
//
// Uso: node --experimental-strip-types scripts/cache-fila.smoke.mjs

import {
  obterFilaCache,
  guardarFilaCache,
  invalidarFilaCache,
  removerDaFilaCache,
  aquecerFilaCache,
  obterLigacaoCache,
  guardarLigacaoCache,
  modoCacheFila,
  fecharCacheFila,
} from '../src/mastra/cache-fila.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function testeModo() {
  checar(
    modoCacheFila() === 'memoria',
    `modoCacheFila() deveria ser 'memoria' sem REDIS_URL, recebido: '${modoCacheFila()}'`,
  );
}

async function testeDegradacaoDireta() {
  checar(
    (await obterFilaCache('op-1')) === null,
    'obterFilaCache deveria ser null sem Redis (degrada direto ao ClickUp, SC5)',
  );
  checar(
    (await obterLigacaoCache('op-1', 'task-1')) === null,
    'obterLigacaoCache deveria ser null sem Redis (degrada direto ao ClickUp, SC5)',
  );
}

async function testeSettersNaoLancam() {
  const filaFake = [{ taskId: 'task-1', nome: 'Fulano', telefone: '5511999998888', idLead: 'lead-1' }];
  await guardarFilaCache('op-1', filaFake);
  await invalidarFilaCache('op-1');
  await removerDaFilaCache('op-1', 'task-1');
  await guardarLigacaoCache('op-1', 'task-1', { ...filaFake[0], script: 'roteiro' });
  // Sempre chega aqui sem lançar — o próprio fato de não ter lançado já é a prova.
  checar(true, 'setters/invalidadores em modo memoria nao deveriam lancar');
}

async function testeAquecerFilaCacheNaoLanca() {
  // merge parcial (objeto) — no-op sem Redis, nunca lança.
  await aquecerFilaCache('op-1', 'task-1', { nome: 'Fulano Atualizado' });
  // remove (null) — no-op sem Redis, nunca lança.
  await aquecerFilaCache('op-1', 'task-1', null);
  checar(true, 'aquecerFilaCache (merge e remove) em modo memoria nao deveria lancar');
}

async function main() {
  testeModo();
  await testeDegradacaoDireta();
  await testeSettersNaoLancam();
  await testeAquecerFilaCacheNaoLanca();

  await fecharCacheFila();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
