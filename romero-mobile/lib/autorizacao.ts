// server-only por convenção (server-only não instalado).

/* ══════════════════════════════════════════════════════════════════════════
   AUTORIZAÇÃO — gate de sessão do app (`exigirSessao`).

   O app é multi-usuário: cada login tem seu próprio `dToken` (o Bearer do
   discador do PRÓPRIO usuário) guardado na sessão. `exigirSessao` só garante
   que existe uma sessão válida:

   · sem sessão válida → 401;
   · com sessão válida → `{ ok:true, sessao }` (o papel é aplicado no BACKEND,
     por token — rotas de gestor devolvem 403 quando o `dToken` não é de gestor).

   Não há mais checagem de `ROMERO_LOGINS` nem conta de serviço: o gate de papel
   é do backend, aplicado pelo token do usuário repassado nas pontes.

   LGPD: nunca logar usuário nem token.
   ══════════════════════════════════════════════════════════════════════════ */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_SESSAO, lerSessao, type Sessao } from "@/lib/sessao";

export type GateSessao =
  | { ok: true; sessao: Sessao }
  | { ok: false; resposta: NextResponse };

export async function exigirSessao(): Promise<GateSessao> {
  const token = (await cookies()).get(COOKIE_SESSAO)?.value;
  const sessao = await lerSessao(token);

  if (!sessao) {
    return { ok: false, resposta: NextResponse.json({ erro: "Sem sessão." }, { status: 401 }) };
  }

  return { ok: true, sessao };
}
