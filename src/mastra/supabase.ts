// Cliente Supabase reutilizavel para todas as operacoes de banco

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
    const url = `${SUPABASE_URL}/rest/v1/customers_roberth?telefone=eq.${telefone}&select=*&limit=1`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) return null;
    const data = await res.json();
    return data[0] || null;
  } catch { return null; }
}

export async function upsertCustomer(dados: { telefone: string; nome?: string; email?: string }): Promise<string | null> {
  if (!SUPABASE_URL) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/customers_roberth?on_conflict=telefone`;

    const body: Record<string, string> = {
      telefone: dados.telefone,
      updated_at: new Date().toISOString(),
    };
    if (dados.nome) body.nome = dados.nome;
    if (dados.email) body.email = dados.email;

    const res = await fetch(url, {
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

export async function criarConversa(customerId: string, _canal: string = 'whatsapp'): Promise<string | null> {
  if (!SUPABASE_URL) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/conversations_roberth`;
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        customer_id: customerId,
        canal: 'whatsapp',
        status: 'em_atendimento',
        agente_atual: 'vendedor',
        data_ultima_mensagem: new Date().toISOString(),
      }),
    });
    if (!res.ok) { console.error('[supabase] Erro criar conversa:', await res.text()); return null; }
    const data = await res.json();
    return data[0]?.id || null;
  } catch (e) { console.error('[supabase] Erro criar conversa:', e); return null; }
}

export async function buscarConversaAtiva(customerId: string): Promise<any | null> {
  if (!SUPABASE_URL) return null;
  try {
    const limite24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/conversations_roberth?customer_id=eq.${customerId}&ended_at=is.null&data_ultima_mensagem=gte.${limite24h}&select=*&order=data_ultima_mensagem.desc&limit=1`;
    const res = await fetch(url, { headers: headers() });
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
    const url = `${SUPABASE_URL}/rest/v1/conversations_roberth?customer_id=eq.${customerId}&status=eq.aguardando_humano&ended_at=is.null&data_ultima_mensagem=gte.${limite3d}&select=*&order=data_ultima_mensagem.desc&limit=1`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) return null;
    const data = await res.json();
    return data[0] || null;
  } catch { return null; }
}

export async function atualizarConversa(conversaId: string, dados: Record<string, any>): Promise<void> {
  if (!SUPABASE_URL) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/conversations_roberth?id=eq.${conversaId}`;
    await fetch(url, {
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
    const url = `${SUPABASE_URL}/rest/v1/conversations_roberth?` +
      `status=eq.em_atendimento` +
      `&ended_at=is.null` +
      `&handoff_silencio_em=is.null` +
      `&last_assistant_message_at=not.is.null` +
      `&last_assistant_message_at=lt.${limite1h}` +
      `&select=*,customers_roberth(telefone,nome)` +
      `&limit=200`;
    const res = await fetch(url, { headers: headers() });
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
    const url = `${SUPABASE_URL}/rest/v1/messages_roberth`;
    await fetch(url, {
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
    const url = `${SUPABASE_URL}/rest/v1/objecoes_roberth`;
    await fetch(url, {
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
    const url = `${SUPABASE_URL}/rest/v1/conversations_roberth?` +
      `status=in.(em_atendimento,aguardando_humano)` +
      `&ended_at=is.null` +
      `&select=*,customers_roberth(nome,telefone)` +
      `&order=data_ultima_mensagem.desc` +
      `&limit=${limite}`;
    const res = await fetch(url, { headers: headers() });
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
    const url = `${SUPABASE_URL}/rest/v1/conversations_roberth?id=eq.${conversaId}&select=*,customers_roberth(nome,telefone)&limit=1`;
    const res = await fetch(url, { headers: headers() });
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
    const url = `${SUPABASE_URL}/rest/v1/messages_roberth?conversation_id=eq.${conversaId}&select=*&order=created_at.asc&limit=500`;
    const res = await fetch(url, { headers: headers() });
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
      const url = `${SUPABASE_URL}/rest/v1/conversations_roberth?link_enviado=eq.true${filtroExtra}&select=id`;
      const res = await fetch(url, {
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
    const url = `${SUPABASE_URL}/rest/v1/objecoes_roberth?select=*&order=created_at.desc&limit=${limite}`;
    const res = await fetch(url, { headers: headers() });
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
    const url = `${SUPABASE_URL}/rest/v1/objecoes_roberth?select=categoria&limit=2000`;
    const res = await fetch(url, { headers: headers() });
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
    const url = `${SUPABASE_URL}/rest/v1/errors_roberth`;
    await fetch(url, {
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
    const url = `${SUPABASE_URL}/rest/v1/errors_roberth?select=*&order=created_at.desc&limit=${limite}`;
    const res = await fetch(url, { headers: headers() });
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
    const url = `${SUPABASE_URL}/rest/v1/errors_roberth?select=error_code&created_at=gte.${desde}&limit=5000`;
    const res = await fetch(url, { headers: headers() });
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

// ==================== RESET DE TESTE ====================
// Helpers usados apenas pelo comando #55555 (resetar conversa pra testar).

/**
 * Encerra todas as conversas do customer (marca ended_at e status='encerrada').
 */
export async function encerrarConversasDoCustomer(customerId: string): Promise<void> {
  if (!SUPABASE_URL || !customerId) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/conversations_roberth?customer_id=eq.${customerId}&ended_at=is.null`;
    await fetch(url, {
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
    const urlConv = `${SUPABASE_URL}/rest/v1/conversations_roberth?customer_id=eq.${customerId}&select=id`;
    const resConv = await fetch(urlConv, { headers: headers() });
    if (!resConv.ok) return;
    const conversas = await resConv.json() as Array<{ id: string }>;
    if (conversas.length === 0) return;
    const ids = conversas.map(c => c.id).join(',');

    const url = `${SUPABASE_URL}/rest/v1/messages_roberth?conversation_id=in.(${ids})`;
    await fetch(url, { method: 'DELETE', headers: headers() });
  } catch (e) { console.error('[supabase] Erro deletar mensagens:', e); }
}

/**
 * Apaga objecoes registradas para o telefone.
 */
export async function deletarObjecoesDoTelefone(telefone: string): Promise<void> {
  if (!SUPABASE_URL) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/objecoes_roberth?telefone=eq.${telefone}`;
    await fetch(url, { method: 'DELETE', headers: headers() });
  } catch (e) { console.error('[supabase] Erro deletar objecoes:', e); }
}
