import { NextResponse } from "next/server";
import { exigirSessao } from "@/lib/autorizacao";

/**
 * Token do CALL CENTER — login automático sem senha no navegador.
 *
 * O call center guarda a sessão em `localStorage['discador_token']`, na origem
 * dele. Nenhum site escreve no localStorage de outro domínio, então o token
 * precisa viajar na URL — e quem o entrega é o SERVIDOR, não o cliente:
 *
 *     operador toca "Ligar"
 *       → o app pede aqui           (cookie de sessão obrigatório)
 *       → devolvemos o `dToken` da PRÓPRIA sessão (o token do usuário logado)
 *       → o app abre o call center com #token=… no FRAGMENTO
 *
 * Assim o handoff "Ligar" abre a tela de chamada como o PRÓPRIO usuário (a fila
 * dele), sem conta de serviço compartilhada.
 *
 * O gate de sessão (`proxy.ts`) cobre esta rota — o matcher só abre exceção
 * para `api/auth`. Sem estar logado, ninguém pega token.
 *
 * LGPD: nunca logar token.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const gate = await exigirSessao();
  if (!gate.ok) return gate.resposta;

  // no-store nos dois sentidos: token de sessão não pode ficar em cache de
  // proxy nem de navegador
  return NextResponse.json(
    { token: gate.sessao.dToken },
    { headers: { "Cache-Control": "no-store, private" } },
  );
}
