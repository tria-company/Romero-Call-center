// Gerenciador de sessao: cache em memoria + persistencia no Supabase.
// Memoria  = rapido (usado no webhook).
// Supabase = persistente (sobrevive a reinicio).

import {
  buscarCustomerPorTelefone,
  upsertCustomer,
  buscarConversaAtiva,
  obterOuCriarConversaAtiva,
  atualizarConversa,
} from './supabase';
import { JANELA_CONVERSA_FLUIDA } from './config';

export interface Sessao {
  telefone: string;
  agenteAtual: string;        // 'vendedor' | 'humano'
  nome: string;
  email: string;
  interesse: string;          // curso/oferta que o lead demonstrou interesse
  customerId: string;
  conversaId: string;
  iniciadaEm: number;
  ghlContactId?: string;      // ID do contato no GoHighLevel (necessario pra mandar mensagem via API)
}

const cache = new Map<string, Sessao>();

// Busca sessao: primeiro cache, depois Supabase. Se houver conversa ativa < 24h,
// reconstroi a sessao no cache. Diferente do projeto antigo (que voltava pra triagem
// apos 2h), aqui o agente unico — vendedor — sempre retoma direto.
export async function getSessao(telefone: string): Promise<Sessao | undefined> {
  if (cache.has(telefone)) {
    return cache.get(telefone);
  }

  const customer = await buscarCustomerPorTelefone(telefone);
  if (!customer) return undefined;

  const conversa = await buscarConversaAtiva(customer.id);
  if (!conversa) return undefined;

  const agenteConversa = conversa.agente_atual || 'vendedor';
  const ultimaMensagem = new Date(conversa.data_ultima_mensagem).getTime();
  const tempoInativo = Date.now() - ultimaMensagem;
  const conversaFluida = tempoInativo < JANELA_CONVERSA_FLUIDA;

  const sessao: Sessao = {
    telefone,
    agenteAtual: agenteConversa,
    nome: customer.nome || '',
    email: customer.email || '',
    interesse: (conversa.metadata as any)?.interesse || '',
    customerId: customer.id,
    conversaId: conversa.id,
    iniciadaEm: new Date(conversa.started_at).getTime(),
    ghlContactId: (conversa.metadata as any)?.ghl_contact_id || undefined,
  };

  cache.set(telefone, sessao);
  console.log(
    `[sessao] Recuperada (${conversaFluida ? 'fluida' : 'inativa'} ` +
    `${conversaFluida ? Math.round(tempoInativo / 60000) + 'min' : Math.round(tempoInativo / 3600000) + 'h'}): ${telefone} → ${agenteConversa}`,
  );
  return sessao;
}

export async function criarSessao(telefone: string, dados: Partial<Sessao>): Promise<Sessao> {
  let customerId = dados.customerId || '';
  const nome = dados.nome || '';
  const email = dados.email || '';

  if (!customerId) {
    const id = await upsertCustomer({ telefone, nome, email });
    if (id) customerId = id;
  } else if (nome || email) {
    const id = await upsertCustomer({ telefone, nome, email });
    if (id) customerId = id;
  }

  let conversaId = '';
  if (customerId) {
    // Idempotente: se ja existe conversa em_atendimento ativa, reusa.
    // Garante uniqueness contra race entre 2 webhooks pro mesmo lead novo
    // (a unique constraint uk_conv_ativa_por_customer rejeita o segundo INSERT
    // e obterOuCriarConversaAtiva trata via fallback).
    const id = await obterOuCriarConversaAtiva(customerId);
    if (id) conversaId = id;
  }

  const sessao: Sessao = {
    telefone,
    agenteAtual: dados.agenteAtual || 'vendedor',
    nome,
    email,
    interesse: dados.interesse || '',
    customerId,
    conversaId,
    iniciadaEm: Date.now(),
    ghlContactId: dados.ghlContactId,
  };

  // Se chegou ghlContactId na criacao, persiste no metadata pra sobreviver reinicio
  if (dados.ghlContactId && conversaId) {
    await atualizarConversa(conversaId, {
      metadata: JSON.stringify({ ghl_contact_id: dados.ghlContactId }),
    });
  }

  cache.set(telefone, sessao);
  console.log(`[sessao] Criada: ${telefone} → agente: ${sessao.agenteAtual} (conversa: ${conversaId || 'sem supabase'})`);
  return sessao;
}

export async function trocarAgente(telefone: string, novoAgente: string): Promise<void> {
  const sessao = cache.get(telefone);
  if (!sessao) return;

  const anterior = sessao.agenteAtual;
  sessao.agenteAtual = novoAgente;
  cache.set(telefone, sessao);

  if (sessao.conversaId) {
    await atualizarConversa(sessao.conversaId, {
      agente_atual: agenteParaEnum(novoAgente),
      status: novoAgente === 'humano' ? 'aguardando_humano' : 'em_atendimento',
    });
  }

  console.log(`[sessao] Handoff: ${telefone} de ${anterior} → ${novoAgente}`);
}

export async function atualizarSessao(telefone: string, dados: Partial<Sessao>): Promise<void> {
  const sessao = cache.get(telefone);
  if (!sessao) return;

  const tinhaCustomerId = sessao.customerId;
  Object.assign(sessao, dados);
  cache.set(telefone, sessao);

  // Persistir customer se chegou nome ou email novo
  if (dados.nome || dados.email) {
    const customerId = await upsertCustomer({
      telefone,
      nome: dados.nome || sessao.nome,
      email: dados.email || sessao.email,
    });
    if (customerId) {
      if (!tinhaCustomerId) {
        const conversaId = await obterOuCriarConversaAtiva(customerId);
        if (conversaId) sessao.conversaId = conversaId;
      }
      sessao.customerId = customerId;
      cache.set(telefone, sessao);
    }
  }

  if (sessao.conversaId) {
    await atualizarConversa(sessao.conversaId, {
      metadata: JSON.stringify({
        interesse: sessao.interesse,
        email: sessao.email,
        ghl_contact_id: sessao.ghlContactId,
      }),
    });
  }

  console.log(`[sessao] Dados atualizados: ${telefone} → ${sessao.nome || '(sem nome)'}`);
}

export async function encerrarSessao(telefone: string): Promise<void> {
  const sessao = cache.get(telefone);
  if (sessao?.conversaId) {
    await atualizarConversa(sessao.conversaId, {
      status: 'encerrada',
      ended_at: new Date().toISOString(),
    });
  }
  cache.delete(telefone);
  console.log(`[sessao] Encerrada: ${telefone}`);
}

// Mapa do ID logico do agente -> chave registrada no Mastra
// Projeto Roberth tinha 1 agente: vendedor. SDR AUTON adiciona
// 'qualificador' (processa o form 14q em modo batch — 01-04) e 'camila'
// (conduz o SPIN, saida JSON estrito — 01-05). 'humano' nao e um agente
// Mastra, e tratado no index.ts como pausa da IA.
export const AGENTES_MAP: Record<string, string> = {
  vendedor: 'vendedorAgent',
  qualificador: 'qualificadorAgent',
  camila: 'camilaAgent',
  humano: 'humano',
};

export function agenteParaEnum(agente: string): string {
  const mapa: Record<string, string> = {
    vendedor: 'vendedor',
    humano: 'atendimento_humano',
  };
  return mapa[agente] || 'vendedor';
}
