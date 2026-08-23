// server-only: nunca importar como VALOR em componente client — só `import type`.
//
// Este módulo faz as chamadas ao backend do discador com o Bearer do PRÓPRIO
// usuário (o `dToken` da sessão). `server-only` NÃO está instalado no projeto,
// então a proteção é por convenção: componentes client só podem usar o TIPO
// exportado (`import type { ItemFilaReal }`), nunca o `chamarDiscador`.

/**
 * Base do call center. Mesma leitura/normalização de
 * `app/api/callcenter/token/route.ts` (default público, sem barra final).
 */
export const BASE_DISCADOR = (
  process.env.CALLCENTER_URL ?? "https://romero-call-center.vercel.app"
).replace(/\/+$/, "");

/**
 * Contrato de um item da fila real — espelha o `ItemFila` do backend do discador
 * (`src/mastra/lote.ts`). Consumido pela rota-ponte e (só como tipo) pelo hook.
 * `leadTaskId` é o task-id REAL do lead (Lista 01) — a chave da ficha /base/:id;
 * `idLead` é a chave de dedupe (id GHL na maioria) e NÃO abre ficha. Opcional
 * porque um backend anterior ao campo pode ainda não mandá-lo.
 */
export type ItemFilaReal = {
  taskId: string;
  nome: string;
  telefone: string;
  idLead: string;
  leadTaskId?: string;
};

/* ══════════════════════════════════════════════════════════════════════════
   PONTE GENÉRICA para as rotas de LEAD do backend do discador (B1).

   As rotas-ponte (`app/api/mobile/leads`, `.../lead/*`, `.../timeline/*`)
   compartilham o mesmo fluxo: chamada Bearer com o token do PRÓPRIO usuário →
   repasse do status TAL QUAL para a UI distinguir 401/403/404/502.
   `chamarDiscador` centraliza isso; a rota só escolhe caminho/método/corpo e
   devolve `r.dados` com `r.status`. O token vem da sessão (`gate.sessao.dToken`)
   e NUNCA é logado.

   LGPD: nunca logar token, telefone nem cpf.
   ══════════════════════════════════════════════════════════════════════════ */

export type RespostaDiscador = { ok: boolean; status: number; dados: unknown };

/**
 * Chama uma rota do backend do discador com o Bearer do PRÓPRIO usuário.
 *
 * · `caminho` é relativo à `BASE_DISCADOR` (ex.: "/api/discador/leads?q=x").
 * · `dToken` é o token do usuário logado (`gate.sessao.dToken`) — o backend
 *   aplica o gate de papel (gestor/atendente) por esse token.
 * · sem token → `502` estável.
 * · devolve sempre `{ ok, status, dados }`; o status é o do backend (para o
 *   repasse fiel de 401/403/404), ou `502` em falha de rede/timeout.
 * · NUNCA lança e NUNCA loga token/telefone/cpf.
 */
export async function chamarDiscador(
  caminho: string,
  dToken: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<RespostaDiscador> {
  if (!dToken) {
    return { ok: false, status: 502, dados: { erro: "Call center inacessível." } };
  }
  const token = dToken;

  const temCorpo = init?.body !== undefined;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (temCorpo) headers["Content-Type"] = "application/json";

  try {
    const r = await fetch(`${BASE_DISCADOR}${caminho}`, {
      method: init?.method ?? "GET",
      headers,
      body: temCorpo ? JSON.stringify(init!.body) : undefined,
      cache: "no-store",
      // 8s cobre as rotas rápidas; chamadas sabidamente lentas (a lista de
      // áudios varre o ClickUp por ~15s) passam um teto maior — senão a ponte
      // aborta ANTES do backend responder e a UI vê 502 eterno.
      signal: AbortSignal.timeout(init?.timeoutMs ?? 8000),
    });
    const dados = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, dados };
  } catch {
    return { ok: false, status: 502, dados: { erro: "Call center inacessível." } };
  }
}

/* ── Contratos espelhando o backend B1 (reuso: ponte + tipo no hook) ─────── */

/** Voto de confirmação (Romero/Andressa) no backend. */
export type VotoReal = "sim" | "nao" | "naoDeclarou";

/** Resumo de lead da listagem (`GET /api/discador/leads`). Visão do gestor: telefone e CPF em claro. */
export type LeadResumoReal = {
  leadTaskId: string;
  nome: string;
  telefone: string;
  cpf: string;
  bairro: string;
  cidade: string;
  confirmouRomero: VotoReal | null;
  confirmouAndressa: VotoReal | null;
  militante: boolean;
  semContato: boolean;
  /** Fase 3: o Romero já iniciou conversa com este lead (histórico de relacionamento). */
  romeroJaFalou: boolean;
};

/** Item da timeline de ligações de um lead (`timeline`). */
export type ItemTimelineReal = {
  data: string;
  atendeu: boolean;
  aderencia: string;
  resumoAnalise: string;
  motivoFalha: string;
  /** DURACAO formatada ("Xmin Ys"): atendida = tempo de conversa; não atendida
   * = tempo de tentativa (u13). '' quando o ClickUp ainda não tem a duração. */
  duracao: string;
};

/** Ficha completa de um lead (`GET /api/discador/lead/:id`). Visão do gestor: telefone e CPF em claro. */
export type LeadFichaReal = {
  lead: {
    leadTaskId: string;
    nome: string;
    telefone: string;
    cpf: string;
    bairro: string;
    cidade: string;
    uf: string;
    confirmouRomero: VotoReal | null;
    confirmouAndressa: VotoReal | null;
    militante: boolean;
    observacao: string;
    ultimoContato: string | null;
    proximoContato: string | null;
  };
  dossie: unknown;
  timeline: ItemTimelineReal[];
};
