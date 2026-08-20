// Camada Redis-ou-inline da fila assincrona de processamento (Fase 6,
// escala-150-atendentes).
//
// Abstrai o enfileiramento do trabalho pesado do webhook Wavoip (transcricao
// Deepgram + analise IA + consolidacao do lead) atras de uma superficie
// publica pequena. O backend e escolhido UMA vez no boot pelo valor de
// REDIS_URL — mesmo espirito de estado-webhook.ts:
//   - vazio    -> INLINE: enfileirar* e no-op ({ enfileirado: false }) e o
//     chamador processa a request sincrona, exatamente como hoje (loop de
//     1 instancia intacto — "construir codigo antes de provisionar").
//   - preenchido -> BULLMQ: Queue Redis durvel, jobId = whatsappCallId
//     (dedup de enqueue, FILA-05), retry com backoff exponencial (FILA-03),
//     jobs falhos ficam no set `failed` do BullMQ como DLQ inspecionavel
//     (FILA-04).
//
// Convencao WR-03 adaptada (mesmo espirito de estado-webhook.ts): esta
// camada NUNCA lanca para o chamador — Redis fora do ar em runtime degrada
// (enfileirar -> { enfileirado: false }, fail-open p/ inline), nunca
// derruba o webhook. Nunca loga telefone/CPF/payload nem a REDIS_URL — so
// ids (whatsappCallId, eventoDuravelId) e a classe do erro.

import { Queue } from 'bullmq';
import {
  REDIS_URL,
  FILA_ATTEMPTS,
  FILA_BACKOFF_MS,
  FILA_NOME,
  ALERT_WEBHOOK_URL,
} from './config.ts';

export interface DadosJobRecord {
  whatsappCallId: string;
  telefone: string; // capturado no enqueue — o job NAO re-le a correlacao (imune ao TTL)
  recordUrl: string;
  payload: Record<string, any>;
  eventoDuravelId: string | null; // linha webhook_eventos, p/ o job fechar o desfecho
  deviceId?: string; // DEVICE-03/DD-07-15: capturado no enqueue (lerCorrelacaoDevice), imune ao TTL entre CALL e RECORD
}

export interface DadosJobFalhaTerminal {
  whatsappCallId: string;
  telefone: string;
  payload: Record<string, any>;
  eventoDuravelId: string | null;
  deviceId?: string; // CR-01/DEVICE-03: capturado no enqueue (deviceIdPorNumero), imune ao TTL — permite ler/limpar a chave COMPOSTA (deviceId|telefone) tambem no caminho nao-atendido
}

/**
 * Payload MINIMO do job de sync ClickUp (CACHE-03, Fase 08 Plano 03) —
 * espelha o voto pos-ligacao confirmado no fim da chamada. So ids + a
 * escolha em si: NUNCA telefone/nome/CPF (minimizacao LGPD do payload da
 * fila e da DLQ, T-08-03-PII).
 */
export interface DadosJobSyncClickup {
  taskId: string;
  assigneeId: string;
  voto: { romero?: 'sim' | 'nao' | 'naoDeclarou'; andressa?: 'sim' | 'nao' | 'naoDeclarou' };
  /** Login do closer que marcou — vira o crédito da declaração em `votos_ligacao`.
   *  OPCIONAL de propósito: job já enfileirado ANTES deste campo existir continua
   *  parseável e grava o voto igual, só sem atribuição. */
  operador?: string;
}

export type NomeJob = 'record' | 'falha-terminal' | 'sync-clickup';

/** Nome da fila BullMQ (Redis key namespace) — padrao 'processamento-ligacao'. */
export const NOME_FILA: string = FILA_NOME;

const MODO: 'bullmq' | 'inline' = REDIS_URL ? 'bullmq' : 'inline';

/** 'bullmq' ou 'inline' — usado pelos planos 06-02..06-05 e pelo log de boot. */
export function modoFila(): 'bullmq' | 'inline' {
  return MODO;
}

/**
 * Opcoes de conexao IORedis derivadas de REDIS_URL, para uso pela Queue e
 * pelo Worker (06-04). BullMQ EXIGE `maxRetriesPerRequest: null` na
 * connection do Worker (blocking commands do BRPOPLPUSH/BLMOVE quebram com
 * qualquer outro valor) — o 06-04 deve reusar exatamente este objeto ao
 * instanciar o Worker. Retorna null em modo inline (sem Redis configurado).
 */
export function conexaoFila(): object | null {
  if (MODO !== 'bullmq') return null;
  return {
    url: REDIS_URL,
    maxRetriesPerRequest: null,
  };
}

/**
 * Opcoes de conexao IORedis do PRODUCER (a Queue) — DELIBERADAMENTE distintas
 * das do Worker (CR-01). O producer PRECISA falhar rapido quando o Redis cai
 * em runtime: `enableOfflineQueue: false` faz o `add()` REJEITAR de imediato
 * (em vez de bufferizar o comando e deixar a Promise pendente pra sempre) —
 * so assim o try/catch de `enfileirar*` dispara o fail-open p/ inline (FILA-02
 * <200ms + "nunca 500, sempre degrada"). `maxRetriesPerRequest: null` (exigido
 * SO pelos blocking commands do Worker) faria o oposto aqui. Mesmo padrao de
 * `garantirCliente()` em estado-webhook.ts:96-104. Retorna null em modo inline.
 */
export function conexaoFilaProducer(): object | null {
  if (MODO !== 'bullmq') return null;
  return {
    url: REDIS_URL,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    connectTimeout: 5000,
  };
}

/**
 * Opcoes de job aplicadas em todo `queue.add` — retry com backoff
 * exponencial (FILA-03) e retencao dos jobs. `removeOnFail: false` MANTEM
 * os jobs falhos no set `failed` do BullMQ — esse set E a DLQ inspecionavel
 * (FILA-04), nunca descartada automaticamente.
 */
export function opcoesJob(): object {
  return {
    attempts: FILA_ATTEMPTS,
    backoff: { type: 'exponential', delay: FILA_BACKOFF_MS },
    removeOnComplete: { count: 1000 },
    removeOnFail: false,
  };
}

// ===== Queue BullMQ — instanciacao lazy singleton (so em modo bullmq) =====
//
// NUNCA instanciar no top-level do modulo (quebraria o boot sem Redis) — so
// na primeira chamada de enfileirar*, espelhando garantirCliente() de
// estado-webhook.ts.

let filaBullMq: Queue | null = null;

function garantirFila(): Queue {
  if (!filaBullMq) {
    // CR-01: o PRODUCER usa a conexao fail-fast (enableOfflineQueue:false), NAO
    // a do Worker (maxRetriesPerRequest:null) — senao o add() bufferiza/pendura
    // em vez de rejeitar e o fail-open p/ inline abaixo nunca dispara.
    filaBullMq = new Queue(NOME_FILA, { connection: conexaoFilaProducer() as any });
    // So para nao derrubar o processo com unhandled error — mensagem curta,
    // NUNCA a REDIS_URL nem dado do job (pode conter PII).
    filaBullMq.on('error', (e) => {
      console.error('[fila] erro de conexao Redis (degradando):', e instanceof Error ? e.message : String(e));
    });
  }
  return filaBullMq;
}

export async function enfileirarRecord(dados: DadosJobRecord): Promise<{ enfileirado: boolean }> {
  if (MODO !== 'bullmq') return { enfileirado: false };
  try {
    // jobId = whatsappCallId: dedup de enqueue (FILA-05) — reenvio do mesmo
    // call_id (retry do Wavoip, corrida de replicas) nao cria job duplicado.
    await garantirFila().add('record', dados, { ...opcoesJob(), jobId: dados.whatsappCallId });
    return { enfileirado: true };
  } catch (e) {
    // Fail-open p/ inline: Redis caiu em runtime, o chamador processa a
    // request sincrona (mesma resiliencia do fail-open de estado-webhook).
    console.error(
      '[fila] falha ao enfileirar record (degradando p/ inline):',
      e instanceof Error ? e.message : String(e),
    );
    return { enfileirado: false };
  }
}

export async function enfileirarFalhaTerminal(
  dados: DadosJobFalhaTerminal,
): Promise<{ enfileirado: boolean }> {
  if (MODO !== 'bullmq') return { enfileirado: false };
  try {
    // BUG-01: jobId com ':' so passa na validacao do BullMQ (job.js) se tiver
    // EXATAMENTE 3 segmentos (compat legado com repeatable jobs) — 'CALLID:falha'
    // tem 2 e sempre lancava 'Custom Id cannot contain :' (40x nos logs de prod,
    // TODA falha-terminal caindo pro fallback inline). Hifen nao tem esse limite.
    await garantirFila().add('falha-terminal', dados, {
      ...opcoesJob(),
      jobId: dados.whatsappCallId + '-falha',
    });
    return { enfileirado: true };
  } catch (e) {
    console.error(
      '[fila] falha ao enfileirar falha-terminal (degradando p/ inline):',
      e instanceof Error ? e.message : String(e),
    );
    return { enfileirado: false };
  }
}

/**
 * Enfileira o job de sync ClickUp (CACHE-03, Fase 08 Plano 03) — espelha o
 * voto pos-ligacao no ClickUp fora do caminho da requisicao. Mesmo molde de
 * `enfileirarRecord`: fail-open p/ inline sem Redis ou em erro de enqueue em
 * runtime (o caller grava sincrono, D-07/SC5). jobId = `sync:voto:{taskId}`
 * (dedup idempotente — o ULTIMO voto enfileirado vence; um segundo enqueue
 * do mesmo taskId antes do primeiro ser consumido substitui o job pendente
 * em vez de empilhar). Reusa `opcoesJob()` (backoff exponencial + DLQ,
 * D-08) e a MESMA fila `NOME_FILA` (Discretion D-07 — sem fila propria).
 */
export async function enfileirarSyncClickup(
  dados: DadosJobSyncClickup,
): Promise<{ enfileirado: boolean }> {
  if (MODO !== 'bullmq') return { enfileirado: false };
  try {
    await garantirFila().add('sync-clickup', dados, {
      ...opcoesJob(),
      jobId: 'sync:voto:' + dados.taskId,
    });
    return { enfileirado: true };
  } catch (e) {
    // Fail-open p/ inline: o caller (Plano 04) grava o voto sincrono no
    // ClickUp em vez de esperar o worker (SC5).
    console.error(
      '[fila] falha ao enfileirar sync-clickup (degradando p/ inline):',
      e instanceof Error ? e.message : String(e),
    );
    return { enfileirado: false };
  }
}

/**
 * Alerta de DLQ (FILA-04) — chamado pelo worker (06-04) quando um job
 * esgota FILA_ATTEMPTS. SEMPRE loga uma linha estruturada `[ALERTA][DLQ]`
 * (nunca telefone/CPF/payload — so ids e a classe do erro). Se
 * ALERT_WEBHOOK_URL estiver setado, faz tambem um POST best-effort com o
 * mesmo payload sem PII — nunca relanca (alerta e observabilidade, nunca
 * derruba o worker).
 */
export async function alertarDLQ(info: {
  job: NomeJob;
  whatsappCallId: string;
  eventoDuravelId: string | null;
  erro: string;
}): Promise<void> {
  console.error(
    `[ALERTA][DLQ] job=${info.job} whatsappCallId=${info.whatsappCallId} ` +
      `eventoDuravelId=${info.eventoDuravelId ?? 'null'} erro=${info.erro}`,
  );

  if (!ALERT_WEBHOOK_URL) return;

  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job: info.job,
        whatsappCallId: info.whatsappCallId,
        eventoDuravelId: info.eventoDuravelId,
        erro: info.erro,
      }),
    });
  } catch (e) {
    console.error(
      '[fila] falha ao enviar alerta de DLQ via webhook (degradando p/ so-log):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Graceful shutdown da Queue (Fase 6) — no-op em modo inline. */
export async function fecharFila(): Promise<void> {
  if (filaBullMq) {
    await filaBullMq.close();
    filaBullMq = null;
  }
}

/**
 * Profundidade da fila (D-06, OBS-02) — jobs pendentes (waiting + delayed +
 * active) na MESMA Queue de enfileirar* (garantirFila(), nunca instancia
 * outro cliente Redis). Reusa a Queue lazy singleton do producer. Retorna 0
 * em modo inline (nao ha fila a medir) e em qualquer erro do Redis em
 * runtime — metricas.ts NUNCA pode travar por causa desta fonte.
 */
export async function profundidadeFila(): Promise<number> {
  if (MODO !== 'bullmq') return 0;
  try {
    const contagens = await garantirFila().getJobCounts('waiting', 'delayed', 'active');
    return (contagens.waiting ?? 0) + (contagens.delayed ?? 0) + (contagens.active ?? 0);
  } catch (e) {
    console.error(
      '[fila] falha ao ler profundidade da fila (degradando p/ 0):',
      e instanceof Error ? e.message : String(e),
    );
    return 0;
  }
}

console.log(
  MODO === 'bullmq'
    ? '[fila] processamento em BullMQ (Redis)'
    : '[fila] processamento inline (1 instancia)',
);
