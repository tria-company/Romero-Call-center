// server-only: nunca importar como VALOR em componente client — só `import type`.
//
// Este módulo lê a credencial do call center (CALLCENTER_USUARIO/CALLCENTER_SENHA)
// e faz o login server-side. `server-only` NÃO está instalado no projeto, então
// a proteção é por convenção: componentes client só podem usar o TIPO exportado
// (`import type { ItemFilaReal }`), nunca o `obterTokenDiscador`.

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
 */
export type ItemFilaReal = { taskId: string; nome: string; telefone: string; idLead: string };

/**
 * Faz o login no call center com a credencial do ambiente e devolve só o token.
 *
 * Devolve `null` (nunca lança) quando:
 * · falta CALLCENTER_USUARIO ou CALLCENTER_SENHA;
 * · o call center recusa a credencial ou não devolve token;
 * · o call center está fora do ar / estourou o timeout.
 *
 * NÃO loga credencial, token nem telefone (LGPD).
 */
export async function obterTokenDiscador(): Promise<string | null> {
  const usuario = process.env.CALLCENTER_USUARIO;
  const senha = process.env.CALLCENTER_SENHA;
  if (!usuario || !senha) return null;

  try {
    const r = await fetch(`${BASE_DISCADOR}/api/discador/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario, senha }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    const dados = (await r.json().catch(() => null)) as { token?: string } | null;
    if (!r.ok || !dados?.token) return null;
    return dados.token;
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   PONTE GENÉRICA para as rotas de LEAD do backend do discador (B1).

   As rotas-ponte (`app/api/mobile/leads`, `.../lead/*`, `.../timeline/*`)
   compartilham o mesmo fluxo: login server-side → chamada Bearer → repasse do
   status TAL QUAL para a UI distinguir 401/403/404/502. `chamarDiscador`
   centraliza isso; a rota só escolhe caminho/método/corpo e devolve `r.dados`
   com `r.status`. O token NUNCA sai deste módulo (server-only por convenção).

   LGPD: nunca logar token, telefone nem cpf.
   ══════════════════════════════════════════════════════════════════════════ */

export type RespostaDiscador = { ok: boolean; status: number; dados: unknown };

/**
 * Chama uma rota do backend do discador com Bearer server-side.
 *
 * · `caminho` é relativo à `BASE_DISCADOR` (ex.: "/api/discador/leads?q=x").
 * · sem token (call center inacessível/mal configurado) → `502` estável.
 * · devolve sempre `{ ok, status, dados }`; o status é o do backend (para o
 *   repasse fiel de 401/403/404), ou `502` em falha de rede/timeout.
 * · NUNCA lança e NUNCA loga token/telefone/cpf.
 */
export async function chamarDiscador(
  caminho: string,
  init?: { method?: string; body?: unknown },
): Promise<RespostaDiscador> {
  const token = await obterTokenDiscador();
  if (!token) {
    return { ok: false, status: 502, dados: { erro: "Call center inacessível." } };
  }

  const temCorpo = init?.body !== undefined;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (temCorpo) headers["Content-Type"] = "application/json";

  try {
    const r = await fetch(`${BASE_DISCADOR}${caminho}`, {
      method: init?.method ?? "GET",
      headers,
      body: temCorpo ? JSON.stringify(init!.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
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

/** Resumo de lead da listagem (`GET /api/discador/leads`). Telefone MASCARADO. */
export type LeadResumoReal = {
  leadTaskId: string;
  nome: string;
  telefoneMascarado: string;
  bairro: string;
  cidade: string;
  confirmouRomero: VotoReal | null;
  confirmouAndressa: VotoReal | null;
  militante: boolean;
  semContato: boolean;
};

/** Item da timeline de ligações de um lead (`timeline`). */
export type ItemTimelineReal = {
  data: string;
  atendeu: boolean;
  aderencia: string;
  resumoAnalise: string;
  motivoFalha: string;
};

/** Ficha completa de um lead (`GET /api/discador/lead/:id`). Telefone em claro. */
export type LeadFichaReal = {
  lead: {
    leadTaskId: string;
    nome: string;
    telefone: string;
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
