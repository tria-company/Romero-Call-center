import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";

/**
 * Token do CALL CENTER — login automático sem senha no navegador.
 *
 * O call center guarda a sessão em `localStorage['discador_token']`, na origem
 * dele. Nenhum site escreve no localStorage de outro domínio, então o token
 * precisa viajar na URL — e quem o busca é o SERVIDOR, não o cliente:
 *
 *     operador toca "Ligar"
 *       → o app pede aqui           (cookie de sessão obrigatório)
 *       → aqui chamamos /api/discador/login com a credencial do ambiente
 *       → devolvemos só o token
 *       → o app abre o call center com #token=… no FRAGMENTO
 *
 * A credencial fica em CALLCENTER_USUARIO / CALLCENTER_SENHA e nunca sai do
 * servidor: este arquivo roda em Node, não vai para o bundle do cliente.
 *
 * O gate de sessão (`proxy.ts`) cobre esta rota — o matcher só abre exceção
 * para `api/auth`. Sem estar logado no Central Animal, ninguém pega token.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = (process.env.CALLCENTER_URL ?? "https://romero-call-center.vercel.app").replace(
  /\/+$/,
  "",
);

export async function POST() {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const usuario = process.env.CALLCENTER_USUARIO;
  const senha = process.env.CALLCENTER_SENHA;

  if (!usuario || !senha) {
    return NextResponse.json(
      { error: "Call center não configurado. Defina CALLCENTER_USUARIO e CALLCENTER_SENHA." },
      { status: 503 },
    );
  }

  try {
    const r = await fetch(`${BASE}/api/discador/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario, senha }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    if (!r.ok) {
      return NextResponse.json({ error: "Credencial recusada pelo call center." }, { status: 502 });
    }

    const dados = (await r.json().catch(() => null)) as { token?: string } | null;
    if (!dados?.token) {
      return NextResponse.json({ error: "Call center não devolveu token." }, { status: 502 });
    }

    // no-store nos dois sentidos: token de sessão não pode ficar em cache de
    // proxy nem de navegador
    return NextResponse.json(
      { token: dados.token },
      { headers: { "Cache-Control": "no-store, private" } },
    );
  } catch {
    return NextResponse.json({ error: "Call center inacessível." }, { status: 504 });
  }
}
