import { NextResponse } from "next/server";
import { exigirSessao } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: os agregados da Central de Campanha (produção diária, ranking de
 * telefonistas e taxa de atendimento) vindos do backend do discador, com o Bearer
 * server-side — o token nunca chega ao navegador.
 *
 * O status do backend é repassado TAL QUAL, em especial `403` quando o usuário não é
 * gestor, para a UI distinguir "acesso não liberado" de "deu erro".
 *
 * LGPD: só agregados e nome de operador (infraestrutura da campanha, não dado do lead).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await exigirSessao();
  if (!gate.ok) return gate.resposta;

  const r = await chamarDiscador("/api/discador/campanha", gate.sessao.dToken);

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
