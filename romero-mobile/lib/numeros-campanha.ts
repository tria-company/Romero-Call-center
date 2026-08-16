"use client";

import * as React from "react";

/* Números REAIS do dashboard do gestor (cadastros + votos confirmados/apoiadores),
   servidos por /api/mobile/painel-numeros. `votosPopulados=false` significa que o
   espelho ainda não foi backfillado (reload do PostgREST pendente) — a UI mostra
   "—" nesses números em vez de um zero enganoso. `cadastros` vem do ClickUp (real). */

interface Resposta {
  cadastros: number | null;
  votosPopulados: boolean;
  votosRomero: number;
  votosAndressa: number;
  apoiadores: number;
}

export interface NumerosCampanha extends Resposta {
  carregando: boolean;
  erro: boolean;
}

export function useNumerosCampanha(): NumerosCampanha {
  const [d, setD] = React.useState<Resposta | null>(null);
  const [carregando, setCarregando] = React.useState(true);
  const [erro, setErro] = React.useState(false);

  React.useEffect(() => {
    let vivo = true;
    fetch("/api/mobile/painel-numeros", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Resposta | null) => {
        if (!vivo) return;
        if (j && typeof j === "object" && !("erro" in j)) setD(j);
        else setErro(true);
      })
      .catch(() => {
        if (vivo) setErro(true);
      })
      .finally(() => {
        if (vivo) setCarregando(false);
      });
    return () => {
      vivo = false;
    };
  }, []);

  return {
    cadastros: d?.cadastros ?? null,
    votosPopulados: Boolean(d?.votosPopulados),
    votosRomero: d?.votosRomero ?? 0,
    votosAndressa: d?.votosAndressa ?? 0,
    apoiadores: d?.apoiadores ?? 0,
    carregando,
    erro,
  };
}
