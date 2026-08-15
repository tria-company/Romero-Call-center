import type { Candidato, Lead, Motivo } from "@/lib/db/schema";
import { primeiroNome } from "@/lib/format";

/* ══════════════════════════════════════════════════════════════════════════
   CONTATO — `tel:` e links do WhatsApp.

   Regra do WhatsApp: o número precisa estar em E.164 SEM o "+", com DDI.
   Números brasileiros guardados como "81999998888" viram "5581999998888".

   As mensagens-modelo são por MOTIVO DA FILA, não por tipo de serviço: o
   motivo é o que o operador tem na mão quando abre a conversa.
   ══════════════════════════════════════════════════════════════════════════ */

const DDI_BR = "55";
const soDigitos = (s: string) => s.replace(/\D/g, "");

/**
 * Central de ligação. O botão "Ligar" NÃO abre mais o discador do aparelho:
 * manda o operador para o call center, onde a chamada acontece de verdade —
 * gravada, transcrita e analisada. O `tel:` deixava a ligação fora de todo
 * esse circuito.
 *
 * A credencial do call center NÃO mora aqui, de propósito: este arquivo vai
 * inteiro para o navegador. Quem faz o login é o servidor, em
 * `app/api/callcenter/token` — o cliente só recebe o token pronto.
 */
export const URL_CALL_CENTER = "https://romero-call-center.vercel.app/";

/**
 * URL do call center já autenticada.
 *
 * O token vai no FRAGMENTO (`#`), nunca na query: fragmento não é enviado ao
 * servidor, então não aparece em log de acesso nem em Referer.
 *
 * Sem token devolve a URL nua — o operador digita a senha uma vez e o próprio
 * call center a guarda. Ou seja, falha de token degrada, não quebra.
 */
export function urlCallCenter(token?: string | null): string {
  const base = URL_CALL_CENTER.replace(/\/+$/, "");
  return token ? `${base}/#token=${encodeURIComponent(token)}` : URL_CALL_CENTER;
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

/** Mensagem inicial por motivo da fila. Em uso pelo botão WhatsApp do perfil. */
export function modeloMensagem(lead: Lead, motivo?: Motivo): string {
  const nome = primeiroNome(lead.nome);
  const pet = lead.pets[0]?.nome;
  const equipe = "Aqui é da equipe do Romero";

  switch (motivo) {
    case "retorno":
      return `Oi, ${nome}! ${equipe}. Passando para saber como ${pet ? `o(a) ${pet} está` : "está tudo"} depois do atendimento. Correu tudo bem?`;
    case "aniversario":
      return `Oi, ${nome}! ${equipe}. Passando para desejar um feliz aniversário — muita saúde para você e ${pet ? `para o(a) ${pet}` : "para os seus bichinhos"}! 🎉`;
    case "primeiro-contato":
      return `Oi, ${nome}! ${equipe}. Vi que você se cadastrou na Central Animal. Posso te contar como a gente ajuda com castração, consulta e resgate?`;
    case "reaquecimento":
      return `Oi, ${nome}! ${equipe}. Faz um tempinho que a gente não se fala. Como estão as coisas por aí${pet ? ` e como está o(a) ${pet}?` : "?"}`;
    default:
      return `Oi, ${nome}! ${equipe}. Tudo bem por aí?`;
  }
}

/** Convite do candidato — o "vídeo" da tela 03 é um envio em nome dele.
 *  SEM CHAMADOR: o botão de Vídeo saiu do perfil a pedido e não voltou (o de
 *  WhatsApp voltou). Fica porque devolvê-lo é religar esta função. */
export function modeloConvite(lead: Lead, candidato: Candidato): string {
  const nome = primeiroNome(lead.nome);
  return `Oi, ${nome}! Aqui é da equipe d${candidato.id === "andreza" ? "a" : "o"} ${candidato.nome} (${candidato.numero}). Estou te mandando um recado em vídeo — dá uma olhadinha quando puder!`;
}

export function linkWhatsapp(lead: Lead, texto: string): string | null {
  const e164 = paraE164(lead.whatsapp);
  if (!e164) return null;
  return `https://wa.me/${e164}?text=${encodeURIComponent(texto)}`;
}

export function vibrar(ms = 8) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* aparelho sem motor de vibração */
  }
}
