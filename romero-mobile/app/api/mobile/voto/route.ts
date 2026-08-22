import { NextResponse } from "next/server";
import { exigirSessao } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: VOTO de confirmação (Romero/Andressa) — fallback tel:
 * (quick-260822-pzh). Encaminha pro backend do discador (`/api/discador/voto`)
 * com o dToken do PRÓPRIO operador. Body repassado tal qual: { taskId, romero?,
 * andressa? }. Mesmo gate/anti-IDOR do backend (`validarLigacaoDoOperador`),
 * reusado sem mudança.
 * LGPD: nunca logar telefone/dToken/body.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await exigirSessao();
  if (!gate.ok) return gate.resposta;

  const body = await req.json().catch(() => ({}));
  const r = await chamarDiscador("/api/discador/voto", gate.sessao.dToken, {
    method: "POST",
    body,
    timeoutMs: 15_000,
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
