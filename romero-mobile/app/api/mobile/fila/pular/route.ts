import { NextResponse } from "next/server";
import { exigirSessao } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: PULAR CONTATO da fila clássica (2026-08-19 — "vai ser usado
 * para todos"): QUALQUER operador logado fecha a própria Ligação explicando o
 * motivo. Gate largo aqui (`exigirSessao`); o anti-IDOR é do backend
 * (`validarLigacaoDoOperador` via o dToken do PRÓPRIO usuário — ninguém pula
 * Ligação alheia). Mesmo backend da lista de áudios do Romero.
 * LGPD: nunca logar telefone/dToken/motivo.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await exigirSessao();
  if (!gate.ok) return gate.resposta;

  const body = await req.json().catch(() => ({}));
  const r = await chamarDiscador("/api/discador/audios/pular", gate.sessao.dToken, {
    method: "POST",
    body,
    // valida + grava metadados + comenta + fecha no ClickUp — passa dos 8s default
    timeoutMs: 45_000,
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
