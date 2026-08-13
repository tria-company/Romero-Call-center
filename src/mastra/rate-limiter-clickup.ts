// Rate limiter global do ClickUp (Fase 8, escala-150-atendentes, CACHE-02).
//
// Token bucket ~90 req/min COMPARTILHADO via Redis (D-05) na frente de TODAS
// as chamadas de saída ao ClickUp — o choke point único é `fetchClickUp()`
// em clickup.ts, que chama `adquirirToken()` imediatamente antes de cada
// `fetchTimeout()`. Ao esvaziar o balde, a chamada ESPERA um token com teto
// limitado (bounded-wait, D-06) em vez de estourar 429 pro chamador.
//
// Mesma casca Redis-ou-memória de estado-webhook.ts: MODO decidido UMA vez no
// boot pelo valor de REDIS_URL, cliente lazy singleton, NUNCA lança pro
// chamador — qualquer falha do Redis em runtime dentro de `adquirirToken`
// degrada para fail-open (deixa passar). Sem REDIS_URL, aplica o MESMO
// algoritmo num bucket local por processo (best-effort; com 1 instância o
// limite local ≈ global, D-02).
//
// LGPD: este módulo NUNCA loga telefone/CPF/token/REDIS_URL/URL de request —
// só o modo, o nome da chave e a classe/mensagem do erro.

import Redis from 'ioredis';
import { REDIS_URL, RL_CLICKUP_MAX, RL_CLICKUP_WINDOW_MS, RL_CLICKUP_WAIT_MAX_MS } from './config.ts';

const MODO: 'redis' | 'memoria' = REDIS_URL ? 'redis' : 'memoria';

const CHAVE_BUCKET = 'rl:clickup:bucket';

// Passo do laço de espera limitada (D-06) — nunca dorme mais que isso por
// iteração, mesmo se o Lua reportar uma espera maior; o teto TOTAL é
// RL_CLICKUP_WAIT_MAX_MS.
const PASSO_ESPERA_MS = 100;

// ===== Backend REDIS — cliente lazy, token bucket atômico via Lua =====

let cliente: Redis | null = null;

/** Instancia o cliente na primeira operação (lazy) e reusa depois (singleton) — mesmo molde de estado-webhook.ts. */
function garantirCliente(): Redis {
  if (!cliente) {
    cliente = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectTimeout: 5000,
    });
    // So para nao derrubar o processo com unhandled error — mensagem curta,
    // NUNCA a REDIS_URL (pode embutir credencial).
    cliente.on('error', (e) => {
      console.error('[rate-limiter] erro de conexao Redis (degradando):', e instanceof Error ? e.message : String(e));
    });
  }
  return cliente;
}

// Token bucket atômico: o balde é um HASH Redis (`tokens`, `ts`) que recarrega
// proporcional ao tempo decorrido desde `ts` (refil = decorrido * capacidade /
// janela, capado em capacidade). Se tokens >= 1, decrementa 1 e retorna
// [1, 0] (permitido); senão retorna [0, esperaMs] (tempo até o próximo
// token). Lua garante atomicidade entre réplicas — o balde é GLOBAL (D-05).
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

/** Uma tentativa de tomar um token via Lua atômico. Lança em erro do Redis — o caller (adquirirToken) faz fail-open. */
async function tentarTokenRedis(): Promise<{ permitido: boolean; esperaMs: number }> {
  const resultado = (await garantirCliente().eval(
    LUA_TOKEN_BUCKET,
    1,
    CHAVE_BUCKET,
    Date.now(),
    RL_CLICKUP_MAX,
    RL_CLICKUP_WINDOW_MS,
  )) as [number, number];
  return { permitido: resultado[0] === 1, esperaMs: resultado[1] };
}

// ===== Backend MEMORIA — mesmo algoritmo, bucket local por processo =====

let tokensMem = RL_CLICKUP_MAX;
let tsMem = Date.now();

/** Mesma matemática de refil do Lua, aplicada num estado in-process (D-02: throttle onde possível). */
function tentarTokenMem(): { permitido: boolean; esperaMs: number } {
  const agora = Date.now();
  const decorrido = agora - tsMem;
  if (decorrido > 0) {
    const refil = (decorrido * RL_CLICKUP_MAX) / RL_CLICKUP_WINDOW_MS;
    tokensMem = Math.min(RL_CLICKUP_MAX, tokensMem + refil);
    tsMem = agora;
  }
  if (tokensMem >= 1) {
    tokensMem -= 1;
    return { permitido: true, esperaMs: 0 };
  }
  const faltando = 1 - tokensMem;
  const esperaMs = Math.ceil((faltando * RL_CLICKUP_WINDOW_MS) / RL_CLICKUP_MAX);
  return { permitido: false, esperaMs };
}

// ===== Superfície pública =====

/**
 * Adquire um token do balde antes de uma chamada de saída ao ClickUp. Espera
 * LIMITADA (bounded-wait, D-06) enquanto o balde está vazio — nunca lança,
 * nunca faz o chamador receber 429. Ao esgotar o teto de espera
 * (RL_CLICKUP_WAIT_MAX_MS), loga um warn curto e deixa passar (fail-open).
 * Qualquer erro do Redis em runtime também faz fail-open imediato — o
 * limiter nunca pode bloquear a chamada ao ClickUp por falha própria.
 */
export async function adquirirToken(): Promise<void> {
  const inicio = Date.now();
  for (;;) {
    let tentativa: { permitido: boolean; esperaMs: number };
    try {
      tentativa = MODO === 'redis' ? await tentarTokenRedis() : tentarTokenMem();
    } catch (e) {
      console.error('[rate-limiter] falha ao adquirir token (degradando p/ fail-open):', e instanceof Error ? e.message : String(e));
      return;
    }
    if (tentativa.permitido) return;

    const decorrido = Date.now() - inicio;
    if (decorrido >= RL_CLICKUP_WAIT_MAX_MS) {
      console.warn('[rate-limiter] teto de espera atingido — deixando passar (fail-open)');
      return;
    }
    const restante = RL_CLICKUP_WAIT_MAX_MS - decorrido;
    const delay = Math.max(1, Math.min(tentativa.esperaMs, PASSO_ESPERA_MS, restante));
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** 'redis' ou 'memoria' — usado pelo smoke e pelo log de boot. */
export function modoRateLimiter(): 'redis' | 'memoria' {
  return MODO;
}

/** Fecha o cliente Redis (graceful shutdown) — no-op em modo memoria. */
export async function fecharRateLimiter(): Promise<void> {
  if (cliente) {
    await cliente.quit();
    cliente = null;
  }
}

console.log(
  MODO === 'redis'
    ? '[rate-limiter] limiter global via Redis'
    : '[rate-limiter] limiter local por processo',
);
