/* ══════════════════════════════════════════════════════════════════════════
   CONTATO — `tel:`, formatação de telefone e link do call center.

   O canal WhatsApp saiu (B4) junto com o store local; sobraram os utilitários
   de telefone (E.164, máscara) e a URL autenticada do call center. Nada aqui
   depende de tipos do store.
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

/** SEM CHAMADOR desde que "Ligar" passou a abrir o call center. Fica porque
 *  devolver a discagem do aparelho é religar esta função. */
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
