// Rate limiter GLOBAL do worker de dreno do outbox (Fase B, Phase 19 Plano
// 06 — endurece o dreno criado no 19-03, ESCRITA-04/design §3.2/Riscos R9).
//
// MOLDE do token bucket Lua atômico de rate-limiter-clickup.ts (mesma
// matemática de refil, mesmo balde HASH `tokens`/`ts` em Redis, mesma
// atomicidade entre réplicas) — mas o COMPORTAMENTO DE ERRO É O OPOSTO:
//
//   rate-limiter-clickup.ts (adquirirToken)  = FAIL-OPEN.  Está na frente de
//     uma chamada SÍNCRONA do usuário (o closer clicando "ligar"/"desfecho")
//     — nunca pode travar essa chamada por falha própria; sem Redis, degrada
//     para um bucket em MEMÓRIA por processo (best-effort).
//
//   rate-limiter-dreno.ts (adquirirTokenDreno) = FAIL-CLOSED. Está na frente
//     de um WORKER DE FUNDO (drenar-outbox.ts) que empurra pushes ao MESMO
//     ClickUp. O teto de ~90/min só é real se for imposto por um balde
//     CENTRAL somando TODAS as réplicas — um bucket em memória por-processo
//     furaria o teto (N réplicas × concurrency não somam 90/min, cada
//     processo teria seu próprio balde cheio). Por isso este módulo NÃO tem
//     modo memória: sem REDIS_URL (ou qualquer erro do Redis em runtime),
//     `adquirirTokenDreno()` retorna `false` (BLOQUEADO) — o caller (o loop
//     do dreno) trata isso como "adiar": a linha do outbox permanece
//     pendente/erro e é retentada quando o Redis voltar (BullMQ backoff ou o
//     próximo tick do fallback inline). Deixar passar sob Redis-fora
//     re-dispararia a mesma varredura sem teto que agravou o incidente de
//     2026-08-20 (R9) — o dreno não pode ser essa varredura.
//
// "Lease central": o teto GLOBAL não é imposto por `concurrency` do BullMQ
// (isso é por-worker/por-processo — N réplicas × concurrency furam os
// 90/min); é imposto pelo balde Redis COMPARTILHADO (Lua atômico, `EVAL`
// entre réplicas concorrentes) — esse balde É o lease central.
//
// LGPD: nunca loga REDIS_URL/token/URL — só o modo e a classe do erro (mesmo
// padrão de rate-limiter-clickup.ts/estado-webhook.ts).

import Redis from 'ioredis';
import { REDIS_URL, DRENO_RATE_MAX, DRENO_RATE_WINDOW_MS, RL_CLICKUP_WAIT_MAX_MS } from './config.ts';

// Sem modo 'memoria' aqui (ao contrário de rate-limiter-clickup.ts) — o teto
// GLOBAL só existe com o balde Redis central; sem Redis o dreno bloqueia.
const MODO: 'redis' | 'sem-redis' = REDIS_URL ? 'redis' : 'sem-redis';

// Chave PRÓPRIA — nunca compartilha o balde `rl:clickup:bucket` do limiter
// síncrono: o dreno de fundo e a fila síncrona dos closers disputam o MESMO
// ClickUp mas cada um tem seu orçamento (o design §3.2 trata o teto do dreno
// como throughput de sync de fundo, não latência do usuário).
const CHAVE_BUCKET = 'rl:dreno:bucket';

// Passo do laço de espera limitada — mesmo molde de rate-limiter-clickup.ts
// (PASSO_ESPERA_MS): nunca dorme mais que isso por iteração. O teto TOTAL de
// espera reusa RL_CLICKUP_WAIT_MAX_MS (config.ts, 19-01) — não se redefine
// um env próprio aqui; ao esgotar o teto, BLOQUEIA (fail-CLOSED) em vez de
// deixar passar.
const PASSO_ESPERA_MS = 100;

let cliente: Redis | null = null;

/** Instancia o cliente na primeira operação (lazy) e reusa depois (singleton) — mesmo molde de rate-limiter-clickup.ts. */
function garantirCliente(): Redis {
  if (!cliente) {
    cliente = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectTimeout: 5000,
    });
    // Nunca derruba o processo com unhandled error — mensagem curta, NUNCA a
    // REDIS_URL (pode embutir credencial).
    cliente.on('error', (e) => {
      console.error('[rate-limiter-dreno] erro de conexao Redis (fail-CLOSED — bloqueando):', e instanceof Error ? e.message : String(e));
    });
  }
  return cliente;
}

// Mesmo Lua atômico de rate-limiter-clickup.ts (token bucket em HASH
// `tokens`/`ts`, refil proporcional ao tempo decorrido) — duplicado aqui
// (chave/balde PRÓPRIOS) para manter este módulo self-contained, mesmo
// racional de outbox-repo.ts (não importar entre módulos-irmãos de
// rate-limiter para preservar testabilidade standalone via
// `node --experimental-strip-types`).
const LUA_TOKEN_BUCKET = `
local chave = KEYS[1]
local agora = tonumber(ARGV[1])
local capacidade = tonumber(ARGV[2])
local janela = tonumber(ARGV[3])

local valores = redis.call('HMGET', chave, 'tokens', 'ts')
local tokens = tonumber(valores[1])
local ts = tonumber(valores[2])

if tokens == nil or ts == nil then
  tokens = capacidade
  ts = agora
end

local decorrido = agora - ts
if decorrido > 0 then
  local refil = decorrido * capacidade / janela
  tokens = math.min(capacidade, tokens + refil)
  ts = agora
end

local permitido = 0
local espera = 0
if tokens >= 1 then
  tokens = tokens - 1
  permitido = 1
else
  local faltando = 1 - tokens
  espera = math.ceil(faltando * janela / capacidade)
end

redis.call('HSET', chave, 'tokens', tostring(tokens), 'ts', tostring(ts))
redis.call('PEXPIRE', chave, janela * 2)

return {permitido, espera}
`;

/** Uma tentativa de tomar um token via Lua atômico. Lança em erro do Redis — o caller (adquirirTokenDreno) trata como fail-CLOSED. */
async function tentarTokenRedis(): Promise<{ permitido: boolean; esperaMs: number }> {
  const resultado = (await garantirCliente().eval(
    LUA_TOKEN_BUCKET,
    1,
    CHAVE_BUCKET,
    Date.now(),
    DRENO_RATE_MAX,
    DRENO_RATE_WINDOW_MS,
  )) as [number, number];
  return { permitido: resultado[0] === 1, esperaMs: resultado[1] };
}

/**
 * Adquire um token do balde GLOBAL antes de UMA saída do dreno ao ClickUp.
 * FAIL-CLOSED (o oposto de rate-limiter-clickup.ts::adquirirToken):
 *
 *   - Sem REDIS_URL (`MODO !== 'redis'`) → retorna `false` IMEDIATAMENTE,
 *     sem tentar nenhum bucket local. O teto global exige o balde central;
 *     sem ele, o dreno não emite (o caller adia, o outbox permanece
 *     pendente/erro e drena quando o Redis voltar).
 *   - Com Redis, espera LIMITADA (bounded-wait, mesmo teto
 *     RL_CLICKUP_WAIT_MAX_MS do limiter síncrono) enquanto o balde está
 *     vazio; ao esgotar o teto de espera → retorna `false` (BLOQUEADO), NÃO
 *     deixa passar.
 *   - Qualquer erro do Redis em runtime (conexão caiu, timeout, etc.) →
 *     retorna `false` IMEDIATAMENTE — fail-CLOSED, nunca fail-open.
 *
 * Isto impede N réplicas × concurrency por-worker de furarem os ~90/min: o
 * único jeito de conseguir `true` é o balde Redis COMPARTILHADO ter tokens
 * (o lease central, somando todas as réplicas).
 */
export async function adquirirTokenDreno(): Promise<boolean> {
  if (MODO !== 'redis') {
    console.warn('[rate-limiter-dreno] sem REDIS_URL — bloqueando (fail-CLOSED): sem balde central não há teto global real');
    return false;
  }

  const inicio = Date.now();
  for (;;) {
    let tentativa: { permitido: boolean; esperaMs: number };
    try {
      tentativa = await tentarTokenRedis();
    } catch (e) {
      console.error('[rate-limiter-dreno] falha ao adquirir token (fail-CLOSED — bloqueando):', e instanceof Error ? e.message : String(e));
      return false;
    }
    if (tentativa.permitido) return true;

    const decorrido = Date.now() - inicio;
    if (decorrido >= RL_CLICKUP_WAIT_MAX_MS) {
      console.warn('[rate-limiter-dreno] teto de espera atingido — bloqueando (fail-CLOSED), a linha do outbox permanece pendente');
      return false;
    }
    const restante = RL_CLICKUP_WAIT_MAX_MS - decorrido;
    const delay = Math.max(1, Math.min(tentativa.esperaMs, PASSO_ESPERA_MS, restante));
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** 'redis' ou 'sem-redis' — usado pelo smoke e pelo log de boot. */
export function modoRateLimiterDreno(): 'redis' | 'sem-redis' {
  return MODO;
}

/** Fecha o cliente Redis (graceful shutdown do worker). No-op em modo sem-redis. */
export async function fecharRateLimiterDreno(): Promise<void> {
  if (cliente) {
    await cliente.quit();
    cliente = null;
  }
}

console.log(
  MODO === 'redis'
    ? '[rate-limiter-dreno] limiter GLOBAL fail-CLOSED via Redis ativo (teto do dreno de fundo)'
    : '[rate-limiter-dreno] sem REDIS_URL — dreno ficará BLOQUEADO (fail-CLOSED) até o Redis estar disponível',
);
