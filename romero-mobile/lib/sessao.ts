/* ══════════════════════════════════════════════════════════════════════════
   SESSÃO — cookie assinado com HMAC-SHA256 via Web Crypto.

   Portado de `lib/sessao-simple.ts` do Ai.data-main. Web Crypto (e não
   `node:crypto`) porque o middleware roda no runtime Edge.

   Diferenças em relação ao original, de propósito:
   · usuários vêm de LOGIN_USERS (vários), não de um par fixo no código;
   · em produção, segredo fraco/ausente derruba a validação (fail-closed) em
     vez de cair silenciosamente num literal comitado.
   ══════════════════════════════════════════════════════════════════════════ */

export const COOKIE_SESSAO = "ca_sessao";

const SEGREDO_DEV = "central-animal-dev-secret-nao-use-em-producao";
const EM_PRODUCAO = process.env.NODE_ENV === "production";

const enc = new TextEncoder();

function segredo(): string | null {
  const s = process.env.AUTH_SECRET?.trim();
  if (s && s.length >= 24) return s;
  if (EM_PRODUCAO) return null; // fail-closed: sem segredo forte, ninguém entra
  return SEGREDO_DEV;
}

const ttlMs = () => Number(process.env.AUTH_TTL_HORAS || 12) * 3_600_000;
export const ttlSegundos = () => Math.floor(ttlMs() / 1000);

/* ── base64url ─────────────────────────────────────────────────────────── */

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function deB64url(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(payload: string, chave: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(chave),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return b64url(new Uint8Array(sig));
}

/** Comparação em tempo constante — evita vazar o segredo por timing. */
function iguaisSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type Papel = "gestor" | "atendente";

export type Sessao = {
  usuario: string;
  nome: string;
  papel: Papel;
  /** Token do discador do próprio usuário (Bearer emitido pelo backend). */
  dToken: string;
  exp: number;
};

export async function criarSessao(
  usuario: string,
  nome: string,
  papel: Papel,
  dToken: string,
): Promise<string | null> {
  const chave = segredo();
  if (!chave) return null;
  const dados: Sessao = { usuario, nome, papel, dToken, exp: Date.now() + ttlMs() };
  const payload = b64url(enc.encode(JSON.stringify(dados)));
  return `${payload}.${await hmac(payload, chave)}`;
}

export async function lerSessao(token: string | undefined | null): Promise<Sessao | null> {
  if (!token) return null;
  const chave = segredo();
  if (!chave) return null;

  const ponto = token.lastIndexOf(".");
  if (ponto <= 0) return null;
  const payload = token.slice(0, ponto);
  const assinatura = token.slice(ponto + 1);

  const esperada = await hmac(payload, chave);
  if (!iguaisSeguro(assinatura, esperada)) return null;

  try {
    const dados = JSON.parse(new TextDecoder().decode(deB64url(payload))) as Sessao;
    if (!dados?.usuario || typeof dados.exp !== "number") return null;
    // Login unificado (U1+U2): sessões antigas sem papel/dToken são inválidas —
    // força relogin contra o cadastro do discador.
    if (dados.papel !== "gestor" && dados.papel !== "atendente") return null;
    if (!dados.dToken) return null;
    if (dados.exp < Date.now()) return null;
    return dados;
  } catch {
    return null;
  }
}

/* ── Usuários ──────────────────────────────────────────────────────────── */

export type UsuarioConfig = { usuario: string; senha: string; nome: string };

/**
 * LOGIN_USERS = "email:senha:Nome, outro@x.com:senha2:Outro Nome"
 * (vírgula ou quebra de linha separam os registros)
 *
 * O identificador pode ser e-mail ou usuário simples — o split pega só os dois
 * primeiros ":", então o Nome de Exibição pode conter ":" à vontade.
 */
export function usuariosConfigurados(): UsuarioConfig[] {
  const cru = process.env.LOGIN_USERS?.trim();
  if (!cru) return [];
  return cru
    .split(/[\n,]+/)
    .map((linha) => linha.trim())
    .filter(Boolean)
    .map((linha) => {
      const [usuario, senha, ...resto] = linha.split(":");
      if (!usuario || !senha) return null;
      return {
        usuario: usuario.trim().toLowerCase(),
        senha,
        nome: resto.join(":").trim() || usuario.trim(),
      };
    })
    .filter((x): x is UsuarioConfig => x !== null);
}

export function autenticar(usuario: string, senha: string): UsuarioConfig | null {
  const alvo = usuario.trim().toLowerCase();
  const achado = usuariosConfigurados().find(
    (u) => u.usuario === alvo && iguaisSeguro(u.senha, senha),
  );
  return achado ?? null;
}
