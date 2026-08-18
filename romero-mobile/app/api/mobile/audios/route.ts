import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: lista de áudios (nunca-ligados + origens). Encaminha o GET ao
 * backend do discador (`GET /api/discador/audios`) tal qual — sem lógica de
 * negócio aqui (Anti-Pattern 1: nenhuma chamada Evolution/ClickUp no
 * romero-mobile). Gate romero-only (ENVIO-07): o backend (12-03,
 * `sessaoRomero`) reaplica o mesmo gate por token — dupla barreira.
 *
 * LGPD: nunca logar telefone/dToken.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const r = await chamarDiscador("/api/discador/audios", gate.sessao.dToken);

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
