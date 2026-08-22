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

/** R8 (quick-260822-rr6): origem da ligação tel: — "direto" do card, ou
 *  "apos-whatsapp" quando veio do gancho "Tentar pelo telefone" na tela de
 *  motivo do discador (chamada WhatsApp não atendida, mesma task). */
export type OrigemTel = "direto" | "apos-whatsapp";

export type LigacaoTelPendente = {
  taskId: string;
  nome: string;
  telefone: string;
  origem: OrigemTel;
};

const CHAVE = "romero:tel:pendente";

function origemValida(v: unknown): v is OrigemTel {
  return v === "direto" || v === "apos-whatsapp";
}

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

/** Lê a ligação `tel:` pendente, se houver. `null` sem guard-rail ativo.
 *  `origem` ausente/inválida (guard-rail gravado pelo pzh, antes de R8)
 *  normaliza para "direto" — compat retroativa. */
export function lerLigacaoTelPendente(): LigacaoTelPendente | null {
  try {
    if (typeof window === "undefined") return null;
    const bruto = window.localStorage.getItem(CHAVE);
    if (!bruto) return null;
    const p = JSON.parse(bruto) as Partial<LigacaoTelPendente>;
    if (!p || typeof p.taskId !== "string" || typeof p.telefone !== "string") return null;
    return {
      taskId: p.taskId,
      nome: typeof p.nome === "string" ? p.nome : "",
      telefone: p.telefone,
      origem: origemValida(p.origem) ? p.origem : "direto",
    };
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

/** Tamanho máximo do texto composto por `montarMarcadores` — < limite 500 do
 *  backend (categoria/observação/anotação), com folga pra outros prefixos que
 *  o caller possa somar (ex.: "📞 Atendida (tel)\n"). */
const LIMITE_MARCADORES = 480;

/**
 * Monta os marcadores em pt-BR embutidos na observação/comentário (R5/R6/R8,
 * D-05/D-06/D-08) — sem migração, sem coluna dedicada. Sempre começa com a
 * origem (`[tel direto]`/`[tel apos-whatsapp]`, SUBSTITUI o antigo `[tel]` do
 * pzh), seguida de `[classificacao] …` e `[demanda] …` quando presentes, e por
 * fim a observação livre. Corta em `LIMITE_MARCADORES` chars. NUNCA inclui
 * telefone/CPF — só texto digitado pelo atendente + rótulos fixos.
 */
export function montarMarcadores(p: {
  origem: OrigemTel;
  classificacao?: string;
  demanda?: string;
  observacao?: string;
}): string {
  const partes: string[] = [p.origem === "apos-whatsapp" ? "[tel apos-whatsapp]" : "[tel direto]"];
  if (p.classificacao) partes.push(`[classificacao] ${p.classificacao}`);
  if (p.demanda?.trim()) partes.push(`[demanda] ${p.demanda.trim()}`);
  let texto = partes.join(" ");
  if (p.observacao?.trim()) texto = `${texto} ${p.observacao.trim()}`;
  return texto.slice(0, LIMITE_MARCADORES);
}

/**
 * Registra o desfecho da ligação `tel:` pela rota-ponte `/api/mobile/desfecho`
 * (mesmo contrato do backend do discador). `duracao:0` — a duração real da
 * ligação nativa não é observável pelo app (fora do circuito Wavoip).
 * `resultado==="nao_atendida"` compõe a `observacao` final via
 * `montarMarcadores` (R5/R6/R8) — substitui o antigo prefixo fixo `[tel] `.
 * Nunca lança; retorna `r.ok`.
 */
export async function registrarDesfechoTel(
  taskId: string,
  resultado: "atendida" | "nao_atendida",
  opts?: {
    categoria?: string;
    classificacao?: string;
    demanda?: string;
    observacao?: string;
    origem?: OrigemTel;
  },
): Promise<boolean> {
  try {
    const observacao =
      resultado === "nao_atendida"
        ? montarMarcadores({
            origem: opts?.origem ?? "direto",
            classificacao: opts?.classificacao,
            demanda: opts?.demanda,
            observacao: opts?.observacao,
          })
        : opts?.observacao;
    const r = await fetch("/api/mobile/desfecho", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId,
        resultado,
        categoria: opts?.categoria,
        observacao,
        duracao: 0,
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Anota a Ligação (caminho "atendeu" do retorno tel:, R6/D-06) pela rota-ponte
 * `/api/mobile/ligacao/:taskId/anotacao` — persiste classificação/demanda/
 * observação num comentário (a rota do desfecho 'atendida' ignora
 * observação). Nunca lança; retorna `r.ok`.
 */
export async function registrarAnotacaoLigacao(taskId: string, texto: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/mobile/ligacao/${encodeURIComponent(taskId)}/anotacao`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texto }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Detalhe leve da Ligação (nome/telefone/script) — R7/D-07, card ANTES de
 *  ligar. Nunca lança; `null` em falha (o card degrada escondendo a seção). */
export async function carregarLigacaoDetalhe(
  taskId: string,
): Promise<{ nome: string; telefone: string; script: string } | null> {
  try {
    const r = await fetch(`/api/mobile/ligacao/${encodeURIComponent(taskId)}`, { cache: "no-store" });
    if (!r.ok) return null;
    const d = (await r.json().catch(() => null)) as
      | { ligacao?: { nome?: string; telefone?: string; script?: string } }
      | null;
    if (!d?.ligacao) return null;
    return {
      nome: typeof d.ligacao.nome === "string" ? d.ligacao.nome : "",
      telefone: typeof d.ligacao.telefone === "string" ? d.ligacao.telefone : "",
      script: typeof d.ligacao.script === "string" ? d.ligacao.script : "",
    };
  } catch {
    return null;
  }
}

/** Dossiê (contexto) do lead ligado à Ligação — R7/D-07. `""` quando a
 *  Ligação não tem lead resolvido, `null` em falha (o card degrada
 *  escondendo a seção). Nunca lança. */
export async function carregarContextoLead(taskId: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/mobile/contexto/${encodeURIComponent(taskId)}`, { cache: "no-store" });
    if (!r.ok) return null;
    const d = (await r.json().catch(() => null)) as { temLead?: boolean; contexto?: string } | null;
    if (!d) return null;
    if (!d.temLead) return "";
    return typeof d.contexto === "string" ? d.contexto : "";
  } catch {
    return null;
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
