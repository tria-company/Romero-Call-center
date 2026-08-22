/* ══════════════════════════════════════════════════════════════════════════
   CONTATO — `tel:`, formatação de telefone, WhatsApp (wa.me) e link do call
   center.

   O canal WhatsApp saiu no B4 junto com o store local e VOLTOU no u12 como
   link `wa.me` puro (pedido do gestor): abre a conversa no aplicativo do
   PRÓPRIO aparelho, e o áudio sai do número do operador — fora do circuito
   gravado do call center, por escolha. Nada aqui depende de tipos do store.
   ══════════════════════════════════════════════════════════════════════════ */

const DDI_BR = "55";
const soDigitos = (s: string) => s.replace(/\D/g, "");

/**
 * Central de ligação. O botão "Ligar" NÃO abre mais o discador do aparelho:
 * manda o operador para o call center (`/discador`), onde a chamada acontece de
 * verdade — gravada, transcrita e analisada. O `tel:` deixava a ligação fora de
 * todo esse circuito.
 *
 * MESMO ENDERECO: o call center vive na MESMA origem do painel (`/discador`,
 * proxied pro Mastra via rewrites). Origem única = mesmo localStorage/cookie, o
 * "Ligar" abre a chamada sem re-login. O token (quando presente) vai no
 * FRAGMENTO, nunca na query.
 */
export const URL_CALL_CENTER = process.env.NEXT_PUBLIC_CALLCENTER_URL || "/discador";

/**
 * URL do call center na MESMA ORIGEM (`/discador`, proxied pro Mastra via
 * rewrites). Como painel e discador compartilham origem, compartilham também o
 * localStorage: o discador já tem o token guardado e abre a chamada sem re-login.
 *
 * O token — quando passado — vai no FRAGMENTO (`#`), nunca na query: fragmento
 * não é enviado ao servidor, então não aparece em log de acesso nem em Referer.
 *
 * `taskId`: vai como `task=` no MESMO fragmento — o discador faz deep-link e
 * abre a Ligação exata. Como a sessão já vive no localStorage da origem, o
 * deep-link da task acontece MESMO sem token no argumento. Sem token nem task,
 * devolve a URL nua (`/discador`) — a porta única.
 */
export function urlCallCenter(token?: string | null, taskId?: string | null): string {
  const base = URL_CALL_CENTER.replace(/\/+$/, "");
  const partes: string[] = [];
  if (token) partes.push(`token=${encodeURIComponent(token)}`);
  if (taskId) partes.push(`task=${encodeURIComponent(taskId)}`);
  return partes.length ? `${base}#${partes.join("&")}` : URL_CALL_CENTER;
}

export function paraE164(bruto: string | undefined | null): string | null {
  if (!bruto) return null;
  let d = soDigitos(bruto);
  if (!d) return null;
  if (d.startsWith("0")) d = d.replace(/^0+/, "");
  if (d.startsWith(DDI_BR) && (d.length === 12 || d.length === 13)) return d;
  if (d.length === 10 || d.length === 11) return DDI_BR + d;
  if (d.length >= 12) return d;
  return null;
}

/** "(81) 99999-8888" — só para exibir. */
export function fmtTelefone(bruto: string | undefined | null): string {
  const d = soDigitos(bruto ?? "");
  const local = d.startsWith(DDI_BR) && d.length > 11 ? d.slice(2) : d;
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return bruto ?? "—";
}

/** Conversa no WhatsApp do PRÓPRIO aparelho (`wa.me`) — o áudio sai do número
 *  do operador. Sem texto pré-preenchido: o recado É o áudio. `null` quando o
 *  telefone não vira E.164 (o botão desabilita em vez de abrir conversa errada). */
export function urlWhatsApp(bruto: string | undefined | null): string | null {
  const e164 = paraE164(bruto);
  return e164 ? `https://wa.me/${e164}` : null;
}

/** RELIGADA (quick-260822-pzh) como FALLBACK plano B: quando o Wavoip falha, o
 *  botão secundário "Ligar pelo telefone" usa este link pra abrir o discador
 *  NATIVO do aparelho. Diferente da versão original (desligada porque deixava
 *  a ligação fora do circuito de desfecho/voto), agora o app COBRA o retorno
 *  manualmente (fallback-tel.ts) — a ligação sai do circuito automático, mas
 *  o desfecho ainda é registrado, com o canal marcado. Assinatura preservada. */
export function linkTelefone(bruto: string | undefined | null): string | null {
  const e164 = paraE164(bruto);
  return e164 ? `tel:+${e164}` : null;
}

export function vibrar(ms = 8) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* aparelho sem motor de vibração */
  }
}

/**
 * Copia o telefone em E.164 (`+55…`) pra área de transferência — ação
 * "Copiar número" do fallback tel: (D-02). Tenta `navigator.clipboard`
 * primeiro; sem suporte (ou falha), cai pro fallback `execCommand('copy')`
 * via `<textarea>` temporário. Retorna `false` sem lançar quando o telefone
 * não normaliza ou nenhum dos dois caminhos funciona. NUNCA loga o telefone.
 */
export async function copiarTelefone(bruto: string | undefined | null): Promise<boolean> {
  const e164 = paraE164(bruto);
  if (!e164) return false;
  const texto = `+${e164}`;

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch {
    /* clipboard API indisponível/negada — cai pro fallback abaixo */
  }

  try {
    if (typeof document === "undefined") return false;
    const area = document.createElement("textarea");
    area.value = texto;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
