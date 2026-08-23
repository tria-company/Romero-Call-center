import { NextResponse } from "next/server";
import { exigirSessao } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: marca o LEAD ligado a esta Ligação como "super-fã" (`POST
 * /api/discador/ligacao/:taskId/super-fa`) — quick-260822-rr6 (R9), tag
 * PERMANENTE no lead (Lista 01), filtrável em lotes futuros. Sem corpo (o
 * taskId já identifica a Ligação). Bearer server-side; status repassado TAL
 * QUAL — `200 { temLead:false, aviso }` quando a Ligação não tem lead
 * vinculado (não é erro, o backend não falha o fluxo).
 *
 * Next 16: `params` assíncrono. LGPD: nunca logar taskId/telefone.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const gate = await exigirSessao();
  if (!gate.ok) return gate.resposta;

  const { taskId } = await params;
  const r = await chamarDiscador(`/api/discador/ligacao/${encodeURIComponent(taskId)}/super-fa`, gate.sessao.dToken, {
    method: "POST",
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
