import { NextResponse } from "next/server";
import { exigirSessao } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: a FICHA de um lead (`GET /api/discador/lead/:id`) — lead,
 * dossiê e timeline — servida ao app com Bearer server-side. Status repassado
 * TAL QUAL (403 quando o usuário não é gestor — gate de papel no backend,
 * 404 lead inexistente, etc.).
 *
 * Next 16: `params` é assíncrono → `await params`. LGPD: nunca logar telefone.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await exigirSessao();
  if (!gate.ok) return gate.resposta;

  const { id } = await params;
  // ?leve=1 (2026-08-20): repassa a variante SEM timeline (card da conversa /
  // modo fast só usam o dossiê — corta ~10s do frio).
  const leve = new URL(req.url).searchParams.get("leve") === "1" ? "?leve=1" : "";
  // 30s: a timeline agora é filtrada no servidor do ClickUp (~2-3s típicos),
  // mas o limiter manso pode espaçar as queries — 8s default ficava no limite.
  const r = await chamarDiscador(
    `/api/discador/lead/${encodeURIComponent(id)}${leve}`,
    gate.sessao.dToken,
    { timeoutMs: 30_000 },
  );

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
