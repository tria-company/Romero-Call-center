import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: PULAR CONTATO (2026-08-19) — fecha a Ligação da fila com o
 * motivo explicado pelo Romero. Encaminha ao backend
 * (`POST /api/discador/audios/pular`) tal qual; gate romero-only, o backend
 * reaplica por token e valida que a Ligação é do operador (anti-IDOR).
 * LGPD: nunca logar telefone/dToken/motivo.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await exigirRomero();
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
