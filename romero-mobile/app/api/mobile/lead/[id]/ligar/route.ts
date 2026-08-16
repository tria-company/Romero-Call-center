import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: "Ligar para QUALQUER lead" (quick-260815-r3). Encaminha o POST ao
 * backend do discador (`POST /api/discador/lead/:id/ligar`), que cria uma
 * Ligação avulsa ATRIBUÍDA ao operador e devolve `{ taskId }` pro deep-link.
 * Status repassado TAL QUAL (403 sem papel gestor, 404 lead inexistente, 409
 * operador sem mapeamento, 422 lead sem telefone).
 *
 * Next 16: `params` é assíncrono → `await params`. LGPD: nunca logar telefone.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const { id } = await params;
  const r = await chamarDiscador(`/api/discador/lead/${encodeURIComponent(id)}/ligar`, {
    method: "POST",
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
