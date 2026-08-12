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
const taskAtivaMem = new Map<string, { taskId: string; ts: number }>();
const recordsMem = new Set<string>();
const falhasMem = new Set<string>();

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

function guardarTaskAtivaMem(telefone: string, taskId: string): void {
  const agora = Date.now();
  const chave = chaveTelefone(telefone);
  taskAtivaMem.set(chave, { taskId, ts: agora });
  if (taskAtivaMem.size > 2000) {
    for (const [k, v] of taskAtivaMem) {
      if (agora - v.ts > CORRELACAO_TTL_MS) taskAtivaMem.delete(k);
    }
  }
}

function lerTaskAtivaMem(telefone: string): string | null {
  return taskAtivaMem.get(chaveTelefone(telefone))?.taskId ?? null;
}

function limparTaskAtivaMem(telefone: string): void {
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

function marcarCallFalhaProcessadaMem(callId: string): boolean {
  if (!callId) return true; // sem callId nao ha chave de dedup — espelha deveProcessarFalhaTerminal
  if (falhasMem.has(callId)) return false;
  falhasMem.add(callId);
  if (falhasMem.size > 5000) falhasMem.clear();
  return true;
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

async function guardarTaskAtivaRedis(telefone: string, taskId: string): Promise<void> {
  try {
    await garantirCliente().set(PREFIXO_TASK + chaveTelefone(telefone), taskId, 'PX', CORRELACAO_TTL_MS);
  } catch (e) {
    console.error('[estado-webhook] falha ao guardar task ativa (degradando p/ no-op):', e instanceof Error ? e.message : String(e));
  }
}

async function lerTaskAtivaRedis(telefone: string): Promise<string | null> {
  try {
    return await garantirCliente().get(PREFIXO_TASK + chaveTelefone(telefone));
  } catch (e) {
    console.error('[estado-webhook] falha ao ler task ativa (degradando p/ miss):', e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function limparTaskAtivaRedis(telefone: string): Promise<void> {
  try {
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

export async function guardarTaskAtiva(telefone: string, taskId: string): Promise<void> {
  return MODO === 'redis' ? guardarTaskAtivaRedis(telefone, taskId) : guardarTaskAtivaMem(telefone, taskId);
}

export async function lerTaskAtiva(telefone: string): Promise<string | null> {
  return MODO === 'redis' ? lerTaskAtivaRedis(telefone) : lerTaskAtivaMem(telefone);
}

export async function limparTaskAtiva(telefone: string): Promise<void> {
  return MODO === 'redis' ? limparTaskAtivaRedis(telefone) : limparTaskAtivaMem(telefone);
}

export async function marcarRecordProcessado(callId: string): Promise<boolean> {
  return MODO === 'redis' ? marcarRecordProcessadoRedis(callId) : marcarRecordProcessadoMem(callId);
}

export async function liberarRecordProcessado(callId: string): Promise<void> {
  return MODO === 'redis' ? liberarRecordProcessadoRedis(callId) : liberarRecordProcessadoMem(callId);
}

export async function marcarCallFalhaProcessada(callId: string): Promise<boolean> {
  return MODO === 'redis' ? marcarCallFalhaProcessadaRedis(callId) : marcarCallFalhaProcessadaMem(callId);
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
