// Camada Redis-ou-memoria do estado do webhook Wavoip (Fase 5, escala-150-atendentes).
//
// Abstrai os 4 conteineres de estado in-memory que o handler do webhook usava
// direto (correlacao call->telefone, task ativa por telefone, dedup de RECORD,
// dedup de falha terminal) atras de 8 funcoes async. O backend e escolhido UMA
// vez no boot pelo valor de REDIS_URL:
//   - vazio  -> MEMORIA: Map/Set no processo, comportamento bit-a-bit identico
//     ao que existia antes desta fase (TTL 6h, normalizacao so-digitos, poda
//     preguicosa por size, semantica add/has/delete/clear). E o modo de 1
//     instancia — "construir codigo antes de provisionar" nao pode mudar isso.
//   - preenchido -> REDIS: TTL nativo, dedup via SET NX atomico (sobrevive a
//     restart e a N replicas).
//
// Convencao WR-03 adaptada (mesmo espirito de supabase.ts): esta camada NUNCA
// lanca para o chamador — Redis fora do ar em runtime degrada (read->miss,
// write->no-op, marcar->fail-open), nunca derruba o webhook. Nunca loga
// telefone/taskId cru nem a REDIS_URL — so o modo e, quando muito, o callId.

import Redis from 'ioredis';
import { REDIS_URL } from './config.ts';

const CORRELACAO_TTL_MS = 6 * 60 * 60 * 1000; // 6h — correlacao e task ativa
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24h — dedup de RECORD/falha terminal (so Redis; memoria poda por size)

/** Normaliza telefone para so-digitos — mesma forma usada por telefoneDoEventoCall. */
function chaveTelefone(telefone: string): string {
  return telefone.replace(/[^\d]/g, '');
}

const MODO: 'redis' | 'memoria' = REDIS_URL ? 'redis' : 'memoria';

// ===== Backend MEMORIA — identico ao comportamento anterior a esta fase =====

const correlacaoMem = new Map<string, { telefone: string; ts: number }>();
const correlacaoDeviceMem = new Map<string, { deviceId: string; ts: number }>();
const taskAtivaMem = new Map<string, { taskId: string; ts: number }>();
const recordsMem = new Set<string>();
const falhasMem = new Set<string>();

/**
 * Chave de task ativa (DD-07-12): composta (deviceId+telefone) quando o
 * device e conhecido, telefone-so quando nao — degrada pro comportamento
 * pre-DEVICE-03 sem `deviceId` (DD-07-13).
 */
function chaveTaskAtiva(telefone: string, deviceId?: string): string {
  const t = chaveTelefone(telefone);
  return deviceId ? `${deviceId}|${t}` : t;
}

function guardarCorrelacaoMem(callId: string, telefone: string): void {
  const agora = Date.now();
  correlacaoMem.set(callId, { telefone, ts: agora });
  if (correlacaoMem.size > 2000) {
    for (const [k, v] of correlacaoMem) {
      if (agora - v.ts > CORRELACAO_TTL_MS) correlacaoMem.delete(k);
    }
  }
}

function lerCorrelacaoMem(callId: string): string | null {
  return correlacaoMem.get(callId)?.telefone ?? null;
}

/** DD-07-11: correlacao de device SEPARADA (call->deviceId) — mesmo padrao da correlacao de telefone, prefixo/container proprio. */
function guardarCorrelacaoDeviceMem(callId: string, deviceId: string): void {
  const agora = Date.now();
  correlacaoDeviceMem.set(callId, { deviceId, ts: agora });
  if (correlacaoDeviceMem.size > 2000) {
    for (const [k, v] of correlacaoDeviceMem) {
      if (agora - v.ts > CORRELACAO_TTL_MS) correlacaoDeviceMem.delete(k);
    }
  }
}

function lerCorrelacaoDeviceMem(callId: string): string | null {
  return correlacaoDeviceMem.get(callId)?.deviceId ?? null;
}

/**
 * DD-07-12: com deviceId, grava na chave composta E TAMBEM na chave
 * telefone-so (fallback best-effort pra RECORDs que nao derivarem o device).
 */
function guardarTaskAtivaMem(telefone: string, taskId: string, deviceId?: string): void {
  const agora = Date.now();
  taskAtivaMem.set(chaveTaskAtiva(telefone, deviceId), { taskId, ts: agora });
  if (deviceId) taskAtivaMem.set(chaveTelefone(telefone), { taskId, ts: agora });
  if (taskAtivaMem.size > 2000) {
    for (const [k, v] of taskAtivaMem) {
      if (agora - v.ts > CORRELACAO_TTL_MS) taskAtivaMem.delete(k);
    }
  }
}

/** DD-07-12: com deviceId tenta a chave composta primeiro, cai na telefone-so se faltar. */
function lerTaskAtivaMem(telefone: string, deviceId?: string): string | null {
  if (deviceId) {
    const composta = taskAtivaMem.get(chaveTaskAtiva(telefone, deviceId))?.taskId ?? null;
    if (composta) return composta;
  }
  return taskAtivaMem.get(chaveTelefone(telefone))?.taskId ?? null;
}

function limparTaskAtivaMem(telefone: string, deviceId?: string): void {
  if (deviceId) taskAtivaMem.delete(chaveTaskAtiva(telefone, deviceId));
  taskAtivaMem.delete(chaveTelefone(telefone));
}

function marcarRecordProcessadoMem(callId: string): boolean {
  if (recordsMem.has(callId)) return false;
  recordsMem.add(callId);
  if (recordsMem.size > 5000) recordsMem.clear(); // backstop de memoria (dedup e best-effort)
  return true;
}

function liberarRecordProcessadoMem(callId: string): void {
  recordsMem.delete(callId);
}

// CR-02: check read-only (NAO reivindica) — usado pelo processador pra pular um
// RECORD que JA foi consolidado numa run anterior, sem marca-lo prematuramente.
function recordJaProcessadoMem(callId: string): boolean {
  return recordsMem.has(callId);
}

function marcarCallFalhaProcessadaMem(callId: string): boolean {
  if (!callId) return true; // sem callId nao ha chave de dedup — espelha deveProcessarFalhaTerminal
  if (falhasMem.has(callId)) return false;
  falhasMem.add(callId);
  if (falhasMem.size > 5000) falhasMem.clear();
  return true;
}

// CR-02: check read-only da falha terminal (espelha recordJaProcessadoMem).
function callFalhaJaProcessadaMem(callId: string): boolean {
  if (!callId) return false; // sem callId nao ha dedup — nunca "ja processado"
  return falhasMem.has(callId);
}

// ===== Backend REDIS — cliente lazy, TTL nativo, SET NX atomico =====

let cliente: Redis | null = null;

/** Instancia o cliente na primeira operacao (lazy) e reusa depois (singleton). */
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
      console.error('[estado-webhook] erro de conexao Redis (degradando):', e instanceof Error ? e.message : String(e));
    });
  }
  return cliente;
}

const PREFIXO_CORR = 'wh:corr:';
const PREFIXO_DEV = 'wh:dev:';
const PREFIXO_TASK = 'wh:task:';
const PREFIXO_REC = 'wh:rec:';
const PREFIXO_FALHA = 'wh:falha:';

async function guardarCorrelacaoRedis(callId: string, telefone: string): Promise<void> {
  try {
    await garantirCliente().set(PREFIXO_CORR + callId, telefone, 'PX', CORRELACAO_TTL_MS);
  } catch (e) {
    console.error('[estado-webhook] falha ao guardar correlacao (degradando p/ no-op):', e instanceof Error ? e.message : String(e));
  }
}

async function lerCorrelacaoRedis(callId: string): Promise<string | null> {
  try {
    return await garantirCliente().get(PREFIXO_CORR + callId);
  } catch (e) {
    console.error('[estado-webhook] falha ao ler correlacao (degradando p/ miss):', e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** DD-07-11: correlacao de device SEPARADA (call->deviceId), prefixo/TTL proprios — espelha guardarCorrelacaoRedis. */
async function guardarCorrelacaoDeviceRedis(callId: string, deviceId: string): Promise<void> {
  try {
    await garantirCliente().set(PREFIXO_DEV + callId, deviceId, 'PX', CORRELACAO_TTL_MS);
  } catch (e) {
    console.error('[estado-webhook] falha ao guardar correlacao de device (degradando p/ no-op):', e instanceof Error ? e.message : String(e));
  }
}

async function lerCorrelacaoDeviceRedis(callId: string): Promise<string | null> {
  try {
    return await garantirCliente().get(PREFIXO_DEV + callId);
  } catch (e) {
    console.error('[estado-webhook] falha ao ler correlacao de device (degradando p/ miss):', e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** DD-07-12: com deviceId, grava na chave composta E TAMBEM na chave telefone-so (fallback best-effort). */
async function guardarTaskAtivaRedis(telefone: string, taskId: string, deviceId?: string): Promise<void> {
  try {
    await garantirCliente().set(PREFIXO_TASK + chaveTaskAtiva(telefone, deviceId), taskId, 'PX', CORRELACAO_TTL_MS);
    if (deviceId) {
      await garantirCliente().set(PREFIXO_TASK + chaveTelefone(telefone), taskId, 'PX', CORRELACAO_TTL_MS);
    }
  } catch (e) {
    console.error('[estado-webhook] falha ao guardar task ativa (degradando p/ no-op):', e instanceof Error ? e.message : String(e));
  }
}

/** DD-07-12: com deviceId tenta a chave composta primeiro, cai na telefone-so se faltar. */
async function lerTaskAtivaRedis(telefone: string, deviceId?: string): Promise<string | null> {
  try {
    if (deviceId) {
      const composta = await garantirCliente().get(PREFIXO_TASK + chaveTaskAtiva(telefone, deviceId));
      if (composta) return composta;
    }
    return await garantirCliente().get(PREFIXO_TASK + chaveTelefone(telefone));
  } catch (e) {
    console.error('[estado-webhook] falha ao ler task ativa (degradando p/ miss):', e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function limparTaskAtivaRedis(telefone: string, deviceId?: string): Promise<void> {
  try {
    if (deviceId) await garantirCliente().del(PREFIXO_TASK + chaveTaskAtiva(telefone, deviceId));
    await garantirCliente().del(PREFIXO_TASK + chaveTelefone(telefone));
  } catch (e) {
    console.error('[estado-webhook] falha ao limpar task ativa (degradando p/ no-op):', e instanceof Error ? e.message : String(e));
  }
}

async function marcarRecordProcessadoRedis(callId: string): Promise<boolean> {
  try {
    // SET NX atomico: colapsa o has-then-add de hoje num passo so, sobrevive a
    // restart e a N replicas. 'OK' = recem-marcado; null (chave ja existia) = duplicado.
    const resultado = await garantirCliente().set(PREFIXO_REC + callId, '1', 'PX', DEDUP_TTL_MS, 'NX');
    return resultado === 'OK';
  } catch (e) {
    // Fail-open: processa. Nunca perder a ligacao por causa do dedup — a
    // durabilidade da Fase 2a (webhook_eventos) e o dedup best-effort ja
    // aceitam reprocesso raro nesta janela de falha do Redis.
    console.error('[estado-webhook] falha ao marcar record processado (degradando p/ fail-open=true):', e instanceof Error ? e.message : String(e));
    return true;
  }
}

async function liberarRecordProcessadoRedis(callId: string): Promise<void> {
  try {
    await garantirCliente().del(PREFIXO_REC + callId);
  } catch (e) {
    console.error('[estado-webhook] falha ao liberar record processado (degradando p/ no-op):', e instanceof Error ? e.message : String(e));
  }
}

// CR-02: GET read-only (nao reivindica). Fail-open p/ false = "nao processado,
// entao PROCESSA" — mesmo racional do fail-open de marcarRecordProcessadoRedis:
// nunca perder a ligacao por causa do dedup; reprocesso raro e aceitavel.
async function recordJaProcessadoRedis(callId: string): Promise<boolean> {
  try {
    return (await garantirCliente().get(PREFIXO_REC + callId)) !== null;
  } catch (e) {
    console.error('[estado-webhook] falha ao checar record processado (degradando p/ nao-processado):', e instanceof Error ? e.message : String(e));
    return false;
  }
}

async function callFalhaJaProcessadaRedis(callId: string): Promise<boolean> {
  if (!callId) return false; // sem callId nao ha chave de dedup
  try {
    return (await garantirCliente().get(PREFIXO_FALHA + callId)) !== null;
  } catch (e) {
    console.error('[estado-webhook] falha ao checar falha terminal processada (degradando p/ nao-processado):', e instanceof Error ? e.message : String(e));
    return false;
  }
}

async function marcarCallFalhaProcessadaRedis(callId: string): Promise<boolean> {
  if (!callId) return true; // sem callId nao ha chave de dedup — espelha deveProcessarFalhaTerminal
  try {
    const resultado = await garantirCliente().set(PREFIXO_FALHA + callId, '1', 'PX', DEDUP_TTL_MS, 'NX');
    return resultado === 'OK';
  } catch (e) {
    // Mesmo racional de marcarRecordProcessadoRedis: fail-open, nunca perder o evento.
    console.error('[estado-webhook] falha ao marcar falha terminal processada (degradando p/ fail-open=true):', e instanceof Error ? e.message : String(e));
    return true;
  }
}

// ===== Superficie publica — despacha para o backend escolhido no boot =====

export async function guardarCorrelacao(callId: string, telefone: string): Promise<void> {
  return MODO === 'redis' ? guardarCorrelacaoRedis(callId, telefone) : guardarCorrelacaoMem(callId, telefone);
}

export async function lerCorrelacao(callId: string): Promise<string | null> {
  return MODO === 'redis' ? lerCorrelacaoRedis(callId) : lerCorrelacaoMem(callId);
}

/** DEVICE-03/DD-07-11: correlacao SEPARADA call->deviceId — lerCorrelacao(callId)->telefone fica intacta. */
export async function guardarCorrelacaoDevice(callId: string, deviceId: string): Promise<void> {
  return MODO === 'redis' ? guardarCorrelacaoDeviceRedis(callId, deviceId) : guardarCorrelacaoDeviceMem(callId, deviceId);
}

export async function lerCorrelacaoDevice(callId: string): Promise<string | null> {
  return MODO === 'redis' ? lerCorrelacaoDeviceRedis(callId) : lerCorrelacaoDeviceMem(callId);
}

/**
 * DEVICE-03/DD-07-12: assinatura retrocompativel — 3o argumento `deviceId`
 * opcional. Sem deviceId, comportamento identico ao de antes desta fase
 * (chaveia so por telefone). Com deviceId, desambigua 2 devices ligando pro
 * MESMO telefone ao mesmo tempo (grava tambem na chave telefone-so, fallback
 * best-effort).
 */
export async function guardarTaskAtiva(telefone: string, taskId: string, deviceId?: string): Promise<void> {
  return MODO === 'redis' ? guardarTaskAtivaRedis(telefone, taskId, deviceId) : guardarTaskAtivaMem(telefone, taskId, deviceId);
}

export async function lerTaskAtiva(telefone: string, deviceId?: string): Promise<string | null> {
  return MODO === 'redis' ? lerTaskAtivaRedis(telefone, deviceId) : lerTaskAtivaMem(telefone, deviceId);
}

export async function limparTaskAtiva(telefone: string, deviceId?: string): Promise<void> {
  return MODO === 'redis' ? limparTaskAtivaRedis(telefone, deviceId) : limparTaskAtivaMem(telefone, deviceId);
}

export async function marcarRecordProcessado(callId: string): Promise<boolean> {
  return MODO === 'redis' ? marcarRecordProcessadoRedis(callId) : marcarRecordProcessadoMem(callId);
}

export async function liberarRecordProcessado(callId: string): Promise<void> {
  return MODO === 'redis' ? liberarRecordProcessadoRedis(callId) : liberarRecordProcessadoMem(callId);
}

/**
 * CR-02: checa (read-only) se o RECORD ja foi DURAVELMENTE processado numa run
 * anterior — usado pelo processador pra pular reentregas de um job ja concluido
 * SEM reivindicar a marca no inicio (a marca so e setada por
 * `marcarRecordProcessado` DEPOIS do efeito terminal). Fail-open p/ false.
 */
export async function recordJaProcessado(callId: string): Promise<boolean> {
  return MODO === 'redis' ? recordJaProcessadoRedis(callId) : recordJaProcessadoMem(callId);
}

export async function marcarCallFalhaProcessada(callId: string): Promise<boolean> {
  return MODO === 'redis' ? marcarCallFalhaProcessadaRedis(callId) : marcarCallFalhaProcessadaMem(callId);
}

/** CR-02: check read-only da falha terminal (espelha `recordJaProcessado`). */
export async function callFalhaJaProcessada(callId: string): Promise<boolean> {
  return MODO === 'redis' ? callFalhaJaProcessadaRedis(callId) : callFalhaJaProcessadaMem(callId);
}

/** 'redis' ou 'memoria' — usado pelo smoke (Plano 04) e pelo log de boot. */
export function modoEstadoWebhook(): 'redis' | 'memoria' {
  return MODO;
}

/** Fecha o cliente Redis (graceful shutdown, Fase 6) — no-op em modo memoria. */
export async function fecharEstadoWebhook(): Promise<void> {
  if (cliente) {
    await cliente.quit();
    cliente = null;
  }
}

console.log(
  MODO === 'redis'
    ? '[estado-webhook] estado do webhook em Redis (compartilhado)'
    : '[estado-webhook] estado do webhook em memoria (1 instancia)',
);
