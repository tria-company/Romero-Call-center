// Gerenciador de bloqueio — pausa a IA quando um humano assume o atendimento.
// Quando alguem (nao o bot) envia mensagem pelo WhatsApp, a IA fica em silencio
// por 1 dia. Cache em memoria (rapido) + Supabase (sobrevive reinicio).

import { buscarCustomerPorTelefone, atualizarConversa, buscarConversaAtiva, buscarConversaBloqueada } from './supabase';
import { DURACAO_BLOQUEIO } from './config';

// Cache: telefone → timestamp de desbloqueio (ms)
const bloqueios = new Map<string, number>();

function parseMetadata(conversa: any): Record<string, any> {
  return (typeof conversa.metadata === 'object' && conversa.metadata) || {};
}

/**
 * Bloqueia a IA para um numero por 1 dia.
 * Chamado quando um humano envia mensagem pelo WhatsApp.
 */
export async function bloquearNumero(telefone: string): Promise<void> {
  // Se ja esta bloqueado no cache, apenas renova o timer
  const existente = bloqueios.get(telefone);
  if (existente && Date.now() < existente) return;

  const desbloqueioEm = Date.now() + DURACAO_BLOQUEIO;
  bloqueios.set(telefone, desbloqueioEm);

  // Persiste no Supabase (metadata da conversa)
  try {
    const customer = await buscarCustomerPorTelefone(telefone);
    if (customer) {
      // Busca conversa ativa (qualquer status) — nao apenas as ja bloqueadas
      const conversa = await buscarConversaAtiva(customer.id) || await buscarConversaBloqueada(customer.id);
      if (conversa) {
        const metadata = parseMetadata(conversa);
        await atualizarConversa(conversa.id, {
          status: 'aguardando_humano',
          metadata: JSON.stringify({ ...metadata, bloqueado_ate: new Date(desbloqueioEm).toISOString() }),
        });
      }
    }
  } catch (e) {
    console.error('[bloqueio] Erro ao persistir:', e);
  }

  console.log(`[bloqueio] IA pausada para ${telefone} por 1 dia (ate ${new Date(desbloqueioEm).toISOString()})`);
}

/**
 * Verifica se a IA esta bloqueada para um numero.
 * Checa cache primeiro, depois Supabase (para sobreviver reinicio).
 */
export async function estaBloqueado(telefone: string): Promise<boolean> {
  // 1. Cache (rapido)
  const expira = bloqueios.get(telefone);
  if (expira) {
    if (Date.now() < expira) return true;
    bloqueios.delete(telefone);
    return false;
  }

  // 2. Supabase (cold start / apos reinicio)
  try {
    const customer = await buscarCustomerPorTelefone(telefone);
    if (!customer) return false;

    const conversa = await buscarConversaBloqueada(customer.id);
    if (!conversa) return false;

    const metadata = parseMetadata(conversa);
    const bloqueadoAte = metadata.bloqueado_ate;
    if (!bloqueadoAte) return false;

    const expiraMs = new Date(bloqueadoAte).getTime();
    if (Date.now() < expiraMs) {
      // Rehidrata cache
      bloqueios.set(telefone, expiraMs);
      return true;
    }
  } catch (e) {
    console.error('[bloqueio] Erro ao verificar:', e);
  }

  return false;
}

/**
 * Desbloqueia a IA para um numero (desbloqueio manual).
 */
export async function desbloquearNumero(telefone: string): Promise<void> {
  bloqueios.delete(telefone);

  try {
    const customer = await buscarCustomerPorTelefone(telefone);
    if (customer) {
      const conversa = await buscarConversaBloqueada(customer.id);
      if (conversa) {
        const { bloqueado_ate, ...rest } = parseMetadata(conversa);
        await atualizarConversa(conversa.id, {
          status: 'em_atendimento',
          metadata: JSON.stringify(rest),
        });
      }
    }
  } catch (e) {
    console.error('[bloqueio] Erro ao desbloquear:', e);
  }

  console.log(`[bloqueio] IA reativada para ${telefone}`);
}
