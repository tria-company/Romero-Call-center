import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { BASE_DISCADOR, obterTokenDiscador, type ItemFilaReal } from "@/lib/discador-servidor";

/**
 * Rota-ponte: a fila REAL do discador (Ligações abertas do dia do Romero) para
 * o app mobile, sem que o token do call center chegue ao navegador — só a fila.
 *
 * Fluxo: sessão do Next (defense-in-depth, além do gate do proxy) → login
 * server-side (`obterTokenDiscador`) → GET {BASE}/api/discador/fila com Bearer.
 *
 * Formas de resposta estáveis: `{ fila }` | `{ semMapeamento: true }` | `{ erro }`.
 * LGPD: NUNCA logar token nem telefone (o telefone SAI no corpo — o operador é
 * autorizado; log não).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  if (!process.env.CALLCENTER_USUARIO || !process.env.CALLCENTER_SENHA) {
    return NextResponse.json({ erro: "Call center não configurado." }, { status: 503 });
  }

  const token = await obterTokenDiscador();
  if (!token) {
    return NextResponse.json({ erro: "Call center inacessível." }, { status: 502 });
  }

  try {
    const r = await fetch(`${BASE_DISCADOR}/api/discador/fila`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    if (!r.ok) {
      return NextResponse.json({ erro: "Fila indisponível." }, { status: 502 });
    }

    const corpo = (await r.json().catch(() => null)) as
      | { fila?: ItemFilaReal[]; semMapeamento?: boolean }
      | null;

    if (corpo?.semMapeamento) {
      return NextResponse.json(
        { semMapeamento: true },
        { headers: { "Cache-Control": "no-store, private" } },
      );
    }

    return NextResponse.json(
      { fila: corpo?.fila ?? [] },
      { headers: { "Cache-Control": "no-store, private" } },
    );
  } catch {
    return NextResponse.json({ erro: "Fila inacessível." }, { status: 502 });
  }
}
