import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: a FICHA de um lead (`GET /api/discador/lead/:id`) — lead,
 * dossiê e timeline — servida ao app com Bearer server-side. Status repassado
 * TAL QUAL (403 sem browse-flag, 404 lead inexistente, etc.).
 *
 * Next 16: `params` é assíncrono → `await params`. LGPD: nunca logar telefone.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const { id } = await params;
  const r = await chamarDiscador(`/api/discador/lead/${encodeURIComponent(id)}`);

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
