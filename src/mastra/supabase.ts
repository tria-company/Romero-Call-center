// Cliente Supabase reutilizavel para todas as operacoes de banco

import { fetchTimeout } from './http';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
// Usa service_role para operacoes server-side (bypassa RLS)
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=representation',
  };
}

// ==================== CUSTOMERS ====================

export async function buscarCustomerPorTelefone(telefone: string): Promise<any | null> {
  if (!SUPABASE_URL) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_customers?telefone=eq.${telefone}&select=*&limit=1`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) return null;
    const data = await res.json();
    return data[0] || null;
  } catch { return null; }
}

export async function upsertCustomer(dados: { telefone: string; nome?: string; email?: string }): Promise<string | null> {
  if (!SUPABASE_URL) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_customers?on_conflict=telefone`;

    const body: Record<string, string> = {
      telefone: dados.telefone,
      updated_at: new Date().toISOString(),
    };
    if (dados.nome) body.nome = dados.nome;
    if (dados.email) body.email = dados.email;

    const res = await fetchTimeout(url, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { console.error('[supabase] Erro upsert customer:', await res.text()); return null; }
    const data = await res.json();
    return data[0]?.id || null;
  } catch (e) { console.error('[supabase] Erro upsert customer:', e); return null; }
}

// ==================== CONVERSATIONS ====================

export async function criarConversa(customerId: string, _canal: string = 'whatsapp', agenteEnum: string = 'vendedor'): Promise<string | null> {
  if (!SUPABASE_URL) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_conversations`;
    const res = await fetchTimeout(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        customer_id: customerId,
        canal: 'whatsapp',
        status: 'em_atendimento',
        agente_atual: agenteEnum,
        data_ultima_mensagem: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      const erroBody = await res.text();
      // Codigo 23505 = unique_violation (uk_conv_ativa_por_customer da migration 04).
      // Ocorre quando 2 webhooks pro mesmo lead chegam em paralelo: um cria a conversa,
      // o outro tenta criar e bate na constraint. Caller deve tratar com obterOuCriarConversaAtiva.
      const conflict = res.status === 409 || erroBody.includes('23505') || erroBody.includes('uk_conv_ativa');
      if (conflict) {
        console.warn(`[supabase] criar conversa: conflito unique (race) pra customer ${customerId} — caller deve buscar a existente`);
      } else {
        console.error('[supabase] Erro criar conversa:', erroBody);
      }
      return null;
    }
    const data = await res.json();
    return data[0]?.id || null;
  } catch (e) { console.error('[supabase] Erro criar conversa:', e); return null; }
}

/**
 * Idempotente: garante que existe (e retorna o id de) a conversa ativa do customer.
 * Sequencia:
 *   1. SELECT da ativa — caso comum, evita INSERT desnecessario.
 *   2. INSERT — se nao existir.
 *   3. SELECT de novo — se INSERT falhou por unique violation (race entre 2 webhooks).
 *
 * Resolve issue #1 do review de prod (race em criarSessao gerando conversations
 * duplicadas com customer fragmentado).
 */
export async function obterOuCriarConversaAtiva(customerId: string, agenteEnum?: string): Promise<string | null> {
  if (!customerId) return null;
  const existente = await buscarConversaAtiva(customerId);
  if (existente?.id) return existente.id;

  const novoId = await criarConversa(customerId, 'whatsapp', agenteEnum || 'vendedor');
  if (novoId) return novoId;

  // Fallback pra race condition: criou em outro processo entre nosso SELECT e INSERT
  const segundaTentativa = await buscarConversaAtiva(customerId);
  return segundaTentativa?.id || null;
}

export async function buscarConversaAtiva(customerId: string): Promise<any | null> {
  if (!SUPABASE_URL) return null;
  try {
    const limite24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_conversations?customer_id=eq.${customerId}&ended_at=is.null&data_ultima_mensagem=gte.${limite24h}&select=*&order=data_ultima_mensagem.desc&limit=1`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) return null;
    const data = await res.json();
    return data[0] || null;
  } catch { return null; }
}

// Conversas pausadas porque humano assumiu (ate 3 dias).
// Usado pelo bloqueio.ts para persistir/recuperar o estado apos reinicio.
export async function buscarConversaBloqueada(customerId: string): Promise<any | null> {
  if (!SUPABASE_URL) return null;
  try {
    const limite3d = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_conversations?customer_id=eq.${customerId}&status=eq.aguardando_humano&ended_at=is.null&data_ultima_mensagem=gte.${limite3d}&select=*&order=data_ultima_mensagem.desc&limit=1`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) return null;
    const data = await res.json();
    return data[0] || null;
  } catch { return null; }
}

export async function atualizarConversa(conversaId: string, dados: Record<string, any>): Promise<void> {
  if (!SUPABASE_URL) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_conversations?id=eq.${conversaId}`;
    await fetchTimeout(url, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ ...dados, updated_at: new Date().toISOString(), data_ultima_mensagem: new Date().toISOString() }),
    });
  } catch (e) { console.error('[supabase] Erro atualizar conversa:', e); }
}

// ==================== FOLLOW-UP TRACKING ====================
// Helpers usados pelo scheduler em follow-up.ts e pelo webhook em index.ts
// pra rastrear quem foi o ultimo a falar e em que momento.

/**
 * Lead acabou de mandar mensagem: registra o timestamp e zera os marcadores
 * de FUP/handoff (ciclo de silencio reseta — proximo silencio comeca do zero).
 */
export async function marcarMsgLead(conversaId: string): Promise<void> {
  if (!conversaId) return;
  await atualizarConversa(conversaId, {
    last_lead_message_at: new Date().toISOString(),
    fup_1_sent_at: null,
    fup_3_sent_at: null,
    fup_5_sent_at: null,
    handoff_silencio_em: null,
  });
}

/**
 * Sofia acabou de mandar mensagem: registra o timestamp.
 * Inicia (ou reinicia) o relogio de silencio.
 */
export async function marcarMsgSofia(conversaId: string): Promise<void> {
  if (!conversaId) return;
  await atualizarConversa(conversaId, {
    last_assistant_message_at: new Date().toISOString(),
  });
}

/**
 * Busca conversas elegiveis pra envio de FUP ou handoff por silencio.
 * Critericos: status em_atendimento, sem handoff de silencio ja disparado,
 * ultima mensagem da Sofia ha pelo menos 1h. O caller checa qual FUP
 * dispara (1h/3h/5h/24h) com base nas colunas fup_*_sent_at.
 *
 * Retorna conversas com customer (telefone, nome) embutido pra evitar
 * round-trip extra por linha.
 */
export async function buscarConversasParaFollowUp(): Promise<any[]> {
  if (!SUPABASE_URL) return [];
  try {
    const limite1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_conversations?` +
      `status=eq.em_atendimento` +
      `&ended_at=is.null` +
      `&handoff_silencio_em=is.null` +
      `&last_assistant_message_at=not.is.null` +
      `&last_assistant_message_at=lt.${limite1h}` +
      `&select=*,auton_sdr_customers(telefone,nome)` +
      `&limit=200`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) {
      console.error('[supabase] buscarConversasParaFollowUp:', await res.text());
      return [];
    }
    const data = await res.json() as any[];
    // Filtro adicional in-memory: Sofia tem que ser a ultima a falar.
    // Postgrest nao tem comparacao entre 2 colunas via querystring, entao a
    // checagem fica aqui.
    return data.filter(c => {
      if (!c.last_lead_message_at) return true;
      return new Date(c.last_assistant_message_at).getTime()
        > new Date(c.last_lead_message_at).getTime();
    });
  } catch (e) {
    console.error('[supabase] Erro buscarConversasParaFollowUp:', e);
    return [];
  }
}

// ==================== MESSAGES ====================

export async function salvarMensagem(dados: {
  conversation_id: string;
  role: string;
  content: string;
  agent_table?: string;
  tool_name?: string;
  tool_input?: any;
  tool_output?: any;
}): Promise<void> {
  if (!SUPABASE_URL) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_messages`;
    await fetchTimeout(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(dados),
    });
  } catch (e) { console.error('[supabase] Erro salvar mensagem:', e); }
}

// ==================== OBJECOES ====================

export async function registrarObjecao(dados: {
  conversation_id: string;
  customer_id: string;
  telefone: string;
  categoria: string;
  texto_original: string;
  contornada: boolean;
}): Promise<void> {
  if (!SUPABASE_URL) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_objecoes`;
    await fetchTimeout(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(dados),
    });
  } catch (e) { console.error('[supabase] Erro registrar objecao:', e); }
}

// ==================== DASHBOARD ====================
// Helpers usados pelo handler do dashboard (src/mastra/dashboard.ts).
// Cada visita do dashboard refaz essas queries (auto-refresh 30s) — manter
// barato. Tudo via REST do PostgREST, mesmo padrao dos outros helpers.

/**
 * Lista conversas em atendimento ou aguardando humano, com customer embutido.
 * Ordenada pela ultima mensagem (mais recente primeiro).
 */
export async function buscarConversasAtivas(limite: number = 50): Promise<any[]> {
  if (!SUPABASE_URL) return [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_conversations?` +
      `status=in.(em_atendimento,aguardando_humano)` +
      `&ended_at=is.null` +
      `&select=*,auton_sdr_customers(nome,telefone)` +
      `&order=data_ultima_mensagem.desc` +
      `&limit=${limite}`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) return [];
    return (await res.json()) as any[];
  } catch (e) {
    console.error('[supabase] Erro buscarConversasAtivas:', e);
    return [];
  }
}

/**
 * Busca uma conversa especifica pelo id, com customer embutido.
 * Usado no header do viewer de conversa.
 */
export async function buscarConversaPorId(conversaId: string): Promise<any | null> {
  if (!SUPABASE_URL || !conversaId) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_conversations?id=eq.${conversaId}&select=*,auton_sdr_customers(nome,telefone)&limit=1`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) return null;
    const data = await res.json() as any[];
    return data[0] || null;
  } catch (e) {
    console.error('[supabase] Erro buscarConversaPorId:', e);
    return null;
  }
}

/**
 * Lista todas as mensagens de uma conversa, em ordem cronologica (ASC).
 * Inclui campos auxiliares pra renderizar badges no viewer (tool_name, tool_input, tool_output).
 */
export async function buscarMensagensDaConversa(conversaId: string): Promise<any[]> {
  if (!SUPABASE_URL || !conversaId) return [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_messages?conversation_id=eq.${conversaId}&select=*&order=created_at.asc&limit=500`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) return [];
    return (await res.json()) as any[];
  } catch (e) {
    console.error('[supabase] Erro buscarMensagensDaConversa:', e);
    return [];
  }
}

/**
 * Conta conversoes (link_enviado=true) em 4 janelas temporais.
 * Faz 4 HEAD requests em paralelo com Prefer: count=exact pra contar sem trazer dados.
 */
export async function contarConversoes(): Promise<{ hoje: number; semana: number; mes: number; total: number }> {
  if (!SUPABASE_URL) return { hoje: 0, semana: 0, mes: 0, total: 0 };
  const agora = Date.now();
  const inicioHoje = new Date(agora);
  inicioHoje.setHours(0, 0, 0, 0);
  const inicioSemana = new Date(agora - 7 * 24 * 60 * 60 * 1000);
  const inicioMes = new Date(agora - 30 * 24 * 60 * 60 * 1000);

  async function contar(filtroExtra: string): Promise<number> {
    try {
      const url = `${SUPABASE_URL}/rest/v1/auton_sdr_conversations?link_enviado=eq.true${filtroExtra}&select=id`;
      const res = await fetchTimeout(url, {
        method: 'HEAD',
        headers: { ...headers(), 'Prefer': 'count=exact' },
      });
      if (!res.ok) return 0;
      const range = res.headers.get('content-range') || '';
      const match = range.match(/\/(\d+|\*)$/);
      return match && match[1] !== '*' ? parseInt(match[1], 10) : 0;
    } catch { return 0; }
  }

  const [hoje, semana, mes, total] = await Promise.all([
    contar(`&link_enviado_em=gte.${inicioHoje.toISOString()}`),
    contar(`&link_enviado_em=gte.${inicioSemana.toISOString()}`),
    contar(`&link_enviado_em=gte.${inicioMes.toISOString()}`),
    contar(''),
  ]);
  return { hoje, semana, mes, total };
}

/**
 * Lista as N objecoes mais recentes (qualquer categoria) com texto + telefone.
 */
export async function buscarObjecoesRecentes(limite: number = 30): Promise<any[]> {
  if (!SUPABASE_URL) return [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_objecoes?select=*&order=created_at.desc&limit=${limite}`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) return [];
    return (await res.json()) as any[];
  } catch (e) {
    console.error('[supabase] Erro buscarObjecoesRecentes:', e);
    return [];
  }
}

/**
 * Conta objecoes por categoria (todas as conversas, sem filtro temporal).
 */
export async function contarObjecoesPorCategoria(): Promise<Record<string, number>> {
  if (!SUPABASE_URL) return {};
  try {
    // PostgREST nao tem GROUP BY direto. Solucao simples: traz max 1000
    // objecoes (campo categoria so) e conta in-memory.
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_objecoes?select=categoria&limit=2000`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) return {};
    const data = await res.json() as Array<{ categoria: string }>;
    const counts: Record<string, number> = {};
    for (const o of data) {
      counts[o.categoria] = (counts[o.categoria] || 0) + 1;
    }
    return counts;
  } catch (e) {
    console.error('[supabase] Erro contarObjecoesPorCategoria:', e);
    return {};
  }
}

/**
 * Salva 1 erro do agente. Chamado pelo catch em index.ts apos timeout/falha
 * do agent.generate. Falha silenciosa pra nao escalar (catch dentro do catch).
 */
export async function salvarErro(dados: {
  telefone: string;
  nome?: string;
  error_message: string;
  error_code?: string;
  context?: any;
  conversation_id?: string | null;
  customer_id?: string | null;
}): Promise<void> {
  if (!SUPABASE_URL) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_errors`;
    await fetchTimeout(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        telefone: dados.telefone,
        nome: dados.nome || null,
        error_message: dados.error_message,
        error_code: dados.error_code || 'outro',
        context: dados.context || null,
        conversation_id: dados.conversation_id || null,
        customer_id: dados.customer_id || null,
      }),
    });
  } catch (e) {
    console.error('[supabase] Erro salvarErro (silencioso):', e);
  }
}

/**
 * Lista os N erros mais recentes pra mostrar no dashboard.
 */
export async function buscarErrosRecentes(limite: number = 30): Promise<any[]> {
  if (!SUPABASE_URL) return [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_errors?select=*&order=created_at.desc&limit=${limite}`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) return [];
    return (await res.json()) as any[];
  } catch (e) {
    console.error('[supabase] Erro buscarErrosRecentes:', e);
    return [];
  }
}

/**
 * Conta erros por error_code desde uma data (default: ultimas 24h).
 */
export async function contarErrosPorCodigo(desdeISO?: string): Promise<Record<string, number>> {
  if (!SUPABASE_URL) return {};
  const desde = desdeISO || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_errors?select=error_code&created_at=gte.${desde}&limit=5000`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) return {};
    const data = await res.json() as Array<{ error_code: string }>;
    const counts: Record<string, number> = {};
    for (const e of data) {
      const code = e.error_code || 'outro';
      counts[code] = (counts[code] || 0) + 1;
    }
    return counts;
  } catch (e) {
    console.error('[supabase] Erro contarErrosPorCodigo:', e);
    return {};
  }
}

// ==================== DASHBOARD — FUNIL & FOLLOW-UPS ====================

/**
 * Funil de vendas — 3 etapas, historico total.
 * Objecoes e Follow-ups sao sections separadas no dashboard, nao etapa do funil.
 *
 * Etapas:
 *   1. total           - todas as conversas iniciadas
 *   2. engajou         - lead respondeu mais que so a primeira msg (last_lead_message_at > started_at)
 *   3. linkEnviado     - Sofia mandou checkout (link_enviado=true)
 */
export async function contarFunil(): Promise<{
  total: number;
  engajou: number;
  linkEnviado: number;
}> {
  if (!SUPABASE_URL) return { total: 0, engajou: 0, linkEnviado: 0 };
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_conversations?select=id,started_at,last_lead_message_at,link_enviado&limit=10000`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) return { total: 0, engajou: 0, linkEnviado: 0 };
    const conversas = await res.json() as Array<{
      id: string;
      started_at: string | null;
      last_lead_message_at: string | null;
      link_enviado: boolean | null;
    }>;

    const total = conversas.length;
    const engajou = conversas.filter((c) => {
      if (!c.last_lead_message_at || !c.started_at) return false;
      return new Date(c.last_lead_message_at).getTime() > new Date(c.started_at).getTime();
    }).length;
    const linkEnviado = conversas.filter((c) => c.link_enviado === true).length;
    return { total, engajou, linkEnviado };
  } catch (e) {
    console.error('[supabase] contarFunil:', e);
    return { total: 0, engajou: 0, linkEnviado: 0 };
  }
}

/**
 * Estatisticas de follow-ups automaticos (1h/3h/5h e handoff 24h por silencio).
 * Section a parte do funil — mede o esforco do scheduler em re-engajar leads
 * que silenciaram apos a Sofia ter falado.
 *
 * Retorna:
 *   - fup1, fup3, fup5: quantas conversas dispararam cada um
 *   - handoff24h: quantas foram pra handoff humano por 24h de silencio
 *   - leadsComFup: total de conversas distintas que receberam pelo menos 1 FUP
 */
export async function contarFollowUps(): Promise<{
  fup1: number;
  fup3: number;
  fup5: number;
  handoff24h: number;
  leadsComFup: number;
}> {
  const vazio = { fup1: 0, fup3: 0, fup5: 0, handoff24h: 0, leadsComFup: 0 };
  if (!SUPABASE_URL) return vazio;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_conversations?select=id,fup_1_sent_at,fup_3_sent_at,fup_5_sent_at,handoff_silencio_em&limit=10000`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) return vazio;
    const conversas = await res.json() as Array<{
      id: string;
      fup_1_sent_at: string | null;
      fup_3_sent_at: string | null;
      fup_5_sent_at: string | null;
      handoff_silencio_em: string | null;
    }>;
    return {
      fup1:        conversas.filter((c) => Boolean(c.fup_1_sent_at)).length,
      fup3:        conversas.filter((c) => Boolean(c.fup_3_sent_at)).length,
      fup5:        conversas.filter((c) => Boolean(c.fup_5_sent_at)).length,
      handoff24h:  conversas.filter((c) => Boolean(c.handoff_silencio_em)).length,
      leadsComFup: conversas.filter((c) =>
        Boolean(c.fup_1_sent_at || c.fup_3_sent_at || c.fup_5_sent_at || c.handoff_silencio_em)
      ).length,
    };
  } catch (e) {
    console.error('[supabase] contarFollowUps:', e);
    return vazio;
  }
}

// ==================== RESET DE TESTE ====================
// Helpers usados apenas pelo comando #55555 (resetar conversa pra testar).

/**
 * Encerra todas as conversas do customer (marca ended_at e status='encerrada').
 */
export async function encerrarConversasDoCustomer(customerId: string): Promise<void> {
  if (!SUPABASE_URL || !customerId) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_conversations?customer_id=eq.${customerId}&ended_at=is.null`;
    await fetchTimeout(url, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({
        status: 'encerrada',
        ended_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (e) { console.error('[supabase] Erro encerrar conversas do customer:', e); }
}

/**
 * Apaga todas as mensagens das conversas do customer.
 */
export async function deletarMensagensDoCustomer(customerId: string): Promise<void> {
  if (!SUPABASE_URL || !customerId) return;
  try {
    // Busca ids das conversas
    const urlConv = `${SUPABASE_URL}/rest/v1/auton_sdr_conversations?customer_id=eq.${customerId}&select=id`;
    const resConv = await fetchTimeout(urlConv, { headers: headers() });
    if (!resConv.ok) return;
    const conversas = await resConv.json() as Array<{ id: string }>;
    if (conversas.length === 0) return;
    const ids = conversas.map(c => c.id).join(',');

    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_messages?conversation_id=in.(${ids})`;
    await fetchTimeout(url, { method: 'DELETE', headers: headers() });
  } catch (e) { console.error('[supabase] Erro deletar mensagens:', e); }
}

/**
 * Apaga objecoes registradas para o telefone.
 */
export async function deletarObjecoesDoTelefone(telefone: string): Promise<void> {
  if (!SUPABASE_URL) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_objecoes?telefone=eq.${telefone}`;
    await fetchTimeout(url, { method: 'DELETE', headers: headers() });
  } catch (e) { console.error('[supabase] Erro deletar objecoes:', e); }
}

// ==================== DEDUP DE WEBHOOK (Fix #4 do review de prod) ====================
// Webhook do GHL Workflow as vezes dispara 2-3x por bug de rede ou retry
// automatico. Sem dedup, isso vira respostas duplicadas pro lead.

/**
 * Tenta registrar o hash do webhook. Retorna:
 *   true  → primeiro registro (deve processar a mensagem)
 *   false → ja registrado nos ultimos minutos (descartar — webhook duplicado)
 *
 * Em caso de erro de Supabase (network, timeout), retorna true (fail-open) —
 * preferimos resposta duplicada do que nao responder o lead.
 */
export async function tentarRegistrarWebhook(hash: string): Promise<boolean> {
  if (!SUPABASE_URL || !hash) return true;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_webhook_dedup?on_conflict=hash`;
    const res = await fetchTimeout(url, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({ hash }),
    });
    if (!res.ok) {
      console.error('[supabase] tentarRegistrarWebhook falhou:', await res.text());
      return true; // fail-open
    }
    const data = await res.json();
    // Quando inserido novo: array com 1 row. Quando conflito (ja existe): array vazio.
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.error('[supabase] tentarRegistrarWebhook erro:', e);
    return true; // fail-open
  }
}

/**
 * Cleanup periodico — chamado pelo scheduler (follow-up.ts).
 * Remove dedup hashes > 1h pra nao acumular.
 */
export async function limparWebhookDedupAntigos(): Promise<void> {
  if (!SUPABASE_URL) return;
  try {
    const corte = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_webhook_dedup?processed_at=lt.${corte}`;
    await fetchTimeout(url, { method: 'DELETE', headers: headers() });
  } catch (e) { console.error('[supabase] limparWebhookDedupAntigos:', e); }
}

// ==================== BUFFER PERSISTENTE (Fix #2 do review de prod) ====================
// Buffer em memoria perde mensagens em restart do container. Aqui persistimos
// cada mensagem antes do debounce — worker recovery (em follow-up.ts) re-processa
// orfas se o container que recebeu morrer antes do timer disparar.

/**
 * Insere uma mensagem no buffer persistente.
 * Chamado em paralelo ao buffer in-memory (fire-and-forget).
 */
export async function inserirBufferRow(dados: {
  telefone: string;
  texto: string;
  nome?: string;
  processar_apos: string;
}): Promise<void> {
  if (!SUPABASE_URL) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_webhook_buffer`;
    await fetchTimeout(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        telefone: dados.telefone,
        texto: dados.texto,
        nome: dados.nome || null,
        processar_apos: dados.processar_apos,
      }),
    });
  } catch (e) { console.error('[supabase] inserirBufferRow:', e); }
}

/**
 * Marca como processadas e devolve TODAS as mensagens pendentes do telefone
 * cujo processar_apos ja passou. Concatena na ordem de criacao.
 *
 * Atomico via PATCH — se 2 processos baterem ao mesmo tempo, so 1 ganha as rows.
 * O outro recebe array vazio e retorna null (nao processa de novo).
 */
export async function consumirBufferPendente(
  telefone: string,
): Promise<{ textoConcatenado: string; nome: string | null; quantidade: number } | null> {
  if (!SUPABASE_URL || !telefone) return null;
  try {
    const agora = new Date().toISOString();
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_webhook_buffer?` +
      `telefone=eq.${telefone}&processado=eq.false&processar_apos=lte.${agora}`;
    const res = await fetchTimeout(url, {
      method: 'PATCH',
      headers: { ...headers(), 'Prefer': 'return=representation' },
      body: JSON.stringify({ processado: true, processado_em: agora }),
    });
    if (!res.ok) {
      console.error('[supabase] consumirBufferPendente falhou:', await res.text());
      return null;
    }
    const rows = await res.json() as Array<{ texto: string; nome: string | null; created_at: string }>;
    if (rows.length === 0) return null;
    rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const textoConcatenado = rows.map(r => r.texto).join('\n');
    const nome = rows[rows.length - 1]?.nome || null;
    return { textoConcatenado, nome, quantidade: rows.length };
  } catch (e) {
    console.error('[supabase] consumirBufferPendente erro:', e);
    return null;
  }
}

/**
 * Telefones com mensagens nao processadas e cujo processar_apos passou ha
 * pelo menos `atrasoMinSec` segundos — provavelmente orfas (container que
 * recebeu morreu antes do timer disparar).
 *
 * Worker recovery em follow-up.ts chama isso periodicamente.
 */
export async function buscarTelefonesComBufferOrfao(atrasoMinSec: number = 30): Promise<string[]> {
  if (!SUPABASE_URL) return [];
  try {
    const corte = new Date(Date.now() - atrasoMinSec * 1000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_webhook_buffer?` +
      `processado=eq.false&processar_apos=lt.${corte}&select=telefone&limit=100`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) return [];
    const rows = await res.json() as Array<{ telefone: string }>;
    return Array.from(new Set(rows.map(r => r.telefone)));
  } catch (e) {
    console.error('[supabase] buscarTelefonesComBufferOrfao:', e);
    return [];
  }
}

/**
 * Cleanup: remove rows ja processadas ha mais de 30min.
 */
export async function limparBufferAntigo(): Promise<void> {
  if (!SUPABASE_URL) return;
  try {
    const corte = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_webhook_buffer?processado=eq.true&processado_em=lt.${corte}`;
    await fetchTimeout(url, { method: 'DELETE', headers: headers() });
  } catch (e) { console.error('[supabase] limparBufferAntigo:', e); }
}
