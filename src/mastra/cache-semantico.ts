// Cache semantico in-memory PARTICIONADO POR LEAD (HARD-04) — embedding +
// similaridade cosseno + TTL + cap/LRU + fail-open.
//
// Por que: muitos leads USI fazem perguntas semelhantes (Metodo ADS, planos,
// como funciona a call). Cachear por similaridade de embedding evita
// re-chamar o LLM (custo/latencia) quando o MESMO lead repete uma pergunta
// com texto levemente diferente mas intencao equivalente.
//
// REGRAS DE SEGURANCA/ROBUSTEZ (inegociaveis — ver <threat_model> da
// 05-02-PLAN.md):
//
// (1) ISOLAMENTO POR LEAD e INVIOLAVEL. O cache e um `Map<lead, entradas[]>`
//     e a busca por similaridade SO percorre o bucket do lead informado —
//     NUNCA cruza para o bucket de outro lead, mesmo com vetor identico. A
//     chave `lead` deve ser sempre o telefone/identificador CONFIAVEL do
//     processo (nunca um valor vindo do payload do LLM). Prova: smoke
//     scripts/smoke-cache-semantico.mjs cobre MISS cross-lead com embedding
//     identico.
//
// (2) FAIL-OPEN. Qualquer falha do embedder injetado (deployment ausente,
//     timeout, erro de rede, resposta invalida) faz `buscar` devolver
//     `null` (MISS silencioso) e `guardar` virar no-op — NUNCA propaga
//     excecao. O pipeline (index.ts) sempre pode seguir chamando o LLM
//     normalmente; o cache e uma otimizacao, nunca uma dependencia dura.
//
// (3) NUNCA logar `texto`/`resposta` bruta (LGPD, mesma regra de
//     anonimizacao.ts) — os logs deste modulo emitem apenas contadores/
//     metadados (hit/miss, tamanho do bucket, similaridade numerica).
//
// (4) IN-MEMORY primario; persistencia e OPCIONAL e NAO implementada aqui —
//     o banco dedicado do SDR esta READ-ONLY hoje (quota 402, ver
//     docs/sql/auton_sdr/README.md secao "Status atual do banco dedicado").
//     O gancho de persistencia opcional fica documentado no wiring
//     (index.ts) para um plano futuro decidir se vale a pena, sem
//     bloquear esta entrega no in-memory + TTL/cap.
//
// Modulo SEM import de azure-client/config no topo — o embedder e sempre
// INJETADO (via config do construtor), pelo mesmo motivo de smoke-abilidade
// dos demais modulos puros do projeto (anonimizacao.ts, guardrails/injecao.ts):
// o smoke injeta um embedder FAKE deterministico e roda sem credenciais/rede.

// CR-01 (review Fase 5): o predicado de cacheabilidade importa SO o parser
// puro do schema da Camila (camila-schema.ts, zero import de azure/config) —
// o modulo continua smoke-avel sem rede/credenciais, mesmo padrao de
// fallback.ts (extensao .ts explicita pelo loader ESM do smoke).
import { parseSaidaCamila } from './camila-schema.ts';

/**
 * CR-01 (review Fase 5): decide se uma saida bruta da Camila PODE ser
 * cacheada. So e cacheavel uma saida SEM efeito colateral: parse ok, acao
 * 'responder' e tools_a_executar[] VAZIO — e nunca uma saida de crise
 * (sinal_alerta 'sofrimento_agudo').
 *
 * Por que: uma entrada cacheada re-passa pelo dispatcher completo num HIT
 * futuro — se carregasse tools_a_executar, cada HIT RE-EXECUTARIA as tools
 * (double booking de create_calendar_event, card re-movido por
 * move_pipeline_stage, re-escalacao de escalate_to_human, regressao de
 * spin_stage por update_contact_field). O pior caso era a saida do protocolo
 * de crise (acao 'escalar' COM 1 mensagem CVV — Safety Envelope item 13),
 * que o guard antigo (`enviouAlgo`) cacheava. Nunca lanca: qualquer erro
 * degrada pra false (nao cacheia — fail-safe na direcao de nao replicar
 * efeito colateral).
 */
export function saidaCacheavel(raw: string): boolean {
  try {
    const parsed = parseSaidaCamila(raw);
    return (
      parsed.ok &&
      parsed.data.acao === 'responder' &&
      parsed.data.tools_a_executar.length === 0 &&
      parsed.data.sinal_alerta !== 'sofrimento_agudo'
    );
  } catch {
    return false;
  }
}

/**
 * Embedder injetavel: recebe um texto e devolve o vetor numerico do
 * embedding. Implementacao real (wiring em index.ts) envolve
 * `azure.embedding(AZURE_OPENAI_DEPLOYMENT_EMBEDDING, { dimensions: 1536 })`
 * (mesmo deployment ja usado por memoria.ts) — este modulo nao sabe nem
 * precisa saber disso.
 */
export type Embedder = (texto: string) => Promise<number[]>;

export interface CacheSemanticoConfig {
  /** Funcao de embedding injetada (nunca importada direto neste modulo). */
  embedder: Embedder;
  /** Limiar minimo de similaridade cosseno pra considerar HIT (0..1). Default: env SDR_CACHE_LIMIAR ou 0.92. */
  limiar?: number;
  /** TTL de cada entrada em ms. Default: env SDR_CACHE_TTL_MS ou 10 min. */
  ttlMs?: number;
  /** Tamanho maximo do bucket por lead (cap/LRU). Default: env SDR_CACHE_MAX_POR_LEAD ou 50. */
  maxPorLead?: number;
}

interface EntradaCache {
  vetor: number[];
  resposta: string;
  expiraEm: number;
}

// Defaults configuraveis por env, com fallback seguro — mesmo padrao de
// env-com-default de fila.ts (le process.env diretamente, sem depender de
// config.ts, pra este modulo continuar puro/sem side-effect de import).
const LIMIAR_DEFAULT = Number(process.env.SDR_CACHE_LIMIAR) || 0.92;
const TTL_MS_DEFAULT = Number(process.env.SDR_CACHE_TTL_MS) || 10 * 60 * 1000; // 10 min
const MAX_POR_LEAD_DEFAULT = Number(process.env.SDR_CACHE_MAX_POR_LEAD) || 50;
// Intervalo do cleanup periodico de entradas expiradas (estilo notificacoes.ts).
const CLEANUP_INTERVALO_MS = 5 * 60 * 1000; // 5 min

/**
 * Similaridade cosseno pura entre dois vetores numericos. Devolve 0 se os
 * vetores forem invalidos (nao-array, vazios, tamanhos diferentes) ou se
 * algum tiver norma zero — nunca lanca, nunca devolve NaN/Infinity.
 */
export function cosseno(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let produtoEscalar = 0;
  let normaA = 0;
  let normaB = 0;
  for (let i = 0; i < a.length; i++) {
    produtoEscalar += a[i] * b[i];
    normaA += a[i] * a[i];
    normaB += b[i] * b[i];
  }

  if (normaA === 0 || normaB === 0) return 0;
  const similaridade = produtoEscalar / (Math.sqrt(normaA) * Math.sqrt(normaB));
  if (!Number.isFinite(similaridade)) return 0;
  return similaridade;
}

/**
 * Cache semantico in-memory PARTICIONADO POR LEAD. Ver regras de seguranca
 * no cabecalho do modulo — isolamento por lead (1), fail-open (2), sem log
 * de texto bruto (3), in-memory com TTL/cap (4).
 */
export class CacheSemantico {
  private readonly embedder: Embedder;
  private readonly limiar: number;
  private readonly ttlMs: number;
  private readonly maxPorLead: number;
  // Estrutura PARTICIONADA: a chave externa e o lead (telefone confiavel do
  // processo). A busca de similaridade em `buscar` SO itera o array
  // associado ao lead informado — nunca outro bucket.
  private readonly buckets: Map<string, EntradaCache[]> = new Map();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(config: CacheSemanticoConfig) {
    this.embedder = config.embedder;
    this.limiar = config.limiar ?? LIMIAR_DEFAULT;
    this.ttlMs = config.ttlMs ?? TTL_MS_DEFAULT;
    this.maxPorLead = config.maxPorLead ?? MAX_POR_LEAD_DEFAULT;

    this.cleanupTimer = setInterval(() => this.limparExpiradas(), CLEANUP_INTERVALO_MS);
    // Nao mantem o processo vivo so por causa deste timer (mesmo cuidado do
    // smoke precisar de process.exit(0) explicito no fim).
    if (typeof (this.cleanupTimer as any).unref === 'function') {
      (this.cleanupTimer as any).unref();
    }
  }

  /** Remove entradas expiradas de todos os buckets; buckets vazios sao descartados. */
  private limparExpiradas(): void {
    const agora = Date.now();
    for (const [lead, entradas] of this.buckets) {
      const vivas = entradas.filter((e) => e.expiraEm > agora);
      if (vivas.length === 0) {
        this.buckets.delete(lead);
      } else if (vivas.length !== entradas.length) {
        this.buckets.set(lead, vivas);
      }
    }
  }

  /**
   * Busca por similaridade DENTRO do bucket do `lead` informado. Fail-open:
   * qualquer erro no embedder (ou vetor invalido devolvido) resulta em
   * `null` (MISS), nunca lanca. Devolve a `resposta` cacheada se a melhor
   * similaridade encontrada no bucket do lead for >= limiar e a entrada nao
   * estiver expirada; senao `null`.
   */
  async buscar(lead: string, texto: string): Promise<string | null> {
    if (!lead || typeof lead !== 'string') return null;
    if (!texto || typeof texto !== 'string') return null;

    const bucket = this.buckets.get(lead); // ISOLAMENTO: so o bucket deste lead
    if (!bucket || bucket.length === 0) return null;

    let vetor: number[];
    try {
      vetor = await this.embedder(texto);
    } catch (e) {
      console.warn(`[cache-semantico] falha no embedding (buscar) — MISS fail-open: ${(e as Error).message}`);
      return null;
    }
    if (!Array.isArray(vetor) || vetor.length === 0) {
      console.warn('[cache-semantico] embedder devolveu vetor invalido (buscar) — MISS fail-open');
      return null;
    }

    const agora = Date.now();
    let melhorEntrada: EntradaCache | null = null;
    let melhorSimilaridade = -Infinity;

    for (const entrada of bucket) {
      if (entrada.expiraEm <= agora) continue; // expirada, ignora
      const similaridade = cosseno(vetor, entrada.vetor);
      if (similaridade > melhorSimilaridade) {
        melhorSimilaridade = similaridade;
        melhorEntrada = entrada;
      }
    }

    if (melhorEntrada && melhorSimilaridade >= this.limiar) {
      console.log(`[cache-semantico] HIT lead=...${lead.slice(-4)} sim=${melhorSimilaridade.toFixed(4)} bucket=${bucket.length}`);
      return melhorEntrada.resposta;
    }

    console.log(`[cache-semantico] MISS lead=...${lead.slice(-4)} melhorSim=${melhorSimilaridade === -Infinity ? 'n/a' : melhorSimilaridade.toFixed(4)} bucket=${bucket.length}`);
    return null;
  }

  /**
   * Guarda `resposta` no bucket do `lead`, com TTL e cap/LRU. Fail-open:
   * qualquer erro no embedder vira no-op silencioso — nunca lanca. So deve
   * ser chamado pelo caller com respostas JA VALIDADAS (schema ok) — este
   * modulo nao valida o conteudo de `resposta`, so armazena.
   */
  async guardar(lead: string, texto: string, resposta: string): Promise<void> {
    if (!lead || typeof lead !== 'string') return;
    if (!texto || typeof texto !== 'string') return;
    if (!resposta || typeof resposta !== 'string') return;

    let vetor: number[];
    try {
      vetor = await this.embedder(texto);
    } catch (e) {
      console.warn(`[cache-semantico] falha no embedding (guardar) — no-op fail-open: ${(e as Error).message}`);
      return;
    }
    if (!Array.isArray(vetor) || vetor.length === 0) {
      console.warn('[cache-semantico] embedder devolveu vetor invalido (guardar) — no-op fail-open');
      return;
    }

    let bucket = this.buckets.get(lead);
    if (!bucket) {
      bucket = [];
      this.buckets.set(lead, bucket);
    }

    bucket.push({ vetor, resposta, expiraEm: Date.now() + this.ttlMs });

    // cap/LRU simplificado: descarta a entrada MAIS ANTIGA do bucket
    // (insercao no fim, descarte no inicio = FIFO) quando excede o cap —
    // suficiente pra nao crescer ilimitado (T-05-02-04), sem precisar de
    // rastreamento de "ultimo acesso" (LRU completo).
    while (bucket.length > this.maxPorLead) {
      bucket.shift();
    }

    console.log(`[cache-semantico] guardado lead=...${lead.slice(-4)} bucket=${bucket.length}/${this.maxPorLead}`);
  }
}
