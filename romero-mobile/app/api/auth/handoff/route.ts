import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_SESSAO, criarSessao, ttlSegundos } from "@/lib/sessao";
import { BASE_DISCADOR } from "@/lib/discador-servidor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Handoff (U5c + u8): AUTO-LOGIN por token do discador. O discador redireciona
 * QUALQUER usuário logado para `${panelUrl}/login#token=<token>`; o painel lê o
 * fragmento e chama esta rota. O token é verificado contra o backend do discador
 * (`GET /api/discador/me`); vira sessão para gestor E atendente (o papel decide
 * o destino no cliente: gestor → painel, atendente → fila).
 *
 * LGPD: nunca logar o token.
 */
export async function POST(req: NextRequest) {
  const { token } = (await req.json().catch(() => ({}))) as { token?: string };

  if (!token) {
    return NextResponse.json({ error: "Token ausente." }, { status: 400 });
  }

  let r: Response;
  try {
    r = await fetch(`${BASE_DISCADOR}/api/discador/me`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return NextResponse.json(
      { error: "Sistema indisponível. Tente de novo." },
      { status: 503 },
    );
  }

  if (!r.ok) {
    return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });
  }

  const dados = (await r.json().catch(() => null)) as {
    usuario?: string;
    papel?: string;
  } | null;

  if (!dados?.usuario) {
    return NextResponse.json(
      { error: "Resposta inválida do sistema de autenticação." },
      { status: 502 },
    );
  }

  // Login único (u8): o handoff aceita gestor E atendente (o papel decide o
  // destino no cliente). Qualquer papel != gestor entra como atendente.
  const papel = dados.papel === "gestor" ? ("gestor" as const) : ("atendente" as const);

  const jwt = await criarSessao(dados.usuario.toLowerCase(), dados.usuario, papel, token);
  if (!jwt) {
    return NextResponse.json(
      { error: "AUTH_SECRET ausente ou fraco. Configure o ambiente." },
      { status: 503 },
    );
  }

  const res = NextResponse.json({ ok: true, papel });
  res.cookies.set(COOKIE_SESSAO, jwt, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ttlSegundos(),
  });
  return res;
}
