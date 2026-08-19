import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: a CONVERSA real do WhatsApp com o lead (Fase 13, fatia 1) —
 * mensagens dos dois lados + transcrições. Encaminha o GET ao backend
 * (`GET /api/discador/audios/:leadId/conversa`) tal qual. Gate romero-only.
 *
 * LGPD: nunca logar telefone/dToken/conteúdo.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const { leadId } = await params;
  // 60s: a PRIMEIRA leitura pode transcrever vários áudios (Deepgram ~2-4s
  // cada); os polls seguintes voltam do cache em segundos.
  const r = await chamarDiscador(`/api/discador/audios/${encodeURIComponent(leadId)}/conversa`, gate.sessao.dToken, {
    timeoutMs: 60_000,
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
