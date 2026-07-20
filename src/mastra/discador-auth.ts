// Auth do PWA Discador (login por closer). v1: usuarios em env DISCADOR_USERS,
// senha guardada como SHA-256 hex. Token de sessao = HMAC assinado (sem estado
// no servidor). Seed default admin/admin pra comecar — TROCAR em producao.
import { createHash, createHmac, timingSafeEqual } from 'crypto';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// DISCADOR_USERS: "user1:sha256hex,user2:sha256hex". Default: admin/admin.
function carregarUsuarios(): Map<string, string> {
  const raw = process.env.DISCADOR_USERS || `admin:${sha256('admin')}`;
  const m = new Map<string, string>();
  for (const par of raw.split(',')) {
    const i = par.indexOf(':');
    if (i === -1) continue;
    const user = par.slice(0, i).trim().toLowerCase();
    const hash = par.slice(i + 1).trim().toLowerCase();
    if (user && hash) m.set(user, hash);
  }
  return m;
}
const USUARIOS = carregarUsuarios();

if (!process.env.DISCADOR_USERS) {
  console.warn('[discador-auth] DISCADOR_USERS nao configurado — usando seed admin/admin (INSEGURO, trocar em prod).');
}

const SESSION_SECRET = process.env.DISCADOR_SESSION_SECRET || 'discador-secret-trocar-em-prod';
if (!process.env.DISCADOR_SESSION_SECRET) {
  console.warn('[discador-auth] DISCADOR_SESSION_SECRET nao configurado — usando default (trocar em prod).');
}
const TTL_MS = 12 * 60 * 60 * 1000; // sessao de 12h

function compararHex(aHex: string, bHex: string): boolean {
  try {
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Valida usuario+senha contra o store (timing-safe). */
export function verificarCredenciais(usuario: string, senha: string): boolean {
  const u = (usuario || '').trim().toLowerCase();
  const esperado = USUARIOS.get(u);
  if (!esperado) return false;
  return compararHex(esperado, sha256(senha || ''));
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
