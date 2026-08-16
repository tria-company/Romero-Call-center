import { NextResponse } from "next/server";
import { exigirSessao } from "@/lib/autorizacao";
import { chamarDiscador, type ItemFilaReal } from "@/lib/discador-servidor";

/**
 * Rota-ponte: a fila REAL do discador (as Ligações abertas do dia do PRÓPRIO
 * usuário) para o app mobile, sem que o token chegue ao navegador — só a fila.
 *
 * Fluxo: sessão do Next (`exigirSessao`) → GET {BASE}/api/discador/fila com o
 * Bearer do PRÓPRIO usuário (`gate.sessao.dToken`), então cada operador vê a
 * sua fila.
 *
 * Formas de resposta estáveis: `{ fila }` | `{ semMapeamento: true }` | `{ erro }`.
 * LGPD: NUNCA logar token nem telefone (o telefone SAI no corpo — o operador é
 * autorizado; log não).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await exigirSessao();
  if (!gate.ok) return gate.resposta;

  const r = await chamarDiscador("/api/discador/fila", gate.sessao.dToken);

  if (!r.ok) {
    return NextResponse.json({ erro: "Fila indisponível." }, { status: r.status });
  }

  const corpo = r.dados as { fila?: ItemFilaReal[]; semMapeamento?: boolean } | null;

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
}
