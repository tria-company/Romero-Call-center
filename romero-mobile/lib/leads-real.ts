"use client";

import * as React from "react";
// `import type` OBRIGATÓRIO: importar como valor arrastaria o código de
// credencial (`obterTokenDiscador`/`chamarDiscador`) para o bundle do cliente.
import type {
  LeadResumoReal,
  LeadFichaReal,
  ItemTimelineReal,
  VotoReal,
} from "@/lib/discador-servidor";

/* ══════════════════════════════════════════════════════════════════════════
   leads-real — hooks/mutations client servidos por /api/mobile/*.

   O token do discador NUNCA passa por aqui: o hook só fala com as rotas-ponte
   do Next. Cada estado distingue carregando/erro/semAcesso para a UI dar o
   feedback certo — `semAcesso` (status 403) = backend sem DISCADOR_LEAD_BROWSE.
   Nenhum log de telefone/cpf (LGPD).
   ══════════════════════════════════════════════════════════════════════════ */

export type Voto = VotoReal;

const CABECALHO_JSON = { "Content-Type": "application/json" } as const;

/* ── Lista de leads ──────────────────────────────────────────────────────── */

export type EstadoLeadsReais = {
  leads: LeadResumoReal[];
  carregando: boolean;
  erro: boolean;
  semAcesso: boolean;
  recarregar: () => void;
};

/**
 * Lista os leads reais. Refaz o fetch quando `busca` muda (com guarda de vida),
 * debouncado ~300ms para não bater a cada tecla. `semAcesso=true` no 403.
 */
export function useLeadsReais(opts: { busca?: string } = {}): EstadoLeadsReais {
  const busca = opts.busca ?? "";

  const [leads, setLeads] = React.useState<LeadResumoReal[]>([]);
  const [carregando, setCarregando] = React.useState(true);
  const [erro, setErro] = React.useState(false);
  const [semAcesso, setSemAcesso] = React.useState(false);

  const vivoRef = React.useRef(true);

  const carregar = React.useCallback(async (termo: string) => {
    setCarregando(true);
    setErro(false);
    setSemAcesso(false);
    try {
      const q = termo ? `?q=${encodeURIComponent(termo)}` : "";
      const r = await fetch(`/api/mobile/leads${q}`, { cache: "no-store" });
      if (!vivoRef.current) return;
      if (r.status === 403) {
        setSemAcesso(true);
        setLeads([]);
        return;
      }
      if (!r.ok) {
        setErro(true);
        setLeads([]);
        return;
      }
      const d = (await r.json().catch(() => null)) as { leads?: LeadResumoReal[] } | null;
      if (!vivoRef.current) return;
      setLeads(d?.leads ?? []);
    } catch {
      if (vivoRef.current) setErro(true);
    } finally {
      if (vivoRef.current) setCarregando(false);
    }
  }, []);

  React.useEffect(() => {
    vivoRef.current = true;
    const t = setTimeout(() => void carregar(busca), 300);
    return () => {
      vivoRef.current = false;
      clearTimeout(t);
    };
  }, [busca, carregar]);

  const recarregar = React.useCallback(() => {
    void carregar(busca);
  }, [busca, carregar]);

  return { leads, carregando, erro, semAcesso, recarregar };
}

/* ── Ficha de um lead ────────────────────────────────────────────────────── */

export type EstadoLeadReal = {
  ficha: LeadFichaReal | null;
  carregando: boolean;
  erro: boolean;
  semAcesso: boolean;
  recarregar: () => void;
};

/** Carrega a ficha completa de um lead. `id` null → não busca (estado ocioso). */
export function useLeadReal(leadTaskId: string | null): EstadoLeadReal {
  const [ficha, setFicha] = React.useState<LeadFichaReal | null>(null);
  const [carregando, setCarregando] = React.useState(leadTaskId !== null);
  const [erro, setErro] = React.useState(false);
  const [semAcesso, setSemAcesso] = React.useState(false);

  const vivoRef = React.useRef(true);

  const carregar = React.useCallback(async (id: string | null) => {
    if (!id) {
      setFicha(null);
      setCarregando(false);
      setErro(false);
      setSemAcesso(false);
      return;
    }
    setCarregando(true);
    setErro(false);
    setSemAcesso(false);
    try {
      const r = await fetch(`/api/mobile/lead/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!vivoRef.current) return;
      if (r.status === 403) {
        setSemAcesso(true);
        setFicha(null);
        return;
      }
      if (!r.ok) {
        setErro(true);
        setFicha(null);
        return;
      }
      const d = (await r.json().catch(() => null)) as LeadFichaReal | null;
      if (!vivoRef.current) return;
      setFicha(d ?? null);
    } catch {
      if (vivoRef.current) setErro(true);
    } finally {
      if (vivoRef.current) setCarregando(false);
    }
  }, []);

  React.useEffect(() => {
    vivoRef.current = true;
    void carregar(leadTaskId);
    return () => {
      vivoRef.current = false;
    };
  }, [leadTaskId, carregar]);

  const recarregar = React.useCallback(() => {
    void carregar(leadTaskId);
  }, [leadTaskId, carregar]);

  return { ficha, carregando, erro, semAcesso, recarregar };
}

/* ── Timeline por taskId (path-fila IDOR-safe; opcional p/ B4) ────────────── */

export type EstadoTimelineReal = {
  timeline: ItemTimelineReal[];
  carregando: boolean;
  erro: boolean;
  recarregar: () => void;
};

/**
 * Timeline de ligações por `taskId` (não depende do browse-flag do backend).
 * A ficha (`useLeadReal`) já traz a timeline; este hook é para o path-fila.
 */
export function useTimelineReal(taskId: string | null): EstadoTimelineReal {
  const [timeline, setTimeline] = React.useState<ItemTimelineReal[]>([]);
  const [carregando, setCarregando] = React.useState(taskId !== null);
  const [erro, setErro] = React.useState(false);

  const vivoRef = React.useRef(true);

  const carregar = React.useCallback(async (id: string | null) => {
    if (!id) {
      setTimeline([]);
      setCarregando(false);
      setErro(false);
      return;
    }
    setCarregando(true);
    setErro(false);
    try {
      const r = await fetch(`/api/mobile/timeline/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!vivoRef.current) return;
      if (!r.ok) {
        setErro(true);
        setTimeline([]);
        return;
      }
      const d = (await r.json().catch(() => null)) as { timeline?: ItemTimelineReal[] } | null;
      if (!vivoRef.current) return;
      setTimeline(d?.timeline ?? []);
    } catch {
      if (vivoRef.current) setErro(true);
    } finally {
      if (vivoRef.current) setCarregando(false);
    }
  }, []);

  React.useEffect(() => {
    vivoRef.current = true;
    void carregar(taskId);
    return () => {
      vivoRef.current = false;
    };
  }, [taskId, carregar]);

  const recarregar = React.useCallback(() => {
    void carregar(taskId);
  }, [taskId, carregar]);

  return { timeline, carregando, erro, recarregar };
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

/** Registra voto de confirmação. `true` se o backend aceitou (2xx). */
export async function salvarVotoReal(
  leadTaskId: string,
  patch: { romero?: Voto; andressa?: Voto },
): Promise<boolean> {
  try {
    const r = await fetch(`/api/mobile/lead/${encodeURIComponent(leadTaskId)}/voto`, {
      method: "POST",
      headers: CABECALHO_JSON,
      body: JSON.stringify(patch),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Grava uma anotação no lead. `true` se o backend aceitou (2xx). */
export async function salvarAnotacaoReal(leadTaskId: string, texto: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/mobile/lead/${encodeURIComponent(leadTaskId)}/anotacao`, {
      method: "POST",
      headers: CABECALHO_JSON,
      body: JSON.stringify({ texto }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Cria a Ligação para o lead (quick-260815-r3) — avulsa atribuída ao operador
 * no backend do discador — e devolve o `taskId` pro deep-link do call center.
 * `null` em qualquer erro (call center fora do ar, sem telefone, sem papel) —
 * o caller degrada abrindo a fila normal. Nunca lança.
 */
export async function iniciarLigacaoReal(leadTaskId: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/mobile/lead/${encodeURIComponent(leadTaskId)}/ligar`, {
      method: "POST",
      headers: CABECALHO_JSON,
    });
    if (!r.ok) return null;
    const d = (await r.json().catch(() => null)) as { taskId?: string } | null;
    return d?.taskId ?? null;
  } catch {
    return null;
  }
}
