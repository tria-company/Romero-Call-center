import { NextResponse } from "next/server";
import { exigirSessao } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: o SCRIPT (roteiro de ligação) do lead, pela task da Ligação —
 * usado pelo MODO FAST (Áudios, Romero) E pelo card da fila do atendente
 * (quick-260822-rr6, R7/D-07: "Roteiro" recolhível ANTES de ligar). Encaminha
 * o GET ao backend (`GET /api/discador/ligacao/:taskId`) tal qual. Gate
 * `exigirSessao` (alargado de romero-only): o backend valida ownership por
 * operador (`assigneeDoOperador` + `validarLigacaoDoOperador`), então o
 * atendente só lê a PRÓPRIA Ligação — Romero segue funcionando (sessão
 * válida, sem mudança de comportamento).
 *
 * LGPD: nunca logar taskId/script/telefone.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const gate = await exigirSessao();
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
