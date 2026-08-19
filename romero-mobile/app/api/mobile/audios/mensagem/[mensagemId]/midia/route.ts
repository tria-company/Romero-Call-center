import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: mídia (base64) de uma mensagem de ÁUDIO da conversa (Fase 13) —
 * alimenta o ▶ das bolhas dos dois lados. Encaminha o GET ao backend
 * (`GET /api/discador/audios/mensagem/:mensagemId/midia`). Gate romero-only.
 *
 * LGPD: nunca logar dToken/base64.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ mensagemId: string }> }) {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const { mensagemId } = await params;
  const r = await chamarDiscador(`/api/discador/audios/mensagem/${encodeURIComponent(mensagemId)}/midia`, gate.sessao.dToken, {
    timeoutMs: 30_000,
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
