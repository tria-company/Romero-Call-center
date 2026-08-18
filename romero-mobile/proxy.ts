import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_SESSAO, lerSessao } from "./lib/sessao";

/**
 * ATIVO como middleware (Next 16.1.4 compila `proxy.ts` — confirmado no log de
 * dev: `proxy.ts: Nms` por request). É o gate real de sessão; o gate no layout
 * `app/(app)/layout.tsx` fica como defesa-em-profundidade (quick-260816-u6).
 *
 * Gate de acesso (o antigo `middleware` — no Next 16 o arquivo se chama
 * `proxy`). Sem sessão válida, tudo redireciona para a PORTA ÚNICA = /discador
 * (MESMO ENDERECO: a mesma origem serve o discador via rewrite).
 *
 * O matcher EXCLUI as rotas proxiadas do discador (`/discador`, `/api/discador`,
 * `/admin`, `/api/admin`): elas são servidas pelo backend Mastra via rewrite e
 * têm auth PRÓPRIA (Bearer) — se o middleware as pegasse, `/discador` (sem
 * sessão-cookie do painel) redirecionaria pra `/discador` num LOOP 307.
 *
 * O matcher também deixa passar assets, ícones, manifest e o service worker: se
 * o SW for redirecionado para o HTML do login, o registro falha e o app deixa
 * de ser instalável.
 */
export default async function proxy(req: NextRequest) {
  const sessao = await lerSessao(req.cookies.get(COOKIE_SESSAO)?.value);

  if (sessao) {
    // Rotas só-gestor: Início (raiz) e Base (e subrotas). O atendente é
    // devolvido para a Fila — o único lugar que ele opera.
    const { pathname } = req.nextUrl;
    const soGestor = pathname === "/" || pathname === "/base" || pathname.startsWith("/base/");
    if (soGestor && sessao.papel !== "gestor") {
      const url = req.nextUrl.clone();
      url.pathname = "/fila";
      url.search = "";
      return NextResponse.redirect(url);
    }

    // Rota só-romero: /audios (ENVIO-07). A barreira REAL é server-side (o
    // backend do discador reaplica sessaoRomero — 12-03); este redirect + a
    // ausência da aba na TabBar são defesa-em-profundidade.
    const soRomero = pathname === "/audios" || pathname.startsWith("/audios/");
    if (soRomero && sessao.usuario !== "romero") {
      const url = req.nextUrl.clone();
      url.pathname = "/fila";
      url.search = "";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = "/discador";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!login|api/auth|api/discador|api/admin|discador|admin|offline|icones/|icon|apple-icon|_next/static|_next/image|sw\\.js|manifest\\.webmanifest|.*\\.[\\w]+$).*)",
  ],
};
