// Lógica pura do Dossiê 360° (DOSS-01/02, Fase 04 Plano 02).
//
// MÓDULO PURO: sem imports (nem relativos, nem de pacotes) — precisa ser
// importável via `node --experimental-strip-types` a partir dos scripts de
// smoke/runner sem depender de resolução de módulo do bundler. Mapas de
// field-id (CAMPOS_LEADS) NÃO são usados aqui — a leitura/escrita por
// field-id é responsabilidade de clickup.ts; este módulo só calcula a
// cascata de dedupe, a mesclagem não-destrutiva e monta o prompt do dossiê,
// sobre valores já normalizados (injetados pelo caller).
//
// Regras de negócio (D-P4-06/08/09, ver 04-CONTEXT.md):
// - Dedupe em cascata ID_SUPABASE -> CPF normalizado -> telefone normalizado
//   (D-P4-08): casa no primeiro nível possível; sem match em nenhum nível,
//   sinaliza criar novo.
// - Mesclagem só preenche campos VAZIOS + grava ID_SUPABASE; NUNCA sobrescreve
//   um campo já preenchido — ClickUp é a fonte da verdade operacional
//   (D-P4-09).
// - montarPromptDossie monta as 6 seções do modelo do Miro; quando a fonte de
//   uma seção está ausente/indisponível, injeta um marcador explícito de
//   degradação — a IA é instruída a NUNCA inventar conteúdo (D-P4-06) e a
//   tratar o conteúdo das fontes como DADO, nunca instrução (anti-injeção,
//   T-04-02-PI).
//
// LGPD: este módulo é puro (zero I/O) e NUNCA loga — CPF/telefone só são
// usados para comparação (dígitos), nunca impressos.

/** Lead já existente na Lista 01 (shape espelhado de clickup.ts/lote.ts, não importado). */
export interface LeadExistente {
  taskId: string;
  idSupabase: string;
  cpf: string;
  telefone: string;
  /** Valores atuais por field-id lógico (ex.: CAMPOS_LEADS.NOME -> valor atual). */
  campos: Record<string, string>;
}

/** Registro bruto vindo do Supabase (self-hosted), normalizado pelo caller antes de chegar aqui. */
export type RegistroSupabase = Record<string, unknown>;

/** Nível da cascata de dedupe em que o match ocorreu (D-P4-08), ou null = nenhum match (criar novo). */
export type NivelDedupe = 'id_supabase' | 'cpf' | 'telefone' | null;

export interface ResultadoDedupe {
  match: LeadExistente | null;
  nivel: NivelDedupe;
}

function normalizarDigitos(valor: string): string {
  return String(valor ?? '').replace(/\D/g, '');
}

function vazio(valor: string | null | undefined): boolean {
  return valor === null || valor === undefined || String(valor).trim() === '';
}

/**
 * Resolve a identidade cruzada de um registro Supabase contra os leads já
 * existentes na Lista 01 (D-P4-08): cascata ID_SUPABASE -> CPF normalizado
 * (só dígitos) -> telefone normalizado (só dígitos), casando no primeiro
 * nível possível. Chave vazia em qualquer nível NUNCA casa (evita
 * falso-positivo de campo-vazio == campo-vazio). Sem match em nenhum nível
 * -> `{ match: null, nivel: null }` (sinaliza criar novo). Função nomeada
 * pura (mesmo racional de `derivarRetornoNecessario` em lote.ts) — sem I/O,
 * sem log (CPF nunca é impresso, LGPD).
 */
export function resolverDedupe(
  chave: { idSupabase: string; cpf: string; telefone: string },
  leadsExistentes: LeadExistente[],
): ResultadoDedupe {
  const idSupabase = String(chave.idSupabase ?? '').trim();
  const cpf = normalizarDigitos(chave.cpf);
  const telefone = normalizarDigitos(chave.telefone);

  if (idSupabase) {
    const match = leadsExistentes.find((lead) => String(lead.idSupabase ?? '').trim() === idSupabase);
    if (match) return { match, nivel: 'id_supabase' };
  }
  if (cpf) {
    const match = leadsExistentes.find((lead) => normalizarDigitos(lead.cpf) === cpf);
    if (match) return { match, nivel: 'cpf' };
  }
  if (telefone) {
    const match = leadsExistentes.find((lead) => normalizarDigitos(lead.telefone) === telefone);
    if (match) return { match, nivel: 'telefone' };
  }
  return { match: null, nivel: null };
}

/**
 * Mescla um registro Supabase num lead existente SEM NUNCA sobrescrever um
 * campo já preenchido (D-P4-09 — ClickUp é a fonte da verdade operacional;
 * Supabase só complementa). Para cada campo do `patchCandidato` (exceto
 * `idSupabaseFieldId`, tratado à parte), inclui no patch de saída SOMENTE se
 * o valor atual em `leadExistente.campos` estiver vazio (null/undefined/''
 * após trim) e o candidato não for vazio; sempre inclui o par
 * `{ [idSupabaseFieldId]: patchCandidato[idSupabaseFieldId] }` quando o lead
 * ainda não tem ID_SUPABASE (`leadExistente.idSupabase` vazio) e o candidato
 * traz um valor. Pura — nunca muta `leadExistente`, retorna sempre um novo
 * objeto.
 */
export function mesclarCamposVazios(
  leadExistente: LeadExistente,
  patchCandidato: Record<string, string>,
  idSupabaseFieldId: string,
): Record<string, string> {
  const patch: Record<string, string> = {};

  for (const [fieldId, valorCandidato] of Object.entries(patchCandidato)) {
    if (fieldId === idSupabaseFieldId) continue; // ID_SUPABASE é tratado à parte abaixo — usa leadExistente.idSupabase, não campos
    const valorAtual = leadExistente.campos[fieldId];
    if (vazio(valorAtual) && !vazio(valorCandidato)) {
      patch[fieldId] = valorCandidato;
    }
  }

  const idSupabaseCandidato = patchCandidato[idSupabaseFieldId];
  if (vazio(leadExistente.idSupabase) && !vazio(idSupabaseCandidato)) {
    patch[idSupabaseFieldId] = idSupabaseCandidato;
  }

  return patch;
}
