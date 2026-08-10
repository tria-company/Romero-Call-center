// Lógica pura de derivação de metadados da ligação (OPER-02, Fase 03 Plano 02).
//
// MÓDULO PURO: sem imports (nem relativos, nem de pacotes) — precisa ser
// importável via `node --experimental-strip-types` a partir dos scripts de
// smoke/runner sem depender de resolução de módulo do bundler. Mapas de
// field-id (CAMPOS_LIGACOES) são injetados pelo caller, nunca importados de
// clickup.ts.
//
// Regras de negócio (D-P3-05, ver 03-CONTEXT.md):
// - ATENDEU, MOTIVO_FALHA e DURACAO derivam do payload Wavoip (evento CALL
//   traz `status`/`direction`/`duration`; RECORD só existe quando houve
//   gravação) — preenchimento 100% automático, o operador não digita nada.
// - Vocabulário de `status` assumido (ACCEPT/ACTIVE/ANSWERED = atendido;
//   NOT_ANSWERED/UNANSWERED/REJECTED/MISSED = não atendido), combinado com
//   `duration > 0` E/OU a existência de gravação. Cada derivação é uma
//   função nomeada/isolada — o vocabulário real (confirmado nos logs do
//   webhook, checkpoint 03-05) pode ser ajustado sem tocar no resto.
// - Limitação aceita: caixa postal pode contar como "atendeu" (D-P3-05).

/** Subconjunto do payload Wavoip (eventos CALL/RECORD) que este módulo lê. */
export interface PayloadCallWavoip {
  status?: string;
  direction?: string;
  duration?: number | string;
  caller?: string;
  receiver?: string;
  record_url?: string;
}

/** Statuses que indicam que a ligação foi atendida (vocabulário assumido — D-P3-05). */
const STATUS_ATENDIDA = new Set(['ACCEPT', 'ACTIVE', 'ANSWERED']);

/** Statuses que indicam que a ligação NÃO foi atendida (vocabulário assumido — D-P3-05). */
const STATUS_NAO_ATENDIDA = new Set(['NOT_ANSWERED', 'UNANSWERED', 'REJECTED', 'MISSED']);

function paraNumero(valor: unknown): number {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

function statusNormalizado(payload: PayloadCallWavoip): string {
  return String(payload.status || '').toUpperCase();
}

/**
 * Deriva `duracao` (segundos) a partir de `duration` do payload Wavoip — 0
 * se ausente/inválido. Isolada/nomeada para o cálculo poder mudar sem tocar
 * no resto (mesmo racional de `derivarRetornoNecessario` em lote.ts).
 */
export function derivarDuracao(payload: PayloadCallWavoip): number {
  return paraNumero(payload.duration);
}

/**
 * Deriva se a ligação foi ATENDIDA (D-P3-05): true quando o `status` do
 * payload indica atendida OU (`duration > 0` OU `teveGravacao === true`).
 * false quando o `status` indica explicitamente não-atendida, mesmo com
 * duration > 0 (ex.: toque residual antes de rejeitar). Isolada/nomeada —
 * o vocabulário de `status` pode ser ajustado após confirmação nos logs
 * (checkpoint 03-05) sem tocar no resto da cadeia.
 */
export function derivarAtendeu(payload: PayloadCallWavoip, teveGravacao: boolean): boolean {
  const status = statusNormalizado(payload);
  if (STATUS_NAO_ATENDIDA.has(status)) return false;
  if (STATUS_ATENDIDA.has(status)) return true;
  return derivarDuracao(payload) > 0 || teveGravacao === true;
}

/**
 * Deriva o motivo de falha (D-P3-05) quando a ligação NÃO foi atendida —
 * string vazia quando atendeu. Mapeamento do `status` normalizado para um
 * texto em português; status desconhecido cai num motivo genérico (nunca
 * some silenciosamente, T-02-02-E). Diferente de `derivarAtendeu`, esta
 * função não recebe `teveGravacao` — quando o `status` não indica nem
 * atendida nem não-atendida, usa `duration > 0` como sinal de atendida
 * (mesma heurística, sem o sinal extra de gravação).
 */
export function derivarMotivoFalha(payload: PayloadCallWavoip): string {
  const status = statusNormalizado(payload);
  if (STATUS_ATENDIDA.has(status)) return '';
  if (status === 'NOT_ANSWERED' || status === 'UNANSWERED') return 'não atendida';
  if (status === 'REJECTED') return 'recusada';
  if (status === 'MISSED') return 'perdida';
  if (derivarDuracao(payload) > 0) return '';
  if (!status) return 'motivo desconhecido (status ausente)';
  return `não atendida (status=${status})`;
}

// ===== Agente Análise — prompt/parse/regra de revisão/extração de retorno (OPER-03/04, Fase 03 Plano 03) =====
//
// Regras de negócio (D-P3-09/10/11/15, ver 03-CONTEXT.md):
// - Aderência ao script: nota 0–10 avaliando a transcrição contra as 5 seções
//   do script (abertura/contexto/objetivo/objeções/fechamento), a mesma
//   estrutura gerada pelo Agente Script (montarPromptScript, lote.ts).
// - NECESSITA_REVISAO é uma regra composta (D-P3-10): true quando
//   aderência < limiar OU falha técnica (LLM indisponível/parse inválido) OU
//   há sinal de alerta na conversa (reclamação, pedido de não ligar mais —
//   opt-out —, dado sensível). Opt-out marca revisão e é registrado; NUNCA
//   remove o lead automaticamente (D-P3-15) — decisão de um humano.
// - RETORNO_NECESSARIO/DATA_RETORNO são extraídos da conversa pela IA
//   (D-P3-11); quando o lead combina um retorno sem data explícita, o
//   default é +2 dias úteis a partir de hoje — função isolada/nomeada para
//   poder ser ajustada sem tocar no resto.

/** Resultado normalizado da análise (saída de `parseResultadoAnalise`). */
export interface ResultadoAnalise {
  /** Nota de aderência ao script, 0–10 (D-P3-09). */
  aderencia: number;
  /** Resumo curto da ligação, gerado pela IA. */
  resumoAnalise: string;
  /** Sinais de alerta na conversa (reclamação, opt-out, dado sensível — D-P3-10/15). */
  sinaisAlerta: string[];
  /** Retorno combinado na conversa (D-P3-11) — `data` como string bruta da IA (normalizada por `extrairRetorno`). */
  retorno: { necessario: boolean; data: string | null };
  /** Observações relevantes extraídas da conversa (discrição do planner). */
  observacoesExtraidas: string;
  /** true quando o parse da saída do LLM falhou — alimenta `necessitaRevisao` (D-P3-10). */
  falhaTecnica: boolean;
}

/**
 * Monta o pedido ao LLM (Agente Análise, D-P3-09) para avaliar a aderência
 * da transcrição ao script combinado. NÃO chama o LLM (isso é do webhook via
 * `chamarLLM`) — só monta `system`/`prompt`, puro e determinístico. Mesmo
 * molde de `montarPromptScript` (lote.ts): pt-BR, tom consultivo, retorna
 * `{ system, prompt }`.
 */
export function montarPromptAnalise({ script, transcricao }: { script: string; transcricao: string }): {
  system: string;
  prompt: string;
} {
  const system = [
    'Você é o Agente Análise da campanha RomeroCall.',
    'Sua tarefa é avaliar, a partir da transcrição de uma ligação, o quanto o vendedor seguiu o script combinado.',
    'Responda sempre em português do Brasil, num tom analítico e objetivo — nunca agressivo, nunca robótico.',
    'Devolva APENAS um JSON válido no formato pedido, sem comentários fora dele e sem cercas de código.',
  ].join(' ');

  const prompt = [
    'Avalie a ligação abaixo contra o script combinado, considerando estas 5 seções:',
    '1. Abertura — cumprimento e identificação do operador/campanha.',
    '2. Contexto do lead — retomada do histórico dele nesta campanha.',
    '3. Objetivo — clareza sobre o que a ligação buscava alcançar.',
    '4. Objeções — como o vendedor respondeu às objeções levantadas pelo lead.',
    '5. Fechamento — o próximo passo combinado com o lead.',
    '',
    'Dê uma nota GERAL de aderência de 0 (não seguiu nada do script) a 10 (seguiu perfeitamente todas as seções).',
    '',
    '=== SCRIPT COMBINADO ===',
    script || '(script vazio)',
    '',
    '=== TRANSCRIÇÃO DA LIGAÇÃO ===',
    transcricao || '(transcrição vazia)',
    '',
    'Responda com um JSON EXATAMENTE neste formato (sem texto antes ou depois):',
    '{',
    '  "aderencia": <numero de 0 a 10>,',
    '  "resumoAnalise": "<resumo curto da ligação em 1-2 frases>",',
    '  "sinaisAlerta": ["<sinal, ex.: reclamação, pedido para não ligar mais, dado sensível compartilhado>"],',
    '  "retorno": { "necessario": <true ou false>, "data": "<AAAA-MM-DD ou null>" },',
    '  "observacoesExtraidas": "<observações relevantes extraídas da conversa>"',
    '}',
    '',
    'Se não houver nenhum sinal de alerta, devolva "sinaisAlerta": []. Se o lead não combinou um retorno, devolva "retorno": { "necessario": false, "data": null }.',
  ].join('\n');

  return { system, prompt };
}

/** Resultado de fallback quando o parse da saída do LLM falha (marca falha técnica — D-P3-10). */
function resultadoFalhaTecnica(): ResultadoAnalise {
  return {
    aderencia: 0,
    resumoAnalise: '',
    sinaisAlerta: [],
    retorno: { necessario: false, data: null },
    observacoesExtraidas: '',
    falhaTecnica: true,
  };
}

/**
 * Extrai o JSON de forma defensiva da saída do LLM (D-P3-09): tolera cercas
 * de código (```json ... ```) e texto ao redor do objeto. Em parse inválido
 * (sem JSON reconhecível, ou JSON malformado) retorna um resultado marcado
 * como falha técnica — alimenta `necessitaRevisao` (D-P3-10). Campos
 * ausentes/malformados dentro de um JSON válido caem em defaults seguros
 * (não é tratado como falha técnica: o LLM respondeu, só não completou tudo).
 */
export function parseResultadoAnalise(textoLLM: string): ResultadoAnalise {
  if (!textoLLM || typeof textoLLM !== 'string') return resultadoFalhaTecnica();

  const semCercas = textoLLM.replace(/```(?:json)?/gi, '').replace(/```/g, '');
  const inicio = semCercas.indexOf('{');
  const fim = semCercas.lastIndexOf('}');
  if (inicio === -1 || fim === -1 || fim < inicio) return resultadoFalhaTecnica();

  let obj: any;
  try {
    obj = JSON.parse(semCercas.slice(inicio, fim + 1));
  } catch {
    return resultadoFalhaTecnica();
  }
  if (!obj || typeof obj !== 'object') return resultadoFalhaTecnica();

  const aderenciaBruta = Number(obj.aderencia);
  const aderencia = Number.isFinite(aderenciaBruta) ? Math.max(0, Math.min(10, aderenciaBruta)) : 0;
  const sinaisAlerta = Array.isArray(obj.sinaisAlerta) ? obj.sinaisAlerta.map((s: unknown) => String(s)) : [];
  const retornoBruto = obj.retorno && typeof obj.retorno === 'object' ? obj.retorno : {};
  const retornoData =
    retornoBruto.data === null || retornoBruto.data === undefined || retornoBruto.data === ''
      ? null
      : String(retornoBruto.data);

  return {
    aderencia,
    resumoAnalise: typeof obj.resumoAnalise === 'string' ? obj.resumoAnalise : '',
    sinaisAlerta,
    retorno: { necessario: Boolean(retornoBruto.necessario), data: retornoData },
    observacoesExtraidas: typeof obj.observacoesExtraidas === 'string' ? obj.observacoesExtraidas : '',
    falhaTecnica: false,
  };
}

/**
 * Regra composta de revisão (D-P3-10, espelha `elegivel` em lote.ts —
 * combinador booleano puro, sem I/O): true quando a aderência ficou abaixo
 * do limiar parametrizável, OU houve falha técnica (LLM indisponível/parse
 * inválido — a cadeia não trava, mas marca revisão, D-P3-08), OU há algum
 * sinal de alerta na conversa (reclamação, opt-out, dado sensível — o
 * opt-out NUNCA remove o lead automaticamente, D-P3-15, só sinaliza revisão
 * humana).
 */
export function necessitaRevisao(opts: {
  aderencia: number;
  limiar: number;
  sinaisAlerta: string[];
  falhaTecnica: boolean;
}): boolean {
  if (opts.falhaTecnica) return true;
  if (opts.aderencia < opts.limiar) return true;
  if (opts.sinaisAlerta.length > 0) return true;
  return false;
}

function ehDiaUtil(data: Date): boolean {
  const dia = data.getUTCDay();
  return dia !== 0 && dia !== 6;
}

/** Soma `dias` dias ÚTEIS (pula sábado/domingo) a partir de `base` — isolada para o default de D-P3-11 poder mudar sem tocar no resto. */
function somarDiasUteis(base: Date, dias: number): Date {
  const resultado = new Date(base.getTime());
  let restantes = dias;
  while (restantes > 0) {
    resultado.setUTCDate(resultado.getUTCDate() + 1);
    if (ehDiaUtil(resultado)) restantes -= 1;
  }
  return resultado;
}

/**
 * Normaliza `resultado.retorno` (D-P3-11): quando o lead combinou um
 * retorno mas a IA não extraiu uma data explícita (ou a data veio
 * inválida), usa o default `hoje + defaultDias` dias ÚTEIS. Isolada/nomeada
 * — o default é substituível sem tocar no resto da cadeia.
 */
export function extrairRetorno(
  resultado: ResultadoAnalise,
  opts: { hoje: Date; defaultDias: number },
): { necessario: boolean; data: Date | null } {
  const necessario = Boolean(resultado?.retorno?.necessario);
  if (!necessario) return { necessario: false, data: null };

  const dataStr = resultado?.retorno?.data;
  if (dataStr) {
    const data = new Date(dataStr);
    if (!Number.isNaN(data.getTime())) {
      return { necessario: true, data };
    }
  }
  return { necessario: true, data: somarDiasUteis(opts.hoje, opts.defaultDias) };
}
