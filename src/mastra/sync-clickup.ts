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
import { salvarVotoLead, listarTasks, lerAtendeu, CAMPOS_LIGACOES, CLICKUP_LIST_LIGACOES, type TaskClickUp } from './clickup.ts';
import { registrarVotoLigacao } from './supabase.ts';
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
    const { leadId } = await salvarVotoLead(dados.taskId, dados.assigneeId, dados.voto);
    registrarSucessoEtapa('sync');
    // ATRIBUIÇÃO (votos_ligacao): quem colheu a declaração e quando. Só aqui a informação
    // existe — o campo de voto no ClickUp fica no LEAD, que não tem operador nem data.
    //
    // DEPOIS do registrarSucessoEtapa e num try/catch próprio DE PROPÓSITO: o voto no
    // ClickUp já está gravado neste ponto, e ele é a fonte da verdade. Deixar um erro do
    // Supabase escapar daqui faria o BullMQ reprocessar o job e regravar o voto por causa
    // de uma falha na CONTABILIDADE — troca um dado certo por um retry inútil. Loga-e-
    // segue, mesmo critério do write-through do espelho na rota de voto.
    await atribuirVoto(dados, leadId);
  } catch (e) {
    registrarErroEtapa('sync');
    throw e;
  }
}

/**
 * Grava uma linha em `votos_ligacao` por candidato marcado. Never-throws: sem operador no
 * job (job antigo, enfileirado antes do campo existir) é no-op silencioso; erro de
 * Supabase vira log. LGPD: só login e ids de task, nunca telefone/CPF/nome.
 */
async function atribuirVoto(dados: DadosJobSyncClickup, leadId: string | undefined): Promise<void> {
  if (!dados.operador) return;
  const candidatos: Array<['romero' | 'andressa', 'sim' | 'nao' | 'naoDeclarou' | undefined]> = [
    ['romero', dados.voto.romero],
    ['andressa', dados.voto.andressa],
  ];
  for (const [candidato, escolha] of candidatos) {
    if (!escolha) continue;
    try {
      await registrarVotoLigacao({
        ligacaoTaskId: dados.taskId,
        leadTaskId: leadId ?? '',
        operador: dados.operador,
        candidato,
        escolha,
      });
    } catch (e) {
      console.error(
        `[sync] atribuicao do voto (${candidato}) falhou — o voto no ClickUp esta gravado:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}

/**
 * Atribui a declaração de voto marcada na TELA DO LEAD (rota do gestor) ao operador da
 * sessão.
 *
 * Por que existe uma segunda porta: a Lista 01 guarda o voto por LEAD, e esta rota só
 * recebe o `leadTaskId` — não há Ligação no corpo. Mas `votos_ligacao` é chaveada por
 * ligação, então a ligação precisa ser RESOLVIDA. Usa o filtro `LEAD_REL` no servidor do
 * ClickUp (1 request, o mesmo caminho que a timeline da ficha já usa) em vez de paginar a
 * Lista 02 — que hoje custa minutos.
 *
 * Escolhe a ligação ATENDIDA mais recente; sem atendida, a de INICIO mais recente. É o
 * mesmo desempate do backfill, e pelo mesmo motivo: o voto nasce numa chamada atendida.
 *
 * O OPERADOR é certo (vem da sessão de quem marcou); só o vínculo com a ligação é
 * inferido. Sem nenhuma ligação vinculada, não grava — melhor não atribuir do que atribuir
 * a uma chamada que não existe.
 *
 * NEVER-THROWS: chamada com `void`, fora do caminho da resposta. O voto no ClickUp já está
 * gravado quando isto roda.
 */
export async function atribuirVotoDoLead(
  leadTaskId: string,
  operador: string,
  voto: { romero?: 'sim' | 'nao' | 'naoDeclarou'; andressa?: 'sim' | 'nao' | 'naoDeclarou' },
): Promise<void> {
  try {
    if (!operador) return;
    const { tasks } = await listarTasks(CLICKUP_LIST_LIGACOES, {
      includeClosed: true,
      customFields: [{ field_id: CAMPOS_LIGACOES.LEAD_REL, operator: 'ANY', value: [leadTaskId] }],
    });
    if (!tasks.length) {
      console.warn(`[sync] voto do lead ${leadTaskId} sem Ligacao vinculada — sem atribuicao`);
      return;
    }
    const inicio = (t: TaskClickUp) => Number(t.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.INICIO)?.value ?? 0);
    const escolhida = [...tasks].sort((a, b) => {
      const aa = lerAtendeu(a) ? 1 : 0;
      const ab = lerAtendeu(b) ? 1 : 0;
      if (aa !== ab) return ab - aa;
      return inicio(b) - inicio(a);
    })[0];

    for (const [candidato, escolha] of [['romero', voto.romero], ['andressa', voto.andressa]] as const) {
      if (!escolha) continue;
      await registrarVotoLigacao({
        ligacaoTaskId: String(escolhida.id),
        leadTaskId,
        operador,
        candidato,
        escolha,
      });
    }
  } catch (e) {
    console.error('[sync] atribuicao do voto pelo lead falhou (o voto no ClickUp esta gravado):', e instanceof Error ? e.message : String(e));
  }
}
