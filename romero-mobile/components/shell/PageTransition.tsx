"use client";

import { usePathname } from "next/navigation";

/**
 * Transição entre rotas. `key={pathname}` força a remontagem, e a animação
 * `reveal-up` roda do zero a cada navegação — barato, previsível e desligado
 * sozinho sob prefers-reduced-motion (clamp global em globals.css).
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div
      key={pathname}
      style={{ animation: "reveal-up 300ms var(--ease-out-soft)" }}
    >
      {children}
    </div>
  );
}
