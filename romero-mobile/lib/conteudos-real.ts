"use client";

/* ══════════════════════════════════════════════════════════════════════════
   conteudos-real — biblioteca de CONTEÚDOS/links prontos (Fase 2 do roadmap).
   Fonte: /api/mobile/conteudos (rotas-ponte romero-only) — nunca fala direto com
   o backend do discador. LGPD: sem dado pessoal (só título/categoria/texto/url).
   ══════════════════════════════════════════════════════════════════════════ */

export type ConteudoTipo = "texto" | "link";

export type ConteudoReal = {
  id: string;
  categoria: string | null;
  titulo: string;
  tipo: ConteudoTipo;
  texto: string | null;
  url: string | null;
  ordem: number;
};

/** Campos aceitos ao criar/editar um conteúdo (tela de gestão, Fatia 3). */
export type ConteudoInputReal = {
  categoria?: string | null;
  titulo: string;
  tipo: ConteudoTipo;
  texto?: string | null;
  url?: string | null;
  ordem?: number;
};

/** Lista os conteúdos ATIVOS da biblioteca. Falha/indisponível → [] (a UI degrada). */
export async function listarConteudos(categoria?: string): Promise<ConteudoReal[]> {
  try {
    const qs = categoria ? `?categoria=${encodeURIComponent(categoria)}` : "";
    const r = await fetch(`/api/mobile/conteudos${qs}`, { cache: "no-store" });
    if (!r.ok) return [];
    const d = (await r.json().catch(() => null)) as { conteudos?: ConteudoReal[] } | null;
    return d && Array.isArray(d.conteudos) ? d.conteudos : [];
  } catch {
    return [];
  }
}

/** Cria um conteúdo (gestão). Retorna a linha criada ou null em falha. */
export async function criarConteudo(dados: ConteudoInputReal): Promise<ConteudoReal | null> {
  try {
    const r = await fetch(`/api/mobile/conteudos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(dados),
    });
    if (!r.ok) return null;
    const d = (await r.json().catch(() => null)) as { conteudo?: ConteudoReal } | null;
    return d?.conteudo ?? null;
  } catch {
    return null;
  }
}

/** Edita um conteúdo por id (gestão). Retorna a linha atualizada ou null. */
export async function atualizarConteudo(
  id: string,
  dados: Partial<ConteudoInputReal>,
): Promise<ConteudoReal | null> {
  try {
    const r = await fetch(`/api/mobile/conteudos/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(dados),
    });
    if (!r.ok) return null;
    const d = (await r.json().catch(() => null)) as { conteudo?: ConteudoReal } | null;
    return d?.conteudo ?? null;
  } catch {
    return null;
  }
}

/** Exclui (soft-delete) um conteúdo por id (gestão). true se aceito. */
export async function excluirConteudo(id: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/mobile/conteudos/${encodeURIComponent(id)}`, {
      method: "DELETE",
      cache: "no-store",
    });
    return r.ok;
  } catch {
    return false;
  }
}
