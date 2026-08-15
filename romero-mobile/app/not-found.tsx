import type { Metadata } from "next";
import { Marca } from "@/components/brand/Marca";

export const metadata: Metadata = { title: "Tela não encontrada" };

/**
 * 404 do app.
 *
 * Existe porque REMOVER TELA DEIXA ATALHO PARA TRÁS. Quem instalou o PWA antes
 * da remoção da Equipe tem o atalho antigo no launcher: tocar nele abre uma
 * janela standalone em `/equipe`, e sem este arquivo o Next entrega a página
 * nativa dele — fundo branco, "This page could not be found." em inglês, sem
 * barra de abas e sem link de volta. Dentro de um app instalado, isso é um beco
 * sem saída: não há barra de endereço para digitar outra coisa.
 *
 * Fica na RAIZ de `app/`, e não em `(app)/`: URL que não casa com rota nenhuma
 * não pertence a grupo nenhum, então é a raiz que a captura. Por isso a casca
 * autenticada (TabBar, PageTransition) não está aqui — o desenho segue o mesmo
 * padrão de `/offline`, que também vive fora dela.
 */
export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "24px 20px",
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: 330 }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Marca size={54} showName={false} />
        </div>
        <h1 style={{ marginTop: 16, fontSize: 20, fontWeight: 800, letterSpacing: "-.02em" }}>
          Essa tela não existe mais
        </h1>
        <p className="dim" style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.6 }}>
          O endereço pode ter vindo de um atalho antigo, de antes de o app mudar. O Início tem
          tudo o que continua aqui.
        </p>
        <a href="/" className="cta" style={{ marginTop: 20, display: "block" }}>
          Ir para o Início
        </a>
      </div>
    </main>
  );
}
