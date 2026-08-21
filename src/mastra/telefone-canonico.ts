// telefone-canonico.ts — ÚNICA fonte de normalização de telefone da inversão
// Supabase-fonte-da-verdade (Fase B, .planning/phases/
// 19-fase-b-inverter-ligacoes-escrita-leitura-juntas/19-CONTEXT.md decisão
// 14, design §5.3, Riscos R4).
//
// A escrita (espelho.ts, e as RPCs/rotas que gravam `ligacoes` a partir do
// 19-02), a correlação do webhook (19-05) e a criação de avulsa/lote
// (19-07..19-09) usam a MESMA `canonizarTelefone`/`variantesTelefone` — senão
// 12 e 13 dígitos do MESMO número não casariam a mesma ligação (a query de
// correlação multi-candidato é `telefone_canonico = $canon OR
// telefone_variantes && $candidatos`, design §4/§5.3).
//
// MÓDULO SELF-CONTAINED (folha): NÃO importa clickup.ts nem espelho.ts —
// preserva testabilidade standalone via `node --experimental-strip-types`,
// mesmo racional já documentado nas cópias privadas de `semNonoDigito`/
// `normalizarTelefoneE164` em clickup.ts, espelho.ts e estado-webhook.ts (par
// pequeno demais pra justificar acoplar módulos por uma função de poucas
// linhas). A duplicação aqui é DELIBERADA e VIRA a fonte única a partir desta
// fase — espelho.ts é refatorado para IMPORTAR daqui (ver comentário lá).
//
// LGPD: funções PURAS (sem I/O, sem log) — telefone NUNCA é impresso.

/** Remove o nono dígito (prefixo móvel BR) quando presente — mesma lógica de
 *  clickup.ts::semNonoDigito / espelho.ts::semNonoDigito / estado-webhook.ts
 *  (duplicada de propósito, ver header do módulo). Unifica 12↔13 e 10↔11
 *  dígitos ANTES do E.164, pra 2 formatos do MESMO número produzirem o MESMO
 *  telefone_canonico (§5.3). */
function semNonoDigito(digitos: string): string {
  if (digitos.length === 13 && digitos.startsWith('55') && digitos[4] === '9') {
    return digitos.slice(0, 4) + digitos.slice(5);
  }
  if (digitos.length === 11 && digitos[2] === '9') {
    return digitos.slice(0, 2) + digitos.slice(3);
  }
  return digitos;
}

/** Normaliza um telefone cru (já sem o 9º dígito) para E.164 — mesma lógica
 *  de clickup.ts::normalizarTelefoneE164 (duplicada de propósito). BR local
 *  (10/11 díg) ganha prefixo '55'; formas já com DDI (12+ díg) não são
 *  re-prefixadas. Fora da faixa 12-15 dígitos não é E.164 plausível -> null
 *  (o caller trata como "não normalizável", nunca lança). */
function normalizarTelefoneE164(digitos: string): string | null {
  if (!digitos) return null;
  const comDDI = digitos.length === 10 || digitos.length === 11 ? `55${digitos}` : digitos;
  if (comDDI.length < 12 || comDDI.length > 15) return null;
  return `+${comDDI}`;
}

/** Limpa a entrada crua (sufixo '@...' do Wavoip + qualquer não-dígito —
 *  '+', espaços, parênteses, hífen) antes de qualquer normalização. */
function apenasDigitos(raw: string): string {
  return String(raw ?? '')
    .split('@')[0]
    .replace(/\D/g, '');
}

/**
 * `telefone_canonico` = E.164 PÓS-normalização do 9º dígito (design §2.1) —
 * a MESMA forma que espelho.ts já gravou na Fase A. Determinístico: a mesma
 * entrada sempre produz a mesma saída. NUNCA lança — entrada vazia ou
 * não-normalizável devolve `null` (resultado legítimo, não erro).
 *
 * Prova obrigatória (R4): `canonizarTelefone('5581987654321')` (13 díg) ===
 * `canonizarTelefone('558187654321')` (12 díg) — ver
 * scripts/telefone-canonico.smoke.mjs.
 */
export function canonizarTelefone(raw: string | null | undefined): string | null {
  const digitos = semNonoDigito(apenasDigitos(String(raw ?? '')));
  return normalizarTelefoneE164(digitos);
}

/**
 * Conjunto de candidatos ±9º dígito (E.164, com '+') pra correlação
 * multi-candidato (§5.3, Riscos R4) — mesma estratégia já usada em
 * clickup.ts::criarLigacaoAvulsa (candidatos com/sem o 9 antes de consultar a
 * Lista 01): a forma "como veio" (após limpeza) + a forma com o 9 inserido
 * (quando a entrada tem 12 dígitos, sem o 9) + a forma sem o 9 (quando a
 * entrada tem 13 dígitos com o 9 no índice esperado). NUNCA lança — entrada
 * vazia ou não normalizável devolve `[]`.
 *
 * Determinístico (mesmo conjunto sempre para a mesma entrada); o array pode
 * ter 1 ou 2 elementos, nunca duplicados (Set).
 */
export function variantesTelefone(raw: string | null | undefined): string[] {
  const digitos = apenasDigitos(String(raw ?? ''));
  if (!digitos) return [];
  const comPais = digitos.length >= 12 ? digitos : `55${digitos}`;
  const candidatos = new Set<string>([`+${comPais}`]);
  if (comPais.length === 12) {
    candidatos.add(`+${comPais.slice(0, 4)}9${comPais.slice(4)}`);
  }
  if (comPais.length === 13 && comPais[4] === '9') {
    candidatos.add(`+${comPais.slice(0, 4)}${comPais.slice(5)}`);
  }
  return Array.from(candidatos);
}
