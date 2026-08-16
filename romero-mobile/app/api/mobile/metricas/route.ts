import { NextResponse } from "next/server";
import { exigirSessao } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: as métricas de operação ao vivo do discador (atendentes online,
 * chamadas ativas, profundidade da fila, erros do dia) para o app mobile, sem
 * que o token do call center chegue ao navegador.
 *
 * Fluxo: gate de sessão (`exigirSessao`) → GET {BASE}/api/admin/metricas com o
 * Bearer do PRÓPRIO usuário (`gate.sessao.dToken`). O status do backend é
 * repassado TAL QUAL para a UI distinguir 403 (não-gestor) de 502 (call center
 * inacessível).
 *
 * LGPD: nunca logar token nem PII (as métricas são agregadas, sem PII).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await exigirSessao();
  if (!gate.ok) return gate.resposta;

  const r = await chamarDiscador("/api/admin/metricas", gate.sessao.dToken);
  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
