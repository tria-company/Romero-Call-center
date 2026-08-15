"use client";

import * as React from "react";

/**
 * A COLUNA-FOGUETE — o elemento assinatura do sistema, herdado do painel de
 * referência: a meta é uma coluna que enche e a nave sobe junto.
 *
 * O preenchimento começa em zero e só depois vai ao valor real; sem esse
 * quadro inicial em zero, a transição de `height` não teria de onde partir e
 * a coluna apareceria cheia, sem subir.
 */
export function Foguete({ pct }: { pct: number }) {
  const [subiu, setSubiu] = React.useState(false);
  const alvo = Math.max(0, Math.min(100, pct));

  React.useEffect(() => {
    const t = setTimeout(() => setSubiu(true), 240);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="rocket" aria-hidden>
      <div className="tick" style={{ bottom: "25%" }} />
      <div className="tick" style={{ bottom: "50%" }} />
      <div className="tick" style={{ bottom: "75%" }} />
      <div className="fill" style={{ height: subiu ? `${alvo}%` : 0 }} />
      <div className="ship" style={{ bottom: subiu ? `${alvo}%` : 0 }}>
        🚀
      </div>
    </div>
  );
}
