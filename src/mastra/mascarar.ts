// Mascaramento de PII — fonte única (Fase 10, OBS-03, D-09/D-10).
//
// Antes desta fase, mascararTelefone estava duplicada em 6 lugares (2 in-app
// TS + 4 scripts) com 3 variantes ligeiramente diferentes, e CPF não tinha
// máscara nenhuma. Este módulo é a ÚNICA definição de máscara de telefone e
// de CPF no repo — todo call site importa daqui (D-09). Funções puras, sem
// dependência de Redis/rede/env.
//
// LGPD: nunca retornar/logar telefone ou CPF em claro — cada função revela
// só o mínimo necessário para correlação humana em log (D-10: CPF revela só
// os 3 primeiros + 2 últimos dígitos, nunca o miolo).

/** Mascara o telefone — só os últimos 4 dígitos aparecem em claro. */
export function mascararTelefone(telefone: string): string {
  const digitos = String(telefone || '').replace(/\D/g, '');
  if (digitos.length === 0) return '(sem telefone)';
  if (digitos.length <= 4) return `****${digitos}`;
  return `${'*'.repeat(digitos.length - 4)}${digitos.slice(-4)}`;
}

/**
 * Mascara o CPF (D-10) — revela só os 3 PRIMEIROS + 2 ÚLTIMOS dígitos, no
 * formato pontilhado alvo `123.***.***-45`. Precisa de pelo menos 1 dígito de
 * miolo sobrando (length > 3+2) pra esse formato realmente mascarar algo —
 * com exatamente 5 dígitos, prefixo+sufixo cobririam o CPF inteiro disfarçado
 * de mascarado, o que violaria a garantia. Abaixo desse mínimo volta
 * totalmente mascarado. NUNCA retorna o CPF inteiro.
 */
export function mascararCpf(cpf: string): string {
  const digitos = String(cpf || '').replace(/\D/g, '');
  if (digitos.length === 0) return '(sem cpf)';
  if (digitos.length < 6) return '*'.repeat(digitos.length);
  return `${digitos.slice(0, 3)}.***.***-${digitos.slice(-2)}`;
}

/**
 * Scrub de PII em TEXTO LIVRE — para saídas de API que expõem markdown/resumos
 * de IA ao cliente (dossiê da Lista 01, `resumoAnalise`/`motivoFalha` da timeline).
 * Esses textos são gerados injetando dados do Supabase (inclui CPF) e a
 * transcrição da ligação no prompt do LLM, então CPF/telefone podem reaparecer
 * no texto livre — e a regra do projeto é "CPF NUNCA no corpo" (LGPD).
 *
 * Pura (sem rede/env), reusa `mascararCpf`/`mascararTelefone`. Estratégia
 * CONSERVADORA — over-masking é aceitável, vazar não. As regras são aplicadas
 * EM ORDEM (formatados antes dos nus) para não reprocessar um trecho já mascarado:
 *   a) CPF formatado `123.456.789-01` → `mascararCpf`.
 *   b) telefone formatado com DDD/parênteses/traço (ex.: `(81) 99999-8888`,
 *      `81 99999 8888`) → `mascararTelefone`.
 *   c) sequências nuas de dígitos: 11 díg. (CPF ou celular) → `mascararCpf`
 *      (mascarar como CPF é seguro); 10 díg. → `mascararTelefone`.
 * Se `!texto`, devolve como está.
 */
export function scrubPii(texto: string): string {
  if (!texto) return texto;
  let out = texto;
  // a) CPF formatado (pontuado) primeiro.
  out = out.replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, (m) => mascararCpf(m));
  // b) telefone formatado com DDD/parênteses/traço/espaços.
  out = out.replace(/\(?\b\d{2}\)?[\s-]?\d{4,5}[\s-]?\d{4}\b/g, (m) => mascararTelefone(m));
  // c) sequências nuas de dígitos: 11 (CPF/celular) e 10 (fixo com DDD).
  out = out.replace(/\b\d{11}\b/g, (m) => mascararCpf(m));
  out = out.replace(/\b\d{10}\b/g, (m) => mascararTelefone(m));
  return out;
}
