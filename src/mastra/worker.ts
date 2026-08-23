// Entrypoint do worker BullMQ em processo separado (Fase 6 Plano 04,
// escala-150-atendentes; retry/DLQ endurecidos na Fase 19.1 Plano 04,
// DUR-01/DUR-02; varredura periodica de re-drive da DLQ na Fase 19.1 Plano
// 05, DUR-03, redrive-dlq.ts).
//
// Consome a fila `processamento-ligacao` (fila.ts) fora do caminho da
// requisicao do webhook Wavoip: despacha cada job por `job.name` para
// `processador.ts` (processarRecordJob/processarFalhaTerminalJob, 06-02) sob
// um wrapper que CLASSIFICA cada falha (classificar-erro.ts) — TRANSITORIO
// relanca o erro original pro BullMQ reagendar com o backoff CAPADO
// (settings.backoffStrategy delega a calcularBackoffCapado, fila.ts) e
// retenta PARA SEMPRE na pratica (FILA_MAX_TENTATIVAS); PERMANENTE alerta
// (alertarEstacionado) e lanca UnrecoverableError, estacionando o job na DLQ
// IMEDIATO. worker.on('failed') so registra (marcarEventoWebhook('erro') +
// alertarDLQ) o que REALMENTE parou — nada e auto-fechado sem humano (decisao
// travada do dono da operacao). DRENA o job em andamento no SIGTERM/SIGINT
// antes de encerrar (INFRA-05, graceful shutdown do swarm).
//
// Reusa a MESMA imagem `discador-wavoip:latest` — o Dockerfile bundla este
// arquivo em `worker.mjs` (esbuild) e o servico do swarm sobrescreve o CMD
// pra `node worker.mjs` (deploy/worker-service.md).
//
// LGPD/WR-01: nenhum telefone/CPF/payload em log — so ids (whatsappCallId,
// eventoDuravelId, job.id) e a classe/mensagem do erro.

import { Worker, UnrecoverableError } from 'bullmq';

import { FILA_CONCURRENCY } from './config.ts';

import {
  NOME_FILA,
  conexaoFila,
  modoFila,
  alertarDLQ,
  calcularBackoffCapado,
  fecharFila,
  type DadosJobRecord,
  type DadosJobFalhaTerminal,
  type DadosJobSyncClickup,
  type DadosJobDrenoOutbox,
  type NomeJob,
} from './fila.ts';

import { classificarErro } from './classificar-erro.ts';
// finalizarRecordSemTranscricao NAO e mais importado/chamado aqui — Fase
// 19.1 Plano 04 removeu a auto-finalizacao por esgotamento (ver comentario
// no worker.on('failed') abaixo). A funcao continua exportada em
// processador.ts (dead code documentado, nao removida — pode voltar a ser
// util se uma fase futura decidir reintroduzir fechamento assistido).
import { processarRecordJob, processarFalhaTerminalJob } from './processador.ts';
import { processarSyncClickupJob } from './sync-clickup.ts';
import { processarDrenoOutboxJob } from './drenar-outbox.ts';
import { marcarEventoWebhook } from './supabase.ts';
import { fecharEstadoWebhook } from './estado-webhook.ts';
import { fecharRateLimiter } from './rate-limiter-clickup.ts';
import { iniciarChecagemAlertas, fecharAlertas, alertarEstacionado } from './alertas.ts';
import { iniciarRedriveDLQ, fecharRedriveDLQ } from './redrive-dlq.ts';

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
    // Fase 19.1 Plano 04 (DUR-01/DUR-02): wrapper de classificacao em volta
    // do dispatch por job.name — decide o destino de CADA falha, nao so
    // loga-e-propaga como antes. TRANSITORIO (rede/5xx/429/degradacao
    // conhecida): re-lanca o erro ORIGINAL (preserva a causa especifica, ex.
    // host/status do storage) para o BullMQ reagendar com o backoff capado
    // (settings.backoffStrategy acima) — com FILA_MAX_TENTATIVAS o job
    // re-tenta PARA SEMPRE na pratica. PERMANENTE (task apagada, payload
    // invalido, 404 definitivo): alerta ANTES de estacionar
    // (alertarEstacionado) e lanca UnrecoverableError — o BullMQ move o job
    // pro set `failed` (DLQ) IMEDIATAMENTE, sem consumir tentativas do
    // retry-infinito. Decisao travada do dono da operacao: nada e
    // auto-descartado sem humano.
    try {
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
    } catch (err) {
      const classificado = classificarErro(err);
      if (classificado.tipo === 'permanente') {
        await alertarEstacionado({
          job: job.name,
          jobId: job.id,
          origem: classificado.origem,
          status: classificado.status,
          motivo: classificado.motivo,
        });
        throw new UnrecoverableError(classificado.motivo);
      }
      // transitorio: relanca o erro ORIGINAL (preserva a causa especifica p/
      // log/DLQ) — o BullMQ reagenda com o backoff capado.
      throw err;
    }
  },
  {
    connection: conexaoFila() as object,
    concurrency: FILA_CONCURRENCY,
    // Fase 19.1 Plano 04 (DUR-01): registra a estrategia de backoff NOMEADA
    // 'capado' usada por opcoesJob() (fila.ts) — BullMQ exige que backoff
    // customizado seja uma funcao registrada no Worker (nao serializavel no
    // job), entao delega ao PURO calcularBackoffCapado (a mesma curva
    // testada isolada em retry-durabilidade.smoke.mjs).
    settings: { backoffStrategy: (attemptsMade: number) => calcularBackoffCapado(attemptsMade) },
  },
);

// ===== Handler de falha — registro (DLQ + alerta) do que REALMENTE falhou =====
//
// Fase 19.1 Plano 04 (DUR-01/DUR-02): o BullMQ emite 'failed' a CADA
// tentativa que lanca, mesmo quando o job ainda vai retentar (nao so na
// falha final) — por isso o guard abaixo continua necessario. A diferenca
// pro comportamento pre-Fase 19.1: com FILA_MAX_TENTATIVAS (~1_000_000), um
// erro TRANSITORIO efetivamente NUNCA esgota `job.attemptsMade >=
// job.opts.attempts` na pratica — ele so cai neste handler retentando (log
// curto, sem DLQ/alerta) ate o terceiro conseguir de novo. O UNICO jeito de
// um job chegar aqui "de verdade" (retido no set `failed` do BullMQ) e:
//   1) PERMANENTE — o wrapper de classificacao (acima) ja disparou
//      `alertarEstacionado` e lancou UnrecoverableError ANTES deste handler
//      rodar; `err` chega aqui como UnrecoverableError, identificavel por
//      `err.name` (BullMQ marca o job como failed IMEDIATO, sem esgotar
//      tentativas — entao NAO da pra usar o mesmo check de
//      attemptsMade>=attempts pra detectar este caso).
//   2) LEGADO — um job enfileirado ANTES deste deploy, com
//      `attempts:3`/`backoff:exponential` ja gravados no proprio job
//      (opcoesJob() no momento do enqueue antigo) — esgota do jeito de
//      sempre (migracao suave, NOME_FILA intacta).
worker.on('failed', async (job, err) => {
  if (!job) {
    // BullMQ documenta: job pode vir undefined quando um job "stalled"
    // esgota o limite e e removido por removeOnFail antes deste handler
    // rodar. Nada pra correlacionar — so loga a mensagem do erro.
    console.error('[worker] job failed sem referencia de job:', err instanceof Error ? err.message : String(err));
    return;
  }

  const ehPermanenteEstacionado = err instanceof UnrecoverableError || (err as { name?: string })?.name === 'UnrecoverableError';
  const tentativasEsgotadasLegado = !ehPermanenteEstacionado && job.attemptsMade >= (job.opts.attempts ?? 1);

  if (!ehPermanenteEstacionado && !tentativasEsgotadasLegado) {
    // Transitorio, ainda vai retentar (backoff capado, settings.backoffStrategy
    // acima) — log curto, sem tocar em DLQ/alerta (o [ALERTA][ESTACIONADO], se
    // for o caso, ja disparou no wrapper de classificacao antes deste evento).
    console.warn(
      `[worker] job=${job.name} id=${job.id} falhou (tentativa ${job.attemptsMade}/${job.opts.attempts ?? 1}), retentando: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }

  // Aqui: permanente-estacionado (UnrecoverableError) OU legado esgotado. O
  // job ja fica retido no set `failed` do BullMQ (DLQ inspecionavel,
  // removeOnFail:false de opcoesJob()). Marca o desfecho durvel do evento
  // cru como 'erro' (log-e-segue) e dispara o alerta de DLQ como REGISTRO
  // (alertarEstacionado ja alertou o permanente antes; alertarDLQ aqui cobre
  // ambos os casos, inclusive o legado que nao passa pelo wrapper). NUNCA
  // telefone/CPF/payload — so ids e a classe do erro.
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

  // Fase 19.1 Plano 04 (DUR-02, decisao travada do dono da operacao): "nada
  // e auto-descartado/auto-fechado sem humano" — REMOVIDA a auto-finalizacao
  // por esgotamento (finalizarRecordSemTranscricao) que existia aqui antes.
  // Um RECORD estacionado (permanente) OU legado esgotado permanece "em
  // processamento" ATE um humano agir — o [ALERTA][ESTACIONADO]/[ALERTA][DLQ]
  // acima E o sinal, nao um fechamento automatico da Ligacao. Tradeoff
  // explicito: preferimos uma Ligacao presa "em processamento" (visivel,
  // alarmada) a fecha-la sozinha e potencialmente descartar trabalho que um
  // humano ainda poderia recuperar.
});

console.log(`[worker] consumindo a fila ${NOME_FILA} (concurrency=${FILA_CONCURRENCY})`);

// D-07/OBS-02: checador periódico de threshold (fila/erro-por-etapa/429) só
// no caminho modo bullmq — o early return `process.exit(0)` do modo inline
// (linhas 46-51 acima) já impede que rode sem fila/Redis para monitorar.
iniciarChecagemAlertas();

// Fase 19.1 Plano 05 (DUR-03): varredura periódica da DLQ — re-driva failed
// TRANSITÓRIOS sozinha (rate-spaced, DLQ_REDRIVE_ESPACO_MS entre re-adds) e
// alarma jobs presos além de DLQ_AGE_ALERTA_MS. Mesmo gate do modo bullmq
// (redrive-dlq.ts também no-op em modo inline).
iniciarRedriveDLQ();

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
  await fecharRedriveDLQ();
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
