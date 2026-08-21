import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: o SCRIPT (roteiro de ligação) do lead, pela task da Ligação —
 * usado pelo MODO FAST (Áudios) no lugar do dossiê. Encaminha o GET ao
 * backend (`GET /api/discador/ligacao/:taskId`) tal qual. Gate romero-only.
 *
 * LGPD: nunca logar taskId/script/telefone.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const { taskId } = await params;
  // 15s: leitura leve (não transcreve nada) — mais curto que os 60s da conversa.
  const r = await chamarDiscador(`/api/discador/ligacao/${encodeURIComponent(taskId)}`, gate.sessao.dToken, {
    timeoutMs: 15_000,
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
