// HARD-05/HARD-06 (Fase 5, plano 05-03): camada de RESILIENCIA — Circuit
// Breaker + Bulkhead (falha rapida + pool isolado por recurso) nas chamadas
// de LLM/GHL, backoff com JITTER (evita thundering herd) e idempotencia de
// nivel-chamada (evita efeito duplicado quando o retry re-executa).
//
// ============================================================================
// INVARIANTE INVIOLAVEL DO PROJETO (nao remover/enfraquecer sem revisao):
//
//   O bypass `chamarComResiliencia(fn, { crise: true })` existe porque
//   BLOQUEAR a escalacao de sofrimento agudo (protocolo CVV 188,
//   escalate-to-human.ts) por causa de um circuit breaker aberto e
//   INACEITAVEL (CLAUDE.md: compliance clinico + core value do SDR — "se
//   tudo mais falhar, o agendamento/encaminhamento tem que funcionar").
//   Prefere-se SEMPRE TENTAR e possivelmente falhar a NUNCA tentar. Por
//   isso `crise: true` ignora TOTALMENTE o estado do breaker e a fila do
//   bulkhead do recurso — a unica coisa que ainda se aplica e o timeout
//   (protecao contra travar o processo pra sempre, nao contra travar o
//   protocolo de crise).
//
//   Mesmo espirito de fila.ts (HARD-03: crise nunca rate-limited/enfileirada/
//   shedada) e escalate-to-human.ts (acionamento garantido independente de
//   config opcional) — aqui a mesma garantia se aplica ao circuito de
//   falha-rapida.
// ============================================================================
//
// Modulo PURO (sem import de config/azure/index no topo) — smoke-avel sem
// rede/credenciais, mesmo padrao de fila.ts/cache-semantico.ts. Tunables via
// process.env com defaults seguros (lidos em module-load-time, como
// fila.ts). Zero dependencia npm nova: breaker/bulkhead/jitter sao
// hand-rolled in-memory (sem lib tipo opossum/cockatiel).

/** Identificador do recurso protegido. Sempre string FIXA no codigo do
 * caller (ex.: 'llm', 'ghl') — nunca deve vir de payload externo/do lead
 * (T-05-03-05: superficie de manipulacao teria que vir do conteudo do
 * lead, o que este modulo nunca aceita como entrada). */
export type Recurso = string;

export type EstadoBreaker = 'closed' | 'open' | 'half-open';

/** Erro tipado de fast-fail do breaker aberto. `codigo` fixo 'breaker_open'
 * — classificavel programaticamente (mesmo espirito de classificarErro em
 * index.ts) e e o GATILHO documentado pro fallback em cascata do plano
 * 05-04 (primario esgotado / breaker aberto = trocar de estrategia). */
export class ErroBreakerAberto extends Error {
  readonly codigo = 'breaker_open' as const;
  readonly recurso: Recurso;

  constructor(recurso: Recurso) {
    super(`breaker_open: recurso '${recurso}' com circuit breaker ABERTO — fast-fail sem executar a chamada`);
    this.name = 'ErroBreakerAberto';
    this.recurso = recurso;
  }
}

// ---- Circuit Breaker por recurso ----
//
// Defaults configuraveis por env (mesmo padrao de fila.ts/cache-semantico.ts
// — le process.env diretamente, sem importar config.ts, pra este modulo
// continuar puro/sem side-effect de import).
const BREAKER_LIMIAR_FALHAS_DEFAULT = Number(process.env.SDR_BREAKER_LIMIAR_FALHAS) || 5;
const BREAKER_COOLDOWN_MS_DEFAULT = Number(process.env.SDR_BREAKER_COOLDOWN_MS) || 30_000;

interface EstadoRecursoBreaker {
  estado: EstadoBreaker;
  falhasConsecutivas: number;
  /** timestamp (Date.now()) de quando o recurso entrou em OPEN pela ultima vez. */
  abriuEm: number;
}

export interface CircuitBreakerConfig {
  /** Falhas consecutivas ate abrir o circuito. Default: env SDR_BREAKER_LIMIAR_FALHAS ou 5. */
  limiarFalhas?: number;
  /** Tempo em OPEN antes de permitir 1 tentativa de teste (HALF_OPEN). Default: env SDR_BREAKER_COOLDOWN_MS ou 30s. */
  cooldownMs?: number;
}

/**
 * Circuit breaker POR RECURSO (registro interno particionado por
 * `recurso` — chamar `.falha('llm')` NUNCA afeta o estado de `.estado('ghl')`,
 * isolamento estrutural, nao so condicional).
 *
 * Estados: 'closed' (normal) -> apos `limiarFalhas` falhas consecutivas ->
 * 'open' (fast-fail, `permite()` devolve false) -> apos `cooldownMs` ->
 * 'half-open' (`permite()` volta a devolver true pra 1 tentativa de teste)
 * -> sucesso leva a 'closed' (zera contador); falha em half-open volta a
 * 'open' (reinicia o cooldown).
 */
export class CircuitBreaker {
  private readonly estados = new Map<Recurso, EstadoRecursoBreaker>();
  private readonly limiarFalhas: number;
  private readonly cooldownMs: number;

  constructor(config: CircuitBreakerConfig = {}) {
    this.limiarFalhas = config.limiarFalhas ?? BREAKER_LIMIAR_FALHAS_DEFAULT;
    this.cooldownMs = config.cooldownMs ?? BREAKER_COOLDOWN_MS_DEFAULT;
  }

  private obter(recurso: Recurso): EstadoRecursoBreaker {
    let e = this.estados.get(recurso);
    if (!e) {
      e = { estado: 'closed', falhasConsecutivas: 0, abriuEm: 0 };
      this.estados.set(recurso, e);
    }
    return e;
  }

  /**
   * `true` se a chamada pode prosseguir agora (closed OU half-open). `false`
   * = fast-fail (open, cooldown ainda nao decorrido). Transiciona
   * OPEN -> HALF_OPEN automaticamente quando o cooldown expira (efeito
   * colateral proposital: e a unica forma de sair de OPEN sem uma tentativa
   * de teste real).
   */
  permite(recurso: Recurso): boolean {
    const e = this.obter(recurso);
    if (e.estado === 'open') {
      if (Date.now() - e.abriuEm >= this.cooldownMs) {
        e.estado = 'half-open';
        return true;
      }
      return false;
    }
    return true;
  }

  /** Registra sucesso: reseta pra CLOSED e zera o contador de falhas consecutivas. */
  sucesso(recurso: Recurso): void {
    const e = this.obter(recurso);
    e.estado = 'closed';
    e.falhasConsecutivas = 0;
  }

  /** Registra falha: incrementa o contador; abre (ou reabre, se half-open) o circuito ao atingir o limiar. */
  falha(recurso: Recurso): void {
    const e = this.obter(recurso);
    e.falhasConsecutivas += 1;

    if (e.estado === 'half-open') {
      // Falha na tentativa de teste -> volta pra OPEN, reinicia o cooldown.
      e.estado = 'open';
      e.abriuEm = Date.now();
      return;
    }

    if (e.falhasConsecutivas >= this.limiarFalhas) {
      e.estado = 'open';
      e.abriuEm = Date.now();
    }
  }

  /** Leitura READ-ONLY do estado atual (reflete a expiracao do cooldown sem mutar o registro). */
  estado(recurso: Recurso): EstadoBreaker {
    const e = this.obter(recurso);
    if (e.estado === 'open' && Date.now() - e.abriuEm >= this.cooldownMs) {
      return 'half-open';
    }
    return e.estado;
  }
}

// ---- Bulkhead (pool de concorrencia isolado por recurso) ----

const BULKHEAD_LIMITE_DEFAULT = Number(process.env.SDR_BULKHEAD_LIMITE) || 10;
// WR-03 (review Fase 5): cap da FILA DE ESPERA do bulkhead. Sem cap, cada
// turno admitido sob saturacao sustentada de 'llm' estacionava um resolver
// no array indefinidamente (memoria sem limite + pilha de turnos velhos que
// disparariam todos juntos quando a capacidade liberasse). Acima do cap, a
// aquisicao REJEITA com erro tipado (ErroBulkheadSaturado) — o caller
// (chamarComResiliencia -> catch de index.ts) degrada honestamente pra
// cascata de fallback em vez de enfileirar pra sempre.
const BULKHEAD_FILA_MAX_DEFAULT = Number(process.env.SDR_BULKHEAD_FILA_MAX) || 50;

/** Erro tipado de rejeicao explicita quando a fila de espera do bulkhead
 * atinge o cap (WR-03) — mesmo espirito de ErroBreakerAberto: classificavel
 * programaticamente, gatilho da degradacao honesta pro fallback. */
export class ErroBulkheadSaturado extends Error {
  readonly codigo = 'bulkhead_saturado' as const;
  readonly recurso: Recurso;

  constructor(recurso: Recurso, tamanhoFila: number) {
    super(`bulkhead_saturado: fila de espera do recurso '${recurso}' cheia (${tamanhoFila}) — rejeicao explicita em vez de espera ilimitada`);
    this.name = 'ErroBulkheadSaturado';
    this.recurso = recurso;
  }
}

export interface BulkheadConfig {
  /** Maximo de execucoes concorrentes por recurso. Default: env SDR_BULKHEAD_LIMITE ou 10. */
  limitePorRecurso?: number;
  /** Cap da fila de espera por recurso (WR-03). Default: env SDR_BULKHEAD_FILA_MAX ou 50. */
  filaEsperaMax?: number;
}

/**
 * Bulkhead POR RECURSO — um semaforo simples com fila de espera (FIFO,
 * BOUNDED — WR-03) particionado por `recurso`. Um pico de concorrencia em
 * 'llm' nao afeta a capacidade disponivel de 'ghl' (isolamento de falha).
 *
 * `adquirir()` E ASSINCRONO: se o pool do recurso estiver cheio, a chamada
 * ESPERA (fila FIFO) ate uma vaga liberar; se a PROPRIA fila estiver no cap
 * (`filaEsperaMax`), rejeita EXPLICITAMENTE com ErroBulkheadSaturado (nunca
 * espera ilimitada, nunca rejeicao silenciosa). O caminho de CRISE
 * (chamarComResiliencia com `crise:true`) NUNCA passa por aqui (bypass
 * total, ver invariante no cabecalho do modulo).
 *
 * WR-03 (corrida de overshoot corrigida): `liberar()` com fila nao-vazia
 * TRANSFERE a vaga diretamente pro proximo da fila SEM decrementar o
 * contador (e o waiter acordado NAO reincrementa). No codigo antigo, o
 * decremento + resolve via microtask abria a janela em que um `adquirir()`
 * concorrente via `usoAtual < limite`, tomava o fast path, e o waiter
 * TAMBEM incrementava — `emUso` excedia o limite configurado.
 */
export class Bulkhead {
  private readonly emUso = new Map<Recurso, number>();
  private readonly filaEspera = new Map<Recurso, Array<() => void>>();
  private readonly limitePorRecurso: number;
  private readonly filaEsperaMax: number;

  constructor(config: BulkheadConfig = {}) {
    this.limitePorRecurso = config.limitePorRecurso ?? BULKHEAD_LIMITE_DEFAULT;
    this.filaEsperaMax = config.filaEsperaMax ?? BULKHEAD_FILA_MAX_DEFAULT;
  }

  private usoAtual(recurso: Recurso): number {
    return this.emUso.get(recurso) ?? 0;
  }

  /**
   * Adquire uma vaga no pool do `recurso`, esperando na fila (bounded) se
   * necessario. Resolve quando a vaga esta garantida; rejeita com
   * ErroBulkheadSaturado se a fila de espera estiver no cap (WR-03).
   */
  async adquirir(recurso: Recurso): Promise<void> {
    if (this.usoAtual(recurso) < this.limitePorRecurso) {
      this.emUso.set(recurso, this.usoAtual(recurso) + 1);
      return;
    }
    const fila = this.filaEspera.get(recurso) ?? [];
    if (fila.length >= this.filaEsperaMax) {
      throw new ErroBulkheadSaturado(recurso, fila.length);
    }
    await new Promise<void>((resolve) => {
      fila.push(resolve);
      this.filaEspera.set(recurso, fila);
    });
    // A vaga foi TRANSFERIDA por liberar() (contador NAO foi decrementado
    // la) — NAO reincrementa aqui. E exatamente isso que fecha a corrida de
    // overshoot do WR-03: nunca existem 2 caminhos incrementando pela mesma
    // vaga liberada.
  }

  /**
   * Libera a vaga do `recurso`. Com fila de espera nao-vazia, TRANSFERE a
   * vaga diretamente pro proximo (handoff — contador inalterado, o waiter
   * nao reincrementa); sem fila, decrementa o contador normalmente.
   */
  liberar(recurso: Recurso): void {
    const fila = this.filaEspera.get(recurso);
    if (fila && fila.length > 0) {
      const proximo = fila.shift()!;
      proximo();
      return;
    }
    this.emUso.set(recurso, Math.max(0, this.usoAtual(recurso) - 1));
  }

  /** Diagnostico: quantas execucoes estao em uso agora pro `recurso` (com o handoff de liberar(), nunca excede o limite configurado). */
  emUsoAtual(recurso: Recurso): number {
    return this.usoAtual(recurso);
  }

  /** Diagnostico (WR-03): tamanho atual da fila de espera do `recurso`. */
  tamanhoFilaEspera(recurso: Recurso): number {
    return this.filaEspera.get(recurso)?.length ?? 0;
  }
}

// ---- Backoff com JITTER (T-05-03-04: thundering herd) ----

const RETRY_BASE_MS_DEFAULT = Number(process.env.SDR_RETRY_BASE_MS) || 1_000;
const RETRY_TETO_MS_DEFAULT = Number(process.env.SDR_RETRY_TETO_MS) || 20_000;

/**
 * Delay de retry com "full jitter": `random() * min(teto, base * 2^(tentativa-1))`.
 * Substitui o backoff LINEAR puro (`tentativa * 2000`) — full jitter
 * dessincroniza retries concorrentes (evita que N clientes retentem todos
 * exatamente no mesmo instante sob falha compartilhada do Azure/GHL).
 * Sempre devolve um inteiro > 0 e <= `tetoMs`.
 */
export function backoffComJitter(
  tentativa: number,
  baseMs: number = RETRY_BASE_MS_DEFAULT,
  tetoMs: number = RETRY_TETO_MS_DEFAULT,
): number {
  const tentativaSegura = Number.isFinite(tentativa) && tentativa > 0 ? tentativa : 1;
  const exponencial = baseMs * Math.pow(2, tentativaSegura - 1);
  const teto = Math.min(tetoMs, exponencial);
  const delay = Math.round(Math.random() * teto);
  // Full jitter classico pode sortear bem perto de 0 — piso minimo de 1ms
  // garante que o delay nunca vira um retry instantaneo (0ms).
  return Math.max(1, delay);
}

// ---- Idempotencia de nivel-chamada ----

const IDEMPOTENCIA_JANELA_MS_DEFAULT = Number(process.env.SDR_IDEMPOTENCIA_JANELA_MS) || 30_000;

interface RegistroIdempotencia {
  promise: Promise<unknown>;
  ts: number;
}

// Registro module-level (estado in-memory compartilhado, mesmo padrao do
// cacheNotificacoes de notificacoes.ts) — a chave e a idempotencyKey inteira
// (ja deve incluir lead+turno, montada pelo caller).
const registrosIdempotencia = new Map<string, RegistroIdempotencia>();

// WR-08 (review Fase 5): idempotencia de DESPACHO. A idempotencia de
// chamada acima garante 1 execucao de `fn` (1 chamada LLM) por chave — mas
// 2 invocacoes CONCORRENTES de processarMensagem com a mesma chave (caso
// real: webhook + buffer-recovery pegando o mesmo turno apos blip de
// container) recebiam a MESMA promise resolvida e AMBAS seguiam pro
// dispatcher: mensagens enviadas 2x, tools_a_executar executadas 2x (double
// create_calendar_event/escalate_to_human). Os EFEITOS vivem no dispatcher,
// fora da regiao guardada — este marcador cobre exatamente essa fronteira:
// so o PRIMEIRO caller que chegar em tentarMarcarDespacho(chave) despacha.
// Sincrono de proposito (sem await entre check e set — atomico no event
// loop, sem janela de corrida). Mesma janela/limpeza da idempotencia de
// chamada.
const despachosMarcados = new Map<string, number>();

/**
 * Marca o despacho do turno identificado por `chave` (mesma idempotencyKey
 * de lead+turno usada na chamada LLM). Retorna `true` se este caller e o
 * PRIMEIRO a despachar (pode prosseguir) e `false` se o turno ja foi
 * despachado dentro da janela (caller deve PULAR o dispatch — outra
 * invocacao concorrente ja enviou as mensagens/executou as tools). Chave
 * vazia nunca bloqueia (fail-open: sem chave nao ha como deduplicar).
 */
export function tentarMarcarDespacho(chave: string): boolean {
  if (!chave) return true;
  const agora = Date.now();
  const ts = despachosMarcados.get(chave);
  if (ts !== undefined && agora - ts <= IDEMPOTENCIA_JANELA_MS_DEFAULT) {
    return false;
  }
  despachosMarcados.set(chave, agora);
  return true;
}

const limpezaIdempotenciaTimer = setInterval(() => {
  const agora = Date.now();
  for (const [chave, registro] of registrosIdempotencia) {
    if (agora - registro.ts > IDEMPOTENCIA_JANELA_MS_DEFAULT) registrosIdempotencia.delete(chave);
  }
  for (const [chave, ts] of despachosMarcados) {
    if (agora - ts > IDEMPOTENCIA_JANELA_MS_DEFAULT) despachosMarcados.delete(chave);
  }
}, 60_000);
if (typeof (limpezaIdempotenciaTimer as unknown as { unref?: () => void }).unref === 'function') {
  (limpezaIdempotenciaTimer as unknown as { unref: () => void }).unref();
}

// ---- Wrapper orquestrador ----

export interface OpcoesChamadaResiliente {
  /** Identificador FIXO do recurso protegido (ex.: 'llm', 'ghl') — nunca vindo de payload externo. */
  recurso: Recurso;
  /** BYPASS DE CRISE (invariante inviolavel, ver cabecalho do modulo). */
  crise?: boolean;
  /** Chave de idempotencia por (lead + turno) — repetida dentro da janela reusa a MESMA promise em vez de re-executar `fn`. */
  idempotencyKey?: string;
  /** Tentativas internas (retry com backoffComJitter entre elas). Default: env SDR_RESILIENCIA_TENTATIVAS ou 1 (sem retry interno — caller decide). */
  tentativas?: number;
  /** Timeout (ms) por tentativa. Default: env SDR_RESILIENCIA_TIMEOUT_MS ou 60s. */
  timeoutMs?: number;
}

const RESILIENCIA_TENTATIVAS_DEFAULT = Number(process.env.SDR_RESILIENCIA_TENTATIVAS) || 1;
const RESILIENCIA_TIMEOUT_MS_DEFAULT = Number(process.env.SDR_RESILIENCIA_TIMEOUT_MS) || 60_000;

// Singletons module-level: 1 unico breaker e 1 unico bulkhead pro processo
// inteiro, cada um particionado INTERNAMENTE por `recurso` — mesmo espirito
// de fila.ts (1 fila global, particionada por prioridade). Exportados pra
// diagnostico/observabilidade (dashboard futuro) e pros smokes inspecionarem
// o estado real usado por `chamarComResiliencia`.
export const breakerPadrao = new CircuitBreaker();
export const bulkheadPadrao = new Bulkhead();

function comTimeoutInterno<T>(promise: Promise<T>, ms: number, recurso: Recurso): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`[resiliencia][timeout] recurso '${recurso}' excedeu ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * Orquestra circuit breaker + bulkhead + retry-com-jitter + idempotencia em
 * torno de `fn`. Ver invariante de CRISE no cabecalho do modulo — com
 * `crise: true`, `fn` e SEMPRE executada (so timeout se aplica), ignorando
 * totalmente o breaker/bulkhead do `recurso`.
 *
 * Fluxo (crise=false): idempotencia (reusa chamada em voo/concluida com a
 * MESMA `idempotencyKey`) -> breaker.permite(recurso) (fast-fail
 * `ErroBreakerAberto` se OPEN) -> bulkhead.adquirir(recurso) (espera se pool
 * cheio) -> tentativas internas com `backoffComJitter` entre elas -> breaker
 * .sucesso/.falha conforme o resultado -> bulkhead.liberar (sempre, no
 * finally).
 */
export async function chamarComResiliencia<T>(
  fn: () => Promise<T>,
  opts: OpcoesChamadaResiliente,
): Promise<T> {
  const {
    recurso,
    crise = false,
    idempotencyKey,
    tentativas = RESILIENCIA_TENTATIVAS_DEFAULT,
    timeoutMs = RESILIENCIA_TIMEOUT_MS_DEFAULT,
  } = opts;

  // Idempotencia: chamada com a MESMA chave dentro da janela reusa a MESMA
  // promise (em voo OU ja concluida) em vez de re-executar `fn` — evita
  // efeito duplicado quando o retry externo (ou um re-disparo de webhook)
  // repete a mesma chave lead+turno.
  if (idempotencyKey) {
    const existente = registrosIdempotencia.get(idempotencyKey);
    if (existente) {
      return existente.promise as Promise<T>;
    }
  }

  const executar = async (): Promise<T> => {
    if (crise) {
      // BYPASS TOTAL (invariante inviolavel) — nunca consulta o breaker nem
      // adquire o bulkhead. So o timeout ainda se aplica (protecao contra
      // travar o processo, nao contra travar a escalacao).
      return comTimeoutInterno(fn(), timeoutMs, recurso);
    }

    if (!breakerPadrao.permite(recurso)) {
      throw new ErroBreakerAberto(recurso);
    }

    await bulkheadPadrao.adquirir(recurso);
    try {
      let ultimoErro: unknown;
      for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
        try {
          const resultado = await comTimeoutInterno(fn(), timeoutMs, recurso);
          breakerPadrao.sucesso(recurso);
          return resultado;
        } catch (erro) {
          ultimoErro = erro;
          breakerPadrao.falha(recurso);
          if (tentativa < tentativas) {
            await new Promise((resolve) => setTimeout(resolve, backoffComJitter(tentativa)));
          }
        }
      }
      throw ultimoErro;
    } finally {
      bulkheadPadrao.liberar(recurso);
    }
  };

  const promise = executar();

  if (idempotencyKey) {
    registrosIdempotencia.set(idempotencyKey, { promise, ts: Date.now() });
    // Falha -> remove o registro imediatamente (retry honesto numa proxima
    // chamada externa com a mesma chave, em vez de travar um erro na janela
    // inteira). Sucesso -> permanece registrado ate a janela expirar.
    promise.catch(() => {
      const atual = registrosIdempotencia.get(idempotencyKey);
      if (atual && atual.promise === promise) registrosIdempotencia.delete(idempotencyKey);
    });
  }

  return promise;
}
