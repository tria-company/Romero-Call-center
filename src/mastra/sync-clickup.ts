// Processor do job de sync ClickUp (CACHE-03, Fase 08 Plano 03,
// escala-150-atendentes).
//
// Espelha o voto pos-ligacao (confirmado no fim da chamada, D-07) no
// ClickUp de forma assincrona — o worker (worker.ts) chama isto fora do
// caminho da requisicao, consistencia eventual (p95 < 60s). Mesma semantica
// de falha de processador.ts: NAO envolve o throw de `salvarVotoLead` em
// try/catch que engole — deixa PROPAGAR pro BullMQ contar a tentativa e
// reagendar com backoff exponencial (opcoesJob(), D-08); tentativas
// esgotadas retem o job na DLQ (removeOnFail:false) — nada se perde, so
// atrasa. Em modo inline (sem Redis, Plano 04) o caller traduz o throw.
//
// A autz (a task e uma Ligacao da Lista 02 e pertence ao operador,
// validarLigacaoDoOperador) e a saida HTTP ja rate-limitada (Plano 01,
// fetchClickUp) rodam DENTRO de `salvarVotoLead`/clickup.ts — este arquivo
// NAO reimplementa nenhuma dessas duas coisas, so chama o helper existente.
//
// LGPD/WR-01: nenhum voto/telefone em log — se logar, so taskId/assigneeId
// e a classe do erro (o payload em si ja e minimizado por design, sem PII —
// ver DadosJobSyncClickup em fila.ts).

import type { DadosJobSyncClickup } from './fila.ts';
import { salvarVotoLead } from './clickup.ts';
import { registrarErroEtapa, registrarSucessoEtapa } from './metricas.ts';

/**
 * Espelha o voto do lead (Romero/Andressa) no ClickUp para a Ligacao
 * `dados.taskId` do operador `dados.assigneeId`. LANCA em erro de
 * infra/autorizacao (WR-03, propagado de `salvarVotoLead`) — o BullMQ conta
 * a tentativa e reagenda com backoff (D-08); esgotadas as tentativas, o job
 * fica retido na DLQ (removeOnFail:false) para inspecao/retry manual.
 */
export async function processarSyncClickupJob(dados: DadosJobSyncClickup): Promise<void> {
  // D-06: instrumenta a etapa 'sync' — o catch conta o erro e RE-LANCA, sem
  // engolir o throw que o BullMQ usa pro retry/DLQ (ver cabecalho do
  // arquivo). Nenhum voto/telefone e passado ao coletor, so a etapa literal.
  try {
    await salvarVotoLead(dados.taskId, dados.assigneeId, dados.voto);
    registrarSucessoEtapa('sync');
  } catch (e) {
    registrarErroEtapa('sync');
    throw e;
  }
}
