import { NextResponse } from "next/server";
import { exigirSessao } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: DESFECHO da Ligação (fallback tel:, quick-260822-pzh) — encaminha
 * pro backend do discador (`/api/discador/desfecho`) com o dToken do PRÓPRIO
 * operador. Body repassado tal qual: { taskId, resultado, categoria?,
 * observacao?, duracao? }. O anti-IDOR é do backend (assignee vem da sessão,
 * nunca do body; `validarLigacaoDoOperador` recusa Ligação alheia) — reusado
 * sem mudança nenhuma.
 * LGPD: nunca logar telefone/dToken/observação/body.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await exigirSessao();
  if (!gate.ok) return gate.resposta;

  const body = await req.json().catch(() => ({}));
  const r = await chamarDiscador("/api/discador/desfecho", gate.sessao.dToken, {
    method: "POST",
    body,
    // caminho nao_atendida terminal grava metadados + comenta + fecha no
    // ClickUp (rate-limitado) — mesmo teto do pular.
    timeoutMs: 45_000,
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
