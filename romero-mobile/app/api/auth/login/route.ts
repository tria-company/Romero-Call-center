import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_SESSAO, autenticar, criarSessao, ttlSegundos, usuariosConfigurados } from "@/lib/sessao";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { usuario, senha } = (await req.json().catch(() => ({}))) as {
    usuario?: string;
    senha?: string;
  };

  if (!usuario || !senha) {
    return NextResponse.json({ error: "Informe e-mail e senha." }, { status: 400 });
  }

  if (usuariosConfigurados().length === 0) {
    // Sem LOGIN_USERS não há como validar ninguém — dizer isso é melhor do que
    // devolver "senha inválida" para credenciais que nunca poderiam funcionar.
    return NextResponse.json(
      { error: "Nenhum usuário configurado. Defina LOGIN_USERS no ambiente." },
      { status: 503 },
    );
  }

  const achado = autenticar(usuario, senha);
  if (!achado) {
    return NextResponse.json({ error: "E-mail ou senha inválidos." }, { status: 401 });
  }

  const token = await criarSessao(achado.usuario, achado.nome);
  if (!token) {
    return NextResponse.json(
      { error: "AUTH_SECRET ausente ou fraco. Configure o ambiente." },
      { status: 503 },
    );
  }

  const res = NextResponse.json({ ok: true, nome: achado.nome });
  res.cookies.set(COOKIE_SESSAO, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ttlSegundos(),
  });
  return res;
}
