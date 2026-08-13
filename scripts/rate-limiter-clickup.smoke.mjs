#!/usr/bin/env node
// scripts/rate-limiter-clickup.smoke.mjs
//
// Smoke determinístico (sem rede/Redis) do rate limiter global do ClickUp
// (`src/mastra/rate-limiter-clickup.ts`, Fase 08, CACHE-02). Roda SEM
// REDIS_URL no ambiente (modo memoria) e prova:
//   1. Degradação graciosa — `modoRateLimiter() === 'memoria'` sem REDIS_URL
//      (mesmo molde de estado-webhook.ts/fila.ts: MODO decidido no boot).
//   2. Bounded-wait never-throws (D-06) — uma rajada de N chamadas
//      `adquirirToken()` (N > RL_CLICKUP_MAX) resolve TODAS sem lançar,
//      nunca gerando 429 pro chamador; o tempo total respeita o teto de
//      espera configurado (RL_CLICKUP_WAIT_MAX_MS), não escala sem limite.
//   3. `fecharRateLimiter()` roda sem lançar (no-op em modo memoria).
//
// A validação E2E-com-Redis (bucket GLOBAL entre réplicas, 429 real do
// ClickUp sob volume real) fica FORA deste smoke — precisa de Redis real e
// múltiplos processos. Mesmo padrão dos smokes das Fases 05/06
// (fila-assincrona.smoke.mjs, dispositivos.smoke.mjs).
//
// Uso: node --experimental-strip-types scripts/rate-limiter-clickup.smoke.mjs

import { adquirirToken, modoRateLimiter, fecharRateLimiter } from '../src/mastra/rate-limiter-clickup.ts';
import { RL_CLICKUP_MAX, RL_CLICKUP_WAIT_MAX_MS } from '../src/mastra/config.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function testeModoDegradacao() {
  checar(
    modoRateLimiter() === 'memoria',
    `modoRateLimiter() deveria ser 'memoria' sem REDIS_URL, recebido: '${modoRateLimiter()}'`,
  );
}

/**
 * D-06 — o check central do smoke: dispara uma rajada MUITO acima do teto do
 * balde (N > RL_CLICKUP_MAX) e prova que TODAS as chamadas resolvem sem
 * lançar (bounded-wait/fail-open), nunca 429. Cronometra que o total NÃO
 * excede (com folga) o teto de espera configurado — prova que o "bounded"
 * do bounded-wait é real (não é um retry sem fim).
 */
async function testeRajadaBoundedWaitNeverThrows() {
  const N = RL_CLICKUP_MAX + 50; // bem acima da capacidade do balde
  const inicio = performance.now();

  const promessas = [];
  for (let i = 0; i < N; i++) promessas.push(adquirirToken());

  let lancou = false;
  try {
    await Promise.all(promessas);
  } catch {
    lancou = true;
  }
  const duracaoMs = performance.now() - inicio;

  checar(!lancou, `adquirirToken() não deveria lançar mesmo em rajada acima do limite (N=${N}), mas lançou`);

  // Folga generosa (2x + 1s) sobre o teto configurado — cada chamada individual
  // tem seu próprio orçamento de RL_CLICKUP_WAIT_MAX_MS, mas todas rodam
  // concorrentes (Promise.all), então o total não deveria disparar muito além
  // de um único orçamento de espera.
  const limiteMs = RL_CLICKUP_WAIT_MAX_MS * 2 + 1000;
  checar(
    duracaoMs < limiteMs,
    `rajada de ${N} chamadas deveria terminar em < ${limiteMs}ms (bounded-wait real, RL_CLICKUP_WAIT_MAX_MS=${RL_CLICKUP_WAIT_MAX_MS}), recebido: ${duracaoMs.toFixed(0)}ms`,
  );

  console.log(
    `[rate-limiter-clickup.smoke] rajada de ${N} chamadas (capacidade=${RL_CLICKUP_MAX}) resolveu em ${duracaoMs.toFixed(0)}ms sem lançar`,
  );
}

async function testeFechar() {
  let lancou = false;
  try {
    await fecharRateLimiter();
  } catch {
    lancou = true;
  }
  checar(!lancou, 'fecharRateLimiter() não deveria lançar em modo memoria (no-op)');
}

async function main() {
  testeModoDegradacao();
  await testeRajadaBoundedWaitNeverThrows();
  await testeFechar();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
