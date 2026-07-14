// Gerenciador de sessao: cache em memoria + persistencia no Supabase.
// Memoria  = rapido (usado no webhook).
// Supabase = persistente (sobrevive a reinicio).

import {
  buscarCustomerPorTelefone,
  upsertCustomer,
  buscarConversaAtiva,
  buscarConversaPorId,
  obterOuCriarConversaAtiva,
  atualizarConversa,
} from './supabase';
import { JANELA_CONVERSA_FLUIDA } from './config';

// WR-06 (4a rodada): merge read-modify-write do metadata da conversa. Os
// writers deste modulo montavam o JSON de metadata DO ZERO — clobber que
// apagava chaves gravadas por outros modulos, em especial `bloqueado_ate`
// (bloqueio.ts — perna DURAVEL do cold-cache de estaBloqueado, ou seja, a
// persistencia da pausa de crise) e `agendamento_owner` num race. Mesmo
// padrao de bloquearNumero (que ja fazia merge, corretamente): le o valor
// persistido e faz spread antes de sobrescrever chaves especificas.
// Best-effort: se a leitura falhar, devolve {} (o PATCH segue com as chaves
// proprias — comportamento identico ao anterior, nunca pior).
async function metadataAtualDaConversa(conversaId: string): Promise<Record<string, any>> {
  try {
    const conversa = await buscarConversaPorId(conversaId);
    return (conversa && typeof conversa.metadata === 'object' && conversa.metadata) || {};
  } catch {
    return {};
  }
}

// WR-06: chaves proprias da sessao pro metadata — SO inclui valores
// definidos/nao-vazios, pra um campo ausente na sessao em memoria (ex:
// cache reconstruido parcial) nao apagar o valor ja persistido no merge.
function metadataDaSessao(sessao: Sessao): Record<string, any> {
  const proprio: Record<string, any> = {};
  if (sessao.interesse) proprio.interesse = sessao.interesse;
  if (sessao.email) proprio.email = sessao.email;
  if (sessao.ghlContactId) proprio.ghl_contact_id = sessao.ghlContactId;
  if (sessao.agendamentoOwner) proprio.agendamento_owner = sessao.agendamentoOwner;
  return proprio;
}

export interface Sessao {
  telefone: string;
  agenteAtual: string;        // 'qualificador' | 'camila' | 'humano'
  nome: string;
  email: string;
  interesse: string;          // curso/oferta que o lead demonstrou interesse
  customerId: string;
  conversaId: string;
  iniciadaEm: number;
  ghlContactId?: string;      // ID do contato no GoHighLevel (necessario pra mandar mensagem via API)
  // FUN-05 (coordenacao SDR AUTON, 01-06): quem "ganhou a corrida" de
  // agendar a call primeiro — 'ia' (Camila, via create_calendar_event,
  // 01-07) ou 'humano' (SDR direto no GHL). Setado 1x (primeiro a chegar
  // fica) e consultado por dupla-acao.ts#podeAgendar antes de qualquer
  // tentativa real de agendamento pela IA.
  agendamentoOwner?: 'ia' | 'humano';
}

const cache = new Map<string, Sessao>();

// Busca sessao: primeiro cache, depois Supabase. Se houver conversa ativa < 24h,
// reconstroi a sessao no cache. O SDR AUTON tem 3 estados logicos —
// qualificador (batch)/camila (SPIN)/humano (pausa) — sempre retoma direto
// no estado em que a conversa parou.
export async function getSessao(telefone: string): Promise<Sessao | undefined> {
  if (cache.has(telefone)) {
    return cache.get(telefone);
  }

  const customer = await buscarCustomerPorTelefone(telefone);
  if (!customer) return undefined;

  const conversa = await buscarConversaAtiva(customer.id);
  if (!conversa) return undefined;

  const agenteConversa = enumParaAgente(conversa.agente_atual || 'humano');
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
    agendamentoOwner: (conversa.metadata as any)?.agendamento_owner || undefined,
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

  const agenteAtual = dados.agenteAtual || 'humano';

  let conversaId = '';
  if (customerId) {
    // Idempotente: se ja existe conversa em_atendimento ativa, reusa.
    // Garante uniqueness contra race entre 2 webhooks pro mesmo lead novo
    // (a unique constraint uk_conv_ativa_por_customer rejeita o segundo INSERT
    // e obterOuCriarConversaAtiva trata via fallback). Repassa o agente ja na
    // criacao (Gap 3/CR-01) — evita que 'camila'/'qualificador' fiquem so no
    // cache em memoria, sem sobreviver a restart/eviction.
    const id = await obterOuCriarConversaAtiva(customerId, agenteParaEnum(agenteAtual));
    if (id) conversaId = id;
  }

  const sessao: Sessao = {
    telefone,
    agenteAtual,
    nome,
    email,
    interesse: dados.interesse || '',
    customerId,
    conversaId,
    iniciadaEm: Date.now(),
    ghlContactId: dados.ghlContactId,
  };

  // Se chegou ghlContactId na criacao, persiste no metadata pra sobreviver
  // reinicio. Tambem corrige agente_atual quando a conversa foi REUSADA
  // (obterOuCriarConversaAtiva so grava o agente na criacao de uma conversa
  // nova; se ja existia uma ativa com outro agente, este PATCH sincroniza).
  // WR-06: merge com o metadata persistido — uma conversa REUSADA (race)
  // pode ja ter interesse/agendamento_owner/bloqueado_ate gravados.
  if (conversaId && (dados.ghlContactId || agenteAtual !== 'humano')) {
    const patch: Record<string, any> = {};
    if (dados.ghlContactId) {
      const atual = await metadataAtualDaConversa(conversaId);
      patch.metadata = JSON.stringify({ ...atual, ghl_contact_id: dados.ghlContactId });
    }
    if (agenteAtual !== 'humano') {
      patch.agente_atual = agenteParaEnum(agenteAtual);
    }
    await atualizarConversa(conversaId, patch);
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
    // WR-06: merge — preserva bloqueado_ate (pausa de crise) e qualquer
    // outra chave gravada por outros modulos.
    const atual = await metadataAtualDaConversa(sessao.conversaId);
    await atualizarConversa(sessao.conversaId, {
      metadata: JSON.stringify({ ...atual, ...metadataDaSessao(sessao) }),
    });
  }

  console.log(`[sessao] Dados atualizados: ${telefone} → ${sessao.nome || '(sem nome)'}`);
}

// FUN-05: marca quem "ganhou a corrida" de agendar a call primeiro. Idempotente
// por design — so seta se ainda nao houver owner (o primeiro a chegar fica;
// chamadas subsequentes do MESMO lado ou do lado perdedor nao sobrescrevem).
// Persiste no mesmo metadata JSON da conversa (sobrevive reinicio, mesmo
// padrao de ghl_contact_id/interesse acima).
export async function marcarAgendamentoOwner(telefone: string, quem: 'ia' | 'humano'): Promise<void> {
  const sessao = cache.get(telefone);
  if (!sessao) return;
  if (sessao.agendamentoOwner) {
    console.log(`[sessao] agendamentoOwner ja setado (${sessao.agendamentoOwner}) para ${telefone}, ignorando tentativa de ${quem}`);
    return;
  }

  sessao.agendamentoOwner = quem;
  cache.set(telefone, sessao);

  if (sessao.conversaId) {
    // WR-06: merge — preserva bloqueado_ate (pausa de crise) e qualquer
    // outra chave gravada por outros modulos.
    const atual = await metadataAtualDaConversa(sessao.conversaId);
    await atualizarConversa(sessao.conversaId, {
      metadata: JSON.stringify({ ...atual, ...metadataDaSessao(sessao), agendamento_owner: quem }),
    });
  }

  console.log(`[sessao] Agendamento owner marcado: ${telefone} → ${quem}`);
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
// SDR AUTON tem 2 agentes Mastra: 'qualificador' (processa o form 14q em
// modo batch — 01-04) e 'camila' (conduz o SPIN, saida JSON estrito —
// 01-05). O antigo agente vendedor/Sofia (Closer) foi removido (CLEAN-01)
// — nao existe mais chave logica 'vendedor'. 'humano' nao e um agente
// Mastra, e tratado no index.ts como pausa da IA.
export const AGENTES_MAP: Record<string, string> = {
  qualificador: 'qualificadorAgent',
  camila: 'camilaAgent',
  humano: 'humano',
};

export function agenteParaEnum(agente: string): string {
  const mapa: Record<string, string> = {
    qualificador: 'qualificador',
    camila: 'camila',
    humano: 'atendimento_humano',
  };
  // Fail-safe: qualquer agente logico desconhecido (nunca mais 'vendedor',
  // que foi removido — CLEAN-01) grava o valor de enum de pausa segura.
  return mapa[agente] || 'atendimento_humano';
}

// Inverso de agenteParaEnum — reconstroi o agente logico a partir do valor
// persistido no enum Postgres `auton_sdr_agente_tipo`. Fecha o Gap 3/CR-01:
// sem isso, 'atendimento_humano' nunca voltava como 'humano' apos restart
// (getSessao lia o valor cru do enum), quebrando a pausa da IA em leads
// escalados por sofrimento agudo.
// CLEAN-01: o enum Postgres ainda pode ter linhas legadas com o valor
// 'vendedor' (gravadas antes desta limpeza) — mapeia pra 'humano' (retomada
// segura), nunca pro agente Sofia/Closer removido.
export function enumParaAgente(enumValor: string): string {
  const mapa: Record<string, string> = {
    vendedor: 'humano',
    qualificador: 'qualificador',
    camila: 'camila',
    atendimento_humano: 'humano',
  };
  return mapa[enumValor] || 'humano';
}
