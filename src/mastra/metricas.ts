// Modulo de metricas operacionais (Fase 10, escala-150-atendentes, OBS-02, D-06).
//
// Colhe/le as metricas que alimentam o painel (10-05) e os alertas de
// threshold (10-04): atendentes online, chamadas ativas, profundidade da
// fila, erros do dia e taxa de erro por etapa, contagem de 429 do ClickUp.
// Mesma casca Redis-ou-memoria de rate-limiter-clickup.ts: MODO decidido UMA
// vez no boot pelo valor de REDIS_URL, cliente lazy singleton, NUNCA lanca
// pro chamador — qualquer falha do Redis em runtime degrada para o valor
// neutro (0) daquele campo. Sem REDIS_URL, aplica o MESMO algoritmo num
// estado local por processo.
//
// LGPD: este modulo NUNCA loga telefone/CPF/token — so o modo, o operadorId
// de sessao (nao e PII de lead) e a classe/mensagem do erro.

import Redis from 'ioredis';
import {
  REDIS_URL,
  METRICAS_ERRO_JANELA_MS,
  METRICAS_429_JANELA_MS,
  METRICAS_PRESENCA_TTL_MS,
} from './config.ts';
import { profundidadeFila } from './fila.ts';
import { contarChamadasAtivas } from './estado-webhook.ts';

export type EtapaMetrica = 'webhook' | 'transcricao' | 'analise' | 'sync';

export interface MetricasSnapshot {
  atendentesOnline: number;
  chamadasAtivas: number;
  profundidadeFila: number;
  errosDia: number;
  taxaErroPorEtapa: Record<EtapaMetrica, { erros: number; total: number; taxa: number }>;
  contagem429: number;
}

const MODO: 'redis' | 'memoria' = REDIS_URL ? 'redis' : 'memoria';

const ETAPAS: EtapaMetrica[] = ['webhook', 'transcricao', 'analise', 'sync'];

const DIA_TTL_MS = 48 * 60 * 60 * 1000; // 48h — contador diario de erros

// ===== Backend REDIS — cliente lazy singleton =====

let cliente: Redis | null = null;

/** Instancia o cliente na primeira operacao (lazy) e reusa depois (singleton) — mesmo molde de rate-limiter-clickup.ts. */
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
      console.error('[metricas] erro de conexao Redis (degradando):', e instanceof Error ? e.message : String(e));
    });
  }
  return cliente;
}

const PREFIXO_PRESENCA = 'met:presenca:';
const PREFIXO_ETAPA = 'met:etapa:'; // + etapa + ':' + (erros|total) + ':' + bucket
const PREFIXO_DIA = 'met:dia:'; // + data (YYYY-MM-DD)
const PREFIXO_429 = 'met:429:'; // + bucket

/** Bucket de janela fixa — a chave muda a cada janela, TTL cobre a janela inteira (contador janelado sem sorted set). */
function bucketJanela(janelaMs: number): number {
  return Math.floor(Date.now() / janelaMs);
}

function diaHojeStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function chaveDiaHoje(): string {
  return PREFIXO_DIA + diaHojeStr();
}

// ===== Backend MEMORIA — mesmo algoritmo, estado local por processo =====

const presencaMem = new Map<string, number>(); // operadorId -> ts visto
const etapaMem = new Map<EtapaMetrica, { erros: number; total: number; bucket: number }>();
const contador429Mem = { bucket: 0, contagem: 0 };
let errosDiaMem = { data: '', contagem: 0 };

function podarPresencaMem(): void {
  const agora = Date.now();
  for (const [k, ts] of presencaMem) {
    if (agora - ts > METRICAS_PRESENCA_TTL_MS) presencaMem.delete(k);
  }
}

function registrarPresencaMem(operadorId: string): void {
  presencaMem.set(operadorId, Date.now());
  if (presencaMem.size > 1000) podarPresencaMem();
}

function atendentesOnlineMem(): number {
  podarPresencaMem();
  return presencaMem.size;
}

function garantirContadorEtapaMem(etapa: EtapaMetrica): { erros: number; total: number; bucket: number } {
  const bucketAtual = bucketJanela(METRICAS_ERRO_JANELA_MS);
  const existente = etapaMem.get(etapa);
  if (!existente || existente.bucket !== bucketAtual) {
    const novo = { erros: 0, total: 0, bucket: bucketAtual };
    etapaMem.set(etapa, novo);
    return novo;
  }
  return existente;
}

function registrarErroDiaMem(): void {
  const hoje = diaHojeStr();
  if (errosDiaMem.data !== hoje) errosDiaMem = { data: hoje, contagem: 0 };
  errosDiaMem.contagem += 1;
}

function registrarErroEtapaMem(etapa: EtapaMetrica): void {
  const c = garantirContadorEtapaMem(etapa);
  c.erros += 1;
  c.total += 1;
  registrarErroDiaMem();
}

function registrarSucessoEtapaMem(etapa: EtapaMetrica): void {
  const c = garantirContadorEtapaMem(etapa);
  c.total += 1;
}

function taxaErroPorEtapaMem(): Record<EtapaMetrica, { erros: number; total: number; taxa: number }> {
  const bucketAtual = bucketJanela(METRICAS_ERRO_JANELA_MS);
  const resultado = {} as Record<EtapaMetrica, { erros: number; total: number; taxa: number }>;
  for (const etapa of ETAPAS) {
    const c = etapaMem.get(etapa);
    const valido = !!c && c.bucket === bucketAtual;
    const erros = valido ? (c as any).erros : 0;
    const total = valido ? (c as any).total : 0;
    resultado[etapa] = { erros, total, taxa: total > 0 ? erros / total : 0 };
  }
  return resultado;
}

function errosDiaLerMem(): number {
  return errosDiaMem.data === diaHojeStr() ? errosDiaMem.contagem : 0;
}

function registrar429Mem(): void {
  const atual = bucketJanela(METRICAS_429_JANELA_MS);
  if (contador429Mem.bucket !== atual) {
    contador429Mem.bucket = atual;
    contador429Mem.contagem = 0;
  }
  contador429Mem.contagem += 1;
}

function contagem429Mem(): number {
  return contador429Mem.bucket === bucketJanela(METRICAS_429_JANELA_MS) ? contador429Mem.contagem : 0;
}

// ===== Backend REDIS — contadores janelados via chave+bucket + PEXPIRE =====

async function registrarPresencaRedis(operadorId: string): Promise<void> {
  await garantirCliente().set(PREFIXO_PRESENCA + operadorId, '1', 'PX', METRICAS_PRESENCA_TTL_MS);
}

async function atendentesOnlineRedis(): Promise<number> {
  let cursor = '0';
  let total = 0;
  do {
    const [proximoCursor, chaves] = await garantirCliente().scan(
      cursor,
      'MATCH',
      PREFIXO_PRESENCA + '*',
      'COUNT',
      200,
    );
    cursor = proximoCursor;
    total += chaves.length;
  } while (cursor !== '0');
  return total;
}

function chaveEtapa(etapa: EtapaMetrica, campo: 'erros' | 'total'): string {
  return `${PREFIXO_ETAPA}${etapa}:${campo}:${bucketJanela(METRICAS_ERRO_JANELA_MS)}`;
}

async function incrementarEtapaRedis(etapa: EtapaMetrica, campo: 'erros' | 'total'): Promise<void> {
  const chave = chaveEtapa(etapa, campo);
  const cli = garantirCliente();
  await cli.incr(chave);
  await cli.pexpire(chave, METRICAS_ERRO_JANELA_MS * 2);
}

async function registrarErroEtapaRedis(etapa: EtapaMetrica): Promise<void> {
  await incrementarEtapaRedis(etapa, 'erros');
  await incrementarEtapaRedis(etapa, 'total');
  const cli = garantirCliente();
  const chaveDia = chaveDiaHoje();
  await cli.incr(chaveDia);
  await cli.pexpire(chaveDia, DIA_TTL_MS);
}

async function registrarSucessoEtapaRedis(etapa: EtapaMetrica): Promise<void> {
  await incrementarEtapaRedis(etapa, 'total');
}

async function taxaErroPorEtapaRedis(): Promise<Record<EtapaMetrica, { erros: number; total: number; taxa: number }>> {
  const cli = garantirCliente();
  const resultado = {} as Record<EtapaMetrica, { erros: number; total: number; taxa: number }>;
  for (const etapa of ETAPAS) {
    const [errosStr, totalStr] = await Promise.all([
      cli.get(chaveEtapa(etapa, 'erros')),
      cli.get(chaveEtapa(etapa, 'total')),
    ]);
    const erros = Number(errosStr) || 0;
    const total = Number(totalStr) || 0;
    resultado[etapa] = { erros, total, taxa: total > 0 ? erros / total : 0 };
  }
  return resultado;
}

async function errosDiaLerRedis(): Promise<number> {
  const valor = await garantirCliente().get(chaveDiaHoje());
  return Number(valor) || 0;
}

function chave429(): string {
  return `${PREFIXO_429}${bucketJanela(METRICAS_429_JANELA_MS)}`;
}

async function registrar429Redis(): Promise<void> {
  const chave = chave429();
  const cli = garantirCliente();
  await cli.incr(chave);
  await cli.pexpire(chave, METRICAS_429_JANELA_MS * 2);
}

async function contagem429Redis(): Promise<number> {
  const valor = await garantirCliente().get(chave429());
  return Number(valor) || 0;
}

// ===== Superficie publica — despacha para o backend escolhido no boot, NUNCA lanca =====

/**
 * Marca o operador como visto agora (janela METRICAS_PRESENCA_TTL_MS decide
 * se ainda conta como "online" em lerMetricas()). Sincrona pro chamador — em
 * modo Redis dispara a escrita em background (fire-and-forget), nunca segura
 * quem chamou; qualquer falha so loga, NUNCA lanca/rejeita sem catch.
 */
export function registrarPresenca(operadorId: string): void {
  try {
    if (MODO === 'redis') {
      registrarPresencaRedis(operadorId).catch((e) => {
        console.error(
          '[metricas] falha ao registrar presenca (degradando p/ no-op):',
          e instanceof Error ? e.message : String(e),
        );
      });
    } else {
      registrarPresencaMem(operadorId);
    }
  } catch (e) {
    console.error(
      '[metricas] falha ao registrar presenca (degradando p/ no-op):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Incrementa erro + total da etapa (janela METRICAS_ERRO_JANELA_MS) e o contador diario. NUNCA lanca. */
export function registrarErroEtapa(etapa: EtapaMetrica): void {
  try {
    if (MODO === 'redis') {
      registrarErroEtapaRedis(etapa).catch((e) => {
        console.error(
          '[metricas] falha ao registrar erro de etapa (degradando p/ no-op):',
          e instanceof Error ? e.message : String(e),
        );
      });
    } else {
      registrarErroEtapaMem(etapa);
    }
  } catch (e) {
    console.error(
      '[metricas] falha ao registrar erro de etapa (degradando p/ no-op):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Incrementa so o total da etapa (janela METRICAS_ERRO_JANELA_MS) — sucesso nao conta como erro nem alimenta errosDia. NUNCA lanca. */
export function registrarSucessoEtapa(etapa: EtapaMetrica): void {
  try {
    if (MODO === 'redis') {
      registrarSucessoEtapaRedis(etapa).catch((e) => {
        console.error(
          '[metricas] falha ao registrar sucesso de etapa (degradando p/ no-op):',
          e instanceof Error ? e.message : String(e),
        );
      });
    } else {
      registrarSucessoEtapaMem(etapa);
    }
  } catch (e) {
    console.error(
      '[metricas] falha ao registrar sucesso de etapa (degradando p/ no-op):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Incrementa a contagem de 429 do ClickUp na janela METRICAS_429_JANELA_MS. NUNCA lanca. */
export function registrar429ClickUp(): void {
  try {
    if (MODO === 'redis') {
      registrar429Redis().catch((e) => {
        console.error('[metricas] falha ao registrar 429 (degradando p/ no-op):', e instanceof Error ? e.message : String(e));
      });
    } else {
      registrar429Mem();
    }
  } catch (e) {
    console.error('[metricas] falha ao registrar 429 (degradando p/ no-op):', e instanceof Error ? e.message : String(e));
  }
}

async function lerAtendentesOnline(): Promise<number> {
  try {
    return MODO === 'redis' ? await atendentesOnlineRedis() : atendentesOnlineMem();
  } catch (e) {
    console.error('[metricas] falha ao ler atendentes online (degradando p/ 0):', e instanceof Error ? e.message : String(e));
    return 0;
  }
}

async function lerErrosDia(): Promise<number> {
  try {
    return MODO === 'redis' ? await errosDiaLerRedis() : errosDiaLerMem();
  } catch (e) {
    console.error('[metricas] falha ao ler erros do dia (degradando p/ 0):', e instanceof Error ? e.message : String(e));
    return 0;
  }
}

async function lerTaxaErroPorEtapa(): Promise<Record<EtapaMetrica, { erros: number; total: number; taxa: number }>> {
  try {
    return MODO === 'redis' ? await taxaErroPorEtapaRedis() : taxaErroPorEtapaMem();
  } catch (e) {
    console.error(
      '[metricas] falha ao ler taxa de erro por etapa (degradando p/ zerado):',
      e instanceof Error ? e.message : String(e),
    );
    const zerado = {} as Record<EtapaMetrica, { erros: number; total: number; taxa: number }>;
    for (const etapa of ETAPAS) zerado[etapa] = { erros: 0, total: 0, taxa: 0 };
    return zerado;
  }
}

async function lerContagem429(): Promise<number> {
  try {
    return MODO === 'redis' ? await contagem429Redis() : contagem429Mem();
  } catch (e) {
    console.error('[metricas] falha ao ler contagem de 429 (degradando p/ 0):', e instanceof Error ? e.message : String(e));
    return 0;
  }
}

/**
 * Monta o snapshot completo consumido pelo painel (10-05) e pelos alertas
 * (10-04). Cada campo degrada para o valor neutro (0) SE a fonte falhar —
 * uma fonte fora do ar nunca derruba o snapshot inteiro nem trava o
 * chamador (T-10-02-D1). Resolve todas as fontes em paralelo; NUNCA rejeita.
 */
export async function lerMetricas(): Promise<MetricasSnapshot> {
  const [atendentesOnline, chamadasAtivas, profFila, errosDia, taxaErroPorEtapa, contagem429] = await Promise.all([
    lerAtendentesOnline(),
    contarChamadasAtivas().catch((e) => {
      console.error(
        '[metricas] falha ao ler chamadas ativas (degradando p/ 0):',
        e instanceof Error ? e.message : String(e),
      );
      return 0;
    }),
    profundidadeFila().catch((e) => {
      console.error(
        '[metricas] falha ao ler profundidade da fila (degradando p/ 0):',
        e instanceof Error ? e.message : String(e),
      );
      return 0;
    }),
    lerErrosDia(),
    lerTaxaErroPorEtapa(),
    lerContagem429(),
  ]);
  return {
    atendentesOnline,
    chamadasAtivas,
    profundidadeFila: profFila,
    errosDia,
    taxaErroPorEtapa,
    contagem429,
  };
}

/** 'redis' ou 'memoria' — usado pelo smoke e pelo log de boot. */
export function modoMetricas(): 'redis' | 'memoria' {
  return MODO;
}

/** Fecha o cliente Redis (graceful shutdown) — no-op em modo memoria. */
export async function fecharMetricas(): Promise<void> {
  if (cliente) {
    await cliente.quit();
    cliente = null;
  }
}

console.log(
  MODO === 'redis'
    ? '[metricas] coleta/leitura de metricas via Redis (compartilhado)'
    : '[metricas] coleta/leitura de metricas em memoria (1 instancia)',
);
