import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_SESSAO, lerSessao } from "./lib/sessao";

/**
 * INERTE nesta versão do Next: este arquivo NÃO é compilado como middleware
 * (middleware-manifest.json vazio), então o gate real de sessão vive no
 * layout autenticado — `app/(app)/layout.tsx` (quick-260816-u5-fix, WR-02).
 *
 * Gate de acesso (o antigo `middleware` — no Next 16 o arquivo se chama
 * `proxy`). Sem sessão válida, tudo redireciona para a PORTA ÚNICA = /discador
 * (MESMO ENDERECO: mesma origem serve o discador via rewrite).
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
  url.pathname = "/discador";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!login|api/auth|offline|icones/|icon|apple-icon|_next/static|_next/image|sw\\.js|manifest\\.webmanifest|.*\\.[\\w]+$).*)",
  ],
};
