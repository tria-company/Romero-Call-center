// HARD-02 (Fase 5, plano 05-05): OUTPUT GUARDRAILS deterministicos e locais —
// a ultima camada antes de qualquer mensagem da Camila chegar ao WhatsApp do
// lead. Tres checagens, nesta ordem de defesa:
//
//   (1) SCHEMA — validarSchema consolida (nao reinventa) o parse fail-closed
//       ja existente em camila-schema.ts (parseSaidaCamila, T-05-JSON): JSON
//       malformado ou fora do shape nunca vira ok:true.
//   (2) PII — scrubPII redige (via redigirPII de anonimizacao.ts) PII
//       ESTRUTURADO (CPF/CNPJ/RG/telefone/email/CEP) e nome de paciente com
//       marcador explicito ('paciente <Nome>') que vazaria na mensagem
//       enviada ao lead. WR-02: o blocklist clinico amplo da transcricao
//       NAO se aplica ao canal outbound (ver redigirPII).
//   (3) FATOS-AUTORIZADOS (anti-alucinacao) — checarFatosAutorizados espelha
//       deterministicamente as Boundaries 1-6 do Safety Envelope da Camila
//       (agents/camila.ts): preco/prazo/bonus/garantia inventados, %/
//       estatistica de marketing, prazo de resultado clinico, concorrente
//       nominal. Nenhuma dessas checagens chama LLM/Azure — elimina na raiz
//       o 400/responsibleAIPolicyViolation do content filter que aposentou
//       os processors LLM-based (systemPromptScrubber, ver processors.ts).
//
// POLITICA DE ACAO: uma violacao de PII e sempre REDIGIDA (nunca bloqueia a
// mensagem inteira — o resto do texto e legitimo). Uma violacao de FATO
// prefere SUPRIMIR o trecho (nao enviar a promessa/estatistica inventada) a
// deixar passar; se a violacao for GRAVE (prazo de resultado clinico ou
// garantia/bonus inventados — dano de compliance clinico direto, mesmo
// espirito do Behavioral Gradient "Alto Risco" do playbook), a acao sinaliza
// 'escalar' pra handoff humano em vez de so 'suprimir' o trecho e seguir o
// turno. Schema invalido nunca envia nada (fail-closed, ja o contrato
// T-05-JSON existente).
//
// MODULO PURO: so importa camila-schema.ts (parseSaidaCamila) e
// anonimizacao.ts (redigirPII) — NENHUM import de config/azure-client/index.
// Sem I/O, sem chamada de rede, sem estado de modulo. Importado direto via
// `node --experimental-strip-types` pelo smoke (scripts/smoke-guardrail-saida.mjs),
// mesmo padrao de guardrails/injecao.ts / fallback.ts. Import com extensao
// `.ts` explicita (mesma razao documentada em fallback.ts, 05-04-SUMMARY.md:
// o loader ESM nativo do Node nao resolve extensionless; `npm run
// build`/esbuild tolera a extensao explicita sem erro).
//
// FAIL-SAFE: nenhuma funcao aqui lanca. scrubPII/checarFatosAutorizados
// devolvem um resultado seguro em caso de excecao interna (documentado em
// cada funcao) — um bug NESTE guardrail nao pode nem vazar PII pra frente
// (fail-open no scrub seria pior) nem travar o turno inteiro.

import { parseSaidaCamila, type SaidaCamila } from '../camila-schema.ts';
import { redigirPII } from '../anonimizacao.ts';

// ---------------------------------------------------------------------
// (1) SCHEMA
// ---------------------------------------------------------------------

export interface ResultadoValidacaoSchema {
  seguro: boolean;
  data?: SaidaCamila;
  erro?: string;
}

/**
 * Camada explicita de validacao de schema — fino wrapper de
 * `parseSaidaCamila` (camila-schema.ts). NAO reinventa a validacao: so
 * traduz o resultado `{ok}` do parser pro formato `{seguro}` consistente com
 * as outras 2 checagens deste modulo, pra `avaliarSaida` orquestrar as 3 sob
 * o mesmo shape. Schema invalido => seguro:false (nunca envia, T-05-JSON).
 */
export function validarSchema(raw: string): ResultadoValidacaoSchema {
  const resultado = parseSaidaCamila(raw);
  if (!resultado.ok) {
    return { seguro: false, erro: resultado.erro };
  }
  return { seguro: true, data: resultado.data };
}

// ---------------------------------------------------------------------
// (2) PII SCRUBBER
// ---------------------------------------------------------------------

export interface ResultadoScrubPII {
  texto: string;
  redacoes: number;
}

/**
 * Redige PII ESTRUTURADO (CPF/CNPJ/RG/telefone/email/CEP) e nome de paciente
 * por contexto explicito ('paciente <Nome>') de uma mensagem ANTES do envio
 * ao lead — delega a `redigirPII` (anonimizacao.ts). WR-02 (review Fase 5):
 * o blocklist clinico amplo da TRANSCRICAO (anonimizarTranscricao) NAO se
 * aplica ao canal outbound — vocabulario clinico e legitimo numa conversa de
 * venda com profissional de saude, e o garble inline ("[CLINICO]") corrompia
 * mensagens legitimas (ver docstring de redigirPII).
 *
 * Diferenca deliberada de fail-direction vs. `anonimizarTranscricao`: aquela
 * funcao e fail-CLOSED (persistencia de transcricao — perder o dado e
 * preferivel a persistir PII bruto). Este scrubber e fail-OPEN em erro
 * interno (praticamente impossivel — regex puro sobre string): devolve o
 * texto ORIGINAL intacto em vez de esvaziar a mensagem, porque silenciar um
 * lead legitimo por um bug de scrub tambem viola o core value do SDR (a
 * call precisa ser agendada). Nunca loga o texto de entrada/saida (LGPD).
 */
export function scrubPII(texto: string): ResultadoScrubPII {
  if (typeof texto !== 'string') {
    return { texto: '', redacoes: 0 };
  }
  try {
    const resultado = redigirPII(texto);
    return { texto: resultado.textoAnon, redacoes: resultado.redacoes };
  } catch {
    return { texto, redacoes: 0 };
  }
}

// ---------------------------------------------------------------------
// (3) FATOS-AUTORIZADOS (anti-alucinacao deterministica)
// ---------------------------------------------------------------------

export interface ResultadoChecagemFatos {
  seguro: boolean;
  violacoes: string[];
}

// preco inventado: "R$ 497", "custa X", "por apenas X", "X reais/BRL".
//
// WR-01 (review Fase 5): a Camila PODE citar os precos AUTORIZADOS pelo
// proprio system prompt (Hallucination Defense, agents/camila.ts: "Planos:
// Starter R$ 797 / Pro R$ 1.497"; Behavioral Gradient "Medio risco": falar
// de plano/preco SO se o lead perguntar direto). O guardrail deterministico
// nao pode contradizer o prompt canonico e suprimir a resposta legitima a
// "quanto custa?" — as mencoes AUTORIZADAS sao removidas do texto ANTES de
// testar o padrao de preco inventado (o marcador de substituicao NAO contem
// digitos, pra nao re-casar em `custa ... \d`). Qualquer OUTRO valor
// numerico de preco continua sendo, por definicao, invencao.
const PRECOS_AUTORIZADOS_REGEX =
  /R\$\s?797\b|R\$\s?1\.?497\b|\b797\s*(?:reais|BRL)\b|\b1\.?497\s*(?:reais|BRL)\b/gi;
const PRECO_REGEX = /R\$\s?\d|\b\d+(?:[.,]\d+)?\s*(?:reais|BRL)\b|\bcusta(?:m)?\b[\s\S]{0,20}?\d|\bpor apenas\b[\s\S]{0,25}?\d/i;

// percentual/estatistica de marketing em contexto de resultado/cliente
// (Example "Cita Estatistica" do prompt: "83% dos nossos clientes..." e
// BAD). Contexto evita falso-positivo de numero solto sem % (horario/data).
const PERCENTUAL_REGEX =
  /\b\d{1,3}\s?%\s*(?:dos?|das?|de)?\s*(?:nossos?|nossas?)?\s*(?:clientes?|pacientes?|alunos?|pessoas?|profissionais?|resultados?)\b|\b\d{1,3}\s+por\s+cento\b/i;

// prazo de resultado clinico (Boundary 3: "nunca prometa prazo de resultado
// clinico") — "cura/resultado/melhora" proximo de "em N dias/semanas/meses",
// nas duas ordens de palavra.
const PRAZO_CLINICO_REGEX =
  /\b(?:cura\w*|resultados?|melhor\w*)\b[\s\S]{0,25}?\bem\s+\d+\s*(?:dias?|semanas?|meses)\b|\bem\s+\d+\s*(?:dias?|semanas?|meses)\b[\s\S]{0,25}?\b(?:cura\w*|resultados?|melhor\w*)\b/i;

// garantia/bonus inventados (Boundary 1: "nunca invente ... bonus, garantia
// nao confirmada").
//
// WR-01 (review Fase 5): o padrao antigo casava `garantid[ao]` SOLTO, o que
// disparava violacao GRAVE (escalate + IA pausada) para fraseados legitimos
// de fatos AUTORIZADOS ("a migracao e garantida pela equipe em 48h",
// "Garantia: 7 dias" — ambos na lista fechada da Hallucination Defense). O
// padrao agora e restrito a GARANTIA DE RESULTADO (a promessa proibida de
// verdade: "garantia de resultado", "resultado/cura/melhora garantid[ao]")
// + bonus exclusivo inventado.
const GARANTIA_BONUS_REGEX =
  /\bgarantia\s+de\s+resultado\b|\b(?:resultado|cura|melhora)s?\s+(?:(?:e|é|esta|está|sera|será|fica)\s+)?garantid[ao]s?\b|\bgarant(?:o|imos)\s+(?:o\s+)?resultado\b|\bb[oô]nus\s+exclusivo\b/i;

// Lista-PISO de concorrentes nominais conhecidos (Boundary 6: "nunca opine
// sobre concorrente nominal"). O playbook (notes/playbook-sdr-auton.md §2.2)
// cita uma "lista fechada de 12 marcas" que NAO esta enumerada em nenhum doc
// do repo ate este plano — mesmo espirito do placeholder
// ICP_PROFISSOES_STEMS (bant.ts): lista inicial razoavel de players de
// apoio-a-decisao-clinica/educacao medica no Brasil, AJUSTAVEL pelo time
// comercial/produto quando a lista oficial for confirmada. NAO e exaustiva.
export const CONCORRENTES_CONHECIDOS_STEMS = [
  'whitebook',
  'pebmed',
  'uptodate',
  'sanarflix',
  'medcurso',
] as const;

const CONCORRENTE_REGEX = new RegExp(`\\b(?:${CONCORRENTES_CONHECIDOS_STEMS.join('|')})\\w*`, 'i');

// Violacoes GRAVES o suficiente pra preferir ESCALAR (handoff humano) em vez
// de so suprimir o trecho e seguir o turno normalmente — prazo de cura
// clinica e garantia/bonus inventados sao promessas que, se vazassem,
// configuram dano de compliance direto (falsa expectativa
// terapeutica/comercial), mesmo espirito do Behavioral Gradient "Alto Risco"
// do playbook (escalar, nao so contornar).
export const VIOLACOES_GRAVES: ReadonlySet<string> = new Set(['prazo_clinico', 'garantia_bonus']);

/**
 * Checagem DETERMINISTICA (regex, sem LLM) dos padroes de invencao proibidos
 * pelo Safety Envelope da Camila (Boundaries 1-6, agents/camila.ts). Espelha
 * — nao reimplementa — a lista canonica do prompt: preco, percentual/
 * estatistica de marketing, prazo de resultado clinico, garantia/bonus
 * inventados, concorrente nominal.
 *
 * Usa fronteira de palavra (`\b`) e contexto (proximidade de keyword) em
 * TODOS os padroes pra evitar falso-positivo classico: horario ("as 15h"),
 * data, duracao de call ("45min de call") NAO sao preco/%/prazo-clinico —
 * ver T-05-05-04 (DoS por falso-positivo) no threat model do plano.
 *
 * Fail-safe: qualquer excecao interna (praticamente impossivel — regex
 * estatico sobre string) devolve seguro:true/violacoes:[] — um bug NESTE
 * guardrail nao pode suprimir uma mensagem legitima do lead.
 */
export function checarFatosAutorizados(texto: string): ResultadoChecagemFatos {
  if (typeof texto !== 'string' || texto.trim().length === 0) {
    return { seguro: true, violacoes: [] };
  }

  try {
    const violacoes: string[] = [];
    // WR-01: remove as mencoes de preco AUTORIZADAS (Starter R$ 797 / Pro
    // R$ 1.497 — fatos oficiais do prompt) antes de testar preco inventado.
    // O marcador nao contem digitos de proposito (nao re-casa em PRECO_REGEX).
    const textoSemPrecosAutorizados = texto.replace(PRECOS_AUTORIZADOS_REGEX, '[PRECO-AUTORIZADO]');
    if (PRECO_REGEX.test(textoSemPrecosAutorizados)) violacoes.push('preco');
    if (PERCENTUAL_REGEX.test(texto)) violacoes.push('percentual');
    if (PRAZO_CLINICO_REGEX.test(texto)) violacoes.push('prazo_clinico');
    if (GARANTIA_BONUS_REGEX.test(texto)) violacoes.push('garantia_bonus');
    if (CONCORRENTE_REGEX.test(texto)) violacoes.push('concorrente_nominal');

    return { seguro: violacoes.length === 0, violacoes };
  } catch {
    return { seguro: true, violacoes: [] };
  }
}

// ---------------------------------------------------------------------
// ORQUESTRACAO: avaliarSaida
// ---------------------------------------------------------------------

export interface ResultadoAvaliacaoSaida {
  seguro: boolean;
  envia: boolean;
  mensagensScrubbed: string[];
  violacoes: string[];
  acao: 'enviar' | 'suprimir' | 'escalar';
}

/**
 * Orquestra as 3 camadas sobre o texto BRUTO devolvido pelo LLM: (1) schema
 * — invalido nunca envia (T-05-JSON, fail-closed, ja o contrato existente);
 * (2) PII — cada mensagem[] passa por scrubPII antes de qualquer outra
 * checagem; (3) fatos-autorizados — roda sobre o texto JA scrubado; uma
 * mensagem com violacao de fato e SUPRIMIDA (nao entra em
 * `mensagensScrubbed`) em vez de enviada crua. `acao` reflete a pior
 * violacao encontrada: 'escalar' se alguma violacao for GRAVE
 * (VIOLACOES_GRAVES), 'suprimir' se houver violacao nao-grave, 'enviar' se
 * nao houve nenhuma.
 *
 * Nota de uso: o dispatcher (index.ts, despacharSaidaCamila) tambem pode
 * aplicar `scrubPII`/`checarFatosAutorizados` mensagem-a-mensagem
 * diretamente (preserva o indice de `delay_ms[]` 1:1) — `avaliarSaida` fica
 * disponivel como orquestracao de conveniencia/teste de ponta-a-ponta (ver
 * smoke) e para qualquer chamador futuro que so precise do resultado
 * agregado.
 */
export function avaliarSaida(raw: string): ResultadoAvaliacaoSaida {
  const schema = validarSchema(raw);
  if (!schema.seguro || !schema.data) {
    return { seguro: false, envia: false, mensagensScrubbed: [], violacoes: ['schema_invalido'], acao: 'suprimir' };
  }

  const mensagensScrubbed: string[] = [];
  const violacoesTotais: string[] = [];
  const vistas = new Set<string>();

  for (const mensagemOriginal of schema.data.mensagens) {
    const { texto: mensagemScrubada } = scrubPII(mensagemOriginal);
    const { seguro: mensagemSegura, violacoes } = checarFatosAutorizados(mensagemScrubada);

    for (const v of violacoes) {
      if (!vistas.has(v)) {
        vistas.add(v);
        violacoesTotais.push(v);
      }
    }

    // Violacao de fato: SUPRIME o trecho (nao adiciona a mensagensScrubbed)
    // — prefere nao enviar a promessa/estatistica inventada a arriscar.
    if (mensagemSegura) {
      mensagensScrubbed.push(mensagemScrubada);
    }
  }

  if (violacoesTotais.length === 0) {
    return { seguro: true, envia: mensagensScrubbed.length > 0, mensagensScrubbed, violacoes: [], acao: 'enviar' };
  }

  const grave = violacoesTotais.some((v) => VIOLACOES_GRAVES.has(v));
  return {
    seguro: false,
    envia: mensagensScrubbed.length > 0,
    mensagensScrubbed,
    violacoes: violacoesTotais,
    acao: grave ? 'escalar' : 'suprimir',
  };
}
