import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_SESSAO, criarSessao, ttlSegundos } from "@/lib/sessao";
import { BASE_DISCADOR } from "@/lib/discador-servidor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Login unificado (U1+U2): autentica contra o CADASTRO DO DISCADOR (mesma base
 * do /admin). No sucesso grava na sessão o papel (gestor/atendente) e o token
 * do discador do próprio usuário (dToken).
 *
 * LGPD: nunca logar senha nem token.
 */
export async function POST(req: NextRequest) {
  const { usuario, senha } = (await req.json().catch(() => ({}))) as {
    usuario?: string;
    senha?: string;
  };

  if (!usuario || !senha) {
    return NextResponse.json({ error: "Informe e-mail e senha." }, { status: 400 });
  }

  let r: Response;
  try {
    r = await fetch(`${BASE_DISCADOR}/api/discador/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario, senha }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return NextResponse.json(
      { error: "Sistema indisponível. Tente de novo." },
      { status: 503 },
    );
  }

  if (r.status === 401) {
    return NextResponse.json({ error: "Usuário ou senha inválidos." }, { status: 401 });
  }
  if (!r.ok) {
    return NextResponse.json(
      { error: "Sistema indisponível. Tente de novo." },
      { status: 503 },
    );
  }

  const dados = (await r.json().catch(() => null)) as {
    token?: string;
    usuario?: string;
    papel?: string;
  } | null;

  if (!dados?.token) {
    return NextResponse.json(
      { error: "Resposta inválida do sistema de autenticação." },
      { status: 502 },
    );
  }

  const login = (dados.usuario || usuario).toLowerCase();
  const nome = dados.usuario || usuario;
  const papel = dados.papel === "gestor" ? "gestor" : "atendente";

  const jwt = await criarSessao(login, nome, papel, dados.token);
  if (!jwt) {
    return NextResponse.json(
      { error: "AUTH_SECRET ausente ou fraco. Configure o ambiente." },
      { status: 503 },
    );
  }

  const res = NextResponse.json({ ok: true, papel, nome });
  res.cookies.set(COOKIE_SESSAO, jwt, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ttlSegundos(),
  });
  return res;
}
