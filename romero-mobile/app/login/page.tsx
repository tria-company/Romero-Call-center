import type { Metadata } from "next";
import { FormularioLogin } from "./FormularioLogin";
import { Patinha } from "@/components/brand/Marca";

export const metadata: Metadata = { title: "Entrar · Central Animal" };

export default function LoginPage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "calc(24px + var(--safe-t)) 20px calc(24px + var(--safe-b))",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* patinhas de fundo, bem apagadas: dão textura sem competir com o form */}
      <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {[
          { x: "10%", y: "12%", s: 118, r: -22 },
          { x: "78%", y: "8%", s: 84, r: 16 },
          { x: "82%", y: "74%", s: 138, r: -8 },
          { x: "6%", y: "78%", s: 94, r: 24 },
        ].map((p, i) => (
          <span
            key={i}
            style={{
              position: "absolute",
              left: p.x,
              top: p.y,
              color: "var(--romero)",
              opacity: 0.06,
              transform: `rotate(${p.r}deg)`,
            }}
          >
            <Patinha size={p.s} />
          </span>
        ))}
      </div>

      <FormularioLogin />
    </main>
  );
}
