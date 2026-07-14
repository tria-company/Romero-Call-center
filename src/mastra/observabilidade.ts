// Observabilidade por interacao LLM (HARD-08, Fase 5 plano 05-06).
//
// Por que: o projeto ja tem traces do Mastra Observability (DefaultExporter/
// CloudExporter + SensitiveDataFilter, index.ts) e uma tabela de erros
// (auton_sdr_errors, 03_errors.sql) — mas nao ha rastreio de CUSTO/TOKEN/
// LATENCIA por interacao nem VERSIONAMENTO de prompt. Sem isso nao da pra
// medir o custo por lead, o ganho do cache semantico (05-02/HARD-04) nem
// correlacionar qualidade de resposta a mudanca de prompt.
//
// Este modulo e PURO (zero import de config/azure/supabase) — a persistencia
// real (salvarMetricaLLM) e INJETADA via parametro `persist` em
// registrarMetricaLLM, exatamente pra permitir que o smoke
// (scripts/smoke-observabilidade.mjs) rode as funcoes puras (estimarCusto,
// registrarMetricaLLM com um persist stub que lanca) sem tocar rede/import
// de modulo com side-effect. O call site real (index.ts) injeta
// `salvarMetricaLLM` de supabase.ts nesse parametro.
//
// LGPD (T-05-06-01): registrarMetricaLLM/salvarMetricaLLM NUNCA recebem nem
// logam o texto bruto da mensagem/resposta do lead — apenas contadores
// (tokens/custo/latencia), identificadores (telefone/conversationId/
// customerId) e a versao do prompt. Mesma regra de anonimizacao.ts.
//
// Fail-open (T-05-06-02): registrarMetricaLLM NUNCA lanca. Se o `persist`
// injetado lancar (banco read-only/ausente/quota), o catch e silencioso — o
// log JSON estruturado ja rodou ANTES da chamada de persist, entao a
// observabilidade continua consultavel mesmo com o banco fora do ar (mesmo
// espirito do fail-open de salvarErro, supabase.ts:725-753).

/**
 * Tabela de custo por modelo — PISO AJUSTAVEL (mesmo tratamento dado a
 * ICP_PROFISSOES_STEMS/CONCORRENTES_CONHECIDOS_STEMS em outras fases: valor
 * inicial razoavel, nao um preco contratual/oficial). Precos em USD por 1000
 * tokens. Ajustar quando o time confirmar os precos reais de contrato Azure
 * OpenAI (podem variar por regiao/SKU/data).
 */
export const CUSTO_POR_MODELO: Record<string, { inputPor1k: number; outputPor1k: number }> = {
  'gpt-5.1': { inputPor1k: 0.005, outputPor1k: 0.015 },
  'gpt-5-mini': { inputPor1k: 0.001, outputPor1k: 0.003 },
  'gpt-4.1-mini': { inputPor1k: 0.0004, outputPor1k: 0.0016 },
  'text-embedding-3-large': { inputPor1k: 0.00013, outputPor1k: 0 },
};

/**
 * Versoes rastreaveis do system prompt de cada agente — emitidas por
 * interacao em registrarMetricaLLM (promptVersao), permitindo correlacionar
 * custo/qualidade a mudancas de prompt (T-05-06-04). Incrementar
 * manualmente quando o texto de CAMILA_INSTRUCTIONS (agents/camila.ts) ou o
 * prompt do Qualificador mudar em substancia.
 */
export const CAMILA_PROMPT_VERSION = 'camila-v2.0';
export const QUALIFICADOR_PROMPT_VERSION = 'qualificador-v1.0';

export interface ResultadoCusto {
  custo: number;
  conhecido: boolean;
}

// WR-05 (review Fase 5): os call sites (index.ts) passam o NOME DO
// DEPLOYMENT Azure (env AZURE_OPENAI_DEPLOYMENT_*), que na pratica costuma
// diferir do nome canonico do modelo (ex.: 'gpt51-prod', 'gpt-5-mini-sdr').
// Sem normalizacao, qualquer deployment com nome diferente zerava
// SILENCIOSAMENTE o custo_estimado de todas as linhas. Ordem dos padroes
// importa: os '-mini' vem ANTES do gpt-5.1 (mais generico).
const PADROES_MODELO: Array<{ padrao: RegExp; canonico: string }> = [
  { padrao: /gpt[-_.]?4[-_.]?1[-_.]?mini/i, canonico: 'gpt-4.1-mini' },
  { padrao: /gpt[-_.]?5[-_.]?mini/i, canonico: 'gpt-5-mini' },
  { padrao: /gpt[-_.]?5[-_.]?1/i, canonico: 'gpt-5.1' },
  { padrao: /embedding/i, canonico: 'text-embedding-3-large' },
];

/**
 * WR-05: normaliza um nome de deployment Azure pro nome canonico do modelo
 * em CUSTO_POR_MODELO. Match exato tem precedencia; senao, primeiro padrao
 * que casar; senao devolve o valor original intacto (estimarCusto entao
 * marca conhecido:false + warning 1x). PURA — nunca lanca.
 */
export function normalizarModelo(modelo: string): string {
  if (typeof modelo !== 'string' || modelo.length === 0) return modelo;
  if (CUSTO_POR_MODELO[modelo]) return modelo;
  for (const { padrao, canonico } of PADROES_MODELO) {
    if (padrao.test(modelo)) return canonico;
  }
  return modelo;
}

// WR-05: warning UMA VEZ por modelo desconhecido — sem isso, o "custo 0"
// era invisivel (fake-success de metrica). Set module-level minusculo
// (cardinalidade = numero de deployments distintos, nunca cresce por lead).
const modelosSemCustoAvisados = new Set<string>();

/**
 * Estima o custo (USD) de uma chamada LLM a partir do modelo + tokens.
 * PURA — nunca lanca. Aceita nome de DEPLOYMENT Azure (normalizado via
 * normalizarModelo, WR-05). Modelo desconhecido (fora de CUSTO_POR_MODELO
 * mesmo apos normalizar) -> custo 0, conhecido:false + console.warn 1x por
 * modelo (nao trava a metrica, mas a incognita deixa de ser silenciosa).
 */
export function estimarCusto(args: {
  modelo: string;
  promptTokens: number;
  completionTokens: number;
}): ResultadoCusto {
  try {
    const tabela = CUSTO_POR_MODELO[normalizarModelo(args.modelo)];
    if (!tabela) {
      if (!modelosSemCustoAvisados.has(args.modelo)) {
        modelosSemCustoAvisados.add(args.modelo);
        console.warn(
          `[metrica-llm] modelo/deployment "${args.modelo}" sem entrada em CUSTO_POR_MODELO (nem via normalizarModelo) — custo registrado como 0 com custoConhecido=false. Mapear em PADROES_MODELO/CUSTO_POR_MODELO.`,
        );
      }
      return { custo: 0, conhecido: false };
    }
    const promptTokens = Number.isFinite(args.promptTokens) ? args.promptTokens : 0;
    const completionTokens = Number.isFinite(args.completionTokens) ? args.completionTokens : 0;
    const custo =
      (promptTokens / 1000) * tabela.inputPor1k + (completionTokens / 1000) * tabela.outputPor1k;
    return { custo: Number.isFinite(custo) ? custo : 0, conhecido: true };
  } catch {
    // Nunca lanca — qualquer erro interno (ex: tokens nao-numericos) degrada
    // pra custo 0/conhecido:false, nunca derruba o caller.
    return { custo: 0, conhecido: false };
  }
}

/** Tipos de interacao LLM rastreados (espelham os 3 call sites de index.ts + fallback). */
export type TipoInteracaoLLM = 'camila_primaria' | 'secundario_fallback' | 'qualificador';

export interface DadosMetricaLLM {
  modelo: string;
  tipo: TipoInteracaoLLM;
  promptTokens: number;
  completionTokens: number;
  latenciaMs: number;
  promptVersao: string;
  telefone?: string;
  conversationId?: string | null;
  customerId?: string | null;
  cacheHit?: boolean;
  /** true quando os tokens acima sao uma ESTIMATIVA (usage indisponivel na resposta do @ai-sdk), nao o valor exato do provider. */
  tokensEstimados?: boolean;
}

/**
 * Assinatura da funcao de persistencia REAL (injetada pelo caller — ver
 * salvarMetricaLLM em supabase.ts). Recebe o mesmo shape ja calculado
 * (com custo/total) pra persistir na tabela auton_sdr_llm_metrics.
 */
export type PersistMetricaLLM = (dados: DadosMetricaLLM & { totalTokens: number; custoEstimado: number; custoConhecido: boolean }) => Promise<void>;

/**
 * Registra 1 metrica de interacao LLM: calcula tokens totais + custo
 * estimado, emite UMA linha de log JSON estruturado (prefixo
 * `[metrica-llm]`) SEM texto bruto de mensagem/resposta, e chama o
 * `persist` injetado (fail-open — se lancar, so o log ja emitido continua
 * valendo, a excecao e engolida). Nunca lanca pro caller (T-05-06-02).
 */
export function registrarMetricaLLM(dados: DadosMetricaLLM, persist?: PersistMetricaLLM): void {
  try {
    const promptTokens = Number.isFinite(dados.promptTokens) ? dados.promptTokens : 0;
    const completionTokens = Number.isFinite(dados.completionTokens) ? dados.completionTokens : 0;
    const totalTokens = promptTokens + completionTokens;
    const { custo, conhecido } = estimarCusto({ modelo: dados.modelo, promptTokens, completionTokens });

    // Log JSON estruturado — CONSULTAVEL mesmo sem banco (T-05-06-02). NUNCA
    // inclui chaves de texto bruto (mensagem/resposta/texto) — so
    // contadores/ids/versao (LGPD, T-05-06-01).
    const linhaLog = {
      tipo: dados.tipo,
      modelo: dados.modelo,
      promptTokens,
      completionTokens,
      totalTokens,
      custoEstimado: custo,
      custoConhecido: conhecido,
      latenciaMs: dados.latenciaMs,
      promptVersao: dados.promptVersao,
      telefone: dados.telefone,
      conversationId: dados.conversationId ?? null,
      customerId: dados.customerId ?? null,
      cacheHit: dados.cacheHit ?? false,
      tokensEstimados: dados.tokensEstimados ?? false,
    };
    console.log('[metrica-llm]', JSON.stringify(linhaLog));

    if (persist) {
      // Fail-open: se a persistencia (banco read-only/ausente/quota)
      // lancar, o log acima ja rodou — engole a excecao e segue. Nunca
      // propaga pro caller (nunca derruba o pipeline por causa de metrica).
      Promise.resolve(
        persist({ ...dados, promptTokens, completionTokens, totalTokens, custoEstimado: custo, custoConhecido: conhecido }),
      ).catch((e) => {
        console.error('[metrica-llm] persist falhou (fail-open, so o log JSON acima roda):', (e as Error)?.message || e);
      });
    }
  } catch (e) {
    // Nunca lanca pro caller — mesmo se o calculo/log acima falhar por
    // algum motivo inesperado, registrarMetricaLLM nunca derruba o turno.
    console.error('[metrica-llm] erro interno ao registrar metrica (fail-open, ignorado):', (e as Error)?.message || e);
  }
}
