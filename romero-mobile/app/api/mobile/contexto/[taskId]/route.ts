import { NextResponse } from "next/server";
import { exigirSessao } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: o CONTEXTO (dossiê 360° do lead) ligado a uma Ligação —
 * quick-260822-rr6 (R7/D-07), usado pelo card da fila do atendente ANTES de
 * ligar. Encaminha o GET ao backend (`GET /api/discador/contexto/:taskId`,
 * já existente e ownership-safe por operador) tal qual — devolve
 * `{ temLead, contexto }`.
 *
 * LGPD: nunca logar taskId/contexto/telefone.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const gate = await exigirSessao();
  if (!gate.ok) return gate.resposta;

  const { taskId } = await params;
  // 15s: leitura leve (mesmo teto de /ligacao/:taskId).
  const r = await chamarDiscador(`/api/discador/contexto/${encodeURIComponent(taskId)}`, gate.sessao.dToken, {
    timeoutMs: 15_000,
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
