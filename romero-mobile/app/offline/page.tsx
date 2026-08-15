import type { Metadata } from "next";
import { Marca } from "@/components/brand/Marca";

export const metadata: Metadata = { title: "Sem conexão" };

export default function OfflinePage() {
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
          Você está sem conexão
        </h1>
        <p className="dim" style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.6 }}>
          As telas que você já abriu continuam disponíveis. Assim que a internet voltar, o app
          recarrega sozinho.
        </p>
        <a href="/" className="cta" style={{ marginTop: 20, display: "block" }}>
          Tentar de novo
        </a>
      </div>
    </main>
  );
}
