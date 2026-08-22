// drenar-outbox.ts — worker de dreno do transactional outbox (ESCRITA-02 +
// LGPD-03, Fase B, Phase 19 Plano 03). Generaliza `sync-clickup.ts`: drena o
// `clickup_outbox` de UM `aggregate_id` por vez, EM ORDEM DE SEQ
// (outbox-repo.ts::proximasPendentes), idempotente por `dedup_key` (o UNIQUE
// e o ON CONFLICT ficam nas RPCs, 19-02) — reusa o choke `fetchClickUp`
// (clickup.ts:41, rate-limiter incluso) e as primitivas por-ID
// (criarTask/setCustomField/atualizarTask/comentarTask/fecharLigacao), NUNCA
// a listagem de tasks (os endpoints por-ID sobreviveram ao incidente 2026-08-20).
//
// `op='criar_task'` resolve o `clickup_task_id` e faz BACK-FILL na linha de
// `ligacoes` (outbox-repo.ts::backfillClickupTaskId) — mas é IDEMPOTENTE A
// CRASH (CR-01): se o agregado já tem `clickup_task_id` resolvido (uma passada
// anterior criou a task mas morreu ANTES de `marcarEnviado`, a linha ficou
// pendente), a re-execução NÃO chama `criarTask` de novo (zero task ClickUp
// duplicada) — reusa o id e só marca `enviado`. ops seguintes daquele
// aggregate que precisam do id ADIAM (a linha continua pendente) enquanto
// `clickup_task_id` for `null` — preserva a ordem por `seq`: nunca pula uma
// linha bloqueada para processar a próxima (isso destruiria a ordem). Após
// CADA envio bem-sucedido, `marcarEnviado` marca `enviado` e NULA o payload
// (scrub de PII pós-drain, LGPD-03/Riscos R13).
//
// WR-A (19-13, 19-REVIEW-2.md) — fecha a janela residual do CR-01: o
// `clickup_task_id` só é conhecido DEPOIS de `criarTask` e persistido por uma
// chamada SEPARADA (`backfillClickupTaskId`). Um crash ENTRE as duas deixaria
// a re-execução sem id resolvido → `criarTask` de novo → task DUPLICADA. A
// defesa é um CLAIM por compare-and-set (`outbox-repo.ts::claimLinha`,
// `pendente`/`erro`→`enviando`) ANTES de `criarTask`: se o processo morre
// depois do claim mas antes do back-fill, a linha fica `enviando` (fora do
// conjunto que `proximasPendentes` lê) — a próxima passada NÃO a re-executa às
// cegas: `reconciliarCriarTaskPresa` a detecta e, sem id resolvido, a converte
// em `orphan` (a task PODE existir no ClickUp mas descorrelacionada) — um
// ÓRFÃO DETECTÁVEL reconciliável pelo 19-06, NUNCA uma DUPLICATA. Se `criarTask`
// falha DENTRO do processo (sem crash), o claim é LIBERADO (`liberarLinha`,
// `enviando`→`pendente`) e o retry segue como antes.
//
// `processarDrenoOutboxJob` é EXPORTADA e usada TANTO pelo worker (worker.ts,
// case 'drenar-outbox') QUANTO pelo fallback inline dos callers (rotas
// 19-07/08, quando `enfileirarDrenoOutbox` retorna `{ enfileirado:false }` —
// sem Redis, dev/homolog).
//
// Erro numa op BLOQUEANTE propaga (throw) — NÃO segue para as próximas ops
// daquele aggregate (preserva ordem); o caller (BullMQ ou o fallback inline)
// decide o retry/backoff (D-08). Erro numa op NÃO-bloqueante
// (`bloqueante=false`, `comentar`/`anexar`) NÃO propaga — cai em DLQ por-linha
// (`marcarDlqLinha`, 19-06/R6) e o loop CONTINUA para a próxima linha, sem
// travar o `seq` das ops bloqueantes. Adiar (taskId ainda null OU rate
// limiter do dreno bloqueado) NÃO é erro — é backpressure (de ordem ou de
// teto global), contado em `adiadas`, e INTERROMPE o loop (break) — nunca
// pula a linha bloqueada para preservar a ordem.
//
// Rate limiter GLOBAL fail-CLOSED (19-06/R9, `rate-limiter-dreno.ts`): ANTES
// de cada saída ao ClickUp (cada primitiva por-ID dentro de `processarLinha`)
// o dreno adquire um token do balde central; sem token (balde vazio além do
// teto de espera, ou erro do Redis) a linha ADIA — nunca deixa passar sem o
// teto global, ao contrário do rate-limiter-clickup.ts (fail-open) que continua
// na frente de `fetchClickUp` como segunda camada. EXCEÇÃO (WR-03): no caminho
// INLINE sem Redis (DRENO_INLINE, dev/homolog) o dreno LIBERA — o teto global
// só existe entre réplicas concorrentes e o inline é single-shot; ver
// `drenoInlineLiberadoSemRedis`.
//
// LGPD/WR-01: NUNCA loga payload/telefone/URL — só `aggregateId`, `linha.op`,
// `linha.dedup_key`, `linha.status` e a classe/mensagem do erro (propagada
// pelas primitivas de clickup.ts, que já seguem essa disciplina).
//
// FORA DE ESCOPO deste plano (débito documentado, não implementado aqui): o
// `op='anexar'` (áudios) segue como não-bloqueante/pulada — o store canônico
// de mídia é Phase 20; hoje não faz I/O nenhum ao ClickUp (não passa pelo
// rate limiter nem pode cair em DLQ, porque não lança).

import { CAMPOS_LIGACOES, CLICKUP_LIST_LIGACOES } from './clickup.ts';
import { criarTask, atualizarTask, setCustomField, comentarTask, fecharLigacao } from './clickup.ts';
import {
  proximasPendentes,
  resolverClickupTaskId,
  backfillClickupTaskId,
  marcarEnviado,
  marcarDlqLinha,
  claimLinha,
  liberarLinha,
  linhasPresasEnviando,
  marcarOrphanEnviando,
  type LinhaOutbox,
} from './outbox-repo.ts';
import { adquirirTokenDreno, modoRateLimiterDreno } from './rate-limiter-dreno.ts';

/**
 * Monta o body de `criarTask` a partir do payload de uma linha
 * `op='criar_task'` (ex.: `{ origem:'avulsa', telefone_canonico, ... }`,
 * gravado pela RPC `criar_ligacao_avulsa`, sql/escala/16). Função PURA (sem
 * I/O) — o `telefone_canonico` já vem em E.164 (telefone-canonico.ts, 19-01),
 * pronto para o custom field TELEFONE (tipo "phone" do ClickUp). NUNCA loga o
 * payload — o `name` da task vai para o ClickUp (dado operacional), não para
 * um log.
 */
function montarBodyDaTask(payload: Record<string, unknown>): {
  name: string;
  assignees?: number[];
  custom_fields?: Array<{ id: string; value: unknown }>;
} {
  const telefone = typeof payload.telefone_canonico === 'string' ? payload.telefone_canonico : '';
  const origem = typeof payload.origem === 'string' ? payload.origem : 'lote';
  const leadTaskId = typeof payload.lead_clickup_task_id === 'string' ? payload.lead_clickup_task_id : '';
  const assigneeRaw = payload.assignee_clickup_id;
  const assigneeNum =
    assigneeRaw !== undefined && assigneeRaw !== null && assigneeRaw !== '' ? Number(assigneeRaw) : NaN;

  const customFields: Array<{ id: string; value: unknown }> = [];
  if (telefone) customFields.push({ id: CAMPOS_LIGACOES.TELEFONE, value: telefone });
  if (leadTaskId) customFields.push({ id: CAMPOS_LIGACOES.LEAD_REL, value: { add: [leadTaskId] } });

  return {
    name: origem === 'avulsa' ? `Ligação avulsa — ${telefone || 'sem telefone'}` : `Ligação — ${telefone || 'sem telefone'}`,
    ...(Number.isFinite(assigneeNum) ? { assignees: [assigneeNum] } : {}),
    ...(customFields.length > 0 ? { custom_fields: customFields } : {}),
  };
}

/**
 * Drena o `clickup_outbox` de UM `aggregate_id`, em ordem de `seq`. Retorna
 * quantas linhas foram enviadas, quantas ficaram adiadas (backpressure de
 * ordem OU de rate limiter, não erro) e quantas caíram em DLQ por-linha
 * (op não-bloqueante que falhou, 19-06/R6). LANÇA quando uma op BLOQUEANTE
 * falha (a linha continua `pendente`/`erro` — o retry/backoff fica a cargo
 * do BullMQ, D-08, ou do fallback inline do caller).
 */
export async function processarDrenoOutboxJob(
  aggregateId: number,
): Promise<{ enviadas: number; adiadas: number; emDlq: number }> {
  // WR-A (19-13): ANTES de tudo, reconcilia uma `criar_task` presa em
  // `enviando` (claim feito, mas o processo morreu antes do back-fill do id).
  // Roda independentemente de haver linhas pendentes — fecha também o caso de
  // uma `criar_task` "pelada" (sem ops seguintes) cujo `enviando` seria
  // invisível a `proximasPendentes`/`cabecaMaisAntiga`.
  await reconciliarCriarTaskPresa(aggregateId);

  const linhas = await proximasPendentes(aggregateId);
  let enviadas = 0;
  let adiadas = 0;
  let emDlq = 0;
  if (linhas.length === 0) return { enviadas, adiadas, emDlq };

  const aggregate = linhas[0].aggregate;
  // O clickup_task_id já resolvido (se `criar_task` já rodou numa passada
  // anterior) — só suportado para 'ligacao' nesta fase (débito de fases
  // futuras para 'lead'/'audio'/'nota').
  let taskId: string | null = aggregate === 'ligacao' ? await resolverClickupTaskId(aggregate, aggregateId) : null;

  for (const linha of linhas) {
    let executada: boolean;
    try {
      executada = await processarLinha(linha, aggregateId, taskId, (novoTaskId) => (taskId = novoTaskId));
    } catch (e) {
      if (linha.bloqueante === false) {
        // DLQ por-linha (R6): op NÃO-bloqueante falhou — não trava o
        // aggregate, o seq das ops bloqueantes segue na próxima iteração.
        const msg = e instanceof Error ? e.message : String(e);
        await marcarDlqLinha(linha.id, msg);
        console.warn(
          `[drenar-outbox] op não-bloqueante '${linha.op}' falhou — DLQ por-linha (aggregateId=${aggregateId}, dedup_key=${linha.dedup_key})`,
        );
        emDlq++;
        continue;
      }
      throw e; // op bloqueante: propaga (BullMQ conta a tentativa/backoff), como no 19-03
    }

    if (!executada) {
      adiadas++;
      break; // preserva ordem: taskId ainda não resolvido OU rate limiter do dreno bloqueado (fail-CLOSED)
    }
    await marcarEnviado(linha.id);
    enviadas++;
  }

  return { enviadas, adiadas, emDlq };
}

/**
 * WR-A (19-13, 19-REVIEW-2.md) — reconcilia uma `criar_task` PRESA em `enviando`
 * (o claim foi feito mas o processo morreu antes do back-fill do id). Dois
 * sub-casos de crash, ambos SEM re-criar a task (nunca duplicata):
 *   1. `clickup_task_id` NÃO resolvido (`resolverClickupTaskId` = null): o
 *      crash foi entre `criarTask` e o back-fill — a task PODE existir no
 *      ClickUp mas está descorrelacionada. Converte em `orphan`
 *      (`marcarOrphanEnviando`): um órfão DETECTÁVEL, reconciliável pelo 19-06.
 *   2. `clickup_task_id` JÁ resolvido: o back-fill rodou, só o `marcarEnviado`
 *      faltou (crash pós-back-fill). Finaliza a(s) linha(s) `enviando` como
 *      `enviado` — o id já está persistido, as ops seguintes o reusam; nenhuma
 *      task nova é criada.
 * `linhasPresasEnviando` filtra `aggregate=eq.ligacao` + `op=eq.criar_task`, então
 * para qualquer outro aggregate/id esta função é um no-op barato (lista vazia).
 * NUNCA loga payload — só a contagem e o `aggregateId`.
 */
async function reconciliarCriarTaskPresa(aggregateId: number): Promise<void> {
  const presas = await linhasPresasEnviando(aggregateId);
  if (presas.length === 0) return;

  const idPersistido = await resolverClickupTaskId('ligacao', aggregateId);
  if (idPersistido) {
    // Crash pós-back-fill: id já persistido; só faltou marcar enviado. Finaliza
    // (não re-cria — as ops seguintes reusam o id via `resolverClickupTaskId`).
    for (const linha of presas) await marcarEnviado(linha.id);
    console.warn(
      `[drenar-outbox] WR-A: ${presas.length} criar_task presa(s) em 'enviando' com id JÁ persistido (crash pós-back-fill) — finalizada(s) como enviado, sem re-criar (aggregateId=${aggregateId})`,
    );
    return;
  }

  // Crash entre criarTask e o back-fill: id NÃO resolvido. A task pode existir
  // no ClickUp descorrelacionada — NUNCA re-cria; converte em órfão detectável.
  const orfas = await marcarOrphanEnviando(aggregateId);
  console.warn(
    `[drenar-outbox] WR-A: ${orfas} criar_task presa(s) em 'enviando' SEM clickup_task_id resolvido (crash entre criarTask e back-fill) — roteada(s) para reconciliação/órfão (19-06), NÃO re-criada(s) (aggregateId=${aggregateId})`,
  );
}

/**
 * WR-03: o caminho INLINE (sem Redis) do dreno NÃO é limitado pelo teto GLOBAL.
 *
 * O teto global fail-CLOSED (`rate-limiter-dreno.ts`, 19-06/R9) existe para
 * impedir que N RÉPLICAS concorrentes do worker furem o orçamento ~90/min do
 * ClickUp — e ele SÓ é real com o balde Redis central somando as réplicas. Sem
 * `REDIS_URL` o deploy é o fallback INLINE single-shot (`DRENO_INLINE`, dev/
 * homolog): um único processo, um agregado por vez, disparado pelo caller —
 * não há réplicas concorrentes a coordenar, então o teto global não se aplica.
 *
 * O bug (revisão 19-REVIEW.md/WR-03): `adquirirTokenDreno()` retorna `false`
 * imediatamente sem Redis, e como `garantirTokenDreno` roda antes de CADA saída,
 * o dreno inline NUNCA emitia nada — o outbox enchia e o espelho ClickUp travava
 * silenciosamente após o flip sem `REDIS_URL`. Aqui distinguimos os dois
 * caminhos: sem Redis (inline), LIBERA; com Redis (worker/multi-réplica), segue
 * fail-CLOSED de verdade (overflow do balde OU erro do Redis → bloqueia). A
 * segunda camada de teto no caminho inline é o choke fail-open por-processo de
 * `rate-limiter-clickup.ts`, que continua na frente de cada `fetchClickUp`.
 */
export function drenoInlineLiberadoSemRedis(): boolean {
  return modoRateLimiterDreno() === 'sem-redis';
}

/**
 * Adquire o token do dreno (`rate-limiter-dreno.ts`, fail-CLOSED, 19-06/R9)
 * ANTES de uma saída ao ClickUp. `false` = BLOQUEADO (balde global esgotado ou
 * erro do Redis) — o caller (`processarLinha`) trata exatamente como o adiar
 * por ordem (`taskIdAtual` ainda null): retorna `false`, o loop de
 * `processarDrenoOutboxJob` interrompe (break) e a linha permanece pendente.
 * EXCEÇÃO (WR-03): sem Redis (caminho inline), LIBERA — ver
 * `drenoInlineLiberadoSemRedis`.
 */
async function garantirTokenDreno(linha: LinhaOutbox): Promise<boolean> {
  if (drenoInlineLiberadoSemRedis()) return true; // WR-03: inline single-shot sem Redis DRENA
  const permitido = await adquirirTokenDreno();
  if (!permitido) {
    console.warn(
      `[drenar-outbox] rate limiter do dreno bloqueado (fail-CLOSED) — adiando (dedup_key=${linha.dedup_key})`,
    );
  }
  return permitido;
}

/**
 * Processa UMA linha do outbox. Retorna `true` quando a op foi executada
 * (o caller marca `enviado` em seguida) ou `false` quando a linha precisou
 * ADIAR — `taskId` ainda null (backpressure de ordem) OU o rate limiter do
 * dreno bloqueou (backpressure de teto global, fail-CLOSED, 19-06/R9) — o
 * loop do caller para ali (preserva ordem). Erro numa op (bloqueante ou não)
 * PROPAGA (throw) — nunca engole; `processarDrenoOutboxJob` decide DLQ
 * vs. propagação conforme `linha.bloqueante`.
 */
async function processarLinha(
  linha: LinhaOutbox,
  aggregateId: number,
  taskIdAtual: string | null,
  setTaskId: (id: string) => void,
): Promise<boolean> {
  const payload = (linha.payload ?? {}) as Record<string, unknown>;

  switch (linha.op) {
    case 'criar_task': {
      // CR-01 (idempotência a crash): se o `clickup_task_id` do agregado JÁ
      // está resolvido (`taskIdAtual` != null — o `resolverClickupTaskId` no
      // topo de `processarDrenoOutboxJob` o leu de `ligacoes`), então uma
      // passada ANTERIOR já criou a task no ClickUp e fez o back-fill, mas
      // MORREU antes de `marcarEnviado` (a linha continuou pendente). Recriar
      // aqui geraria uma SEGUNDA task "Ligação avulsa —" na Lista 02 (a exata
      // falha "op double-sends", risco #2). PULA `criarTask`: reusa o id
      // existente (o `backfillClickupTaskId` é `is.null`-guardado, idempotente
      // — não sobrescreve) e retorna true para o caller marcar `enviado` e
      // fechar a linha. NÃO consome token do dreno (não há saída ao ClickUp).
      if (taskIdAtual) {
        await backfillClickupTaskId(aggregateId, taskIdAtual);
        return true;
      }
      // Adquire o token do dreno ANTES do claim: se o teto global bloqueia
      // (worker/multi-réplica), a linha ADIA ainda em `pendente` (nunca fica
      // reivindicada sem ter criado a task) — preserva a ordem e o fail-CLOSED.
      if (!(await garantirTokenDreno(linha))) return false;
      // WR-A (19-13): CLAIM por compare-and-set ANTES de `criarTask`. Se OUTRA
      // réplica/passada já tirou a linha de `pendente`/`erro`, o claim falha
      // (null) — trata como adiar (return false): a outra passada é a dona.
      const reivindicada = await claimLinha(linha.id);
      if (!reivindicada) return false;
      let nova: { id?: string } | null;
      try {
        nova = await criarTask(CLICKUP_LIST_LIGACOES, montarBodyDaTask(payload));
      } catch (e) {
        // `criarTask` falhou DENTRO do processo (sem crash): a task NÃO foi
        // criada. LIBERA o claim (`enviando`→`pendente`) para retry seguro e
        // re-lança (op bloqueante) — nunca deixa como órfão uma falha que não
        // criou task. (Um CRASH real NÃO chega aqui: a linha fica `enviando` e
        // vira órfão detectável na próxima passada, via reconciliarCriarTaskPresa.)
        await liberarLinha(linha.id);
        throw e;
      }
      if (!nova?.id) {
        await liberarLinha(linha.id);
        throw new Error(
          `[drenar-outbox] criarTask não retornou id (aggregateId=${aggregateId}, dedup_key=${linha.dedup_key})`,
        );
      }
      setTaskId(nova.id);
      await backfillClickupTaskId(aggregateId, nova.id);
      return true;
    }

    case 'set_campo': {
      if (!taskIdAtual) return false; // adiar: preserva ordem, tenta de novo quando criar_task resolver
      const campo = typeof payload.campo === 'string' ? payload.campo : '';
      const fieldId = campo ? (CAMPOS_LIGACOES as Record<string, string>)[campo] : undefined;
      if (!fieldId) {
        throw new Error(
          `[drenar-outbox] set_campo com campo lógico desconhecido (aggregateId=${aggregateId}, dedup_key=${linha.dedup_key})`,
        );
      }
      if (!(await garantirTokenDreno(linha))) return false;
      await setCustomField(taskIdAtual, fieldId, payload.valor);
      return true;
    }

    case 'set_status': {
      if (!taskIdAtual) return false;
      const status = typeof payload.status === 'string' ? payload.status : '';
      if (!status) {
        throw new Error(
          `[drenar-outbox] set_status sem status no payload (aggregateId=${aggregateId}, dedup_key=${linha.dedup_key})`,
        );
      }
      if (!(await garantirTokenDreno(linha))) return false;
      await atualizarTask(taskIdAtual, { status });
      return true;
    }

    case 'comentar': {
      if (!taskIdAtual) return false;
      const texto = typeof payload.texto === 'string' ? payload.texto : '';
      if (!(await garantirTokenDreno(linha))) return false;
      await comentarTask(taskIdAtual, texto);
      return true;
    }

    case 'fechar': {
      if (!taskIdAtual) return false;
      if (!(await garantirTokenDreno(linha))) return false;
      await fecharLigacao(taskIdAtual);
      return true;
    }

    case 'anexar': {
      // Débito Phase 20 (áudios) — o store canônico de mídia ainda não
      // existe. Não-bloqueante: pula sem tentar enviar, marca enviado (não
      // deixa a linha travar o aggregate para sempre). NUNCA loga midia_ref.
      console.warn(
        `[drenar-outbox] op 'anexar' ainda não implementada (Phase 20) — pulando (aggregateId=${aggregateId})`,
      );
      return true;
    }

    default:
      console.warn(
        `[drenar-outbox] op desconhecida '${linha.op}' — adiando (aggregateId=${aggregateId}, dedup_key=${linha.dedup_key})`,
      );
      return false;
  }
}
