"use client";

import * as React from "react";

/* ══════════════════════════════════════════════════════════════════════════
   useMetricasReais — as métricas de operação ao vivo servidas por
   /api/mobile/metricas.

   A fonte é o backend do discador (`GET /api/admin/metricas`), atravessado pela
   rota-ponte que segura o token server-side. Extrai só os quatro números que a
   Home mostra (atendentes online, chamadas ativas, profundidade da fila, erros
   do dia); thresholds e taxa por etapa são ignorados. Estados distintos para
   carregando/erro/semAcesso, para a Home dar o feedback certo sem quebrar.
   Nenhum log de PII/token (LGPD).
   ══════════════════════════════════════════════════════════════════════════ */

export type MetricasReais = {
  atendentesOnline: number;
  chamadasAtivas: number;
  profundidadeFila: number;
  errosDia: number;
};

export type EstadoMetricasReais = {
  metricas: MetricasReais | null;
  carregando: boolean;
  erro: boolean;
  semAcesso: boolean;
  recarregar: () => void;
};

/** Número seguro: aceita só finitos; qualquer outra coisa vira 0. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function useMetricasReais(): EstadoMetricasReais {
  const [metricas, setMetricas] = React.useState<MetricasReais | null>(null);
  const [carregando, setCarregando] = React.useState(true);
  const [erro, setErro] = React.useState(false);
  const [semAcesso, setSemAcesso] = React.useState(false);

  // Guarda de vida entre carregamentos: um fetch que volta após o unmount (ou
  // depois de um recarregar mais novo) não pode escrever no estado.
  const vivoRef = React.useRef(true);

  const carregar = React.useCallback(async () => {
    setCarregando(true);
    setErro(false);
    setSemAcesso(false);
    try {
      const r = await fetch("/api/mobile/metricas", { cache: "no-store" });
      if (!vivoRef.current) return;
      if (r.status === 403) {
        setSemAcesso(true);
        setMetricas(null);
        return;
      }
      if (!r.ok) {
        setErro(true);
        setMetricas(null);
        return;
      }
      const d = (await r.json().catch(() => null)) as Record<string, unknown> | null;
      if (!vivoRef.current) return;
      if (!d) {
        setErro(true);
        setMetricas(null);
        return;
      }
      setMetricas({
        atendentesOnline: num(d.atendentesOnline),
        chamadasAtivas: num(d.chamadasAtivas),
        profundidadeFila: num(d.profundidadeFila),
        errosDia: num(d.errosDia),
      });
    } catch {
      if (vivoRef.current) {
        setErro(true);
        setMetricas(null);
      }
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

  return { metricas, carregando, erro, semAcesso, recarregar: carregar };
}
