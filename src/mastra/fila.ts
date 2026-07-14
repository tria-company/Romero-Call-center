// Rate limit + fila com prioridade in-memory na entrada do webhook de
// mensagens (HARD-03). Modulo hand-rolled, SEM Redis/lib nova (zero
// dependencia npm adicional) — token bucket simples + 2 filas (crise/normal)
// no mesmo espirito de cache in-memory + setInterval de notificacoes.ts.
//
// INVARIANTE INVIOLAVEL DO PROJETO (CLAUDE.md: core value = agendar a call;
// "se tudo mais falhar, o agendamento da call qualificada tem que
// funcionar"): uma mensagem classificada como CRISE (sofrimento agudo, ou
// lead ja em bloqueio duravel de crise) NUNCA e rate-limited, NUNCA e
// enfileirada atras de trafego normal, e NUNCA e shedada/descartada. O
// protocolo de crise tem prioridade maxima e caminho direto (fail-safe na
// direcao do humano) — isso vale mesmo com o token bucket zerado ou a fila
// de NORMAL cheia.
//
// O que este modulo NAO faz: nao substitui o buffer/debounce de 10s
// existente (buffer.ts) — a admissao roda ANTES dele, na entrada do
// webhook, como um controle de "posso aceitar esta mensagem agora?". A
// mensagem admitida via fila (motivo='rate_limited_enfileirado') segue
// normalmente pro caminho de processamento de sempre; a fila aqui so limita
// QUANTAS mensagens NORMAL podem estar "em transito" simultaneamente sob
// rate limit, devolvendo um sinal EXPLICITO de overload (nunca perda
// silenciosa) quando essa capacidade estoura.

/** 0 = CRISE (prioridade maxima, inviolavel). 1 = NORMAL. */
export type Prioridade = 0 | 1;
export const PRIORIDADE_CRISE: Prioridade = 0;
export const PRIORIDADE_NORMAL: Prioridade = 1;

// Lexico de sofrimento agudo — deteccao PROPRIA deste modulo (nao reusa o
// guardrail de injection; sao dominios diferentes). Fronteira de palavra
// (\b) e frases completas evitam falso-positivo por substring solta (mesma
// licao do LEXICO_PROIBIDO_REGEX da Fase 1 — WR-01, bant.ts).
const LEXICO_CRISE_REGEX =
  /\b(n[ãa]o\s+aguento\s+mais|quero\s+morrer|vou\s+me\s+matar|me\s+matar|vou\s+sumir\s+de\s+vez|sumir\s+de\s+vez|acabar\s+com\s+(a\s+)?minha\s+vida|tirar\s+(a\s+)?minha\s+vida|n[ãa]o\s+quero\s+mais\s+viver)\b/i;

/**
 * Classifica a prioridade de uma mensagem. CRISE (0) quando: (a) o texto
 * casa o lexico de sofrimento agudo, OU (b) o predicado `leadEmCrise`
 * injetado (no wiring real, um wrapper da leitura duravel ja existente —
 * estaBloqueado/buscarConversaAguardandoHumano) indica que o numero ja esta
 * em bloqueio/pausa de crise. Recebe o predicado por injecao (nao importa
 * bloqueio.ts/supabase.ts direto) pra este modulo continuar puro e
 * smoke-avel sem I/O. Nunca lanca — qualquer erro no predicado injetado
 * degrada pra NORMAL (nao pra CRISE), mas o lexico local continua valendo
 * como rede de seguranca independente do predicado.
 */
export function classificarPrioridade(
  numero: string,
  texto: string,
  leadEmCrise?: (numero: string) => boolean,
): Prioridade {
  const textoSeguro = typeof texto === 'string' ? texto : '';

  if (LEXICO_CRISE_REGEX.test(textoSeguro)) {
    return PRIORIDADE_CRISE;
  }

  if (typeof leadEmCrise === 'function') {
    try {
      if (leadEmCrise(numero)) return PRIORIDADE_CRISE;
    } catch (e) {
      console.error('[fila] erro no predicado leadEmCrise, degradando pra NORMAL:', e);
    }
  }

  return PRIORIDADE_NORMAL;
}

/**
 * Fila com 2 niveis (CRISE e NORMAL). `proximo()` sempre drena TODOS os
 * itens CRISE antes de qualquer NORMAL, independente da ordem de chegada —
 * a mecanica que garante que crise nunca fica presa atras de flood normal.
 */
export class FilaPrioridade<T = unknown> {
  private filaCrise: T[] = [];
  private filaNormal: T[] = [];

  enfileirar(item: T, prioridade: Prioridade): void {
    if (prioridade === PRIORIDADE_CRISE) {
      this.filaCrise.push(item);
    } else {
      this.filaNormal.push(item);
    }
  }

  /** Remove e devolve o proximo item (CRISE antes de NORMAL). undefined se vazia. */
  proximo(): T | undefined {
    if (this.filaCrise.length > 0) return this.filaCrise.shift();
    return this.filaNormal.shift();
  }

  get tamanhoCrise(): number {
    return this.filaCrise.length;
  }

  get tamanhoNormal(): number {
    return this.filaNormal.length;
  }
}

// --- Rate limit (token bucket) + fila global de admissao ---
//
// Capacidade/janela configuraveis por env com default seguro (60 msg/min),
// mesmo padrao de env-com-default de config.ts — SEM instanciar nada de
// config.ts aqui (este modulo continua puro/sem side-effect de import).
//
// WR-04 (review Fase 5): validacao explicita dos tunables — `Number(x) ||
// default` engolia silenciosamente um valor invalido/zero explicito. envNum
// avisa (1x, no load) quando o env esta presente mas nao e um numero finito
// positivo, em vez de substituir mudo pelo default.
function envNum(nome: string, def: number): number {
  const bruto = process.env[nome];
  if (bruto === undefined || bruto === '') return def;
  const n = Number(bruto);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[fila] env ${nome}="${bruto}" invalido (esperado numero finito > 0) — usando default ${def}`);
    return def;
  }
  return n;
}

const RATE_LIMIT_CAPACIDADE = envNum('SDR_RATE_LIMIT_CAPACIDADE', 60);
const RATE_LIMIT_JANELA_MS = envNum('SDR_RATE_LIMIT_JANELA_MS', 60_000); // 1 min
// Capacidade da fila bounded de NORMAL — acima disso, shed explicito
// (overload) em vez de crescer sem limite (T-05-01-03).
//
// WR-04: limites REALISTAS. A "fila" e um contador de admissoes-em-transito
// drenado por timer (a mensagem admitida segue imediatamente pro buffer/
// LLM), entao o teto real de vazao pro processamento antes do 1o shed e
// aproximadamente: capacidade do bucket + cap_da_fila * (60s / drenagem).
// Com os defaults antigos (200 / 15s) isso dava ~860 msg/min — o bucket nao
// protegia nada downstream. Defaults novos: cap 50 + drenagem 30s =>
// ~60 + 50*2 = ~160 msg/min no pior caso antes do shed explicito — coerente
// com 1 container + bulkhead('llm')=10 (resiliencia.ts). Amarrar a drenagem
// a conclusao REAL de processarMensagem nao e 1:1 aqui por design: o buffer
// de 10s MESCLA varias admissoes num unico processamento (buffer.ts), entao
// o timer continua sendo a aproximacao documentada — ajustar
// SDR_FILA_DRENAGEM_MS se a latencia media observada de processamento mudar.
const FILA_NORMAL_CAPACIDADE_MAX = envNum('SDR_FILA_NORMAL_CAPACIDADE_MAX', 50);
// Tempo que uma entrada "enfileirada por rate limit" fica contando contra a
// capacidade da fila antes de ser considerada drenada. A MENSAGEM em si
// segue pro processamento normal imediatamente (nunca fica de fato parada
// esperando aqui) — esta fila e so um contador de "quantas admissoes por
// fila estao em transito agora", pra dar sinal de overload explicito sob
// carga sustentada em vez de deixar crescer sem limite.
const TEMPO_EM_FILA_MS = envNum('SDR_FILA_DRENAGEM_MS', 30_000);

let tokensDisponiveis = RATE_LIMIT_CAPACIDADE;

// Refill periodico do token bucket (mesmo estilo de setInterval de cleanup
// de notificacoes.ts). WR-04: unref() — um import direto deste modulo (ex.:
// smoke) nao pode manter o processo vivo so por causa do timer (mesmo
// cuidado ja aplicado em cache-semantico.ts/resiliencia.ts).
const refillTimer = setInterval(() => {
  tokensDisponiveis = RATE_LIMIT_CAPACIDADE;
}, RATE_LIMIT_JANELA_MS);
if (typeof (refillTimer as unknown as { unref?: () => void }).unref === 'function') {
  (refillTimer as unknown as { unref: () => void }).unref();
}

const filaGlobal = new FilaPrioridade<{ criadoEm: number }>();

export type MotivoAdmissao = 'ok' | 'rate_limited_enfileirado' | 'overload';

/**
 * Decide se uma mensagem de prioridade `prioridade` pode ser admitida agora.
 *
 * REGRAS INVIOLAVEIS:
 * - CRISE (0): SEMPRE `{ admitido: true }`, sem consumir token e sem checar
 *   capacidade da fila — fail-safe na direcao do humano, nunca bloqueado.
 * - NORMAL (1): consome 1 token do bucket se disponivel
 *   (`{ admitido: true, motivo: 'ok' }`); se sem token, tenta enfileirar
 *   (nao perde) ate `FILA_NORMAL_CAPACIDADE_MAX`
 *   (`{ admitido: true, motivo: 'rate_limited_enfileirado' }`); se a fila
 *   tambem estiver cheia, `{ admitido: false, motivo: 'overload' }` — shed
 *   EXPLICITO (o caller decide handoff/aviso ao suporte), nunca perda
 *   silenciosa.
 */
export function admitir(prioridade: Prioridade): { admitido: boolean; motivo?: MotivoAdmissao } {
  if (prioridade === PRIORIDADE_CRISE) {
    return { admitido: true, motivo: 'ok' };
  }

  if (tokensDisponiveis > 0) {
    tokensDisponiveis -= 1;
    return { admitido: true, motivo: 'ok' };
  }

  if (filaGlobal.tamanhoNormal >= FILA_NORMAL_CAPACIDADE_MAX) {
    return { admitido: false, motivo: 'overload' };
  }

  const item = { criadoEm: Date.now() };
  filaGlobal.enfileirar(item, PRIORIDADE_NORMAL);
  const drenagemTimer = setTimeout(() => {
    // Libera a capacidade contada apos o tempo estimado de "transito" — a
    // mensagem real ja seguiu pro processamento no momento da admissao.
    filaGlobal.proximo();
  }, TEMPO_EM_FILA_MS);
  // WR-04: timers de drenagem tambem nao seguram o processo vivo.
  if (typeof (drenagemTimer as unknown as { unref?: () => void }).unref === 'function') {
    (drenagemTimer as unknown as { unref: () => void }).unref();
  }

  return { admitido: true, motivo: 'rate_limited_enfileirado' };
}

/** So pra diagnostico/observabilidade (dashboard futuro) — nao usado no smoke. */
export function estadoFila(): { tokensDisponiveis: number; tamanhoFilaNormal: number } {
  return { tokensDisponiveis, tamanhoFilaNormal: filaGlobal.tamanhoNormal };
}
