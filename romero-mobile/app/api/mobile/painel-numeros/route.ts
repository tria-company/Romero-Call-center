import { NextResponse } from "next/server";
import { exigirSessao } from "@/lib/autorizacao";
import { chamarDiscador } from "@/lib/discador-servidor";

/**
 * Rota-ponte: os números do dashboard do gestor (cadastros na base + votos
 * confirmados/apoiadores) do backend do discador, com o Bearer do PRÓPRIO usuário
 * (o backend gate por papel gestor). Sem token no navegador.
 *
 * Forma: `{ cadastros, votosPopulados, votosRomero, votosAndressa, apoiadores }`.
 * LGPD: só agregados, nada de PII.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await exigirSessao();
  if (!gate.ok) return gate.resposta;

  const r = await chamarDiscador("/api/discador/painel-numeros", gate.sessao.dToken);
  return NextResponse.json(r.dados ?? { erro: "Sem resposta." }, {
    status: r.status,
    headers: { "Cache-Control": "no-store, private" },
  });
}
