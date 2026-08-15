// Auth do PWA Discador (login por closer). A fonte de credenciais agora e o
// Postgres (tabela discador_usuarios, Fase 11 D-01/D-02) — nao mais o env
// DISCADOR_USERS. verificarCredenciais despacha por algoritmo (scrypt novo
// vs sha256-legado importado do seed) e faz upgrade-on-login do legado pra
// scrypt (D-08). Token de sessao = HMAC assinado (sem estado no servidor),
// payload permanece `usuario|exp` (sem papel — o gate de gestor le o papel
// do store por request, Fase 11 Plano 04, pra revogacao imediata).
import { createHmac, timingSafeEqual } from 'crypto';
import { buscarUsuario, atualizarSenha } from './usuarios.ts';
import { verificarSenhaScrypt, verificarSenhaLegada } from './senha.ts';

const SESSION_SECRET = process.env.DISCADOR_SESSION_SECRET || 'discador-secret-trocar-em-prod';
if (!process.env.DISCADOR_SESSION_SECRET) {
  console.warn('[discador-auth] DISCADOR_SESSION_SECRET nao configurado — usando default (trocar em prod).');
}
const TTL_MS = 12 * 60 * 60 * 1000; // sessao de 12h

/**
 * Valida usuario+senha lendo do store (Postgres). Fail-closed: qualquer throw
 * de infra (config ausente/rede/HTTP) de `buscarUsuario` PROPAGA pro chamador
 * — nunca degrada pra "credencial valida" (T-11-03-D1). Usuario inexistente
 * ou senha errada -> false (401), nunca excecao.
 *
 * Dispatch por `senha_algo`: 'scrypt' (caminho novo, D-08) verifica direto;
 * 'sha256-legado' (importado do seed, Fase 11 Plano 02) verifica pelo
 * caminho legado e, em sucesso, faz upgrade-on-login best-effort pra scrypt
 * — falha do upgrade NUNCA derruba o login (T-11-03-T1).
 *
 * LGPD: NUNCA logar `senha`/hash/salt.
 */
export async function verificarCredenciais(usuario: string, senha: string): Promise<boolean> {
  const reg = await buscarUsuario(usuario.trim().toLowerCase());
  if (!reg) return false;
  if (reg.senha_algo === 'scrypt') {
    return verificarSenhaScrypt(senha, reg.senha_hash, reg.senha_salt);
  }
  // 'sha256-legado'
  const ok = verificarSenhaLegada(senha, reg.senha_hash);
  if (ok) {
    try {
      await atualizarSenha(reg.id, senha);
    } catch {
      // upgrade nunca derruba o login (T-11-03-T1) — o proximo login legado
      // bem-sucedido tenta de novo.
    }
  }
  return ok;
}

/** Emite token de sessao: base64url("user|exp").hmac. */
export function emitirToken(usuario: string): string {
  const u = (usuario || '').trim().toLowerCase();
  const payload = `${u}|${Date.now() + TTL_MS}`;
  const p64 = Buffer.from(payload).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET).update(p64).digest('base64url');
  return `${p64}.${sig}`;
}

/** Verifica token de sessao. Retorna {usuario} ou null (invalido/expirado). */
export function verificarToken(token: string): { usuario: string } | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const p64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const esperado = createHmac('sha256', SESSION_SECRET).update(p64).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const payload = Buffer.from(p64, 'base64url').toString('utf8');
  const barra = payload.lastIndexOf('|');
  if (barra === -1) return null;
  const u = payload.slice(0, barra);
  const exp = Number(payload.slice(barra + 1));
  if (!u || !exp || Date.now() > exp) return null;
  return { usuario: u };
}

/** Extrai o Bearer token do header Authorization. */
export function tokenDoHeader(authHeader: string | undefined | null): string {
  if (!authHeader) return '';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1] : '';
}
