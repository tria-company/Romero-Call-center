import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: envio de áudio pra um lead. Encaminha o POST (body: áudio) ao
 * backend do discador (`POST /api/discador/audios/:leadId/enviar`) tal qual —
 * sem lógica de negócio aqui (nenhuma chamada Evolution/ClickUp no
 * romero-mobile, Anti-Pattern 1). Gate romero-only (ENVIO-07): o backend
 * (12-03, `sessaoRomero`) reaplica o mesmo gate por token.
 *
 * Next 16: `params` é assíncrono → `await params`. LGPD: nunca logar
 * telefone/dToken/áudio.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const { leadId } = await params;
  const body = await _req.json().catch(() => ({}));
  const r = await chamarDiscador(`/api/discador/audios/${encodeURIComponent(leadId)}/enviar`, gate.sessao.dToken, {
    method: "POST",
    body,
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
