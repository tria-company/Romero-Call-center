// Entrypoint do worker BullMQ em processo separado (Fase 6 Plano 04,
// escala-150-atendentes).
//
// Consome a fila `processamento-ligacao` (fila.ts) fora do caminho da
// requisicao do webhook Wavoip: despacha cada job por `job.name` para
// `processador.ts` (processarRecordJob/processarFalhaTerminalJob, 06-02),
// deixa o throw do processador PROPAGAR pro BullMQ contar a tentativa e
// reagendar com backoff exponencial (FILA-03, opcoesJob() gravado no job
// pelo enqueue em 06-03), encaminha jobs com tentativas esgotadas pra DLQ +
// alerta (FILA-04) e DRENA o job em andamento no SIGTERM/SIGINT antes de
// encerrar (INFRA-05, graceful shutdown do swarm).
//
// Reusa a MESMA imagem `discador-wavoip:latest` — o Dockerfile bundla este
// arquivo em `worker.mjs` (esbuild) e o servico do swarm sobrescreve o CMD
// pra `node worker.mjs` (deploy/worker-service.md).
//
// LGPD/WR-01: nenhum telefone/CPF/payload em log — so ids (whatsappCallId,
// eventoDuravelId, job.id) e a classe/mensagem do erro.

import { Worker } from 'bullmq';

import { FILA_CONCURRENCY } from './config.ts';

import {
  NOME_FILA,
  conexaoFila,
  modoFila,
  alertarDLQ,
  fecharFila,
  type DadosJobRecord,
  type DadosJobFalhaTerminal,
  type DadosJobSyncClickup,
  type DadosJobDrenoOutbox,
  type NomeJob,
} from './fila.ts';

import { processarRecordJob, processarFalhaTerminalJob, finalizarRecordSemTranscricao } from './processador.ts';
import { processarSyncClickupJob } from './sync-clickup.ts';
import { processarDrenoOutboxJob } from './drenar-outbox.ts';
import { marcarEventoWebhook } from './supabase.ts';
import { fecharEstadoWebhook } from './estado-webhook.ts';
import { fecharRateLimiter } from './rate-limiter-clickup.ts';
import { iniciarChecagemAlertas, fecharAlertas } from './alertas.ts';

// Degradacao graciosa: sem REDIS_URL, fila.ts roda em modo inline (o
// webhook processa a request sincrona, 06-03) — nao ha fila para este
// processo consumir. Encerra limpo em vez de subir um Worker sem conexao ou
// ficar um servico do swarm falhando em loop por engano de configuracao.
if (modoFila() !== 'bullmq') {
  console.log(
    '[worker] REDIS_URL ausente — sem fila para consumir; encerrando (processamento é inline no web)',
  );
  process.exit(0);
}

const worker = new Worker(
  NOME_FILA,
  async (job) => {
    switch (job.name) {
      case 'record':
        await processarRecordJob(job.data as DadosJobRecord);
        return;
      case 'falha-terminal':
        await processarFalhaTerminalJob(job.data as DadosJobFalhaTerminal);
        return;
      case 'sync-clickup':
        await processarSyncClickupJob(job.data as DadosJobSyncClickup);
        return;
      case 'drenar-outbox':
        // ESCRITA-02/LGPD-03 (Fase B, Phase 19 Plano 03): drena o
        // clickup_outbox do aggregate — reusa a MESMA fila/conexão (sem fila
        // própria), mesmo padrão de sync-clickup acima.
        await processarDrenoOutboxJob((job.data as DadosJobDrenoOutbox).aggregateId);
        return;
      default:
        // Nome de job desconhecido (schema futuro/engano de enqueue) — loga
        // e ignora; nao ha handler pra reprocessar isto num retry.
        console.warn(`[worker] job com nome desconhecido ignorado: ${job.name} (id=${job.id})`);
        return;
    }
  },
  { connection: conexaoFila() as object, concurrency: FILA_CONCURRENCY },
);

// ===== Handler de falha — retry (FILA-03) ou DLQ + alerta (FILA-04) =====
worker.on('failed', async (job, err) => {
  if (!job) {
    // BullMQ documenta: job pode vir undefined quando um job "stalled"
    // esgota o limite e e removido por removeOnFail antes deste handler
    // rodar. Nada pra correlacionar — so loga a mensagem do erro.
    console.error('[worker] job failed sem referencia de job:', err instanceof Error ? err.message : String(err));
    return;
  }

  const tentativasEsgotadas = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!tentativasEsgotadas) {
    // Ainda vai retentar (backoff exponencial de opcoesJob(), FILA-03) — log
    // curto, sem tocar em DLQ/alerta.
    console.warn(
      `[worker] job=${job.name} id=${job.id} falhou (tentativa ${job.attemptsMade}/${job.opts.attempts ?? 1}), retentando: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }

  // FILA-04: tentativas esgotadas -> o job ja fica retido no set `failed`
  // do BullMQ (DLQ inspecionavel, removeOnFail:false de opcoesJob()). Marca
  // o desfecho durvel do evento cru como 'erro' (log-e-segue) e dispara o
  // alerta. NUNCA telefone/CPF/payload — so ids e a classe do erro.
  //
  // job.data e tratado como Record<string,any> aqui (nao um union dos 3
  // tipos de payload) porque o job de sync-clickup (CACHE-03) NAO tem
  // `eventoDuravelId`/`whatsappCallId` (payload minimizado, so
  // taskId/assigneeId/voto) — o guard condicional abaixo evita chamar
  // marcarEventoWebhook com um campo inexistente.
  const dados = job.data as Record<string, any>;
  if (dados.eventoDuravelId) {
    try {
      await marcarEventoWebhook(dados.eventoDuravelId, 'erro', String(err?.message ?? err).slice(0, 500));
    } catch (e) {
      console.error(
        '[worker] falha ao marcar evento durvel como erro apos DLQ:',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  await alertarDLQ({
    job: job.name as NomeJob,
    // O job de sync-clickup nao tem whatsappCallId — correlaciona pelo
    // taskId da Ligacao no lugar (ambos identificam o "o que" falhou). O job
    // de drenar-outbox (Fase B, Phase 19 Plano 03) so tem aggregateId.
    whatsappCallId: dados.whatsappCallId ?? dados.taskId ?? (dados.aggregateId != null ? `aggregate:${dados.aggregateId}` : 'n/a'),
    eventoDuravelId: dados.eventoDuravelId ?? null,
    erro: err?.name || 'erro',
  });

  // Desfecho gracioso do RECORD (FILA-04/OPER-05): sem esta finalizacao a
  // Ligacao fica presa em "em processamento" para SEMPRE quando a transcricao
  // nunca sucede (zumbi observado em prod). ADITIVA — fecha a Ligacao ALEM do
  // registro na DLQ/alerta/marcarEventoWebhook('erro') acima, nao os substitui.
  // So para 'record' (falha-terminal ja fecha; sync-clickup nao tem Ligacao a
  // fechar). try/catch loga-e-segue: uma falha ao finalizar NAO pode quebrar o
  // handler de falha nem invalidar o registro na DLQ que ja rodou acima (WR-01:
  // so ids/classe do erro em log, nunca payload).
  if (job.name === 'record') {
    try {
      await finalizarRecordSemTranscricao(job.data as DadosJobRecord);
    } catch (e) {
      console.error(
        `[worker] falha ao finalizar record sem transcricao (id=${job.id}):`,
        e instanceof Error ? e.name : String(e),
      );
    }
  }
});

console.log(`[worker] consumindo a fila ${NOME_FILA} (concurrency=${FILA_CONCURRENCY})`);

// D-07/OBS-02: checador periódico de threshold (fila/erro-por-etapa/429) só
// no caminho modo bullmq — o early return `process.exit(0)` do modo inline
// (linhas 46-51 acima) já impede que rode sem fila/Redis para monitorar.
iniciarChecagemAlertas();

// ===== Graceful shutdown (INFRA-05) =====
//
// SIGTERM (deploy/scale-down do swarm, dentro do stop_grace_period) ou
// SIGINT (Ctrl+C local): `worker.close()` DRENA o job em andamento — o
// BullMQ espera o processor em curso terminar antes de resolver — so depois
// fecha a conexao da fila e do estado do webhook e sai. Idempotente (flag
// `encerrando`): um segundo sinal durante o shutdown nao reinicia a sequencia.
let encerrando = false;

async function encerrar(sinal: NodeJS.Signals): Promise<void> {
  if (encerrando) return;
  encerrando = true;
  console.log(`[worker] recebido ${sinal} — drenando job atual...`);
  try {
    await worker.close();
  } catch (e) {
    console.error('[worker] falha ao drenar/fechar o worker:', e instanceof Error ? e.message : String(e));
  }
  fecharAlertas();
  await fecharFila();
  await fecharEstadoWebhook();
  // INFRA-05: o worker abre o cliente Redis do rate limiter ao escrever no
  // ClickUp (record/falha-terminal/sync-clickup saem pelo choke point
  // rate-limitado do Plano 01) — fecha no shutdown gracioso junto com os
  // demais clientes. O worker nunca le a fila do dia (o cache-aside do
  // Plano 02 vive so no processo web) — esse outro cliente Redis jamais e
  // aberto neste processo, entao nao ha o que fechar aqui alem do acima.
  await fecharRateLimiter();
  process.exit(0);
}

process.on('SIGTERM', () => void encerrar('SIGTERM'));
process.on('SIGINT', () => void encerrar('SIGINT'));
