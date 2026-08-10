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

/** Shape mínimo de task que este módulo lê (espelha TaskClickUp de clickup.ts). */
interface TaskLike {
  id: string;
  custom_fields?: CustomFieldLike[];
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
