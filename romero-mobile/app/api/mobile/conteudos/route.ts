import { NextResponse } from "next/server";
import { exigirRomero } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: biblioteca de conteúdos (Fase 2 do roadmap). GET lista os
 * conteúdos ativos (seletor do operador); POST cria (gestão). Encaminha ao
 * backend do discador (/api/discador/conteudos) tal qual — sem lógica de
 * negócio aqui (Anti-Pattern 1). Gate romero-only: o backend reaplica por token.
 * LGPD: conteúdos não têm dado pessoal.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const categoria = new URL(req.url).searchParams.get("categoria");
  const qs = categoria ? `?categoria=${encodeURIComponent(categoria)}` : "";
  const r = await chamarDiscador(`/api/discador/conteudos${qs}`, gate.sessao.dToken);

  return NextResponse.json(r.dados ?? { conteudos: [] }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}

export async function POST(req: Request) {
  const gate = await exigirRomero();
  if (!gate.ok) return gate.resposta;

  const body = await req.json().catch(() => ({}));
  const r = await chamarDiscador(`/api/discador/conteudos`, gate.sessao.dToken, {
    method: "POST",
    body,
  });

  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
