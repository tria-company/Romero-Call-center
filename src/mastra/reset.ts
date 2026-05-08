// Comando de reset para testes manuais.
// Disparado quando o usuario envia "#55555" pelo WhatsApp.
// Limpa: caches em memoria (sessao, bloqueio, buffer), conversa no Supabase
// (mensagens + objecoes + ended_at), e a Memory do Mastra (thread + working
// memory do resourceId).

import {
  buscarCustomerPorTelefone,
  encerrarConversasDoCustomer,
  deletarMensagensDoCustomer,
  deletarObjecoesDoTelefone,
} from './supabase';
import { encerrarSessao } from './sessao';
import { desbloquearNumero } from './bloqueio';
import { removerBuffer } from './buffer';
import { memoria } from './memoria';

export const COMANDO_RESET = '#55555';

interface ResultadoReset {
  cacheLimpo: boolean;
  conversasEncerradas: boolean;
  mensagensApagadas: boolean;
  objecoesApagadas: boolean;
  threadDeletada: boolean;
  workingMemoryLimpa: boolean;
  erros: string[];
}

async function limparMemoryMastra(telefone: string, erros: string[]): Promise<{
  threadDeletada: boolean;
  workingMemoryLimpa: boolean;
}> {
  let threadDeletada = false;
  let workingMemoryLimpa = false;

  // threadId e resourceId = telefone (ver index.ts)
  const memAny = memoria as unknown as Record<string, any>;

  try {
    if (typeof memAny.deleteThread === 'function') {
      await memAny.deleteThread({ threadId: telefone });
      threadDeletada = true;
    } else if (typeof memAny.delete === 'function') {
      await memAny.delete({ threadId: telefone });
      threadDeletada = true;
    }
  } catch (e) {
    erros.push(`deleteThread: ${(e as Error).message}`);
  }

  try {
    if (typeof memAny.deleteWorkingMemory === 'function') {
      await memAny.deleteWorkingMemory({ resourceId: telefone });
      workingMemoryLimpa = true;
    } else if (typeof memAny.updateWorkingMemory === 'function') {
      // Sobrescreve com template em branco — funciona como reset funcional
      await memAny.updateWorkingMemory({ resourceId: telefone, workingMemory: '' });
      workingMemoryLimpa = true;
    }
  } catch (e) {
    erros.push(`workingMemory: ${(e as Error).message}`);
  }

  return { threadDeletada, workingMemoryLimpa };
}

export async function resetarConversaTeste(telefone: string): Promise<ResultadoReset> {
  const erros: string[] = [];
  console.log(`[reset] Iniciando reset de teste para ${telefone}`);

  // 1. Buffer pendente (se houver mensagens em transito, descarta)
  removerBuffer(telefone);

  // 2. Supabase: encerrar conversas + apagar mensagens + objecoes
  let conversasEncerradas = false;
  let mensagensApagadas = false;
  let objecoesApagadas = false;
  try {
    const customer = await buscarCustomerPorTelefone(telefone);
    if (customer?.id) {
      await deletarMensagensDoCustomer(customer.id); // ordem: msgs antes de encerrar
      mensagensApagadas = true;
      await encerrarConversasDoCustomer(customer.id);
      conversasEncerradas = true;
    }
    await deletarObjecoesDoTelefone(telefone);
    objecoesApagadas = true;
  } catch (e) {
    erros.push(`supabase: ${(e as Error).message}`);
  }

  // 3. Caches em memoria
  let cacheLimpo = false;
  try {
    await encerrarSessao(telefone);
    await desbloquearNumero(telefone);
    cacheLimpo = true;
  } catch (e) {
    erros.push(`cache: ${(e as Error).message}`);
  }

  // 4. Memory do Mastra (thread + working memory)
  const { threadDeletada, workingMemoryLimpa } = await limparMemoryMastra(telefone, erros);

  const resultado: ResultadoReset = {
    cacheLimpo,
    conversasEncerradas,
    mensagensApagadas,
    objecoesApagadas,
    threadDeletada,
    workingMemoryLimpa,
    erros,
  };

  console.log(`[reset] Concluido para ${telefone}:`, resultado);
  return resultado;
}
