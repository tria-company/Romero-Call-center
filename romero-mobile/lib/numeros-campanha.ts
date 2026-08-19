"use client";

import * as React from "react";

/* Números REAIS do dashboard, servidos por /api/mobile/painel-numeros.
   Cada bloco vem da fonte correta (correção de 18/08/2026):
     cadastros -> POSTGRES (users_romero, 224.5 mil) — antes vinha do task_count da
                  Lista 01 do ClickUp e mostrava 100.007, escondendo 124 mil pessoas.
     votos     -> CLICKUP ao vivo — antes vinha do espelho, um snapshot congelado de
                  17/08 15:30, então voto novo nunca aparecia.
     ligações  -> CLICKUP ao vivo — bloco NOVO; o painel nunca leu a Lista 02.
   `votosPopulados=false` agora significa "não consegui ler os votos", não "espelho
   não backfillado" — a UI segue mostrando "—" em vez de um zero enganoso.

   TEMPO REAL: o hook refaz a leitura a cada INTERVALO_MS e ao voltar para a aba
   (visibilitychange), porque um dashboard aberto o dia todo numa TV precisa mudar
   sozinho. O backend serve de cache com revalidação em segundo plano, então esse
   poll é barato — não vira chamada ao ClickUp a cada 20s. */

const INTERVALO_MS = 20000;

export interface ResumoLigacoes {
  total: number;
  hoje: number;
  atendidasHoje: number;
  naoAtendidasHoje: number;
  /** Ligações de hoje sem desfecho gravado. `hoje - semDesfechoHoje` é o denominador da
   *  taxa de atendimento — o mesmo que a Central de Campanha usa. */
  semDesfechoHoje: number;
  atendidasTotal: number;
  comGravacao: number;
  comTranscricao: number;
  comAnaliseIa: number;
  ultimaEm: string | null;
  parcial: boolean;
}

interface Resposta {
  cadastros: number | null;
  cadastrosIdadeS?: number | null;
  votosPopulados: boolean;
  votosRomero: number;
  votosAndressa: number;
  apoiadores: number;
  votosParcial?: boolean;
  ligacoes?: ResumoLigacoes | null;
  ligacoesIdadeS?: number | null;
}

export interface NumerosCampanha extends Resposta {
  ligacoes: ResumoLigacoes | null;
  carregando: boolean;
  erro: boolean;
}

export function useNumerosCampanha(): NumerosCampanha {
  const [d, setD] = React.useState<Resposta | null>(null);
  const [carregando, setCarregando] = React.useState(true);
  const [erro, setErro] = React.useState(false);

  React.useEffect(() => {
    let vivo = true;

    // Revalidação silenciosa: NÃO liga `carregando` fora da primeira vez, senão a tela
    // pisca a cada 20s. O número só troca quando o novo chega.
    const buscar = () =>
      fetch("/api/mobile/painel-numeros", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: Resposta | null) => {
          if (!vivo) return;
          if (j && typeof j === "object" && !("erro" in j)) {
            setD(j);
            setErro(false);
          } else {
            setErro(true);
          }
        })
        .catch(() => {
          if (vivo) setErro(true);
        })
        .finally(() => {
          if (vivo) setCarregando(false);
        });

    void buscar();
    const id = setInterval(buscar, INTERVALO_MS);
    // Voltar para a aba força leitura na hora: quem reabre o painel quer o número de
    // agora, não o de quando saiu.
    const aoVoltar = () => {
      if (document.visibilityState === "visible") void buscar();
    };
    document.addEventListener("visibilitychange", aoVoltar);

    return () => {
      vivo = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", aoVoltar);
    };
  }, []);

  return {
    cadastros: d?.cadastros ?? null,
    cadastrosIdadeS: d?.cadastrosIdadeS ?? null,
    votosPopulados: Boolean(d?.votosPopulados),
    votosRomero: d?.votosRomero ?? 0,
    votosAndressa: d?.votosAndressa ?? 0,
    apoiadores: d?.apoiadores ?? 0,
    votosParcial: Boolean(d?.votosParcial),
    ligacoes: d?.ligacoes ?? null,
    ligacoesIdadeS: d?.ligacoesIdadeS ?? null,
    carregando,
    erro,
  };
}
