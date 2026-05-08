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
