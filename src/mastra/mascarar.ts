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
