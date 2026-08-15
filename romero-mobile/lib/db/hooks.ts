"use client";

import { useMemo, useSyncExternalStore } from "react";
import * as store from "./store";
import {
  MOTIVO_PESO,
  atrasada,
  horasAtePrazo,
  solicitacaoAberta,
  type Banco,
  type CandidatoId,
  type Interacao,
  type ItemFila,
  type Lead,
  type Solicitacao,
} from "./schema";
import { mesmoDia } from "@/lib/format";
import { semAcento } from "@/lib/texto";

/** Snapshot reativo da base. `null` até o cliente hidratar. */
export function useBanco(): Banco | null {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

/* ── Candidatos ────────────────────────────────────────────────────────── */

export function useCandidatos() {
  const b = useBanco();
  return b?.candidatos ?? [];
}

export function useCandidato(id: CandidatoId) {
  const b = useBanco();
  return b?.candidatos.find((c) => c.id === id) ?? null;
}

/* ── Leads ─────────────────────────────────────────────────────────────── */

export function useLead(id: string | null | undefined): Lead | null {
  const b = useBanco();
  return useMemo(() => (b && id ? (b.leads.find((l) => l.id === id) ?? null) : null), [b, id]);
}

export type FiltroBase = {
  busca?: string;
  /** 'todos' | 'multiplicadoras' | 'romero' | 'andreza' | 'sem-contato' */
  recorte?: string;
};

export function useLeads(f: FiltroBase = {}): Lead[] | null {
  const b = useBanco();
  const { busca, recorte } = f;
  return useMemo(() => {
    if (!b) return null;
    let out = b.leads;

    if (recorte === "multiplicadoras") out = out.filter((l) => l.multiplicadora);
    else if (recorte === "romero") out = out.filter((l) => l.confirmou.includes("romero"));
    else if (recorte === "andreza") out = out.filter((l) => l.confirmou.includes("andreza"));
    else if (recorte === "sem-contato") out = out.filter((l) => !l.ultimoContatoEm);

    const q = busca?.trim();
    if (q) {
      const alvo = semAcento(q);
      const digitos = q.replace(/\D/g, "");
      out = out.filter(
        (l) =>
          semAcento(l.nome).includes(alvo) ||
          semAcento(l.bairro).includes(alvo) ||
          semAcento(l.cidade).includes(alvo) ||
          l.pets.some((p) => semAcento(p.nome).includes(alvo)) ||
          (digitos.length >= 3 && l.whatsapp.includes(digitos)),
      );
    }

    return [...out].sort((a, c) => a.nome.localeCompare(c.nome, "pt-BR"));
  }, [b, busca, recorte]);
}

export function useAtendimentos(leadId: string | null | undefined) {
  const b = useBanco();
  return useMemo(
    () =>
      b && leadId
        ? b.atendimentos.filter((a) => a.leadId === leadId).sort((x, y) => y.em.localeCompare(x.em))
        : [],
    [b, leadId],
  );
}

export function useInteracoes(leadId: string | null | undefined): Interacao[] {
  const b = useBanco();
  return useMemo(
    () =>
      b && leadId
        ? b.interacoes.filter((i) => i.leadId === leadId).sort((x, y) => y.em.localeCompare(x.em))
        : [],
    [b, leadId],
  );
}

/**
 * Bloqueio de repetição: houve envio SEU para este lead hoje?
 * É a regra que a tela 04 anuncia — o sistema avisa antes de deixar enviar de
 * novo, para o apoiador não receber dois disparos no mesmo dia.
 */
export function useBloqueioRepeticao(leadId: string | null | undefined) {
  const interacoes = useInteracoes(leadId);
  return useMemo(() => {
    const agora = new Date();
    // Bloqueia se houve QUALQUER contato hoje — inclusive uma entrega da
    // equipe. Quem acabou de receber a castração já ouviu do gabinete hoje;
    // mandar vídeo por cima é a repetição que a regra existe para evitar.
    const bloqueado = interacoes.some((i) => mesmoDia(i.em, agora));
    // Para o texto, o que interessa é o último ENVIO nosso.
    const ultimo =
      interacoes.find(
        (i) => i.autor !== "equipe" && ["mensagem", "video", "audio", "ligacao"].includes(i.tipo),
      ) ?? null;
    return { bloqueado, ultimo };
  }, [interacoes]);
}

/* ── Fila ──────────────────────────────────────────────────────────────── */

export function useFila(): { itens: ItemFila[]; feitas: number; total: number } {
  const b = useBanco();
  return useMemo(() => {
    if (!b) return { itens: [], feitas: 0, total: 0 };
    const itens = [...b.fila].sort((a, c) => {
      if (a.feito !== c.feito) return a.feito ? 1 : -1;
      return MOTIVO_PESO[a.motivo] - MOTIVO_PESO[c.motivo];
    });
    return {
      itens,
      feitas: itens.filter((i) => i.feito).length,
      total: itens.length,
    };
  }, [b]);
}

/* ── Solicitações ──────────────────────────────────────────────────────── */

export function useSolicitacoes() {
  const b = useBanco();
  return useMemo(() => {
    if (!b) return { abertas: [] as Solicitacao[], todas: [] as Solicitacao[] };
    const abertas = b.solicitacoes
      .filter(solicitacaoAberta)
      .sort((a, c) => new Date(a.prazo).getTime() - new Date(c.prazo).getTime());
    return { abertas, todas: b.solicitacoes };
  }, [b]);
}

export function useSolicitacoesDoLead(leadId: string | null | undefined) {
  const b = useBanco();
  return useMemo(
    () =>
      b && leadId
        ? b.solicitacoes
            .filter((s) => s.leadId === leadId)
            .sort((a, c) => c.criadaEm.localeCompare(a.criadaEm))
        : [],
    [b, leadId],
  );
}

/* ── Números das telas ─────────────────────────────────────────────────── */

export type Indicadores = {
  cadastros: number;
  apoiadoresAtivos: number;
  apoiadoresHoje: number;
  filaTotal: number;
  filaFeitas: number;
  filaRestante: number;
  abertas: number;
  vencendoHoje: number;
  atrasadas: number;
  dentroDoPrazoPct: number;
  /** minutos estimados para terminar a fila (4 min por contato — 35 → 2h20) */
  minutosRestantes: number;
};

export function useIndicadores(): Indicadores | null {
  const b = useBanco();
  return useMemo(() => {
    if (!b) return null;
    const agora = new Date();

    const feitas = b.fila.filter((f) => f.feito).length;
    const total = b.fila.length;

    const abertas = b.solicitacoes.filter(solicitacaoAberta);
    const vencendoHoje = abertas.filter((s) => horasAtePrazo(s, agora) <= 24).length;

    const resolvidas = b.solicitacoes.filter((s) => s.status === "resolvida" && s.resolvidaEm);
    const noPrazo = resolvidas.filter(
      (s) => new Date(s.resolvidaEm!).getTime() <= new Date(s.prazo).getTime(),
    ).length;

    return {
      cadastros: b.painel.cadastros,
      apoiadoresAtivos: b.painel.apoiadoresAtivos,
      apoiadoresHoje: b.painel.apoiadoresHoje,
      filaTotal: total,
      filaFeitas: feitas,
      filaRestante: total - feitas,
      abertas: abertas.length,
      vencendoHoje,
      atrasadas: abertas.filter((s) => atrasada(s, agora)).length,
      dentroDoPrazoPct: resolvidas.length ? Math.round((noPrazo / resolvidas.length) * 100) : 100,
      minutosRestantes: (total - feitas) * 4,
    };
  }, [b]);
}
