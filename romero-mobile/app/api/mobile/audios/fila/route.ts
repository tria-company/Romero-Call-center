import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: a FILA do Romero como lista de áudios (pedido 2026-08-19 — "a
 * fila de ligações É a lista de áudios"). Encaminha ao backend
 * (`GET /api/discador/audios/fila`) tal qual; mesmo gate/duplo-gate das demais
 * rotas de áudios. LGPD: nunca logar telefone/dToken.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  // 60s: a fila lê o ClickUp (cache-aside) + o selo varre a Lista 03 — na
  // primeira carga fria passa fácil dos 8s default da ponte.
  const r = await chamarDiscador("/api/discador/audios/fila", gate.sessao.dToken, { timeoutMs: 60_000 });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
