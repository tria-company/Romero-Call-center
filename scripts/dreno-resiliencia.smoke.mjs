#!/usr/bin/env node
// scripts/dreno-resiliencia.smoke.mjs
//
// Smoke determinístico (OFFLINE — sem Redis real) da resiliência do dreno
// (Fase B, Phase 19 Plano 06, ESCRITA-04/design §3.2/Riscos R9):
// `src/mastra/rate-limiter-dreno.ts`. Roda SEM REDIS_URL no ambiente e prova
// o CONTRASTE fail-open (rate-limiter-clickup.ts, síncrono) vs. fail-CLOSED
// (rate-limiter-dreno.ts, o dreno de fundo) — a garantia central de R9:
//
//   1. `modoRateLimiterDreno() === 'sem-redis'` sem REDIS_URL (MODO decidido
//      no import-time, mesmo molde de estado-webhook.ts/fila.ts).
//   2. `adquirirTokenDreno()` retorna `false` (BLOQUEADO) sem Redis — nunca
//      lança, nunca deixa passar.
//   3. Contraste: `adquirirToken()` (rate-limiter-clickup.ts, o MESMO cenário
//      sem Redis) NUNCA bloqueia — resolve sem lançar (fail-open, cai no
//      bucket em memória local). Prova que os dois módulos têm posturas
//      OPOSTAS de erro por design, não por acidente.
//   4. `fecharRateLimiterDreno()` roda sem lançar (no-op sem cliente).
//
// A validação E2E-com-Redis (balde GLOBAL somando réplicas, bounded-wait
// real) fica FORA deste smoke — precisa de Redis real e múltiplos processos
// (mesmo padrão de rate-limiter-clickup.smoke.mjs).
//
// Uso: node --experimental-strip-types scripts/dreno-resiliencia.smoke.mjs

import { adquirirTokenDreno, modoRateLimiterDreno, fecharRateLimiterDreno } from '../src/mastra/rate-limiter-dreno.ts';
import { adquirirToken, modoRateLimiter } from '../src/mastra/rate-limiter-clickup.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function testeModoSemRedis() {
  checar(
    modoRateLimiterDreno() === 'sem-redis',
    `modoRateLimiterDreno() deveria ser 'sem-redis' sem REDIS_URL, recebido: '${modoRateLimiterDreno()}'`,
  );
}

async function testeFailClosedSemRedis() {
  const permitido = await adquirirTokenDreno();
  checar(
    permitido === false,
    `adquirirTokenDreno() deveria retornar false (fail-CLOSED) sem REDIS_URL, recebido: ${permitido}`,
  );
}

/**
 * O contraste é a prova central deste smoke (R9): no MESMO ambiente sem
 * Redis, o limiter síncrono do ClickUp (que está na frente da chamada do
 * usuário) NUNCA bloqueia — degrada para um bucket em memória e resolve sem
 * lançar. O limiter do dreno (que está na frente de um worker de fundo)
 * bloqueia SEMPRE nesse mesmo cenário. Não é o mesmo módulo com config
 * diferente — são posturas de erro opostas por design.
 */
async function testeContrasteFailOpenVsFailClosed() {
  checar(
    modoRateLimiter() === 'memoria',
    `rate-limiter-clickup.ts deveria estar em modo 'memoria' sem REDIS_URL (contraste), recebido: '${modoRateLimiter()}'`,
  );

  let lancou = false;
  try {
    await adquirirToken();
  } catch {
    lancou = true;
  }
  checar(
    !lancou,
    'adquirirToken() (rate-limiter-clickup, fail-OPEN) não deveria lançar sem Redis — o contraste com adquirirTokenDreno() (fail-CLOSED) é a garantia de R9',
  );
}

async function testeFechar() {
  let lancou = false;
  try {
    await fecharRateLimiterDreno();
  } catch {
    lancou = true;
  }
  checar(!lancou, 'fecharRateLimiterDreno() não deveria lançar sem cliente Redis instanciado (no-op)');
}

async function main() {
  testeModoSemRedis();
  await testeFailClosedSemRedis();
  await testeContrasteFailOpenVsFailClosed();
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
