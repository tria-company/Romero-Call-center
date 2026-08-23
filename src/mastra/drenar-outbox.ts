// drenar-outbox.ts — worker de dreno do transactional outbox (ESCRITA-02 +
// LGPD-03, Fase B, Phase 19 Plano 03 — generalizado multi-agregado na Fase C,
// Phase 20 Plano 02, ESCRITA-05). Generaliza `sync-clickup.ts`: drena o
// `clickup_outbox` de UM `aggregate_id` por vez, EM ORDEM DE SEQ
// (outbox-repo.ts::proximasPendentes), idempotente por `dedup_key` (o UNIQUE
// e o ON CONFLICT ficam nas RPCs, 19-02) — reusa o choke `fetchClickUp`
// (clickup.ts:41, rate-limiter incluso) e as primitivas por-ID
// (criarTask/setCustomField/atualizarTask/comentarTask/fecharLigacao/
// anexarArquivoNaTask), NUNCA a listagem de tasks (os endpoints por-ID
// sobreviveram ao incidente 2026-08-20).
//
// MULTI-AGREGADO (Phase 20 Plano 02): o `aggregate` de uma linha de outbox é
// 'ligacao' | 'audio' | 'lead' | 'nota'. Só 'ligacao'/'audio' têm
// `criar_task`+back-fill (a task-alvo AINDA NÃO existe no ClickUp, o dreno
// cria e persiste o id). 'lead'/'nota' NUNCA criam task nova — a lead/ligação
// já existe, o alvo vem de `payload.clickup_task_id` gravado pela RPC que
// enfileirou a linha (`comentar` de nota / `set_campo` de lead). O agregado
// de UMA passada é sempre o mesmo (todas as linhas de `proximasPendentes`
// pertencem ao mesmo `aggregate_id`, que é local por-tabela — nunca
// mistura ligacao com audio na mesma passada).
//
// `op='criar_task'` resolve o `clickup_task_id` e faz BACK-FILL na linha da
// tabela do agregado (`outbox-repo.ts::backfillClickupTaskId`) — mas é
// IDEMPOTENTE A CRASH (CR-01): se o agregado já tem `clickup_task_id`
// resolvido (uma passada anterior criou a task mas morreu ANTES de
// `marcarEnviado`, a linha ficou pendente), a re-execução NÃO chama
// `criarTask` de novo (zero task ClickUp duplicada) — reusa o id e só marca
// `enviado`. ops seguintes daquele aggregate que precisam do id ADIAM (a
// linha continua pendente) enquanto `clickup_task_id` for `null` — preserva
// a ordem por `seq`: nunca pula uma linha bloqueada para processar a próxima
// (isso destruiria a ordem). Após CADA envio bem-sucedido, `marcarEnviado`
// marca `enviado` e NULA o payload (scrub de PII pós-drain, LGPD-03/Riscos R13).
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
// LGPD/WR-01: NUNCA loga payload/telefone/URL/midia_ref — só `aggregateId`,
// `linha.op`, `linha.dedup_key`, `linha.status` e a classe/mensagem do erro
// (propagada pelas primitivas de clickup.ts, que já seguem essa disciplina).
//
// `op='anexar'` (áudios, Phase 20 Plano 02): lê o binário do store canônico
// (Supabase Storage, `payload.midia_ref` no formato `bucket/path` — mesmo
// contrato de `notas.ts::subirGravacaoStorage`) e anexa via
// `clickup.ts::anexarArquivoNaTask` — a MESMA primitiva usada por
// `registrarEnvioAudio`. NÃO-bloqueante (`bloqueante=false`, design §3.2):
// falha cai em DLQ por-linha (`marcarDlqLinha`), nunca trava o aggregate.

import { CAMPOS_LIGACOES, CAMPOS_AUDIOS, CAMPOS_LEADS, CLICKUP_LIST_LIGACOES, CLICKUP_LIST_AUDIOS } from './clickup.ts';
import { criarTask, atualizarTask, setCustomField, comentarTask, fecharLigacao, anexarArquivoNaTask } from './clickup.ts';
import { mascararTelefone } from './mascarar.ts';
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from './config.ts';
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

/** Agregados com `criar_task`+back-fill — a task-alvo ainda não existe. */
const AGREGADOS_COM_CRIAR_TASK = new Set(['ligacao', 'audio']);

// Endpoint do Supabase Storage montado do env — instância self-hosted, nunca
// hardcoded (D-P4-11). Mesmo molde self-contido de outbox-repo.ts.
const SUPABASE_STORAGE_URL = `${SUPABASE_URL}/storage/v1`;

/** Body de `criarTask` — mesmo shape usado por `clickup.ts::criarTask`. */
type BodyCriarTask = {
  name: string;
  description?: string;
  assignees?: number[];
  custom_fields?: Array<{ id: string; value: unknown }>;
};

/**
 * Monta o body de `criarTask` de uma linha `op='criar_task'` de LIGAÇÃO
 * (ex.: `{ origem:'avulsa', telefone_canonico, ... }`, gravado pela RPC
 * `criar_ligacao_avulsa`, sql/escala/16). Função PURA (sem I/O) — o
 * `telefone_canonico` já vem em E.164 (telefone-canonico.ts, 19-01), pronto
 * para o custom field TELEFONE (tipo "phone" do ClickUp). NUNCA loga o
 * payload — o `name` da task vai para o ClickUp (dado operacional), não para
 * um log.
 */
function montarBodyDaLigacao(payload: Record<string, unknown>): BodyCriarTask {
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
 * Monta o body de `criarTask` de uma linha `op='criar_task'` de ÁUDIO (Lista
 * 03 AUDIOS — Fase C, Phase 20 Plano 02), gravado pelas RPCs
 * `registrar_envio_audio`/`registrar_mensagem_texto` (20-03): payload com
 * `origem`, `tipo` ('audio'|'texto'), `lead_clickup_task_id`,
 * `telefone_canonico`, `enviado_por`, `corpo` (só texto). Função PURA (sem
 * I/O). O PREFIXO do título ("Áudio enviado —"/"Mensagem enviada —") é o
 * MESMO CONTRATO que `clickup.ts::listarEnviosAudioDoLead` usa para
 * distinguir texto de áudio (`String(t.name).startsWith('Mensagem enviada')`)
 * — reproduzido aqui byte-a-byte. Telefone MASCARADO no título (IN-01/LGPD);
 * em claro só no custom field TELEFONE. NUNCA loga o payload.
 */
function montarBodyDoAudio(payload: Record<string, unknown>): BodyCriarTask {
  const telefone = typeof payload.telefone_canonico === 'string' ? payload.telefone_canonico : '';
  const leadTaskId = typeof payload.lead_clickup_task_id === 'string' ? payload.lead_clickup_task_id : '';
  const enviadoPor = typeof payload.enviado_por === 'string' ? payload.enviado_por : '';
  const tipo = payload.tipo === 'texto' ? 'texto' : 'audio';
  const corpo = typeof payload.corpo === 'string' ? payload.corpo : '';
  const dataDoEnvio = typeof payload.data_do_envio === 'number' ? payload.data_do_envio : Date.now();

  const customFields: Array<{ id: string; value: unknown }> = [{ id: CAMPOS_AUDIOS.DATA_DO_ENVIO, value: dataDoEnvio }];
  if (enviadoPor) customFields.push({ id: CAMPOS_AUDIOS.ENVIADO_POR, value: enviadoPor });
  if (telefone) customFields.push({ id: CAMPOS_AUDIOS.TELEFONE, value: telefone });
  if (leadTaskId) customFields.push({ id: CAMPOS_AUDIOS.LEAD, value: { add: [leadTaskId] } });

  const prefixo = tipo === 'texto' ? 'Mensagem enviada' : 'Áudio enviado';
  const nome = `${prefixo} — ${telefone ? mascararTelefone(telefone) : 'sem telefone'}`;

  return {
    name: nome,
    ...(tipo === 'texto' && corpo ? { description: corpo } : {}),
    ...(customFields.length > 0 ? { custom_fields: customFields } : {}),
  };
}

/** Dispatcher de `montarBodyDaTask` por agregado (`criar_task`). */
function montarBodyDaTask(aggregate: string, payload: Record<string, unknown>): BodyCriarTask {
  return aggregate === 'audio' ? montarBodyDoAudio(payload) : montarBodyDaLigacao(payload);
}

/** Lista ClickUp-alvo de `criarTask` por agregado (`criar_task`). */
function listaClickupDoAgregado(aggregate: string): string {
  return aggregate === 'audio' ? CLICKUP_LIST_AUDIOS : CLICKUP_LIST_LIGACOES;
}

/** Mapa de campos lógico→field-id por agregado (`set_campo`). */
function mapaCamposPorAgregado(aggregate: string): Record<string, string> {
  if (aggregate === 'audio') return CAMPOS_AUDIOS as unknown as Record<string, string>;
  if (aggregate === 'lead') return CAMPOS_LEADS as unknown as Record<string, string>;
  return CAMPOS_LIGACOES as unknown as Record<string, string>;
}

/**
 * Resolve a task-alvo de uma linha (`comentar`/`set_campo`): se
 * `taskIdAtual` já está resolvido ('ligacao'/'audio' com `criar_task` já
 * rodado), é o alvo. Para 'ligacao'/'audio' AINDA sem `criar_task` resolvido,
 * é backpressure de ORDEM — `adiar:true` (o caller adia, preserva `seq`,
 * NUNCA erro). Para 'lead'/'nota' (nunca têm `criar_task` — a lead/ligação
 * JÁ EXISTE no ClickUp), o alvo vem SEMPRE de `payload.clickup_task_id`; a
 * ausência aqui é um erro real de dado (não backpressure).
 */
function resolverAlvoLinha(
  linha: LinhaOutbox,
  payload: Record<string, unknown>,
  taskIdAtual: string | null,
): { alvo: string | null; adiar: boolean } {
  if (taskIdAtual) return { alvo: taskIdAtual, adiar: false };
  if (AGREGADOS_COM_CRIAR_TASK.has(linha.aggregate)) return { alvo: null, adiar: true };
  const doPayload = typeof payload.clickup_task_id === 'string' ? payload.clickup_task_id : '';
  return { alvo: doPayload || null, adiar: false };
}

/** Encoda cada segmento do path do objeto (mantendo `/` como separador de pasta) — mesmo molde de notas.ts::encodeStoragePath. */
function encodeStoragePathRef(ref: string): string {
  return ref
    .split('/')
    .filter((seg) => seg !== '')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/**
 * Baixa o binário do store canônico (Supabase Storage) a partir de
 * `midiaRef` (formato `bucket/path`, mesmo contrato de
 * `notas.ts::subirGravacaoStorage`). Materializa em Buffer — sem streaming
 * (diferente do download→upload de `subirGravacaoStorage`): o anexo do
 * ClickUp precisa do buffer inteiro pro multipart, e os áudios enviados pelo
 * discador (WhatsApp) ficam na casa de alguns MB, não dezenas/centenas de MB
 * das gravações de chamada. LANÇA em config ausente/erro de rede/HTTP
 * (WR-03) — o caller (`op='anexar'`, não-bloqueante) decide DLQ por-linha.
 * NUNCA loga `midiaRef`/URL.
 */
async function baixarMidiaStorage(midiaRef: string): Promise<{ buffer: Buffer; contentType: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('[drenar-outbox] SUPABASE_URL/SUPABASE_SERVICE_KEY ausente — não dá para baixar a mídia do store canônico');
  }
  if (!midiaRef) {
    throw new Error('[drenar-outbox] anexar sem midia_ref no payload');
  }
  const url = `${SUPABASE_STORAGE_URL}/object/${encodeStoragePathRef(midiaRef)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
  } catch (e) {
    throw new Error(
      `[drenar-outbox] falha de rede ao baixar mídia do store canônico: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok || !res.body) {
    throw new Error(`[drenar-outbox] HTTP ${res.status} ao baixar mídia do store canônico`);
  }
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType };
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
  // anterior) — suportado para 'ligacao'/'audio' (os únicos com
  // criar_task+back-fill, Fase C Phase 20 Plano 02). 'lead'/'nota' nunca
  // resolvem por tabela — o alvo delas vem de payload.clickup_task_id
  // (resolverAlvoLinha, dentro de processarLinha).
  let taskId: string | null = AGREGADOS_COM_CRIAR_TASK.has(aggregate)
    ? await resolverClickupTaskId(aggregate, aggregateId)
    : null;

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
 * de UM `(aggregate, aggregateId)` (o claim foi feito mas o processo morreu
 * antes do back-fill do id). Dois sub-casos de crash, ambos SEM re-criar a
 * task (nunca duplicata):
 *   1. `clickup_task_id` NÃO resolvido (`resolverClickupTaskId` = null): o
 *      crash foi entre `criarTask` e o back-fill — a task PODE existir no
 *      ClickUp mas está descorrelacionada. Converte em `orphan`
 *      (`marcarOrphanEnviando`): um órfão DETECTÁVEL, reconciliável pelo 19-06.
 *   2. `clickup_task_id` JÁ resolvido: o back-fill rodou, só o `marcarEnviado`
 *      faltou (crash pós-back-fill). Finaliza a(s) linha(s) `enviando` como
 *      `enviado` — o id já está persistido, as ops seguintes o reusam; nenhuma
 *      task nova é criada.
 * `linhasPresasEnviando` filtra por `aggregate=eq.<agg>` + `op=eq.criar_task`,
 * então para qualquer outro aggregate/id esta função é um no-op barato (lista
 * vazia). NUNCA loga payload — só a contagem e o `aggregateId`.
 */
async function reconciliarCriarTaskPresaDoAgregado(aggregate: string, aggregateId: number): Promise<void> {
  const presas = await linhasPresasEnviando(aggregate, aggregateId);
  if (presas.length === 0) return;

  const idPersistido = await resolverClickupTaskId(aggregate, aggregateId);
  if (idPersistido) {
    // Crash pós-back-fill: id já persistido; só faltou marcar enviado. Finaliza
    // (não re-cria — as ops seguintes reusam o id via `resolverClickupTaskId`).
    for (const linha of presas) await marcarEnviado(linha.id);
    console.warn(
      `[drenar-outbox] WR-A: ${presas.length} criar_task presa(s) em 'enviando' com id JÁ persistido (crash pós-back-fill) — finalizada(s) como enviado, sem re-criar (aggregate=${aggregate}, aggregateId=${aggregateId})`,
    );
    return;
  }

  // Crash entre criarTask e o back-fill: id NÃO resolvido. A task pode existir
  // no ClickUp descorrelacionada — NUNCA re-cria; converte em órfão detectável.
  const orfas = await marcarOrphanEnviando(aggregate, aggregateId);
  console.warn(
    `[drenar-outbox] WR-A: ${orfas} criar_task presa(s) em 'enviando' SEM clickup_task_id resolvido (crash entre criarTask e back-fill) — roteada(s) para reconciliação/órfão (19-06), NÃO re-criada(s) (aggregate=${aggregate}, aggregateId=${aggregateId})`,
  );
}

/**
 * WR-A generalizado (Fase C, Phase 20 Plano 02): `processarDrenoOutboxJob`
 * recebe SÓ `aggregateId` (contrato inalterado — os callers de hoje, todos
 * de 'ligacao', são fora do escopo deste plano) e `aggregate_id` é um id
 * LOCAL por-tabela (`ligacoes.id`/`audios_envios.id` são sequências
 * INDEPENDENTES que podem colidir numericamente). Sem saber de antemão QUAL
 * agregado esta passada drena, reconcilia cada agregado candidato (os únicos
 * com `criar_task`+back-fill: 'ligacao'/'audio') SEQUENCIALMENTE — o filtro
 * `aggregate=eq.<agg>` de `linhasPresasEnviando`/`marcarOrphanEnviando`
 * garante que cada chamada só enxerga as linhas do SEU agregado, e a
 * primeira que encontra presas já transiciona o estado (a segunda, do outro
 * agregado, não encontra mais nada de qualquer forma).
 */
async function reconciliarCriarTaskPresa(aggregateId: number): Promise<void> {
  for (const aggregate of AGREGADOS_COM_CRIAR_TASK) {
    await reconciliarCriarTaskPresaDoAgregado(aggregate, aggregateId);
  }
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
      // topo de `processarDrenoOutboxJob` o leu da tabela do agregado), então
      // uma passada ANTERIOR já criou a task no ClickUp e fez o back-fill,
      // mas MORREU antes de `marcarEnviado` (a linha continuou pendente).
      // Recriar aqui geraria uma SEGUNDA task na lista do agregado (a exata
      // falha "op double-sends", risco #2). PULA `criarTask`: reusa o id
      // existente (o `backfillClickupTaskId` é `is.null`-guardado, idempotente
      // — não sobrescreve) e retorna true para o caller marcar `enviado` e
      // fechar a linha. NÃO consome token do dreno (não há saída ao ClickUp).
      // Só 'ligacao'/'audio' chegam aqui com taskIdAtual não-null vindo do
      // topo (AGREGADOS_COM_CRIAR_TASK); 'lead'/'nota' nunca têm criar_task.
      if (taskIdAtual) {
        await backfillClickupTaskId(linha.aggregate, aggregateId, taskIdAtual);
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
        nova = await criarTask(listaClickupDoAgregado(linha.aggregate), montarBodyDaTask(linha.aggregate, payload));
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
      await backfillClickupTaskId(linha.aggregate, aggregateId, nova.id);
      return true;
    }

    case 'set_campo': {
      // 'ligacao'/'audio': alvo vem de taskIdAtual (adiar se ainda não
      // resolvido, backpressure de ordem). 'lead': alvo SEMPRE de
      // payload.clickup_task_id (a lead já existe no ClickUp — sem
      // criar_task/back-fill); ausência é erro real (não backpressure).
      const { alvo, adiar } = resolverAlvoLinha(linha, payload, taskIdAtual);
      if (adiar) return false;
      if (!alvo) {
        throw new Error(
          `[drenar-outbox] set_campo sem alvo resolvido (payload.clickup_task_id ausente) (aggregateId=${aggregateId}, dedup_key=${linha.dedup_key})`,
        );
      }
      const campo = typeof payload.campo === 'string' ? payload.campo : '';
      const fieldId = campo ? mapaCamposPorAgregado(linha.aggregate)[campo] : undefined;
      if (!fieldId) {
        throw new Error(
          `[drenar-outbox] set_campo com campo lógico desconhecido (aggregateId=${aggregateId}, dedup_key=${linha.dedup_key})`,
        );
      }
      if (!(await garantirTokenDreno(linha))) return false;
      await setCustomField(alvo, fieldId, payload.valor);
      return true;
    }

    case 'set_status': {
      // Só 'ligacao' usa set_status (o RPC design de audio/lead/nota não emite
      // esta op) — mantido byte-a-byte (regressão zero).
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
      // 'ligacao': alvo de taskIdAtual (adiar se ainda não resolvido).
      // 'nota': alvo SEMPRE de payload.clickup_task_id (a lead/ligação já
      // existe — sem criar_task/back-fill); ausência é erro real.
      const { alvo, adiar } = resolverAlvoLinha(linha, payload, taskIdAtual);
      if (adiar) return false;
      if (!alvo) {
        throw new Error(
          `[drenar-outbox] comentar sem alvo resolvido (payload.clickup_task_id ausente) (aggregateId=${aggregateId}, dedup_key=${linha.dedup_key})`,
        );
      }
      const texto = typeof payload.texto === 'string' ? payload.texto : '';
      if (!(await garantirTokenDreno(linha))) return false;
      await comentarTask(alvo, texto);
      return true;
    }

    case 'fechar': {
      // Só 'ligacao' usa fechar — mantido byte-a-byte (regressão zero).
      if (!taskIdAtual) return false;
      if (!(await garantirTokenDreno(linha))) return false;
      await fecharLigacao(taskIdAtual);
      return true;
    }

    case 'anexar': {
      // Fase C, Phase 20 Plano 02: lê o binário do store canônico (Supabase
      // Storage, payload.midia_ref) e anexa à task de ÁUDIO — NÃO-bloqueante
      // (bloqueante=false no design da RPC, §3.2): qualquer falha (config,
      // download, upload do anexo) PROPAGA e cai em DLQ por-linha no caller
      // (processarDrenoOutboxJob), nunca trava o aggregate. Adiar (taskIdAtual
      // ainda null, criar_task não resolveu) preserva a ordem, como as demais.
      if (!taskIdAtual) return false;
      const midiaRef = typeof payload.midia_ref === 'string' ? payload.midia_ref : '';
      if (!midiaRef) {
        throw new Error(
          `[drenar-outbox] anexar sem midia_ref no payload (aggregateId=${aggregateId}, dedup_key=${linha.dedup_key})`,
        );
      }
      if (!(await garantirTokenDreno(linha))) return false;
      const { buffer, contentType } = await baixarMidiaStorage(midiaRef);
      await anexarArquivoNaTask(taskIdAtual, buffer, `${linha.aggregate}-${aggregateId}`, contentType);
      return true;
    }

    default:
      console.warn(
        `[drenar-outbox] op desconhecida '${linha.op}' — adiando (aggregateId=${aggregateId}, dedup_key=${linha.dedup_key})`,
      );
      return false;
  }
}
