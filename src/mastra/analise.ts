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
// - Vocabulário de `status` CONFIRMADO nos logs reais de produção
//   (2026-08-12): RINGING/CALLING/ACTIVE = transições (dur=0);
//   CANCELLED/FAILED/ENDED = terminais. ENDED = atendida encerrada (dur>0).
//   CANCELLED = não atendida (quem liga desistiu, dur=0). FAILED com dur>0 e
//   `reason` = queda no MEIO de chamada atendida (gera RECORD depois); FAILED
//   com dur=0 = falha real da chamada. Cada derivação é uma função
//   nomeada/isolada — o vocabulário pode ser ajustado sem tocar no resto.
// - Limitação aceita: caixa postal pode contar como "atendeu" (D-P3-05).

/** Subconjunto do payload Wavoip (eventos CALL/RECORD) que este módulo lê. */
export interface PayloadCallWavoip {
  status?: string;
  direction?: string;
  duration?: number | string;
  caller?: string;
  receiver?: string;
  record_url?: string;
  reason?: string;
}

/** Statuses que indicam que a ligação foi atendida (vocabulário CONFIRMADO — 2026-08-12). */
const STATUS_ATENDIDA = new Set(['ACCEPT', 'ACTIVE', 'ANSWERED']);

/** Statuses que indicam que a ligação NÃO foi atendida (vocabulário CONFIRMADO — 2026-08-12). */
const STATUS_NAO_ATENDIDA = new Set([
  'NOT_ANSWERED',
  'UNANSWERED',
  'REJECTED',
  'MISSED',
  'CANCELLED',
  'CANCELED',
]);

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
 * vocabulário CONFIRMADO nos logs reais (2026-08-12): CANCELLED entra pelo
 * Set (→ false); FAILED com dur>0 cai na heurística duration/gravação
 * (→ true, é queda no meio de chamada atendida).
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
  if (status === 'CANCELLED' || status === 'CANCELED') return 'não atendida';
  if (status === 'NOT_ANSWERED' || status === 'UNANSWERED') return 'não atendida';
  if (status === 'REJECTED') return 'recusada';
  if (status === 'MISSED') return 'perdida';
  if (derivarDuracao(payload) > 0) return '';
  if (status === 'FAILED') return `falha na chamada${payload.reason ? ` (${payload.reason})` : ''}`;
  if (!status) return 'motivo desconhecido (status ausente)';
  return `não atendida (status=${status})`;
}

/**
 * Predicado explícito de falha terminal do branch CALL (CR-01, gap-closure
 * 03-06): retorna `true` quando o `status` normalizado do payload está em
 * `STATUS_NAO_ATENDIDA` (vocabulário CONFIRMADO — 2026-08-12) OU quando
 * `status === 'FAILED'` E `derivarDuracao(payload) === 0` (falha real da
 * chamada; `FAILED` com `duration > 0` é queda no MEIO de uma chamada
 * atendida — o `RECORD` subsequente cuida da task, então retorna `false`).
 * Diferente de `derivarAtendeu`, este predicado NUNCA dispara por fallback
 * de `teveGravacao` — status ausente, intermediário (ex.: RINGING, CALLING,
 * ACTIVE) ou desconhecido retornam `false`. Existe para o gate de
 * "não-atendida" do webhook (index.ts) nunca fechar/consolidar a Ligação
 * enquanto a chamada ainda está tocando (transição), só para falha terminal
 * confirmada. Mantém o vocabulário isolado em `analise.ts`.
 */
export function ehStatusFalhaTerminal(payload: PayloadCallWavoip): boolean {
  const status = statusNormalizado(payload);
  if (STATUS_NAO_ATENDIDA.has(status)) return true;
  return status === 'FAILED' && derivarDuracao(payload) === 0;
}

/**
 * Decisão pura de dedup do caminho de falha do branch CALL (CR-02,
 * gap-closure 03-06) — espelha o padrão de `recordsProcessados` usado no
 * caminho RECORD. Retorna `true` quando o evento deve ser processado: sem
 * `callId` não há chave de dedup, então processa (a limpeza de
 * `taskAtivaPorTelefone` no caller cobre o retry sequencial); com `callId`,
 * só processa se ainda não visto — um segundo evento CALL terminal para a
 * mesma chamada (retry/reentrega do webhook) vira no-op. A MUTAÇÃO do Set
 * (`.add`) fica no caller (index.ts); esta função só DECIDE.
 */
export function deveProcessarFalhaTerminal(callId: string, jaProcessadas: Set<string>): boolean {
  return !callId ? true : !jaProcessadas.has(callId);
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

/**
 * Voto extraído pela IA por candidato: uma escolha de `EscolhaVoto` (espelhada
 * de clickup.ts — este módulo é PURO e não importa) ou `null` quando a
 * transcrição não permite afirmar. Em `null`, o processador NÃO toca no campo.
 */
export type VotoIA = 'sim' | 'nao' | 'naoDeclarou' | null;

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
  /**
   * Intenção de voto do lead extraída da transcrição, por candidato (OPER-04b).
   * `null` = a transcrição não dá base pra afirmar → o processador não escreve
   * nada nesse campo do lead (não sobrescreve a marcação manual do closer).
   */
  voto: { romero: VotoIA; andressa: VotoIA };
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
    'Além da aderência, EXTRAIA da transcrição a intenção de voto do lead para CADA candidato (Romero e Andressa):',
    '- "sim" = o lead declara/confirma que vai votar naquele candidato.',
    '- "nao" = o lead declara que NÃO vai votar naquele candidato (ou que vota em outro).',
    '- "naoDeclarou" = o tema do voto surgiu, mas o lead não se comprometeu / ficou em dúvida.',
    '- null = a transcrição não dá base para afirmar (o assunto não apareceu). Nunca invente; na dúvida entre "naoDeclarou" e null, use null.',
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
    '  "voto": { "romero": <"sim"|"nao"|"naoDeclarou"|null>, "andressa": <"sim"|"nao"|"naoDeclarou"|null> },',
    '  "observacoesExtraidas": "<observações relevantes extraídas da conversa>"',
    '}',
    '',
    'Se não houver nenhum sinal de alerta, devolva "sinaisAlerta": []. Se o lead não combinou um retorno, devolva "retorno": { "necessario": false, "data": null }.',
    'Se a transcrição não deixar clara a intenção de voto de um candidato, devolva null para ele — não chute.',
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
    voto: { romero: null, andressa: null },
    falhaTecnica: true,
  };
}

/** Coage um valor bruto do LLM para `VotoIA` — só aceita as 3 escolhas válidas; qualquer outra coisa (inclusive null/ausente) vira null. */
function normalizarVotoIA(v: unknown): VotoIA {
  return v === 'sim' || v === 'nao' || v === 'naoDeclarou' ? v : null;
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
  const votoBruto = obj.voto && typeof obj.voto === 'object' ? obj.voto : {};

  return {
    aderencia,
    resumoAnalise: typeof obj.resumoAnalise === 'string' ? obj.resumoAnalise : '',
    sinaisAlerta,
    retorno: { necessario: Boolean(retornoBruto.necessario), data: retornoData },
    observacoesExtraidas: typeof obj.observacoesExtraidas === 'string' ? obj.observacoesExtraidas : '',
    voto: { romero: normalizarVotoIA(votoBruto.romero), andressa: normalizarVotoIA(votoBruto.andressa) },
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

/** Ação de escrita do voto extraído pela IA contra o valor atual (manual) do lead. */
export type AcaoVoto = 'ignorar' | 'preencher' | 'manter' | 'divergencia';

/**
 * Política humano×IA para o voto (OPER-04b, decidida pelo operador): a IA
 * PREENCHE o campo vazio e VALIDA o já-preenchido — NUNCA sobrescreve a
 * marcação manual do closer.
 * - `ia === null` → 'ignorar' (a transcrição não deu base pra afirmar).
 * - `atual === null` (campo vazio) → 'preencher' com o valor da IA.
 * - já preenchido e IGUAL → 'manter' (concordam).
 * - já preenchido e DIFERENTE → 'divergencia' (marca revisão humana, sem sobrescrever).
 * Pura/nomeada — a política pode mudar sem tocar no writeback do processador.
 */
export function decidirAcaoVoto(ia: VotoIA, atual: VotoIA): AcaoVoto {
  if (ia === null) return 'ignorar';
  if (atual === null) return 'preencher';
  return ia === atual ? 'manter' : 'divergencia';
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
