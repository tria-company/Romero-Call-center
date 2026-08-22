"use client";

// `import type` OBRIGATÓRIO: importar como valor arrastaria código de
// servidor (`chamarDiscador`) para o bundle do cliente.
import type { VotoReal } from "@/lib/discador-servidor";

/* ══════════════════════════════════════════════════════════════════════════
   FALLBACK-TEL — fallback de ligação nativa (`tel:`) plano B (quick-260822-pzh).

   Quando o Wavoip falha, o atendente usa o discador NATIVO do aparelho e o
   app COBRA o retorno manualmente: guard-rail em localStorage (D-03) +
   registro do desfecho/voto pelas rotas-ponte que encaminham pro backend do
   discador (mesmas rotas que o fluxo Wavoip já usa). Nenhum helper aqui
   lança — toda falha vira `false`/`null`, nunca uma exceção não tratada na
   UI. LGPD: nenhum console.log de telefone/token.
   ══════════════════════════════════════════════════════════════════════════ */

export type LigacaoTelPendente = {
  taskId: string;
  nome: string;
  telefone: string;
};

const CHAVE = "romero:tel:pendente";

/** Marca uma ligação `tel:` em andamento (D-03) — sobrevive a sair/voltar da
 *  tela até o atendente responder ou tocar "Não consegui ligar". SSR-safe. */
export function marcarLigacaoTelPendente(p: LigacaoTelPendente): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CHAVE, JSON.stringify(p));
  } catch {
    /* localStorage indisponível (modo privado/quota) — guard-rail degrada */
  }
}

/** Lê a ligação `tel:` pendente, se houver. `null` sem guard-rail ativo. */
export function lerLigacaoTelPendente(): LigacaoTelPendente | null {
  try {
    if (typeof window === "undefined") return null;
    const bruto = window.localStorage.getItem(CHAVE);
    if (!bruto) return null;
    const p = JSON.parse(bruto) as Partial<LigacaoTelPendente>;
    if (!p || typeof p.taskId !== "string" || typeof p.telefone !== "string") return null;
    return { taskId: p.taskId, nome: typeof p.nome === "string" ? p.nome : "", telefone: p.telefone };
  } catch {
    return null;
  }
}

/** Limpa o guard-rail — chamado após um desfecho terminal OU quando o
 *  atendente toca "Não consegui ligar" (D-03: sem desfecho, o lead segue na
 *  fila). */
export function limparLigacaoTelPendente(): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(CHAVE);
  } catch {
    /* nada a fazer sem localStorage */
  }
}

/**
 * Registra o desfecho da ligação `tel:` pela rota-ponte `/api/mobile/desfecho`
 * (mesmo contrato do backend do discador). `duracao:0` — a duração real da
 * ligação nativa não é observável pelo app (fora do circuito Wavoip).
 * Nunca lança; retorna `r.ok`.
 */
export async function registrarDesfechoTel(
  taskId: string,
  resultado: "atendida" | "nao_atendida",
  opts?: { categoria?: string; observacao?: string },
): Promise<boolean> {
  try {
    const r = await fetch("/api/mobile/desfecho", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId,
        resultado,
        categoria: opts?.categoria,
        observacao: opts?.observacao,
        duracao: 0,
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Registra o(s) voto(s) de confirmação (Romero/Andressa) pela rota-ponte
 * `/api/mobile/voto`. Nunca lança; retorna `r.ok`.
 */
export async function registrarVotoTel(
  taskId: string,
  voto: { romero?: VotoReal; andressa?: VotoReal },
): Promise<boolean> {
  try {
    const r = await fetch("/api/mobile/voto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, ...voto }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
