import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: SINAL DE NOVIDADE (2026-08-19) — ts da última mensagem de
 * WhatsApp persistida. O app sonda a cada ~4s; mudou → recarrega lista e
 * conversa na hora (sem F5, sem esperar o poll de 30s). Encaminha
 * `GET /api/discador/audios/novidades` tal qual. LGPD: nada logado.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const r = await chamarDiscador("/api/discador/audios/novidades", gate.sessao.dToken);

  return NextResponse.json(r.dados ?? { ultimoTs: 0 }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
