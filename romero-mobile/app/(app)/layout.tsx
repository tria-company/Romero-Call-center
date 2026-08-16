import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { TabBar } from "@/components/shell/TabBar";
import { PageTransition } from "@/components/shell/PageTransition";
import { BootDados } from "@/components/shell/BootDados";
import { RegisterSW } from "@/components/shell/RegisterSW";
import { COOKIE_SESSAO, lerSessao } from "@/lib/sessao";

/**
 * Casca do app autenticado.
 *
 * Não há barra superior global: no mockup cada tela traz o próprio cabeçalho
 * (`.vhead`), com título, subtítulo e o indicador ao vivo quando faz sentido.
 * Repetir um header fixo por cima disso empurraria todo o conteúdo para baixo
 * e duplicaria o título.
 *
 * O service worker é registrado AQUI, e não no layout raiz, de propósito: ele
 * pré-carrega as quatro abas na instalação, e essas rotas exigem sessão. Sendo
 * registrado no /login, o precache pegava só redirecionamentos para o próprio
 * login — e o app não abria offline.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const sessao = await lerSessao((await cookies()).get(COOKIE_SESSAO)?.value);
  // Gate real de sessao (quick-260816-u5-fix, WR-02): o proxy.ts NAO e compilado
  // como middleware nesta versao do Next (middleware-manifest.json vazio), entao
  // travamos aqui no layout — sem sessao valida, qualquer rota autenticada (/,
  // /base, /fila, /perfil) volta pro login.
  if (!sessao) redirect("/login");
  const papel = sessao?.papel ?? "atendente";
  return (
    <>
      <BootDados />
      <main className="app-main">
        <PageTransition>{children}</PageTransition>
      </main>
      <TabBar papel={papel} />
      <RegisterSW />
    </>
  );
}
