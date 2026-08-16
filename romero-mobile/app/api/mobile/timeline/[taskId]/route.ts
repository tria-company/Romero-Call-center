import { NextResponse } from "next/server";
import { exigirSessao } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: a TIMELINE de ligações por taskId
 * (`GET /api/discador/timeline/:taskId`). Path-fila IDOR-safe: não depende do
 * `DISCADOR_LEAD_BROWSE` do backend. Bearer server-side; status TAL QUAL.
 *
 * Next 16: `params` assíncrono. LGPD: nunca logar telefone.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const gate = await exigirSessao();
  if (!gate.ok) return gate.resposta;

  const { taskId } = await params;
  const r = await chamarDiscador(
    `/api/discador/timeline/${encodeURIComponent(taskId)}`,
    gate.sessao.dToken,
  );

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
