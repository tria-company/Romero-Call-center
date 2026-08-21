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
// `ligacoes` (outbox-repo.ts::backfillClickupTaskId); ops seguintes daquele
// aggregate que precisam do id ADIAM (a linha continua pendente) enquanto
// `clickup_task_id` for `null` — preserva a ordem por `seq`: nunca pula uma
// linha bloqueada para processar a próxima (isso destruiria a ordem). Após
// CADA envio bem-sucedido, `marcarEnviado` marca `enviado` e NULA o payload
// (scrub de PII pós-drain, LGPD-03/Riscos R13).
//
// `processarDrenoOutboxJob` é EXPORTADA e usada TANTO pelo worker (worker.ts,
// case 'drenar-outbox') QUANTO pelo fallback inline dos callers (rotas
// 19-07/08, quando `enfileirarDrenoOutbox` retorna `{ enfileirado:false }` —
// sem Redis, dev/homolog).
//
// Erro numa op propaga (throw) — NÃO segue para as próximas ops daquele
// aggregate (preserva ordem); o caller (BullMQ ou o fallback inline) decide
// o retry/backoff (D-08). Adiar (taskId ainda null) NÃO é erro — é
// backpressure de ordem, contado em `adiadas`.
//
// LGPD/WR-01: NUNCA loga payload/telefone/URL — só `aggregateId`, `linha.op`,
// `linha.dedup_key`, `linha.status` e a classe/mensagem do erro (propagada
// pelas primitivas de clickup.ts, que já seguem essa disciplina).
//
// FORA DE ESCOPO deste plano (débitos documentados, não implementados aqui):
// head-of-line (alarme de idade + `marcar_orphan` + DLQ por-linha) é 19-06;
// rate limiter fail-CLOSED com teto global é 19-06; o `op='anexar'` (áudios)
// é Phase 20 — tratado abaixo como não-bloqueante/pulado para não travar.

import { CAMPOS_LIGACOES, CLICKUP_LIST_LIGACOES } from './clickup.ts';
import { criarTask, atualizarTask, setCustomField, comentarTask, fecharLigacao } from './clickup.ts';
import {
  proximasPendentes,
  resolverClickupTaskId,
  backfillClickupTaskId,
  marcarEnviado,
  type LinhaOutbox,
} from './outbox-repo.ts';

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
 * quantas linhas foram enviadas e quantas ficaram adiadas (backpressure de
 * ordem, não erro). LANÇA quando uma op BLOQUEANTE falha (a linha continua
 * `pendente`/`erro` — o retry/backoff fica a cargo do BullMQ, D-08, ou do
 * fallback inline do caller).
 */
export async function processarDrenoOutboxJob(
  aggregateId: number,
): Promise<{ enviadas: number; adiadas: number }> {
  const linhas = await proximasPendentes(aggregateId);
  let enviadas = 0;
  let adiadas = 0;
  if (linhas.length === 0) return { enviadas, adiadas };

  const aggregate = linhas[0].aggregate;
  // O clickup_task_id já resolvido (se `criar_task` já rodou numa passada
  // anterior) — só suportado para 'ligacao' nesta fase (débito de fases
  // futuras para 'lead'/'audio'/'nota').
  let taskId: string | null = aggregate === 'ligacao' ? await resolverClickupTaskId(aggregate, aggregateId) : null;

  for (const linha of linhas) {
    if (!(await processarLinha(linha, aggregateId, taskId, (novoTaskId) => (taskId = novoTaskId)))) {
      adiadas++;
      break; // preserva ordem: nunca pula a linha bloqueada para a próxima
    }
    await marcarEnviado(linha.id);
    enviadas++;
  }

  return { enviadas, adiadas };
}

/**
 * Processa UMA linha do outbox. Retorna `true` quando a op foi executada
 * (o caller marca `enviado` em seguida) ou `false` quando a linha precisou
 * ADIAR (taskId ainda null) — o loop do caller para ali (preserva ordem).
 * Erro numa op (bloqueante ou não) PROPAGA (throw) — nunca engole.
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
      const nova = await criarTask(CLICKUP_LIST_LIGACOES, montarBodyDaTask(payload));
      if (!nova?.id) {
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
      await atualizarTask(taskIdAtual, { status });
      return true;
    }

    case 'comentar': {
      if (!taskIdAtual) return false;
      const texto = typeof payload.texto === 'string' ? payload.texto : '';
      await comentarTask(taskIdAtual, texto);
      return true;
    }

    case 'fechar': {
      if (!taskIdAtual) return false;
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
