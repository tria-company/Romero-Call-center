// Cache-aside da fila de Ligações + script, por operador (Fase 8,
// escala-150-atendentes, CACHE-01).
//
// Molde EXATO de estado-webhook.ts (Fase 05): MODO decidido UMA vez no boot
// (REDIS_URL), cliente lazy singleton, TTL nativo via SET PX, never-throws.
//
// Diferença de espírito (D-01/D-02): aqui NÃO existe um "modo memória"
// equivalente ao de estado-webhook.ts — o ClickUp é a fonte da verdade e o
// Redis é só um cache de LEITURA. Sem REDIS_URL (ou Redis fora do ar em
// runtime), os getters retornam `null` para a leitura degradar DIRETO ao
// ClickUp (buscarFilaLigacoes/lerLigacao em clickup.ts) — NÃO para um cache
// in-process.
//
// Chave POR OPERADOR (D-04, isolamento anti-IDOR — T-08-02-IDOR): a chave de
// ligação leva o assigneeId ANTES do taskId — um operador diferente sempre dá
// miss e força `lerLigacao` a re-rodar as 3 checagens de autorização.
//
// TTL curto (D-03, CACHE_FILA_TTL_MS=45s) como rede de segurança +
// invalidação explícita (`invalidarFilaCache`/`removerDaFilaCache`) e
// warm-on-write (`aquecerFilaCache`, D-07b — read-your-writes consumido pelo
// Plano 04 no /voto) na escrita.
//
// LGPD: NUNCA logar telefone/nome/script cru — só o modo, o prefixo/
// assigneeId e a classe do erro.

import Redis from 'ioredis';
import { REDIS_URL, CACHE_FILA_TTL_MS } from './config.ts';
import type { ItemFila } from './lote.ts';

/**
 * Espelha `DetalheLigacao` de clickup.ts (ItemFila + script) — definido AQUI
 * (não importado de clickup.ts) para não criar um ciclo de import: clickup.ts
 * importa deste módulo, não o contrário (ver 08-PATTERNS.md key_links).
 * Estruturalmente idêntico — TypeScript aceita a passagem por tipagem
 * estrutural sem precisar do mesmo nome/origem.
 */
export interface DetalheLigacaoCache extends ItemFila {
  script: string;
}

const MODO: 'redis' | 'memoria' = REDIS_URL ? 'redis' : 'memoria';

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
      console.error(
        '[cache-fila] erro de conexao Redis (degradando p/ leitura direta ao ClickUp):',
        e instanceof Error ? e.message : String(e),
      );
    });
  }
  return cliente;
}

const PREFIXO_FILA = 'cache:fila:';
const PREFIXO_LIGACAO = 'cache:ligacao:';

/** Chave POR OPERADOR (D-04) — um bust de um operador jamais invalida a fila dos outros. */
function chaveFila(assigneeId: string): string {
  return PREFIXO_FILA + assigneeId;
}

/**
 * Chave POR OPERADOR+TASK (D-04/anti-IDOR) — o assigneeId no PREFIXO da chave
 * de ligação é o que impede um operador de ler o script de outro via cache:
 * um assigneeId diferente sempre dá miss e força `lerLigacao` a re-rodar as
 * checagens de autorização completas.
 */
function chaveLigacao(assigneeId: string, taskId: string): string {
  return PREFIXO_LIGACAO + assigneeId + ':' + taskId;
}

/**
 * Lê a fila cacheada do operador. MODO memoria (sem REDIS_URL) ou erro/miss
 * → `null` — a leitura degrada DIRETO ao ClickUp (D-02/SC5), nunca para um
 * cache in-process. Never-throws.
 */
export async function obterFilaCache(assigneeId: string): Promise<ItemFila[] | null> {
  if (MODO !== 'redis') return null;
  try {
    const bruto = await garantirCliente().get(chaveFila(assigneeId));
    if (!bruto) return null;
    return JSON.parse(bruto) as ItemFila[];
  } catch (e) {
    console.error(
      '[cache-fila] falha ao ler fila cacheada (degradando p/ miss):',
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

/** Grava a fila do operador no cache (TTL fresco, D-03). No-op em MODO memoria ou em erro (never-throws). */
export async function guardarFilaCache(assigneeId: string, fila: ItemFila[]): Promise<void> {
  if (MODO !== 'redis') return;
  try {
    await garantirCliente().set(chaveFila(assigneeId), JSON.stringify(fila), 'PX', CACHE_FILA_TTL_MS);
  } catch (e) {
    console.error(
      '[cache-fila] falha ao guardar fila cacheada (degradando p/ no-op):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Invalida (del) a chave da fila do operador — belt-and-suspenders D-03, never-throws. */
export async function invalidarFilaCache(assigneeId: string): Promise<void> {
  if (MODO !== 'redis') return;
  try {
    await garantirCliente().del(chaveFila(assigneeId));
  } catch (e) {
    console.error(
      '[cache-fila] falha ao invalidar fila cacheada (degradando p/ no-op):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Remove UMA task da fila cacheada do operador SEM tocar o ClickUp —
 * consumido pelo Plano 04 no /ligando (a task saiu da fila ao entrar em
 * processamento). Miss → no-op. Reescreve com TTL fresco (PX). Never-throws.
 */
export async function removerDaFilaCache(assigneeId: string, taskId: string): Promise<void> {
  if (MODO !== 'redis') return;
  try {
    const cli = garantirCliente();
    const bruto = await cli.get(chaveFila(assigneeId));
    if (!bruto) return;
    const fila = JSON.parse(bruto) as ItemFila[];
    const filtrada = fila.filter((item) => item.taskId !== taskId);
    await cli.set(chaveFila(assigneeId), JSON.stringify(filtrada), 'PX', CACHE_FILA_TTL_MS);
  } catch (e) {
    console.error(
      '[cache-fila] falha ao remover task da fila cacheada (degradando p/ no-op):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Warm-on-write / read-your-writes (D-07b) — consumido pelo Plano 04 no
 * /voto: reflete o resultado recém-gravado na fila cacheada do operador SEM
 * esperar o ClickUp espelhar (janela <60s até o ClickUp espelhar). GET a fila
 * cacheada → mutação → SET PX (TTL fresco), sempre reescrevendo a chave (é
 * warm-on-write, não um `del` de invalidação).
 *
 * `atualizacao` objeto parcial → merge in-place no item `id === taskId`
 * (mantém a ordem da fila); `atualizacao === null` → remove o item da fila
 * acionável. Miss → no-op (a próxima leitura recomputa; TTL curto limita a
 * staleness). MODO memoria/erro → no-op. Never-throws.
 */
export async function aquecerFilaCache(
  assigneeId: string,
  taskId: string,
  atualizacao: Partial<ItemFila> | null,
): Promise<void> {
  if (MODO !== 'redis') return;
  try {
    const cli = garantirCliente();
    const bruto = await cli.get(chaveFila(assigneeId));
    if (!bruto) return;
    const fila = JSON.parse(bruto) as ItemFila[];
    const proxima =
      atualizacao === null
        ? fila.filter((item) => item.taskId !== taskId)
        : fila.map((item) => (item.taskId === taskId ? { ...item, ...atualizacao } : item));
    await cli.set(chaveFila(assigneeId), JSON.stringify(proxima), 'PX', CACHE_FILA_TTL_MS);
  } catch (e) {
    console.error(
      '[cache-fila] falha ao aquecer fila cacheada (degradando p/ no-op):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Lê o detalhe (script + campos) cacheado da Ligação do operador. MODO
 * memoria ou erro/miss → `null` — a leitura degrada DIRETO ao ClickUp
 * (`lerLigacao`, incl. as 3 checagens de autorização, D-02/SC5). Never-throws.
 */
export async function obterLigacaoCache(assigneeId: string, taskId: string): Promise<DetalheLigacaoCache | null> {
  if (MODO !== 'redis') return null;
  try {
    const bruto = await garantirCliente().get(chaveLigacao(assigneeId, taskId));
    if (!bruto) return null;
    return JSON.parse(bruto) as DetalheLigacaoCache;
  } catch (e) {
    console.error(
      '[cache-fila] falha ao ler ligacao cacheada (degradando p/ miss):',
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

/** Grava o detalhe da Ligação do operador no cache (TTL fresco). No-op em MODO memoria ou em erro (never-throws). */
export async function guardarLigacaoCache(
  assigneeId: string,
  taskId: string,
  detalhe: DetalheLigacaoCache,
): Promise<void> {
  if (MODO !== 'redis') return;
  try {
    await garantirCliente().set(chaveLigacao(assigneeId, taskId), JSON.stringify(detalhe), 'PX', CACHE_FILA_TTL_MS);
  } catch (e) {
    console.error(
      '[cache-fila] falha ao guardar ligacao cacheada (degradando p/ no-op):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** 'redis' ou 'memoria' — usado pelo smoke e pelo log de boot. */
export function modoCacheFila(): 'redis' | 'memoria' {
  return MODO;
}

/** Fecha o cliente Redis (graceful shutdown) — no-op em MODO memoria. */
export async function fecharCacheFila(): Promise<void> {
  if (cliente) {
    await cliente.quit();
    cliente = null;
  }
}

console.log(
  MODO === 'redis'
    ? '[cache-fila] cache-aside da fila via Redis'
    : '[cache-fila] sem cache — leitura direto ao ClickUp (1 instancia)',
);
