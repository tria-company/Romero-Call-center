"use client";

import * as React from "react";
import { montarCampanha, CAMPANHA_VAZIA, type Campanha, type CampanhaReal } from "./campanha";

/* Telemetria AO VIVO da Central de Campanha, servida por /api/mobile/campanha.

   A tela mostrava "sem dados" desde 15/08 por decisão (commit 93c0a31 trocou a leitura de
   um reais.json estático por `const real = VAZIO`, com a nota "sem telemetria ao vivo").
   Este hook é a fonte que faltava: produção diária, ranking de telefonistas e taxa de
   atendimento, agregados da Lista 02 do ClickUp.

   Revalida a cada INTERVALO_MS e ao voltar para a aba — o painel fica aberto o dia todo e
   precisa mudar sozinho. O backend serve de cache com revalidação em segundo plano, então
   o poll não vira varredura do ClickUp.

   Enquanto a primeira resposta não chega, devolve CAMPANHA_VAZIA: a tela cai no mesmo
   "sem dados" de antes, em vez de piscar números pela metade. */

const INTERVALO_MS = 30000;

export interface CampanhaAoVivo {
  dados: Campanha;
  /** Cru, para os cards que precisam do que o painel derivado não carrega. */
  bruto: CampanhaReal | null;
  semDesfecho: number;
  semOperador: { lig: number; cont: number };
  /** % de atendimento entre as ligações COM desfecho — o denominador honesto. */
  taxaAtendimento: number | null;
  idadeS: number | null;
  carregando: boolean;
  erro: boolean;
  semAcesso: boolean;
}

interface Resposta extends CampanhaReal {
  semDesfecho: number;
  semOperador: { lig: number; cont: number };
  idadeS: number | null;
}

export function useCampanhaReal(): CampanhaAoVivo {
  const [d, setD] = React.useState<Resposta | null>(null);
  const [carregando, setCarregando] = React.useState(true);
  const [erro, setErro] = React.useState(false);
  const [semAcesso, setSemAcesso] = React.useState(false);

  React.useEffect(() => {
    let vivo = true;

    // Revalidação silenciosa: `carregando` só na primeira vez, senão a tela pisca.
    const buscar = async () => {
      try {
        const r = await fetch("/api/mobile/campanha", { cache: "no-store" });
        if (!vivo) return;
        if (r.status === 403) {
          setSemAcesso(true);
          setErro(false);
          return;
        }
        if (!r.ok) {
          setErro(true);
          return;
        }
        const j = (await r.json()) as Resposta;
        if (!vivo) return;
        if (j && typeof j === "object" && !("erro" in j)) {
          setD(j);
          setErro(false);
          setSemAcesso(false);
        } else {
          setErro(true);
        }
      } catch {
        if (vivo) setErro(true);
      } finally {
        if (vivo) setCarregando(false);
      }
    };

    void buscar();
    const id = setInterval(buscar, INTERVALO_MS);
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

  const dados = React.useMemo(() => (d ? montarCampanha(d) : CAMPANHA_VAZIA), [d]);

  // Taxa sobre as ligações COM desfecho. Sobre o total ela ficaria artificialmente baixa:
  // hoje a maioria das ligações não grava desfecho (o contador só sobe quando o closer
  // escolhe o motivo na tela), então o denominador cheio mediria o registro, não o
  // atendimento. `semDesfecho` fica exposto para a tela mostrar o tamanho dessa lacuna.
  const comDesfecho = d ? d.totalLigacoes - d.semDesfecho : 0;
  const taxaAtendimento = d && comDesfecho > 0 ? Math.round((d.totalContatos / comDesfecho) * 100) : null;

  return {
    dados,
    bruto: d,
    semDesfecho: d?.semDesfecho ?? 0,
    semOperador: d?.semOperador ?? { lig: 0, cont: 0 },
    taxaAtendimento,
    idadeS: d?.idadeS ?? null,
    carregando,
    erro,
    semAcesso,
  };
}
