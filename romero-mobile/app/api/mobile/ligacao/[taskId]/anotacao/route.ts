import { NextResponse } from "next/server";
import { exigirSessao } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: grava uma ANOTAÇÃO na Ligação (`POST
 * /api/discador/ligacao/:taskId/anotacao`, corpo `{texto}`) — quick-260822-rr6
 * (R6/D-06), caminho "atendeu" do retorno tel: (classificação/demanda/
 * observação persistidas como comentário na Ligação). Bearer server-side;
 * status repassado TAL QUAL. Comentário no ClickUp é rate-limitado — mesmo
 * teto folgado do lead detalhe.
 *
 * Next 16: `params` assíncrono. LGPD: nunca logar corpo/telefone.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const gate = await exigirSessao();
  if (!gate.ok) return gate.resposta;

  const { taskId } = await params;
  const body = (await req.json().catch(() => ({}))) as unknown;
  const r = await chamarDiscador(`/api/discador/ligacao/${encodeURIComponent(taskId)}/anotacao`, gate.sessao.dToken, {
    method: "POST",
    body,
    timeoutMs: 30_000,
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
