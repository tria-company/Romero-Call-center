// Sanitizacao da resposta do agente antes de enviar pro WhatsApp.
//
// Por que: GPT-4.1 ocasionalmente duplica trechos longos dentro do mesmo
// `text` da resposta (visto em prod 09/05/2026). A instrucao no prompt
// ("UMA frase, uma vez por turno") ajuda mas nao garante. Esse arquivo e
// defesa em profundidade — detecta padroes de duplicacao e remove antes
// do envio, sem depender do LLM cooperar.

const MIN_BLOCO_DUPLICADO = 50;     // chars — abaixo disso ignora (pode ser repeticao legitima)
const MIN_FRASE_DUPLICADA = 30;     // chars — frases curtas podem repetir natural ("entendi.", "saquei.")

/**
 * Detecta e remove duplicacoes literais dentro do texto.
 * Cobre 2 padroes vistos em prod:
 *   1. Texto inteiro duplicado: "abc...xyz abc...xyz" → "abc...xyz"
 *   2. Frases longas repetidas: "...?Você está solteira...?Você está solteira...?"
 *
 * Conservador: so remove duplicatas literais (case-insensitive, normaliza
 * espacos). Nao mexe em variacoes paragrafadas legitimas.
 */
export function removerDuplicacoes(texto: string): string {
  if (!texto || texto.length < MIN_BLOCO_DUPLICADO * 2) return texto;

  // Estrategia 1: o texto inteiro e composto por 2 metades iguais?
  // Ex: "oi, sou a Sofia... casada?oi, sou a Sofia... casada?"
  const halfDedup = removerMetadeDuplicada(texto);
  if (halfDedup !== texto) return halfDedup;

  // Estrategia 2: frases repetidas (split por ponto/interrogacao/exclamacao)
  return removerFrasesRepetidas(texto);
}

function normalizar(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Se as duas metades do texto sao iguais (ou quase), devolve so a primeira.
 * Tolera diferenca pequena de pontuacao/espaco.
 */
function removerMetadeDuplicada(texto: string): string {
  const len = texto.length;
  // Procura ponto de divisao em ~50% — testa de meio pra fora pra pegar
  // duplicacao mesmo que tenha pequeno trim no meio.
  const meio = Math.floor(len / 2);
  for (let offset = 0; offset < 20; offset++) {
    for (const split of [meio + offset, meio - offset]) {
      if (split < MIN_BLOCO_DUPLICADO || split >= len - MIN_BLOCO_DUPLICADO) continue;
      const primeira = texto.slice(0, split);
      const segunda = texto.slice(split);
      const primeiraNorm = normalizar(primeira);
      const segundaNorm = normalizar(segunda);
      if (primeiraNorm.length >= MIN_BLOCO_DUPLICADO && primeiraNorm === segundaNorm) {
        console.log(`[sanitize] Texto duplicado em 2 metades, removendo segunda (${segunda.length} chars)`);
        return primeira.trimEnd();
      }
    }
  }
  return texto;
}

/**
 * Remove frases longas que aparecem 2+ vezes literais.
 * Quebra por ponto/interrogacao/exclamacao mantendo a pontuacao.
 */
function removerFrasesRepetidas(texto: string): string {
  // Split mantendo o delimitador (lookbehind)
  const frases = texto.split(/(?<=[.?!])(?=\s|[A-Za-zÀ-ÿ])/);
  if (frases.length < 4) return texto;

  const vistas = new Set<string>();
  const resultado: string[] = [];
  let removeu = false;

  for (const f of frases) {
    const norm = normalizar(f);
    if (norm.length >= MIN_FRASE_DUPLICADA && vistas.has(norm)) {
      console.log(`[sanitize] Frase repetida removida: "${f.slice(0, 60).trim()}..."`);
      removeu = true;
      continue;
    }
    vistas.add(norm);
    resultado.push(f);
  }

  if (!removeu) return texto;
  return resultado.join('').trim();
}
