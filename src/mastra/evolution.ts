// Client REST da Evolution API — canal de envio dedicado de WhatsApp (Fase
// 12, v3.0 Fluxo A). Este é o choke-point ÚNICO de saída pro WhatsApp: toda
// chamada de rede passa por `fetchEvolution()`, que adquire um token do rate
// limiter EMBUTIDO (D-06) imediatamente antes do `fetchTimeout()` — nenhum
// caminho de envio escapa do throttle, mesmo com cliques rápidos/múltiplas
// abas (ENVIO-05).
//
// DIVERGÊNCIA DELIBERADA vs rate-limiter-clickup.ts: ali, ao esgotar o
// bounded-wait, a chamada faz FAIL-OPEN (deixa passar) porque uma escrita
// atrasada no ClickUp é inócua. Aqui o cap SEGURA — ao esgotar o teto de
// espera, `adquirirTokenEvolution()` LANÇA em vez de deixar passar, porque
// exceder o throughput da Evolution é risco de BANIMENTO do número dedicado
// (Pitfall 1 da pesquisa), não um atraso inócuo.
//
// Autenticação: header `apikey` (minúsculo) da instância — NÃO o header
// Bearer usado pela Wavoip (wavoip-api.ts), convenção diferente.
//
// LGPD/segredo: NUNCA logar EVOLUTION_API_KEY, telefone nem os bytes/base64
// do áudio — só a classe/mensagem do erro (mesmo espírito de
// rate-limiter-clickup.ts).

import Redis from 'ioredis';
import {
  EVOLUTION_API_URL,
  EVOLUTION_API_KEY,
  EVOLUTION_INSTANCE,
  EVOLUTION_MAX_POR_MINUTO,
  RL_EVOLUTION_WAIT_MAX_MS,
  REDIS_URL,
} from './config.ts';
import { fetchTimeout } from './http.ts';

// ===== Erro tipado de throttle (IN-03) =====

/**
 * Erro tipado lançado por `adquirirTokenEvolution()` quando o cap de envio
 * SEGURA (bounded-wait esgotado ou falha do backend do limiter). IN-03: o
 * caller (`classificarFalhaEnvioAudio` em index.ts) classifica pelo TIPO
 * (`instanceof EvolutionThrottleError`) em vez de casar a substring `throttle`
 * na mensagem — o texto humano-legível pode mudar sem quebrar a classificação
 * de três vias. A marca `code` dá um discriminador estável e serializável.
 */
export class EvolutionThrottleError extends Error {
  readonly code = 'evolution_throttle' as const;
  constructor(message: string) {
    super(message);
    this.name = 'EvolutionThrottleError';
  }
}

// ===== Rate limiter EMBUTIDO (D-06) — mesma casca de rate-limiter-clickup.ts =====

const MODO: 'redis' | 'memoria' = REDIS_URL ? 'redis' : 'memoria';

const CHAVE_BUCKET = 'rl:evolution:bucket';

// Janela fixa de 60s (por-minuto, igual ao nome de EVOLUTION_MAX_POR_MINUTO).
const JANELA_MS = 60_000;

// Passo do laço de espera limitada — nunca dorme mais que isso por iteração,
// mesmo se o Lua reportar uma espera maior; o teto TOTAL é RL_EVOLUTION_WAIT_MAX_MS.
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
    // So para nao derrubar o processo com unhandled error — mensagem curta,
    // NUNCA a REDIS_URL (pode embutir credencial).
    cliente.on('error', (e) => {
      console.error('[evolution] erro de conexao Redis do rate limiter:', e instanceof Error ? e.message : String(e));
    });
  }
  return cliente;
}

// Token bucket atômico — mesmo script Lua de rate-limiter-clickup.ts (HASH
// `tokens`/`ts`, refil proporcional ao tempo decorrido, capado na capacidade).
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

/** Uma tentativa de tomar um token via Lua atômico. Lança em erro do Redis — o caller (adquirirTokenEvolution) decide (aqui: NUNCA fail-open). */
async function tentarTokenRedis(): Promise<{ permitido: boolean; esperaMs: number }> {
  const resultado = (await garantirCliente().eval(
    LUA_TOKEN_BUCKET,
    1,
    CHAVE_BUCKET,
    Date.now(),
    EVOLUTION_MAX_POR_MINUTO,
    JANELA_MS,
  )) as [number, number];
  return { permitido: resultado[0] === 1, esperaMs: resultado[1] };
}

// ===== Backend MEMORIA — mesmo algoritmo, bucket local por processo =====

let tokensMem = EVOLUTION_MAX_POR_MINUTO;
let tsMem = Date.now();

function tentarTokenMem(): { permitido: boolean; esperaMs: number } {
  const agora = Date.now();
  const decorrido = agora - tsMem;
  if (decorrido > 0) {
    const refil = (decorrido * EVOLUTION_MAX_POR_MINUTO) / JANELA_MS;
    tokensMem = Math.min(EVOLUTION_MAX_POR_MINUTO, tokensMem + refil);
    tsMem = agora;
  }
  if (tokensMem >= 1) {
    tokensMem -= 1;
    return { permitido: true, esperaMs: 0 };
  }
  const faltando = 1 - tokensMem;
  const esperaMs = Math.ceil((faltando * JANELA_MS) / EVOLUTION_MAX_POR_MINUTO);
  return { permitido: false, esperaMs };
}

/**
 * Adquire um token do balde antes de uma chamada de saída à Evolution.
 * Espera LIMITADA (bounded-wait) enquanto o balde está vazio — igual ao
 * espírito de rate-limiter-clickup.ts. DIVERGÊNCIA DELIBERADA: ao esgotar o
 * teto de espera (RL_EVOLUTION_WAIT_MAX_MS), o cap SEGURA — LANÇA em vez de
 * fail-open, porque exceder o throughput da Evolution arrisca banir o número
 * dedicado (Pitfall 1). Um erro do Redis em runtime também NÃO faz fail-open
 * aqui (diferente do ClickUp): propaga como falha de throttle, porque
 * "deixar passar sem saber quantos tokens restam" é exatamente o cenário de
 * overflow que este limiter existe para evitar.
 */
export async function adquirirTokenEvolution(): Promise<void> {
  const inicio = Date.now();
  for (;;) {
    let tentativa: { permitido: boolean; esperaMs: number };
    try {
      tentativa = MODO === 'redis' ? await tentarTokenRedis() : tentarTokenMem();
    } catch (e) {
      throw new EvolutionThrottleError(
        `[evolution] throttle: falha ao adquirir token (${e instanceof Error ? e.message : String(e)}) — cap segura, envio abortado`,
      );
    }
    if (tentativa.permitido) return;

    const decorrido = Date.now() - inicio;
    if (decorrido >= RL_EVOLUTION_WAIT_MAX_MS) {
      throw new EvolutionThrottleError('[evolution] throttle: teto de espera atingido — cap segura (sem fail-open), envio abortado');
    }
    const restante = RL_EVOLUTION_WAIT_MAX_MS - decorrido;
    const delay = Math.max(1, Math.min(tentativa.esperaMs, PASSO_ESPERA_MS, restante));
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** 'redis' ou 'memoria' — usado pelo smoke e pelo log de boot. */
export function modoRateLimiterEvolution(): 'redis' | 'memoria' {
  return MODO;
}

/** Fecha o cliente Redis (graceful shutdown) — no-op em modo memoria. */
export async function fecharRateLimiterEvolution(): Promise<void> {
  if (cliente) {
    await cliente.quit();
    cliente = null;
  }
}

// ===== Choke-point HTTP =====

/**
 * Choke point ÚNICO de saída HTTP à Evolution API: todo caminho de ENVIO
 * passa por `adquirirTokenEvolution()` IMEDIATAMENTE ANTES do `fetchTimeout()`
 * — nunca exportar fetch cru, nenhum caminho de envio escapa do throttle.
 * Header `apikey` (minúsculo) — não o header Bearer usado pela Wavoip,
 * convenção diferente da Evolution.
 *
 * WR-02: `skipThrottle` isenta o probe READ-ONLY de status do balde de envio.
 * Um GET de `connectionState` não é um envio e não arrisca o BANIMENTO que o
 * cap existe pra prevenir (Pitfall 1); consumir token de envio nele podia
 * esvaziar o balde numa rajada de envios e virar o banner pra "desconectado"
 * enquanto os envios ainda estão saindo (falso negativo). O throttle segue
 * ESTRITO em `sendWhatsAppAudio`/pré-check — só o read-only é isento.
 */
async function fetchEvolution(
  caminho: string,
  options?: RequestInit,
  timeoutMs?: number,
  skipThrottle = false,
): Promise<Response> {
  if (!skipThrottle) await adquirirTokenEvolution();
  return fetchTimeout(
    `${EVOLUTION_API_URL}${caminho}`,
    {
      ...options,
      headers: { ...(options?.headers || {}), apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
    },
    timeoutMs,
  );
}

// ===== Envio de áudio =====

/**
 * Envia um áudio (base64) para um número via a instância Evolution dedicada.
 * LANÇA `Error` com prefixo `[evolution]` em falha de rede OU HTTP não-2xx —
 * nunca engole em null/silêncio (D-08, falha alta). LGPD: nunca loga
 * telefone, apikey nem os bytes/base64 do áudio — só status/classe do erro.
 */
export async function enviarAudio(telefoneE164: string, audioBase64: string, mimetype?: string): Promise<void> {
  if (!EVOLUTION_INSTANCE) {
    throw new Error('[evolution] EVOLUTION_INSTANCE ausente — sem instância dedicada configurada');
  }
  let res: Response;
  try {
    res = await fetchEvolution(`/message/sendWhatsAppAudio/${EVOLUTION_INSTANCE}`, {
      method: 'POST',
      body: JSON.stringify({
        number: telefoneE164,
        audio: audioBase64,
        ...(mimetype ? { mimetype } : {}),
      }),
    });
  } catch (e) {
    // IN-03: preserva o tipo do throttle pra classificação no caller — não
    // re-embrulha em "falha de rede" (que apagaria o instanceof).
    if (e instanceof EvolutionThrottleError) throw e;
    throw new Error(`[evolution] falha de rede ao enviar áudio: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[evolution] envio de áudio falhou (${res.status})`);
  }
}

// ===== Status da instância =====

/** Estado normalizado da instância Evolution — { conectado: boolean } (D-08). */
export interface StatusInstanciaEvolution {
  conectado: boolean;
}

/**
 * Consulta o connectionState da instância dedicada e normaliza pra
 * `{ conectado: boolean }` (`state === 'open'`), no mesmo molde de
 * `deviceConectadoWavoip` (wavoip-api.ts). LANÇA em falha de rede/HTTP —
 * nunca engole em null (D-08).
 */
export async function statusInstancia(): Promise<StatusInstanciaEvolution> {
  if (!EVOLUTION_INSTANCE) {
    throw new Error('[evolution] EVOLUTION_INSTANCE ausente — sem instância dedicada configurada');
  }
  let res: Response;
  try {
    // WR-02: read-only — isento do throttle de envio (skipThrottle=true) pra
    // não gastar o balde de envio e virar o banner pra "desconectado" durante
    // uma rajada de envios saudável.
    res = await fetchEvolution(`/instance/connectionState/${EVOLUTION_INSTANCE}`, { method: 'GET' }, undefined, true);
  } catch (e) {
    throw new Error(`[evolution] falha de rede ao consultar status da instância: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[evolution] consulta de status da instância falhou (${res.status})`);
  }
  const j = (await res.json().catch(() => ({}))) as { instance?: { state?: string } };
  const state = j.instance?.state ?? '';
  return { conectado: state === 'open' };
}

// ===== Pré-check de número no WhatsApp (quick 260818-mv2) =====

/**
 * Pré-checa se `telefoneE164` existe no WhatsApp via a instância dedicada,
 * ANTES de gastar o throttle de `enviarAudio` num número que nunca vai
 * receber. Passa pelo choke-point `fetchEvolution` (mesmo rate limiter/apikey
 * de enviarAudio/statusInstancia). SEMÂNTICA CRÍTICA: só retorna `false`
 * quando a Evolution AFIRMA `exists === false` para o número; qualquer outra
 * coisa (array vazio, entrada ausente, `exists` undefined, shape inesperado)
 * retorna `true` — nunca marcar um lead como "sem WhatsApp" por resposta
 * ambígua. LANÇA `Error` com prefixo `[evolution]` em falha de rede OU HTTP
 * não-2xx (D-08) — o caller trata isso como o mesmo caso de "desconectado",
 * NUNCA como "sem WhatsApp". LGPD: nunca loga telefone/apikey/jid — só
 * status/classe do erro.
 */
export async function numeroExisteNoWhatsapp(telefoneE164: string): Promise<boolean> {
  if (!EVOLUTION_INSTANCE) {
    throw new Error('[evolution] EVOLUTION_INSTANCE ausente — sem instância dedicada configurada');
  }
  let res: Response;
  try {
    res = await fetchEvolution(`/chat/whatsappNumbers/${EVOLUTION_INSTANCE}`, {
      method: 'POST',
      body: JSON.stringify({ numbers: [telefoneE164] }),
    });
  } catch (e) {
    // IN-03: preserva o tipo do throttle pra classificação no caller — não
    // re-embrulha em "falha de rede" (que apagaria o instanceof).
    if (e instanceof EvolutionThrottleError) throw e;
    throw new Error(`[evolution] falha de rede ao checar número no WhatsApp: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[evolution] pré-check de WhatsApp falhou (${res.status})`);
  }
  const j = (await res.json().catch(() => [])) as Array<{ exists?: boolean; jid?: string; number?: string }>;
  if (!Array.isArray(j) || j.length === 0) return true;
  const entrada = j.find((x) => x.number === telefoneE164) ?? j[0];
  if (entrada?.exists === false) return false;
  return true;
}
