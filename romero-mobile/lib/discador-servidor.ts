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
