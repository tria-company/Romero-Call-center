import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_SESSAO, lerSessao } from "./lib/sessao";

/**
 * Gate de acesso (o antigo `middleware` — no Next 16 o arquivo se chama
 * `proxy`). Sem sessão válida, tudo redireciona para /login.
 *
 * O matcher deixa passar assets, ícones, manifest e o service worker: se o SW
 * for redirecionado para o HTML do login, o registro falha e o app deixa de
 * ser instalável.
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
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!login|api/auth|offline|icones/|icon|apple-icon|_next/static|_next/image|sw\\.js|manifest\\.webmanifest|.*\\.[\\w]+$).*)",
  ],
};
