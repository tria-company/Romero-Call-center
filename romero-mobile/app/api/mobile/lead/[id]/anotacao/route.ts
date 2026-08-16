import { NextResponse } from "next/server";
import { exigirSessao } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: grava uma ANOTAÇÃO no lead
 * (`POST /api/discador/lead/:id/anotacao`, corpo `{texto}`). Bearer
 * server-side; status repassado TAL QUAL.
 *
 * Next 16: `params` assíncrono. LGPD: nunca logar corpo/telefone.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await exigirSessao();
  if (!gate.ok) return gate.resposta;

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as unknown;
  const r = await chamarDiscador(`/api/discador/lead/${encodeURIComponent(id)}/anotacao`, gate.sessao.dToken, {
    method: "POST",
    body,
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
