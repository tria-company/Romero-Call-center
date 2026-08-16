"use client";

import * as React from "react";
// `import type` OBRIGATÓRIO: importar como valor arrastaria o código de
// servidor (`chamarDiscador`) para o bundle do cliente.
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
  carregando: boolean; // carga inicial (página 0)
  carregandoMais: boolean; // buscando a próxima página
  temMais: boolean; // há um próximo cursor pra carregar
  total: number | null; // total REAL da base (task_count do ClickUp); null quando desconhecido
  erro: boolean;
  semAcesso: boolean;
  recarregar: () => void;
  carregarMais: () => void;
};

/**
 * Lista os leads reais com PAGINAÇÃO POR CURSOR (u9). Carrega a página 0 e, via
 * `carregarMais()`, busca a próxima página (`cursor`) e ANEXA — o scroll infinito
 * da Base chama isso conforme rola, então a base inteira do ClickUp entra aos
 * poucos. Refaz do zero (nova geração) quando `busca` muda — debounce ~300ms.
 *
 * `geracaoRef` é a guarda de corrida: cada fetch captura a geração no início e só
 * aplica o resultado se ela ainda for a atual. Assim, se a busca muda no meio de
 * um `carregarMais`, o append velho é DESCARTADO (não polui a nova lista).
 * `semAcesso=true` no 403. Nunca loga telefone/cpf (LGPD).
 */
export function useLeadsReais(opts: { busca?: string } = {}): EstadoLeadsReais {
  const busca = opts.busca ?? "";

  const [leads, setLeads] = React.useState<LeadResumoReal[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [total, setTotal] = React.useState<number | null>(null);
  const [carregando, setCarregando] = React.useState(true);
  const [carregandoMais, setCarregandoMais] = React.useState(false);
  const [erro, setErro] = React.useState(false);
  const [semAcesso, setSemAcesso] = React.useState(false);

  const buscaRef = React.useRef(busca); // termo atual (sem stale closure em carregarMais)
  const cursorRef = React.useRef<string | null>(null);
  const carregandoMaisRef = React.useRef(false); // serializa: uma página por vez
  const geracaoRef = React.useRef(0); // token de geração (invalida fetch em voo)

  // Página 0 (reset): abre uma geração nova e recomeça a paginação do zero.
  const carregar = React.useCallback(async (termo: string) => {
    const g = ++geracaoRef.current;
    buscaRef.current = termo;
    cursorRef.current = null;
    carregandoMaisRef.current = false;
    setCarregando(true);
    setCarregandoMais(false);
    setErro(false);
    setSemAcesso(false);
    try {
      const q = termo ? `?q=${encodeURIComponent(termo)}` : "";
      const r = await fetch(`/api/mobile/leads${q}`, { cache: "no-store" });
      if (geracaoRef.current !== g) return;
      if (r.status === 403) {
        setSemAcesso(true);
        setLeads([]);
        setCursor(null);
        return;
      }
      if (!r.ok) {
        setErro(true);
        setLeads([]);
        setCursor(null);
        return;
      }
      const d = (await r.json().catch(() => null)) as {
        leads?: LeadResumoReal[];
        cursor?: string;
        total?: number;
      } | null;
      if (geracaoRef.current !== g) return;
      setLeads(d?.leads ?? []);
      setTotal(typeof d?.total === "number" ? d.total : null);
      const c = d?.cursor ?? null;
      setCursor(c);
      cursorRef.current = c;
    } catch {
      if (geracaoRef.current === g) setErro(true);
    } finally {
      if (geracaoRef.current === g) setCarregando(false);
    }
  }, []);

  // Próxima página: busca o `cursor` atual e ANEXA. No-op sem cursor ou se já
  // está carregando. Em erro, PARA de paginar (cursor=null) sem apagar a lista.
  const carregarMais = React.useCallback(async () => {
    if (carregandoMaisRef.current) return;
    const c = cursorRef.current;
    if (!c) return;
    const g = geracaoRef.current;
    carregandoMaisRef.current = true;
    setCarregandoMais(true);
    try {
      const termo = buscaRef.current;
      const pre = termo ? `q=${encodeURIComponent(termo)}&` : "";
      const r = await fetch(`/api/mobile/leads?${pre}cursor=${encodeURIComponent(c)}`, {
        cache: "no-store",
      });
      if (geracaoRef.current !== g) return;
      if (!r.ok) {
        setCursor(null);
        cursorRef.current = null;
        return;
      }
      const d = (await r.json().catch(() => null)) as {
        leads?: LeadResumoReal[];
        cursor?: string;
      } | null;
      if (geracaoRef.current !== g) return;
      setLeads((prev) => [...prev, ...(d?.leads ?? [])]);
      const nc = d?.cursor ?? null;
      setCursor(nc);
      cursorRef.current = nc;
    } catch {
      if (geracaoRef.current === g) {
        setCursor(null);
        cursorRef.current = null;
      }
    } finally {
      carregandoMaisRef.current = false;
      if (geracaoRef.current === g) setCarregandoMais(false);
    }
  }, []);

  React.useEffect(() => {
    const t = setTimeout(() => void carregar(busca), 300);
    return () => clearTimeout(t);
  }, [busca, carregar]);

  // Ao desmontar, invalida qualquer fetch em voo (nada aplica resultado depois).
  React.useEffect(() => () => void geracaoRef.current++, []);

  const recarregar = React.useCallback(() => {
    void carregar(buscaRef.current);
  }, [carregar]);

  return {
    leads,
    carregando,
    carregandoMais,
    temMais: cursor !== null,
    total,
    erro,
    semAcesso,
    recarregar,
    carregarMais,
  };
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
