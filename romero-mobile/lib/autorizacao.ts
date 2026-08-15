// server-only por convenção (server-only não instalado).

/* ══════════════════════════════════════════════════════════════════════════
   AUTORIZAÇÃO — trava de acesso single-tenant do Romero (`exigirRomero`).

   A operação é single-tenant Romero: o `LOGIN_USERS` único do proxy já é o
   portão principal. `exigirRomero` é o endurecimento server-side aplicado nas
   rotas que expõem dados operacionais (fila com PII, token de discagem):

   · sem sessão válida → 401;
   · `ROMERO_LOGINS` definida → só logins da lista passam (senão 403);
   · `ROMERO_LOGINS` ausente/vazia → qualquer sessão válida passa (o
     `LOGIN_USERS` único já é o portão; a lista é o endurecimento opcional).

   LGPD: nunca logar usuário nem token.
   ══════════════════════════════════════════════════════════════════════════ */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_SESSAO, lerSessao, type Sessao } from "@/lib/sessao";

export type GateRomero =
  | { ok: true; sessao: Sessao }
  | { ok: false; resposta: NextResponse };

/** Logins autorizados de `ROMERO_LOGINS` (vírgula/quebra separam, minúsculas). */
function loginsAutorizados(): string[] {
  const cru = process.env.ROMERO_LOGINS?.trim();
  if (!cru) return [];
  return cru
    .split(/[\n,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export async function exigirRomero(): Promise<GateRomero> {
  const token = (await cookies()).get(COOKIE_SESSAO)?.value;
  const sessao = await lerSessao(token);

  if (!sessao) {
    return { ok: false, resposta: NextResponse.json({ erro: "Sem sessão." }, { status: 401 }) };
  }

  const permitidos = loginsAutorizados();
  if (permitidos.length > 0 && !permitidos.includes(sessao.usuario)) {
    return {
      ok: false,
      resposta: NextResponse.json({ erro: "Acesso restrito." }, { status: 403 }),
    };
  }

  return { ok: true, sessao };
}
