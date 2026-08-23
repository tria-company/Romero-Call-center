import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: edição/exclusão de um conteúdo da biblioteca (Fase 2, gestão).
 * PATCH edita; DELETE faz soft-delete (ativo=false no backend). Encaminha ao
 * backend do discador tal qual. Gate romero-only (reaplicado por token no
 * backend). Next 16: `params` é assíncrono → `await params`. LGPD: sem PII.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const r = await chamarDiscador(`/api/discador/conteudos/${encodeURIComponent(id)}`, gate.sessao.dToken, {
    method: "PATCH",
    body,
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const { id } = await params;
  const r = await chamarDiscador(`/api/discador/conteudos/${encodeURIComponent(id)}`, gate.sessao.dToken, {
    method: "DELETE",
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
