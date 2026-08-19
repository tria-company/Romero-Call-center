import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: histórico de envios de áudio do lead (Lista 03) — as bolhas
 * persistentes da conversa. Encaminha o GET ao backend do discador
 * (`GET /api/discador/audios/:leadId/historico`) tal qual. Gate romero-only
 * (ENVIO-07): o backend reaplica o mesmo gate por token.
 *
 * LGPD: nunca logar telefone/dToken.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const { leadId } = await params;
  // 30s: a Lista 03 é pequena, mas cada registro do lead paga um GET individual
  // (anexo) — folga sobre o default de 8s.
  const r = await chamarDiscador(`/api/discador/audios/${encodeURIComponent(leadId)}/historico`, gate.sessao.dToken, {
    timeoutMs: 30_000,
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
