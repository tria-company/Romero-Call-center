// Helper compartilhado para envio de avisos ao grupo SUPORTE CAMINHO DE RAINHA - IA.
// Usado por:
//  - handoff-humano (avisa que IA pausou e humano precisa assumir)
//  - notificar-time (avisa o time mas IA continua atendendo)

import { enviarMensagem } from './evolution';
import { SUPORTE_GRUPO_JID } from './config';

/**
 * Envia uma mensagem (multi-linha) para o grupo de suporte configurado,
 * em UMA unica mensagem (sem quebra automatica) — assim o aviso aparece
 * coeso pro time, em vez de 4-6 balões separados no WhatsApp.
 * Retorna true se SUPORTE_GRUPO_JID estiver setado e o envio nao lancar.
 * Retorna false (no-op) se nao houver grupo configurado.
 */
export async function enviarAvisoAoSuporte(linhas: string[]): Promise<boolean> {
  if (!SUPORTE_GRUPO_JID) {
    console.log('[notificacoes] SUPORTE_GRUPO_JID nao configurado, pulando aviso ao grupo');
    return false;
  }
  try {
    await enviarMensagem(SUPORTE_GRUPO_JID, linhas.join('\n'), { quebrar: false });
    return true;
  } catch (e) {
    console.error('[notificacoes] Falha ao notificar grupo de suporte:', e);
    return false;
  }
}
