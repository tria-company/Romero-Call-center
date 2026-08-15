"use client";

import * as React from "react";
// `import type` OBRIGATÓRIO: importar como valor arrastaria o código de
// credencial (`obterTokenDiscador`) para o bundle do cliente.
import type { ItemFilaReal } from "@/lib/discador-servidor";

/* ══════════════════════════════════════════════════════════════════════════
   useFilaReal — a fila do dia servida por /api/mobile/fila.

   Substitui o `useFila` do store local (localStorage): a fonte agora é o
   backend do discador. Estados distintos para carregando/erro/semMapeamento,
   para a tela dar o feedback certo. Nenhum log de telefone (LGPD).
   ══════════════════════════════════════════════════════════════════════════ */

export type EstadoFilaReal = {
  itens: ItemFilaReal[];
  carregando: boolean;
  erro: boolean;
  semMapeamento: boolean;
  recarregar: () => void;
};

export function useFilaReal(): EstadoFilaReal {
  const [itens, setItens] = React.useState<ItemFilaReal[]>([]);
  const [carregando, setCarregando] = React.useState(true);
  const [erro, setErro] = React.useState(false);
  const [semMapeamento, setSemMapeamento] = React.useState(false);

  // Guarda de vida entre carregamentos: um fetch que volta após o unmount (ou
  // depois de um recarregar mais novo) não pode escrever no estado.
  const vivoRef = React.useRef(true);

  const carregar = React.useCallback(async () => {
    setCarregando(true);
    setErro(false);
    try {
      const r = await fetch("/api/mobile/fila", { cache: "no-store" });
      if (!vivoRef.current) return;
      if (!r.ok) {
        setErro(true);
        setItens([]);
        setSemMapeamento(false);
        return;
      }
      const d = (await r.json().catch(() => null)) as
        | { fila?: ItemFilaReal[]; semMapeamento?: boolean }
        | null;
      if (!vivoRef.current) return;
      setItens(d?.fila ?? []);
      setSemMapeamento(d?.semMapeamento === true);
    } catch {
      if (vivoRef.current) setErro(true);
    } finally {
      if (vivoRef.current) setCarregando(false);
    }
  }, []);

  React.useEffect(() => {
    vivoRef.current = true;
    void carregar();
    return () => {
      vivoRef.current = false;
    };
  }, [carregar]);

  return { itens, carregando, erro, semMapeamento, recarregar: carregar };
}
