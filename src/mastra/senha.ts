// Primitivas de hashing de senha (Fase 11, D-08). Módulo PURO — importa SOMENTE de
// 'crypto' (node:crypto), zero imports relativos de projeto: importável isolado por
// `node --experimental-strip-types` e sem risco de ciclo com usuarios.ts/discador-auth.ts.
//
// Caminho novo: scrypt salted por usuário (D-08 — rejeitou Argon2 justamente para não
// somar dependência nova; scrypt via node:crypto nativo é seguro-o-suficiente e zero
// supply-chain). Caminho legado: sha256 sem salt, herdado do seed admin/admin de
// discador-auth.ts — preservado só para o login continuar funcionando até o
// upgrade-on-login (11-03) re-hashear para scrypt no próximo login bem-sucedido.
//
// LGPD: NUNCA logar senha/hash/salt neste módulo (nem em erro).
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const SCRYPT_KEYLEN = 64;

/** Gera hash scrypt salted de uma senha nova. Salt aleatório por chamada (16 bytes). */
export function hashSenhaScrypt(senha: string): { hash: string; salt: string; algo: 'scrypt' } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(senha, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt, algo: 'scrypt' };
}

/** Verifica uma senha contra hash+salt scrypt (timing-safe). Nunca lança — false em erro. */
export function verificarSenhaScrypt(senha: string, hash: string, salt: string | null): boolean {
  try {
    if (!salt) return false;
    const esperado = Buffer.from(hash, 'hex');
    const recebido = scryptSync(senha, salt, SCRYPT_KEYLEN);
    return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
  } catch {
    return false;
  }
}

/** SHA-256 hex de uma string (idêntico ao `sha256` de discador-auth.ts). */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Verifica senha contra hash sha256 legado (sem salt), timing-safe. Nunca lança. */
export function verificarSenhaLegada(senha: string, hashHex: string): boolean {
  try {
    const esperado = Buffer.from(hashHex, 'hex');
    const recebido = Buffer.from(sha256Hex(senha), 'hex');
    return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
  } catch {
    return false;
  }
}
