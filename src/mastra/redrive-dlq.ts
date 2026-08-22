// src/mastra/redrive-dlq.ts
//
// Varredor periódico da DLQ (Fase 19.1 Plano 05, DUR-03) — molde de
// alertas.ts (setInterval de módulo, idempotente, unref, fecha no graceful
// shutdown). A DLQ deixa de ser beco sem saída: hoje um job que esgota as
// tentativas cai no set `failed` do BullMQ e fica lá para sempre até um
// re-drive MANUAL — que em 22/08 estourou o rate limiter do ClickUp (rajada
// de 25 jobs). Este módulo re-drena os failed TRANSITÓRIOS sozinho, de forma
// SERIALIZADA (rate-spaced), e deixa os PERMANENTES estacionados (visíveis +
// alarmados) — mesmo espírito do dreno do outbox (drenar-outbox.ts, homolog)
// aplicado agora à fila BullMQ da main.
//
// POSSE DE fila.ts (AVISO 1 do plan-checker): este módulo NÃO modifica
// fila.ts. Instancia aqui uma Queue BullMQ PRÓPRIA (lazy singleton) com a
// MESMA conexão/NOME_FILA — importa só NOME_FILA/conexaoFila/modoFila de
// fila.ts (leitura de constantes/factory, sem editar o arquivo). Evita
// colisão de posse com o 19.1-04 (que edita fila.ts na Wave 3) e mantém este
// plano com arquivos disjuntos da sua wave.
//
// LGPD/WR-01: o `failedReason` de um job pode carregar PII (telefone/URL em
// mensagem de erro) — este módulo NUNCA loga/alerta o texto cru. Ele só passa
// o failedReason por `classificarErro` (rótulo curto LGPD-safe) e loga/alerta
// job.id/job.name/origem/idade.

import { Queue } from 'bullmq';

import { NOME_FILA, conexaoFila, modoFila } from './fila.ts';
import {
  DLQ_REDRIVE_INTERVALO_MS,
  DLQ_REDRIVE_LOTE,
  DLQ_REDRIVE_ESPACO_MS,
  DLQ_AGE_ALERTA_MS,
} from './config.ts';
import { classificarErro } from './classificar-erro.ts';
import { alertarThreshold } from './alertas.ts';

/** Formato mínimo de um job "failed" que este módulo precisa (subset de bullmq.Job) — permite injetar um fake determinístico no smoke sem depender de Redis. */
export interface JobFailedLike {
  id?: string;
  name: string;
  failedReason?: string;
  finishedOn?: number;
  timestamp?: number;
  retry(): Promise<void>;
}

/** Formato mínimo de Queue que este módulo precisa — bullmq.Queue satisfaz estruturalmente (seam injetável p/ o smoke offline). */
export interface FilaComoDLQ {
  getFailed(start: number, end: number): Promise<JobFailedLike[]>;
}

export interface ResultadoVarredura {
  redrivados: number;
  estacionados: number;
  alertados: number;
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== Queue BullMQ própria — lazy singleton (fila.ts intacto) =====
//
// NUNCA instanciar no top-level do modulo (quebraria o boot sem Redis) — só
// na primeira varredura em modo bullmq, mesmo espírito de garantirFila() em
// fila.ts.

let filaRedrive: Queue | null = null;

function garantirFilaRedrive(): Queue {
  if (!filaRedrive) {
    filaRedrive = new Queue(NOME_FILA, { connection: conexaoFila() as any });
    // So para nao derrubar o processo com unhandled error — mensagem curta,
    // NUNCA a REDIS_URL nem dado do job (pode conter PII). Mesmo padrao de
    // garantirFila() em fila.ts.
    filaRedrive.on('error', (e) => {
      console.error(
        '[redrive-dlq] erro de conexao Redis (degradando):',
        e instanceof Error ? e.message : String(e),
      );
    });
  }
  return filaRedrive;
}

/** Chaves (job.id) atualmente em estado "alertado" por idade — dedup edge-trigger, mesmo padrão de chavesAlertadas em alertas.ts. */
const jobsAlertadosIdade = new Set<string>();

/**
 * Varredura única da DLQ — lê até DLQ_REDRIVE_LOTE jobs do set `failed`,
 * classifica cada um (classificarErro do failedReason) e decide: TRANSITÓRIO
 * re-driva via job.retry() com espaço (DLQ_REDRIVE_ESPACO_MS) antes do
 * próximo — serializa para não estourar o balde de ~90/min do ClickUp, o que
 * aconteceu no re-drive manual de 22/08 (rajada de 25 jobs). PERMANENTE NÃO
 * é re-drivado — fica estacionado (visível + alarmado se envelhecer). Todo
 * job cuja idade ultrapassa DLQ_AGE_ALERTA_MS dispara um alerta de idade
 * (dedup edge-trigger por job.id — só alerta de novo se o job sumir do
 * failed e um job de MESMO id reaparecer). Best-effort por job: uma falha
 * isolada não derruba a varredura inteira.
 *
 * `filaInjetada` é o seam de teste (offline, sem Redis) — quando presente,
 * ignora o gate de modoFila() e usa a fila fake diretamente (mesmo espírito
 * de fetchImpl em gravacao-store.ts). Em produção, worker.ts chama sem
 * argumento — usa a Queue real (lazy singleton) só em modo bullmq.
 */
export async function varrerDLQUmaVez(filaInjetada?: FilaComoDLQ): Promise<ResultadoVarredura> {
  const resultado: ResultadoVarredura = { redrivados: 0, estacionados: 0, alertados: 0 };

  if (!filaInjetada && modoFila() !== 'bullmq') return resultado;

  const fila = filaInjetada ?? (garantirFilaRedrive() as unknown as FilaComoDLQ);

  let jobsFailed: JobFailedLike[];
  try {
    jobsFailed = await fila.getFailed(0, DLQ_REDRIVE_LOTE);
  } catch (e) {
    console.error(
      '[redrive-dlq] falha ao ler o set failed (tentando de novo na proxima varredura):',
      e instanceof Error ? e.message : String(e),
    );
    return resultado;
  }

  const idsVistosNestaVarredura = new Set<string>();

  for (const job of jobsFailed) {
    if (!job) continue;
    try {
      if (job.id) idsVistosNestaVarredura.add(job.id);

      const idade = Date.now() - (job.finishedOn ?? job.timestamp ?? Date.now());
      if (idade > DLQ_AGE_ALERTA_MS && job.id && !jobsAlertadosIdade.has(job.id)) {
        jobsAlertadosIdade.add(job.id);
        resultado.alertados++;
        // LGPD: so job.name/job.id/idade — NUNCA o failedReason cru.
        await alertarThreshold(
          '⚠️ Job preso na DLQ ha muito tempo',
          `job=${job.name} id=${job.id} idade=${Math.round(idade / 60000)}min (limite ${Math.round(DLQ_AGE_ALERTA_MS / 60000)}min)`,
        );
      }

      // failedReason so passa por classificarErro — nunca logado/alertado cru
      // (pode conter PII, ex. telefone/URL na mensagem de erro de terceiro).
      const classificado = classificarErro(job.failedReason);

      if (classificado.tipo === 'transitorio') {
        await job.retry();
        resultado.redrivados++;
        // Rate-spacing: serializa o re-drive p/ nao estourar o balde do
        // ClickUp (aconteceu no re-drive manual de 22/08, rajada de 25 jobs).
        await esperar(DLQ_REDRIVE_ESPACO_MS);
      } else {
        // permanente: NAO re-driva — fica estacionado (visivel), so o
        // alerta de idade acima cobre se envelhecer.
        resultado.estacionados++;
      }
    } catch (e) {
      // Best-effort por job: falha de um nao derruba a varredura inteira.
      console.error(
        `[redrive-dlq] falha ao processar job da DLQ (seguindo pro proximo): job=${job.name} id=${job.id ?? 'n/a'}`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // Libera o dedup dos jobs que sairam do set failed nesta varredura
  // (re-drivados/removidos) — se um job de MESMO id reaparecer no futuro
  // (raro, mas possivel), pode alertar de novo (edge-trigger, mesmo espirito
  // de chavesAlertadas em alertas.ts).
  for (const id of jobsAlertadosIdade) {
    if (!idsVistosNestaVarredura.has(id)) jobsAlertadosIdade.delete(id);
  }

  return resultado;
}

// ===== Checagem periódica — setInterval de módulo, idempotente =====

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Inicia a varredura periódica da DLQ (setInterval de
 * DLQ_REDRIVE_INTERVALO_MS). Idempotente — uma segunda chamada não cria um
 * segundo interval. No-op em modo inline (sem Redis, sem fila a varrer).
 * `unref()` no timer para não segurar o processo vivo (o graceful shutdown
 * do worker chama fecharRedriveDLQ() explicitamente).
 */
export function iniciarRedriveDLQ(): void {
  if (modoFila() !== 'bullmq') return;
  if (intervalHandle) return;
  intervalHandle = setInterval(() => void varrerDLQUmaVez(), DLQ_REDRIVE_INTERVALO_MS);
  intervalHandle.unref?.();
  console.log(
    `[redrive-dlq] varredura periodica da DLQ ativa (intervalo=${DLQ_REDRIVE_INTERVALO_MS}ms, lote=${DLQ_REDRIVE_LOTE}, espaco=${DLQ_REDRIVE_ESPACO_MS}ms)`,
  );
}

/** Para a varredura periódica e fecha a Queue própria (graceful shutdown do worker). No-op se não iniciada. */
export async function fecharRedriveDLQ(): Promise<void> {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (filaRedrive) {
    await filaRedrive.close();
    filaRedrive = null;
  }
}
