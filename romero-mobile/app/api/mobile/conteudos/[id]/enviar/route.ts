import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: envio NATIVO de um conteúdo da biblioteca a um lead (Fase 5).
 * Encaminha ao backend (/api/discador/conteudos/:id/enviar) tal qual — o backend
 * decide texto/link (sendText) vs imagem/vídeo/áudio (sendMedia). Gate romero-only
 * (reaplicado por token). Next 16: `params` assíncrono. LGPD: sem PII no log.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const r = await chamarDiscador(`/api/discador/conteudos/${encodeURIComponent(id)}/enviar`, gate.sessao.dToken, {
    method: "POST",
    body,
    // 30s: sendMedia por URL + throttle Evolution podem passar dos 8s default.
    timeoutMs: 30_000,
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
