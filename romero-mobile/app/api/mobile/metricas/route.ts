import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: as métricas de operação ao vivo do discador (atendentes online,
 * chamadas ativas, profundidade da fila, erros do dia) para o app mobile, sem
 * que o token do call center chegue ao navegador.
 *
 * Fluxo: gate de sessão (`exigirRomero`, defense-in-depth) → login server-side
 * embutido em `chamarDiscador` → GET {BASE}/api/admin/metricas com Bearer. O
 * status do backend é repassado TAL QUAL para a UI distinguir 403 (sem acesso)
 * de 502 (call center inacessível).
 *
 * LGPD: nunca logar token nem PII (as métricas são agregadas, sem PII).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const r = await chamarDiscador("/api/admin/metricas");
  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
