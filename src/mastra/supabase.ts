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
