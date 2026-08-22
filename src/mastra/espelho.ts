// Sincronizador ClickUp -> ESPELHO (u10, generalizado 17-02): copia da Lista 01
// LEADS (registro completo), Lista 02 LIGACOES e Lista 03 AUDIOS pro read-model
// Postgres (Fase A da inversão Supabase-fonte-da-verdade — só POPULA, nenhuma
// rota lê estas tabelas ainda: .planning/phases/17-fase-a-espelhar-para-leitura/
// 17-CONTEXT.md decisão 3). O ClickUp CONTINUA a fonte da verdade nesta fase.
//
// As 3 funções de sync (`sincronizarEspelhoLeads`/`Ligacoes`/`Audios`) reusam o
// MESMO laço de paginação (`paginarESincronizar`) sobre `listarTasksComRetry`
// (clickup.ts) e os upserts em lote de `supabase.ts` (merge por
// `clickup_task_id`). Os 3 mappers puros (`paraLinha*`) são exportados e
// testáveis offline (scripts/sincronizar-espelho.smoke.mjs) — leem custom
// fields SEMPRE por field-id (D-07, nunca por nome), via os mapas
// CAMPOS_LEADS/CAMPOS_LIGACOES/CAMPOS_AUDIOS de clickup.ts.
//
// NUNCA loga telefone/cpf/transcrição (LGPD) — só contagem/página. Erro
// PROPAGA (WR-03): o caller (script/cron) decide retry/abort.

import {
  listarTasksComRetry,
  valorCampoLead,
  resolverVotoAtualLead,
  lerAtendeu,
  tarefaConcluida,
  CAMPOS_LEADS,
  CAMPOS_LIGACOES,
  CAMPOS_AUDIOS,
  OPCOES_LIGACOES,
  type TaskClickUp,
} from './clickup.ts';
import { parseLeadDaTask, derivarRetornoNecessario } from './lote.ts';
import { mapaOperadorParaAssignee } from './operadores.ts';
import { canonizarTelefone, variantesTelefone } from './telefone-canonico.ts';
import { duracaoEmSegundos } from './painel-dados.ts';
import {
  upsertLeadFullEspelho,
  upsertLigacoesEspelho,
  upsertAudiosEnvios,
  type LeadFullEspelhoRow,
  type LigacaoEspelhoRow,
  type AudioEnvioRow,
} from './supabase.ts';
import {
  CLICKUP_LIST_LEADS,
  CLICKUP_LIST_LIGACOES,
  CLICKUP_LIST_AUDIOS,
  OPER_STATUS_EM_PROCESSAMENTO,
  LOTE_LIMITE_TENTATIVAS,
} from './config.ts';

export interface ResultadoSyncEspelho {
  paginas: number;
  registros: number;
  ultimaPagina: number;
}

/** Opções aceitas pelas 3 funções de sync (mesmo contrato — artifacts_this_phase_produces). */
export interface OpcoesSyncEspelho {
  maxPaginas?: number;
  dryRun?: boolean;
  pausaEntrePaginasMs?: number;
  tentativas?: number;
  onProgress?: (pagina: number, registrosAcumulados: number) => void;
}

// ===== Helpers puros compartilhados (pequenos, duplicados de propósito das versões
// privadas de clickup.ts/lote.ts — mesmo racional de semNonoDigito/estado-webhook.ts:
// par pequeno demais pra justificar acoplar módulos por uma função de 3 linhas) =====

/** Lê um custom field cru (sem stringificar) — usado onde `undefined` vs `''` importa. */
function campoCru(task: TaskClickUp, fieldId: string): unknown {
  return task.custom_fields?.find((c) => c.id === fieldId)?.value;
}

function campoPreenchido(task: TaskClickUp, fieldId: string): boolean {
  const v = campoCru(task, fieldId);
  return v !== null && v !== undefined && v !== '';
}

// canonizarTelefone/variantesTelefone (semNonoDigito + E.164 pós-normalização
// do 9º dígito, e o conjunto ±9º dígito) agora vêm de telefone-canonico.ts —
// fonte ÚNICA da normalização de telefone da Fase B (R4, §5.3): a mesma
// função usada aqui é a que a correlação do webhook (19-05) e as rotas de
// escrita (19-07..19-09) vão usar pra casar 12/13 dígitos do mesmo número.
// As cópias privadas que existiam aqui (semNonoDigito/telefoneCanonicoE164)
// foram removidas nesta refatoração — ver src/mastra/telefone-canonico.ts.

/** ClickUp entrega datas como epoch string em ms — converte pra timestamptz ISO. */
function paraTimestampISO(raw: string): string | null {
  if (!raw) return null;
  const epoch = Number(raw);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch).toISOString();
}

function numeroOuNull(raw: string): number | null {
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Nome do status nativo — `{status}` | string | undefined (mesmo shape de TaskClickUp.status). */
function nomeDoStatus(status: TaskClickUp['status']): string {
  if (!status) return '';
  return typeof status === 'string' ? status : status.status;
}

/** Custom field CHECKBOX como boolean de verdade — mesma lógica de `campoLeadBooleano`
 *  (clickup.ts, privada): o ClickUp devolve `true/false` nativo pro checkbox, mas também
 *  aceita string em alguns paths de leitura; só valores afirmativos viram `true`. */
function campoBooleano(task: TaskClickUp, fieldId: string): boolean {
  const v = campoCru(task, fieldId);
  if (v === true) return true;
  return ['true', 'sim', '1', 'yes'].includes(String(v).toLowerCase().trim());
}

// ===== paraLinhaLigacao — Lista 02 LIGACOES -> ligacoes (design §2.1) =====

/** Task-id do LEAD (Lista 01): `LEAD_REL` (relationship, primeiro item) com fallback
 *  `ID_LEAD` quando tem cara de task-id ClickUp (6-15 alfanumérico) — mesma estratégia
 *  de `leadTaskIdDe` (lote.ts, privada): ids GHL (~20 chars) ficam de fora. */
function leadClickupTaskIdDaLigacao(task: TaskClickUp): string | null {
  const rel = campoCru(task, CAMPOS_LIGACOES.LEAD_REL);
  if (Array.isArray(rel) && rel.length > 0) {
    const primeiro: unknown = rel[0];
    const id =
      typeof primeiro === 'object' && primeiro !== null
        ? String((primeiro as { id?: unknown }).id ?? '')
        : String(primeiro ?? '');
    if (id) return id;
  }
  const idLead = valorCampoLead(task, CAMPOS_LIGACOES.ID_LEAD);
  return /^[a-z0-9]{6,15}$/i.test(idLead) ? idLead : null;
}

/** aberta·em_processamento·fechada, derivado de `task.status` (OPER_STATUS_EM_PROCESSAMENTO
 *  + `tarefaConcluida` — status de tipo closed/done). */
function statusLigacao(task: TaskClickUp): LigacaoEspelhoRow['status'] {
  const nome = nomeDoStatus(task.status);
  if (OPER_STATUS_EM_PROCESSAMENTO && nome === OPER_STATUS_EM_PROCESSAMENTO) return 'em_processamento';
  if (tarefaConcluida(task)) return 'fechada';
  return 'aberta';
}

/** NECESSITA_REVISAO (drop_down Sim/Não) tolerante ao formato de leitura — mesmo
 *  racional de `lerAtendeu` (clickup.ts), mas devolve `null` quando ausente (aqui
 *  ausência é distinta de "não" — a Ligação pode simplesmente não ter sido avaliada). */
function lerNecessitaRevisao(task: TaskClickUp): boolean | null {
  const cf = task.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.NECESSITA_REVISAO);
  const raw = cf?.value;
  if (raw === null || raw === undefined || raw === '') return null;
  const opcoes = OPCOES_LIGACOES[CAMPOS_LIGACOES.NECESSITA_REVISAO];
  const rawStr = String(raw);
  if (rawStr === opcoes.sim) return true;
  if (rawStr === opcoes.nao) return false;
  const opcao = cf?.type_config?.options?.find(
    (o) => String(o.orderindex) === rawStr || o.id === rawStr || o.name === rawStr,
  );
  if (opcao) {
    if (opcao.id === opcoes.sim) return true;
    if (opcao.id === opcoes.nao) return false;
    const nome = String(opcao.name ?? '').trim().toLowerCase();
    if (nome === 'sim') return true;
    if (nome === 'não' || nome === 'nao') return false;
  }
  return null;
}

/** `{ texto }` — ANALISE_IA hoje é texto livre no ClickUp ("LIGAR — ..."/"NÃO LIGAR — ...",
 *  ver clickup.ts/processador.ts), não JSON estruturado; a coluna é `jsonb` (design §2.1)
 *  pensando na estrutura futura (aderência/alertas/retorno/voto-IA) — wrap mínimo aqui,
 *  sem perder o texto, até a estruturação real acontecer (fora do escopo desta fase). */
function paraAnaliseIa(raw: string): Record<string, unknown> | null {
  return raw ? { texto: raw } : null;
}

/**
 * WR-01: reverse-map do assignee do ClickUp (member id numérico) -> login do
 * discador, para pré-preencher `operador` em ligações de LOTE nunca-tentadas.
 *
 * A fila diária sob `supabase` (`buscarFilaSupabase(login)`) filtra
 * `operador=eq.<login>`, mas o custom field OPERADOR só é carimbado (com o
 * login) quando o operador clica "Ligar" (`iniciar_ligacao`). O lote diário do
 * ClickUp atribui por `assignee` (member id, namespace diferente do login) —
 * então uma ligação de lote recém-sincronizada teria `operador=null` e sumiria
 * da fila de TODO operador (fila diária VAZIA após o flip, quebra o core value).
 *
 * Aqui traduzimos o assignee -> login (via o mesmo `mapaOperadorParaAssignee`
 * que o gerador de lote usa) e pré-preenchemos `operador`. O guard anti-IDOR de
 * `iniciar_ligacao` (14) recusa só operador DIFERENTE — como pré-preenchemos com
 * o MESMO login que o operador atribuído vai passar, ele continua podendo
 * carimbar o INÍCIO. Sem mapeamento (assignee não é um operador do discador) →
 * `null` (comportamento de hoje preservado).
 */
function loginDoAssigneeLigacao(assigneeId: number | null | undefined): string | null {
  if (assigneeId === null || assigneeId === undefined) return null;
  const alvo = String(assigneeId);
  for (const [login, memberId] of mapaOperadorParaAssignee()) {
    if (memberId === alvo) return login;
  }
  return null;
}

export function paraLinhaLigacao(task: TaskClickUp, agora: string): LigacaoEspelhoRow {
  const telefoneRaw = valorCampoLead(task, CAMPOS_LIGACOES.TELEFONE);
  const assigneeId = task.assignees?.[0]?.id ?? null;
  return {
    clickup_task_id: task.id,
    lead_id: null, // FK numérica: resolvida só quando a ESCRITA inverter (Phase 19)
    lead_clickup_task_id: leadClickupTaskIdDaLigacao(task),
    // WR-01: OPERADOR carimbado (login) tem precedência; sem ele, herda o login
    // do assignee do lote para a ligação nunca-tentada entrar na fila diária.
    operador: valorCampoLead(task, CAMPOS_LIGACOES.OPERADOR) || loginDoAssigneeLigacao(assigneeId) || null,
    assignee_clickup_id: assigneeId,
    telefone_canonico: canonizarTelefone(telefoneRaw),
    telefone_variantes: variantesTelefone(telefoneRaw),
    script: task.description ?? task.text_content ?? null,
    status: statusLigacao(task),
    // resultado (atendida·recusou·nao_atendida·pulado·sem_whatsapp): a reconstrução fina
    // fica pra quando a LEITURA inverter (Phase 19) — os campos brutos que já populamos
    // aqui (atendeu/motivo_falha/status) bastam pra recompor depois; nesta fase, populado
    // ninguém lê o resultado ainda (17-CONTEXT.md decisão 3), então null é seguro.
    resultado: null,
    inicio: paraTimestampISO(valorCampoLead(task, CAMPOS_LIGACOES.INICIO)),
    fim: paraTimestampISO(valorCampoLead(task, CAMPOS_LIGACOES.FIM)),
    duracao_seg: duracaoEmSegundos(valorCampoLead(task, CAMPOS_LIGACOES.DURACAO)),
    // ATENDEU é drop_down: "preenchido" ≠ "atendida" (mesma distinção de painel-dados.ts) —
    // ausente = sem desfecho ainda (null), nunca `false` por omissão.
    atendeu: campoPreenchido(task, CAMPOS_LIGACOES.ATENDEU) ? lerAtendeu(task) : null,
    motivo_falha: valorCampoLead(task, CAMPOS_LIGACOES.MOTIVO_FALHA) || null,
    url_gravacao: valorCampoLead(task, CAMPOS_LIGACOES.URL_GRAVACAO) || null,
    transcricao: valorCampoLead(task, CAMPOS_LIGACOES.TRANSCRICAO) || null,
    analise_ia: paraAnaliseIa(valorCampoLead(task, CAMPOS_LIGACOES.ANALISE_IA)),
    necessita_revisao: lerNecessitaRevisao(task),
    // lote_data/origem: "novo — hoje implícito" (sql/escala/06_ligacoes.sql) — sem field
    // ClickUp equivalente hoje; ficam null nesta fase (débito documentado, não bloqueia
    // "só popular": nada lê estas colunas ainda).
    lote_data: null,
    origem: null,
    atualizado_em: agora,
  };
}

// ===== paraLinhaAudio — Lista 03 AUDIOS -> audios_envios (design §2.2) =====

function leadClickupTaskIdDoAudio(task: TaskClickUp): string | null {
  const rel = campoCru(task, CAMPOS_AUDIOS.LEAD);
  if (Array.isArray(rel) && rel.length > 0) {
    const primeiro: unknown = rel[0];
    const id =
      typeof primeiro === 'object' && primeiro !== null
        ? String((primeiro as { id?: unknown }).id ?? '')
        : String(primeiro ?? '');
    if (id) return id;
  }
  return null;
}

export function paraLinhaAudio(task: TaskClickUp): AudioEnvioRow {
  // Tipo pelo TÍTULO do registro — mesmo CONTRATO de `listarEnviosAudioDoLead`
  // (clickup.ts): "Mensagem enviada — ..." = texto; "Áudio enviado — ..." = áudio.
  const ehTexto = String(task.name ?? '').startsWith('Mensagem enviada');
  return {
    clickup_task_id: task.id,
    lead_id: null,
    lead_clickup_task_id: leadClickupTaskIdDoAudio(task),
    tipo: ehTexto ? 'texto' : 'audio',
    corpo: task.description ?? task.text_content ?? null,
    transcricao_audio: valorCampoLead(task, CAMPOS_AUDIOS.TRANSCRICAO_AUDIO) || null,
    // midia_ref: a migração do binário pro Supabase Storage é o 17-05 (design §2.6).
    midia_ref: null,
    // selo_conversa: hoje é DERIVADO em tempo real por `mapaConversaPorLead` a partir do
    // histórico inteiro — materializar o cálculo fica pra quando a leitura inverter.
    selo_conversa: null,
    enviado_em: paraTimestampISO(valorCampoLead(task, CAMPOS_AUDIOS.DATA_DO_ENVIO)),
  };
}

// ===== paraLinhaLeadFull — Lista 01 LEADS (registro completo) -> discador_leads_espelho (§2.3) =====

/** Tags nativas da task — `TaskClickUp` não declara `tags` (só `lote.ts::TaskLike` o faz,
 *  pro filtro de seleção), mas a API do ClickUp sempre devolve o campo no GET. */
function extrairTags(task: TaskClickUp): string[] {
  const t = task as TaskClickUp & { tags?: Array<{ name?: string }> };
  return (t.tags ?? []).map((tag) => tag.name).filter((n): n is string => Boolean(n));
}

/** Mesma regra de `selecionarLoteElegivel` (lote.ts, privada): proximoContato preenchido
 *  e <= hoje, e tentativas < LOTE_LIMITE_TENTATIVAS. Materializa o campo pro índice de
 *  priorização (ix_leads_lote) poder filtrar sem reler o ClickUp. */
function leadElegivel(proximoContato: Date | null, tentativas: number, hoje: Date): boolean {
  if (proximoContato === null) return false;
  if (proximoContato.getTime() > hoje.getTime()) return false;
  if (tentativas >= LOTE_LIMITE_TENTATIVAS) return false;
  return true;
}

export function paraLinhaLeadFull(task: TaskClickUp, agora: string): LeadFullEspelhoRow {
  // Reusa o parser já testado de lote.ts (D-07: mesmos field-ids CAMPOS_LEADS) pros campos
  // de priorização/derivação — score/tentativas aqui vêm 0 por default (fine pra cálculo de
  // elegibilidade); o valor ARMAZENADO na linha usa a leitura null-aware abaixo (campo
  // ausente -> null, nunca 0 mascarando "sem dado").
  const parsed = parseLeadDaTask(task, CAMPOS_LEADS);
  const voto = resolverVotoAtualLead(task);
  const agoraDate = new Date(agora);
  const qtdAtendimentosRaw = valorCampoLead(task, CAMPOS_LEADS.QTD_ATENDIMENTOS);

  return {
    clickup_task_id: task.id,
    nome: parsed.nome,
    nome_lower: parsed.nome.toLowerCase(),
    telefone: parsed.telefone,
    cpf: valorCampoLead(task, CAMPOS_LEADS.CPF),
    bairro: valorCampoLead(task, CAMPOS_LEADS.BAIRRO),
    cidade: valorCampoLead(task, CAMPOS_LEADS.CIDADE),
    confirmou_romero: voto.romero.escolha,
    confirmou_andressa: voto.andressa.escolha,
    militante: campoBooleano(task, CAMPOS_LEADS.MILITANTE),
    sem_contato: !(Number(qtdAtendimentosRaw) > 0),
    atualizado_em: agora,
    score: numeroOuNull(valorCampoLead(task, CAMPOS_LEADS.SCORE)),
    tentativas: numeroOuNull(valorCampoLead(task, CAMPOS_LEADS.QTD_TENTATIVAS)),
    proximo_contato: parsed.proximoContato ? parsed.proximoContato.toISOString().slice(0, 10) : null,
    retorno_necessario: derivarRetornoNecessario(parsed, agoraDate),
    observacao_consolidada: valorCampoLead(task, CAMPOS_LEADS.OBSERVACAO_CONSOLIDADA) || null,
    dossie: task.description ?? task.text_content ?? null,
    ultimo_contato: paraTimestampISO(valorCampoLead(task, CAMPOS_LEADS.ULTIMO_CONTATO)),
    qtd_contatos: numeroOuNull(qtdAtendimentosRaw),
    id_lead: valorCampoLead(task, CAMPOS_LEADS.ID_LEAD_GHL) || null,
    tags: extrairTags(task),
    elegivel: leadElegivel(parsed.proximoContato, parsed.tentativas, agoraDate),
  };
}

// ===== Laço de paginação genérico — reusado pelas 3 funções de sync =====

/**
 * Pagina UMA lista do ClickUp (via `listarTasksComRetry`), mapeia cada task com
 * `mapear` (mapper puro; `null` descarta o registro) e grava em lote com `upsert`
 * a cada página — mesmo padrão de `sincronizarEspelhoLeads` original (u10), agora
 * genérico pras 3 listas. `dryRun` lê e monta as linhas mas NÃO grava. Erro de
 * ClickUp/Supabase PROPAGA (WR-03).
 */
async function paginarESincronizar<TRow>(args: {
  listId: string;
  mapear: (task: TaskClickUp) => TRow | null;
  upsert: (rows: TRow[]) => Promise<number>;
  maxPaginas?: number;
  dryRun?: boolean;
  pausaEntrePaginasMs?: number;
  tentativas?: number;
  onProgress?: (pagina: number, registrosAcumulados: number) => void;
}): Promise<ResultadoSyncEspelho> {
  let page = 0;
  let paginas = 0;
  let registrosTotal = 0;
  const limite = args.maxPaginas && args.maxPaginas > 0 ? args.maxPaginas : Infinity;
  while (paginas < limite) {
    const { tasks, lastPage } = await listarTasksComRetry(
      args.listId,
      { page, includeClosed: true },
      args.tentativas ?? 2,
    );
    const linhas = tasks.map(args.mapear).filter((r): r is TRow => r !== null);
    if (linhas.length > 0 && !args.dryRun) {
      await args.upsert(linhas);
    }
    paginas += 1;
    registrosTotal += linhas.length;
    args.onProgress?.(paginas, registrosTotal);
    if (lastPage) break;
    page += 1;
    if (args.pausaEntrePaginasMs) {
      await new Promise((resolve) => setTimeout(resolve, args.pausaEntrePaginasMs));
    }
  }
  return { paginas, registros: registrosTotal, ultimaPagina: page };
}

/** Sincroniza `discador_leads_espelho` com o registro COMPLETO da Lista 01 (§2.3) —
 *  score/tentativas/proximo_contato/retorno_necessario/dossie/elegivel/... além do
 *  subset que o espelho já copiava. */
export async function sincronizarEspelhoLeads(opts: OpcoesSyncEspelho = {}): Promise<ResultadoSyncEspelho> {
  const agora = new Date().toISOString();
  return paginarESincronizar<LeadFullEspelhoRow>({
    listId: CLICKUP_LIST_LEADS,
    mapear: (task) => paraLinhaLeadFull(task, agora),
    upsert: upsertLeadFullEspelho,
    ...opts,
  });
}

/** Sincroniza `ligacoes` a partir da Lista 02 LIGACOES (§2.1) — upsert por `clickup_task_id`. */
export async function sincronizarEspelhoLigacoes(opts: OpcoesSyncEspelho = {}): Promise<ResultadoSyncEspelho> {
  const agora = new Date().toISOString();
  return paginarESincronizar<LigacaoEspelhoRow>({
    listId: CLICKUP_LIST_LIGACOES,
    mapear: (task) => paraLinhaLigacao(task, agora),
    upsert: upsertLigacoesEspelho,
    ...opts,
  });
}

/** Sincroniza `audios_envios` a partir da Lista 03 AUDIOS (§2.2) — upsert por `clickup_task_id`. */
export async function sincronizarEspelhoAudios(opts: OpcoesSyncEspelho = {}): Promise<ResultadoSyncEspelho> {
  return paginarESincronizar<AudioEnvioRow>({
    listId: CLICKUP_LIST_AUDIOS,
    mapear: (task) => paraLinhaAudio(task),
    upsert: upsertAudiosEnvios,
    ...opts,
  });
}
