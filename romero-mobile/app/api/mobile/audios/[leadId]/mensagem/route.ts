import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: envio de mensagem de TEXTO pro lead (Fase 13, fatia 2 — chat).
 * Encaminha o POST ao backend (`POST /api/discador/audios/:leadId/mensagem`)
 * tal qual. Gate romero-only; o backend reaplica por token.
 *
 * LGPD: nunca logar telefone/dToken/texto.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const { leadId } = await params;
  const body = await _req.json().catch(() => ({}));
  const r = await chamarDiscador(`/api/discador/audios/${encodeURIComponent(leadId)}/mensagem`, gate.sessao.dToken, {
    method: "POST",
    body,
    // pré-check + envio + registro podem passar dos 8s default
    timeoutMs: 60_000,
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
