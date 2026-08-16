import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: a LISTA de leads do backend do discador para o app mobile.
 *
 * Repassa `?q=&cursor=&limit=` para `GET /api/discador/leads` com Bearer
 * server-side (o token nunca chega ao navegador). O status do backend é
 * repassado TAL QUAL — em especial `403` quando `DISCADOR_LEAD_BROWSE` não está
 * ligado no backend, para a UI distinguir "acesso não liberado".
 *
 * LGPD: telefone SAI mascarado no corpo; nunca logar.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const qs = new URL(req.url).searchParams;
  const passar = new URLSearchParams();
  for (const chave of ["q", "cursor", "limit"] as const) {
    const v = qs.get(chave);
    if (v) passar.set(chave, v);
  }
  const cauda = passar.toString();
  const r = await chamarDiscador(`/api/discador/leads${cauda ? `?${cauda}` : ""}`);

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
