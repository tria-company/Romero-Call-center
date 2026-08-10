// Lógica pura do lote diário (LOTE-01, Fase 02 Plano 01).
//
// MÓDULO PURO: sem imports (nem relativos, nem de pacotes) — precisa ser
// importável via `node --experimental-strip-types` a partir dos scripts de
// smoke/runner sem depender de resolução de módulo do bundler. O mapa de
// field-ids (CAMPOS_LEADS) é injetado como argumento em vez de importado de
// clickup.ts, para manter este arquivo desacoplado do client ClickUp.
//
// Regras de negócio (D-P2-04, ver 02-01-PLAN.md):
// - Elegibilidade: proximoContato != null && proximoContato <= hoje E
//   tentativas < limiteTentativas.
// - Ordenação: retornoNecessario primeiro (true antes de false) -> score
//   desc -> tentativas asc (desempate). Corta em `tamanho`.

/** Forma normalizada de um lead vindo da Lista 01 (LEADS) do ClickUp. */
export interface LeadLote {
  taskId: string;
  idLead: string;
  nome: string;
  telefone: string;
  score: number;
  tentativas: number;
  proximoContato: Date | null;
  retornoNecessario: boolean;
}

/** Opções de seleção/priorização do lote do dia. */
export interface OpcoesLote {
  hoje: Date;
  limiteTentativas: number;
  tamanho: number;
}

/** Shape mínimo de custom_field que este módulo lê (espelha CustomFieldClickUp de clickup.ts). */
interface CustomFieldLike {
  id: string;
  value?: unknown;
}

/** Shape mínimo de task que este módulo lê/produz (espelha TaskClickUp de clickup.ts). Exportado
 * para o runner/skill (scripts/gerar-lote.mjs) e para a interface `BackendLote` abaixo. */
export interface TaskLike {
  id: string;
  custom_fields?: CustomFieldLike[];
}

/** Payload aceito por `criarTask` (clickup.ts) — espelhado aqui para `montarTaskLigacao`
 * continuar puro (sem importar clickup.ts). */
export interface PayloadCriarTask {
  name: string;
  description?: string;
  assignees?: number[];
  custom_fields?: Array<{ id: string; value: unknown }>;
}

/** Mapa de field-ids da Lista 02 (LIGACOES) que `montarTaskLigacao`/`deveCriar` precisam
 * (subconjunto de CAMPOS_LIGACOES, injetado pelo caller — D-07). */
export interface CamposLigacoesLike {
  ID_LEAD: string;
  TELEFONE: string;
}

/**
 * Backend plugável (D-P2-02) para a etapa "subir lote": a implementação REST
 * (scripts/gerar-lote.mjs, via clickup.ts) é o default executável desta fase;
 * MCP fica documentado como alternativa futura (não implementada aqui). Só o
 * TIPO vive em lote.ts (puro) — a implementação concreta é do runner.
 */
export interface BackendLote {
  ligacoesAbertasDoLead(idLead: string): Promise<TaskLike[]>;
  criarLigacao(payload: PayloadCriarTask): Promise<{ id: string }>;
}

/** Mapa de field-ids da Lista 01 que este parser precisa (subconjunto de CAMPOS_LEADS). */
interface CamposLeadsLike {
  NOME: string;
  TELEFONE: string;
  ID_LEAD_GHL: string;
  SCORE: string;
  QTD_TENTATIVAS: string;
  PROXIMO_CONTATO: string;
}

function valorCampo(task: TaskLike, fieldId: string): unknown {
  const campo = task.custom_fields?.find((c) => c.id === fieldId);
  return campo?.value;
}

function paraString(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  return String(valor);
}

function paraNumero(valor: unknown): number {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

/** ClickUp entrega datas como epoch string em ms (D-P2 interface_context). */
function paraData(valor: unknown): Date | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const epoch = Number(valor);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch);
}

/**
 * Extrai um `LeadLote` de uma `TaskClickUp` da Lista 01, lendo os custom
 * fields SEMPRE por field-id (nunca por nome — D-07). `campos` é o mapa de
 * field-ids (CAMPOS_LEADS), injetado pelo caller para manter este módulo puro.
 */
export function parseLeadDaTask(task: TaskLike, campos: CamposLeadsLike): LeadLote {
  return {
    taskId: task.id,
    idLead: paraString(valorCampo(task, campos.ID_LEAD_GHL)),
    nome: paraString(valorCampo(task, campos.NOME)),
    telefone: paraString(valorCampo(task, campos.TELEFONE)),
    score: paraNumero(valorCampo(task, campos.SCORE)),
    tentativas: paraNumero(valorCampo(task, campos.QTD_TENTATIVAS)),
    proximoContato: paraData(valorCampo(task, campos.PROXIMO_CONTATO)),
    // retornoNecessario é derivado, não lido diretamente da task — ver
    // derivarRetornoNecessario() abaixo (D-P2-04 open_decisions).
    retornoNecessario: false,
  };
}

/**
 * Deriva `retornoNecessario` de sinais já existentes na Lista 01 (D-P2-04):
 * a Lista 01 não tem um custom field dedicado de "retorno necessário" (esse
 * campo só existe na Lista 02 / CAMPOS_LIGACOES, escrito na Fase 3).
 * Interpretação executável desta fase: lead já contatado (tentativas > 0) e
 * reagendado para hoje ou antes (proximoContato <= hoje) = retorno necessário.
 * Isolado numa função nomeada para a Fase 3 poder substituir por um campo
 * consolidado sem mexer no ordenador (selecionarLoteElegivel).
 */
export function derivarRetornoNecessario(lead: LeadLote, hoje: Date): boolean {
  return lead.tentativas > 0 && lead.proximoContato !== null && lead.proximoContato.getTime() <= hoje.getTime();
}

function elegivel(lead: LeadLote, opts: OpcoesLote): boolean {
  if (lead.proximoContato === null) return false;
  if (lead.proximoContato.getTime() > opts.hoje.getTime()) return false;
  if (lead.tentativas >= opts.limiteTentativas) return false;
  return true;
}

/**
 * Filtra os leads elegíveis (D-P2-04) e ordena por retorno necessário
 * (desc) -> score (desc) -> tentativas (asc, desempate). Corta em
 * `opts.tamanho`. Pura e determinística — sem I/O.
 */
export function selecionarLoteElegivel(leads: LeadLote[], opts: OpcoesLote): LeadLote[] {
  const elegiveis = leads
    .filter((lead) => elegivel(lead, opts))
    .map((lead) => ({ ...lead, retornoNecessario: derivarRetornoNecessario(lead, opts.hoje) }));

  elegiveis.sort((a, b) => {
    if (a.retornoNecessario !== b.retornoNecessario) {
      return a.retornoNecessario ? -1 : 1;
    }
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.tentativas - b.tentativas;
  });

  return elegiveis.slice(0, opts.tamanho);
}

// ===== Agente Script + geração de tasks da Ligação (LOTE-02/03, Fase 02 Plano 02) =====

/**
 * Monta o pedido ao LLM (Agente Script, D-P2-05) para gerar o roteiro
 * estruturado de um lead. NÃO chama o LLM (isso é do runner via `chamarLLM`)
 * — só monta `system`/`prompt`, puro e determinístico.
 */
export function montarPromptScript(lead: LeadLote): { system: string; prompt: string } {
  const system = [
    'Você é o Agente Script da campanha RomeroCall.',
    'Escreva sempre em português do Brasil, num tom cordial e consultivo — nunca agressivo, nunca robótico.',
    'Gere APENAS o roteiro estruturado pedido, sem comentários fora dele.',
  ].join(' ');

  const prompt = [
    `Gere um roteiro de ligação para o lead "${lead.nome}" (telefone ${lead.telefone}) da campanha RomeroCall.`,
    'O roteiro deve ter EXATAMENTE estas 5 seções, cada uma com um título claro e nesta ordem:',
    '1. Abertura — cumprimento e identificação do operador/campanha.',
    '2. Contexto do lead — retome o histórico dele nesta campanha.',
    '3. Objetivo — o que queremos alcançar nesta ligação.',
    '4. Objeções — antecipe 2 a 3 objeções comuns e como respondê-las.',
    '5. Fechamento — o próximo passo combinado com o lead.',
    '',
    `Dados do lead: nome=${lead.nome}, telefone=${lead.telefone}, score=${lead.score}, ` +
      `tentativas anteriores=${lead.tentativas}, retorno necessário=${lead.retornoNecessario ? 'sim' : 'não'}.`,
  ].join('\n');

  return { system, prompt };
}

/**
 * Monta o payload de `criarTask` (clickup.ts) para a Ligação de um lead
 * (D-P2-06): name identificando o lead, script na descrição, assignee do
 * operador e vínculo (ID_LEAD/TELEFONE) por field-id injetado (D-07). Puro —
 * não importa clickup.ts.
 */
export function montarTaskLigacao(
  lead: LeadLote,
  script: string,
  assigneeId: string,
  campos: CamposLigacoesLike,
): PayloadCriarTask {
  return {
    name: `Ligar — ${lead.nome}`,
    description: script,
    assignees: [Number(assigneeId)],
    custom_fields: [
      { id: campos.ID_LEAD, value: lead.idLead },
      { id: campos.TELEFONE, value: lead.telefone },
    ],
  };
}

/**
 * Dedupe idempotente (D-P2-03): `false` se alguma Ligação da lista
 * `ligacoesAbertas` (já filtrada para "abertas" pelo caller, via
 * `listarTasks(..., { includeClosed: false })`) já referencia o lead — match
 * por `idLeadFieldId` (field-id de `ID_LEAD` na Lista 02) === `lead.idLead`.
 * `true` = pode criar. Puro e determinística.
 */
export function deveCriar(lead: LeadLote, ligacoesAbertas: TaskLike[], idLeadFieldId: string): boolean {
  const jaTemLigacaoAberta = ligacoesAbertas.some((task) => {
    const campo = task.custom_fields?.find((c) => c.id === idLeadFieldId);
    return campo?.value !== undefined && campo?.value !== null && String(campo.value) === lead.idLead;
  });
  return !jaTemLigacaoAberta;
}
