// Helper compartilhado para envio de avisos ao grupo SUPORTE CAMINHO DE RAINHA - IA.
// Usado por:
//  - handoff-humano (avisa que IA pausou e humano precisa assumir)
//  - notificar-time (avisa o time mas IA continua atendendo)
//
// LIMITACAO no GHL: a API oficial nao envia pra grupos do WhatsApp. Se
// SUPORTE_GRUPO_JID for um JID de grupo (formato @g.us, herdado da Evolution),
// o aviso e logado mas nao chega no WhatsApp. Pra notificar o time hoje:
// olhar logs do agente OU dashboard /api/dashboard (section "Erros do agente"
// e tabela de Conversas). Pra futuro: trocar destino pra Slack/email/SMS.

import { enviarMensagem } from './ghl';
import { SUPORTE_GRUPO_JID } from './config';

// Cache de idempotencia: rastreia (telefone, motivo) ja notificados pra
// evitar spam no grupo quando a Sofia (por perda de memoria, multi-step,
// ou outra anomalia) chama a mesma tool varias vezes pro mesmo contato.
// Janela: 1 hora. Apos isso, considera nova situacao.
const JANELA_IDEMPOTENCIA_MS = 60 * 60 * 1000;
const cacheNotificacoes = new Map<string, number>();

setInterval(() => {
  const agora = Date.now();
  for (const [key, ts] of cacheNotificacoes) {
    if (agora - ts > JANELA_IDEMPOTENCIA_MS) cacheNotificacoes.delete(key);
  }
}, 10 * 60 * 1000); // limpeza a cada 10 min

/**
 * Verifica se ja notificamos esse contato pelo mesmo motivo na ultima 1h.
 * Se sim, retorna true (e nao deve renotificar). Se nao, registra e
 * retorna false (caller pode prosseguir).
 */
export function jaNotificouRecentemente(telefone: string, motivo: string): boolean {
  const key = `${telefone}:${motivo}`;
  const ts = cacheNotificacoes.get(key);
  if (ts && Date.now() - ts < JANELA_IDEMPOTENCIA_MS) {
    return true;
  }
  cacheNotificacoes.set(key, Date.now());
  return false;
}

/**
 * "Envia" um aviso ao grupo de suporte. No GHL, mensagens 1:1 com leads
 * funcionam normalmente, MAS grupos do WhatsApp nao sao suportados pela API
 * oficial. Se SUPORTE_GRUPO_JID for um JID de grupo (legacy Evolution), o
 * aviso e LOGADO de forma estruturada (pra leitura no docker logs ou
 * dashboard), mas nao e entregue como mensagem.
 *
 * Quando o destino e um telefone valido (sem @g.us), o aviso e enviado
 * normalmente via GHL.
 *
 * Retorna true se conseguiu logar/enviar; false se SUPORTE_GRUPO_JID nao
 * estiver configurado.
 */
export async function enviarAvisoAoSuporte(linhas: string[]): Promise<boolean> {
  if (!SUPORTE_GRUPO_JID) {
    console.log('[notificacoes] SUPORTE_GRUPO_JID nao configurado, pulando aviso');
    return false;
  }

  const ehGrupo = SUPORTE_GRUPO_JID.includes('@g.us') || SUPORTE_GRUPO_JID.includes('@broadcast');
  if (ehGrupo) {
    // GHL nao manda pra grupo — log estruturado pra captura via dashboard/CI.
    console.log('[notificacoes][grupo-skip]\n' + linhas.join('\n') + '\n[/notificacoes]');
    return true;
  }

  try {
    await enviarMensagem(SUPORTE_GRUPO_JID, linhas.join('\n'), { quebrar: false });
    return true;
  } catch (e) {
    console.error('[notificacoes] Falha ao notificar:', e);
    return false;
  }
}
