// Helper compartilhado para envio de avisos ao grupo SUPORTE CAMINHO DE RAINHA - IA.
// Usado por:
//  - handoff-humano (avisa que IA pausou e humano precisa assumir)
//  - notificar-time (avisa o time mas IA continua atendendo)

import { enviarMensagem } from './evolution';
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
