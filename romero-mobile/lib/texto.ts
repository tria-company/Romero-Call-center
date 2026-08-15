/* Normalização de texto — usada por busca de leads e pelo assistente.
   O range ̀-ͯ é o bloco de marcas diacríticas combinantes; depois de
   NFD, remover esse bloco é o que transforma "castração" em "castracao". */

export const semAcento = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

export const soDigitos = (s: string): string => s.replace(/\D/g, "");

/** Tokens alfanuméricos, sem acento e sem pontuação. */
export const tokens = (s: string): string[] =>
  semAcento(s)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Distância de Levenshtein com teto — para casar nomes digitados errado. */
export function levenshtein(a: string, b: string, teto = 4): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > teto) return teto + 1;
  const anterior = new Array<number>(b.length + 1);
  const atual = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) anterior[j] = j;
  for (let i = 1; i <= a.length; i++) {
    atual[0] = i;
    let melhorLinha = atual[0];
    for (let j = 1; j <= b.length; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      atual[j] = Math.min(atual[j - 1] + 1, anterior[j] + 1, anterior[j - 1] + custo);
      if (atual[j] < melhorLinha) melhorLinha = atual[j];
    }
    if (melhorLinha > teto) return teto + 1;
    for (let j = 0; j <= b.length; j++) anterior[j] = atual[j];
  }
  return anterior[b.length];
}

/** Junta com vírgulas e "e" no fim: ["a","b","c"] → "a, b e c". */
export function listar(itens: string[]): string {
  if (itens.length === 0) return "";
  if (itens.length === 1) return itens[0];
  return `${itens.slice(0, -1).join(", ")} e ${itens[itens.length - 1]}`;
}

export const plural = (n: number, um: string, muitos: string): string =>
  n === 1 ? um : muitos;
