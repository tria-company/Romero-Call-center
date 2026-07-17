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

export async function criarConversa(customerId: string, _canal: string = 'whatsapp', agenteEnum: string = 'atendimento_humano'): Promise<string | null> {
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

  const novoId = await criarConversa(customerId, 'whatsapp', agenteEnum || 'atendimento_humano');
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

// WR-01 (3a rodada): conversa aberta aguardando humano SEM janela de tempo.
// Diferente de buscarConversaAtiva (24h) e buscarConversaBloqueada (3 dias),
// a pausa de crise (CR-03) precisa valer enquanto a conversa nao for
// encerrada/desbloqueada por um humano: um lead escalado por sofrimento
// agudo pode ficar em silencio por dias, e um re-submit do formulario NAO
// pode reativar o pipeline da IA so porque data_ultima_mensagem envelheceu.
// Usado pelo guard do webhook /api/webhook/formulario (index.ts, CR-03).
export async function buscarConversaAguardandoHumano(customerId: string): Promise<any | null> {
  if (!SUPABASE_URL) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_conversations?customer_id=eq.${customerId}&status=eq.aguardando_humano&ended_at=is.null&select=*&order=data_ultima_mensagem.desc&limit=1`;
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

// WR-04 (4a rodada): buscarConversasParaFollowUp foi REMOVIDA — o scheduler
// de FUP 1h/3h/5h/handoff-24h da Sofia (Closer) que era o unico caller foi
// deletado no rewrite de follow-up.ts (CLEAN-01). Se um re-engajamento
// pre-call do SDR for implementado (item deferido, ver SUMMARY do plano
// 04-01), escrever uma query nova com os criterios do SDR — nao ressuscitar
// a do Closer.

// ==================== CALL REMINDERS (TOOL-08/FUN-02) ====================
// Helpers usados por tools/schedule-reminder.ts (persistencia + confirmacao
// imediata) e pelo scheduler em lembretes.ts (toques D-1/H-1/5min).
// Migration: docs/sql/auton_sdr/07_call_reminders.sql

/**
 * Upsert (on_conflict=telefone) da call agendada. Reschedule (nova call pro
 * mesmo telefone) atualiza call_start_at, volta status='agendada' e ZERA
 * os flags d1/h1/m5_sent_at — mesmo padrao de reset de marcarMsgLead (o
 * relogio dos 3 toques temporizados comeca do zero pra nova data).
 * confirmacao_sent_at NAO e zerada aqui — quem marca ela e a propria tool
 * schedule-reminder, logo em seguida a este upsert.
 *
 * CR-01: o on_conflict=telefone depende do index unico CHEIO
 * uq_call_reminders_telefone (07_call_reminders.sql) — Postgres nao infere
 * index parcial via PostgREST (42P10). Se mudar a chave aqui, mude la junto.
 *
 * WR-04: o upsert tambem REABRE o loop de no-show (terminal=false,
 * motivo_terminal=null) — um lead fechado como Perdido que re-engaja e marca
 * nova call volta a ter deteccao de no-show (buscarCallsParaNoShow filtra
 * terminal=eq.false). Decisao explicita: no_show_tentativas e
 * ultima_recuperacao_em NAO sao zerados — TETO_NO_SHOWS (no-show.ts) conta o
 * TOTAL de faltas do lead, entao quem ja queimou a 1a recuperacao vira
 * Perdido direto na proxima falta (decidirNoShow trata a nova call via
 * comparacao ultima_recuperacao_em < call_start_at).
 */
export async function upsertLembreteCall(dados: {
  telefone: string;
  callStartAt: string;
  nome?: string;
  closer?: string;
  customerId?: string;
  conversationId?: string;
}): Promise<{ id: string } | null> {
  if (!SUPABASE_URL) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_call_reminders?on_conflict=telefone`;

    const body: Record<string, any> = {
      telefone: dados.telefone,
      call_start_at: dados.callStartAt,
      status: 'agendada',
      d1_sent_at: null,
      h1_sent_at: null,
      m5_sent_at: null,
      // WR-04: reabre o loop de no-show pra nova call (ver doc da funcao —
      // no_show_tentativas/ultima_recuperacao_em persistem de proposito).
      terminal: false,
      motivo_terminal: null,
      updated_at: new Date().toISOString(),
    };
    if (dados.nome) body.nome = dados.nome;
    if (dados.closer) body.closer = dados.closer;
    if (dados.customerId) body.customer_id = dados.customerId;
    if (dados.conversationId) body.conversation_id = dados.conversationId;

    const res = await fetchTimeout(url, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { console.error('[supabase] Erro upsert lembrete call:', await res.text()); return null; }
    const data = await res.json();
    return data[0]?.id ? { id: data[0].id as string } : null;
  } catch (e) { console.error('[supabase] Erro upsert lembrete call:', e); return null; }
}

/**
 * Busca lembretes pendentes (status='agendada') — usa o index parcial
 * idx_call_reminders_pendentes. Ordenado pelo call_start_at mais proximo
 * primeiro; limit 200 (mitigacao de DoS padrao das varreduras deste modulo,
 * T-02-04). telefone/nome ja vivem direto na row (nao precisa join).
 *
 * CR-06 (defesa em profundidade contra starvation da janela de 200 rows):
 * alem do filtro por status (que agora TRANSICIONA — ver marcarCallRealizada/
 * marcarCallTerminal), filtra terminal=eq.false e limita a janela temporal a
 * call_start_at >= now-49h (cobre o relogio de 48h do no-show com folga; um
 * toque de lembrete pra call que comecou ha mais de 49h nunca seria devido
 * de qualquer forma — proximoLembreteDevido retorna null apos o inicio).
 */
export async function buscarLembretesPendentes(): Promise<any[]> {
  if (!SUPABASE_URL) return [];
  try {
    const corte49h = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_call_reminders?` +
      `status=eq.agendada` +
      `&terminal=eq.false` +
      `&call_start_at=gte.${corte49h}` +
      `&select=*` +
      `&order=call_start_at.asc` +
      `&limit=200`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) {
      console.error('[supabase] buscarLembretesPendentes:', await res.text());
      return [];
    }
    return (await res.json()) as any[];
  } catch (e) {
    console.error('[supabase] Erro buscarLembretesPendentes:', e);
    return [];
  }
}

/**
 * Marca um dos 4 toques como enviado — gate anti-reenvio (idempotencia).
 * WR-01: checa res.ok e retorna boolean HONESTO — um PATCH perdido (ex:
 * coluna faltando por migration nao aplicada) era invisivel e o toque seria
 * reenviado a cada 60s pra sempre. Caller loga/decide com o retorno.
 */
export async function marcarLembreteEnviado(
  id: string,
  campo: 'confirmacao_sent_at' | 'd1_sent_at' | 'h1_sent_at' | 'm5_sent_at',
): Promise<boolean> {
  if (!SUPABASE_URL || !id) return false;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_call_reminders?id=eq.${id}`;
    const res = await fetchTimeout(url, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ [campo]: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
    if (!res.ok) {
      console.error(`[supabase] marcarLembreteEnviado ${id} (${campo}) falhou: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (e) { console.error('[supabase] Erro marcarLembreteEnviado:', e); return false; }
}

// ==================== NO-SHOW LOOP (FUN-03/FUN-04) ====================
// Helpers usados por src/mastra/no-show.ts (loop de recuperacao de no-show).
// Migration: docs/sql/auton_sdr/08_no_show.sql (estende auton_sdr_call_reminders,
// criada em 07_call_reminders.sql, plano 02-01).

/**
 * Busca calls elegiveis pro loop de no-show: status='agendada' (ainda nao
 * realizada/encerrada) E terminal=false (loop ainda nao encerrou pra essa
 * row — T-02-09, evita reprocessar linha ja resolvida). Embute
 * last_lead_message_at da conversa vinculada (se houver — conversation_id e
 * best-effort, ver schedule-reminder.ts) apenas como FALLBACK: o sinal
 * primario de leadRespondeuAposCall vem de buscarUltimaMsgLeadDoCustomer
 * (WR-02 — a conversa congelada na row envelhece). limit 200
 * (mesma mitigacao de DoS de buscarLembretesPendentes).
 */
export async function buscarCallsParaNoShow(): Promise<any[]> {
  if (!SUPABASE_URL) return [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_call_reminders?` +
      `status=eq.agendada` +
      `&terminal=eq.false` +
      `&select=*,auton_sdr_conversations(last_lead_message_at)` +
      `&order=call_start_at.asc` +
      `&limit=200`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) {
      console.error('[supabase] buscarCallsParaNoShow:', await res.text());
      return [];
    }
    return (await res.json()) as any[];
  } catch (e) {
    console.error('[supabase] Erro buscarCallsParaNoShow:', e);
    return [];
  }
}

/**
 * Registra que uma recuperacao de no-show foi disparada: grava
 * no_show_tentativas (valor ja calculado pelo caller), no_show_detectado_em
 * e ultima_recuperacao_em (relogio do timeout de 48h — decidirNoShow le esta
 * coluna via ultimaRecuperacaoMs).
 * WR-01: checa res.ok e retorna boolean HONESTO — um PATCH perdido (ex:
 * migration 08 nao aplicada → coluna faltando → 400) re-dispararia a
 * recuperacao inteira a cada tick sem nenhum log.
 */
export async function registrarNoShowRecuperacao(
  id: string,
  tentativas: number,
  ultimaRecuperacaoIso: string,
): Promise<boolean> {
  if (!SUPABASE_URL || !id) return false;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_call_reminders?id=eq.${id}`;
    const res = await fetchTimeout(url, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({
        no_show_tentativas: tentativas,
        no_show_detectado_em: ultimaRecuperacaoIso,
        ultima_recuperacao_em: ultimaRecuperacaoIso,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      console.error(`[supabase] registrarNoShowRecuperacao ${id} falhou: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (e) { console.error('[supabase] Erro registrarNoShowRecuperacao:', e); return false; }
}

/**
 * Encerra o loop de no-show pra uma row: terminal=true + motivo_terminal
 * ('2º no-show' | '48h sem resposta'). decidirNoShow retorna 'nada' pra
 * qualquer row terminal=true (T-02-09: sem loop infinito). O card ja foi
 * movido pra PERDIDO no pipeline GHL (pelo caller, ANTES desta chamada).
 * CR-06: tambem transiciona status='no_show' — a row sai das varreduras
 * status=eq.agendada (lembretes E no-show), liberando a janela de 200 rows.
 * WR-01: checa res.ok e retorna boolean HONESTO — um PATCH perdido re-moveria
 * o card pra PERDIDO a cada tick sem nenhum log.
 */
export async function marcarCallTerminal(id: string, motivo: string): Promise<boolean> {
  if (!SUPABASE_URL || !id) return false;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_call_reminders?id=eq.${id}`;
    const res = await fetchTimeout(url, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({
        status: 'no_show',
        terminal: true,
        motivo_terminal: motivo,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      console.error(`[supabase] marcarCallTerminal ${id} falhou: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (e) { console.error('[supabase] Erro marcarCallTerminal:', e); return false; }
}

/**
 * CR-06: fecha a row como 'realizada' quando o lead RESPONDEU depois do
 * inicio da call (proxy de comparecimento/engajamento — decidirNoShow ja
 * retornava 'nada' nesse caso, mas a row ficava zumbi re-escaneada a cada
 * 60s pra sempre e entupindo a janela de 200 rows das varreduras).
 * WR-01: checa res.ok e retorna boolean HONESTO.
 */
export async function marcarCallRealizada(id: string): Promise<boolean> {
  if (!SUPABASE_URL || !id) return false;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_call_reminders?id=eq.${id}`;
    const res = await fetchTimeout(url, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({
        status: 'realizada',
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      console.error(`[supabase] marcarCallRealizada ${id} falhou: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (e) { console.error('[supabase] Erro marcarCallRealizada:', e); return false; }
}

/**
 * WR-02: ultima mensagem do LEAD entre TODAS as conversas do customer — o
 * conversation_id congelado na row do lembrete aponta pra conversa da epoca
 * do agendamento; um lead que respondeu ao toque D-1 dias depois cria uma
 * conversa NOVA e seria falso-no-show se olhassemos so a conversa antiga.
 * Retorna o last_lead_message_at mais recente (ISO) ou null.
 */
export async function buscarUltimaMsgLeadDoCustomer(customerId: string): Promise<string | null> {
  if (!SUPABASE_URL || !customerId) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_conversations?` +
      `customer_id=eq.${customerId}` +
      `&last_lead_message_at=not.is.null` +
      `&select=last_lead_message_at` +
      `&order=last_lead_message_at.desc` +
      `&limit=1`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) {
      console.error(`[supabase] buscarUltimaMsgLeadDoCustomer ${customerId} falhou: ${res.status} ${await res.text()}`);
      return null;
    }
    const data = await res.json() as Array<{ last_lead_message_at: string | null }>;
    return data[0]?.last_lead_message_at || null;
  } catch (e) { console.error('[supabase] Erro buscarUltimaMsgLeadDoCustomer:', e); return null; }
}

// ==================== RESGATES (GRAV-03) ====================
// Helpers usados por src/mastra/resgates.ts (resgate durável de 48h quando a
// extracao de sinais, src/mastra/extracao-sinais.ts, detecta um sinal de
// desistencia sem fechamento). Migration: docs/sql/auton_sdr/09_resgates.sql.

/**
 * Upsert por telefone (index unico CHEIO uq_resgates_telefone — mesma licao
 * do CR-01 da 07_call_reminders.sql: o on_conflict do PostgREST so infere
 * index nao-parcial). Um novo sinal de desistencia pro MESMO lead reabre
 * status='pendente' e recalcula resgatar_em (relogio de 48h reinicia do
 * sinal mais recente) — nunca cria 2 resgates pendentes pro mesmo lead
 * (T-03-09).
 */
export async function upsertResgate(dados: {
  telefone: string;
  customerId?: string;
  nome?: string;
  motivo?: string;
  resgatarEm: string;
}): Promise<{ id: string } | null> {
  if (!SUPABASE_URL) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_resgates?on_conflict=telefone`;

    const body: Record<string, any> = {
      telefone: dados.telefone,
      resgatar_em: dados.resgatarEm,
      status: 'pendente',
      updated_at: new Date().toISOString(),
    };
    if (dados.customerId) body.customer_id = dados.customerId;
    if (dados.nome) body.nome = dados.nome;
    if (dados.motivo) body.motivo = dados.motivo;

    const res = await fetchTimeout(url, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { console.error('[supabase] Erro upsert resgate:', await res.text()); return null; }
    const data = await res.json();
    return data[0]?.id ? { id: data[0].id as string } : null;
  } catch (e) { console.error('[supabase] Erro upsert resgate:', e); return null; }
}

/**
 * Busca resgates pendentes e DEVIDOS (status='pendente' & resgatar_em<=now)
 * — usa o index parcial idx_resgates_pendentes. limit 200 (mesma mitigacao
 * de DoS de buscarLembretesPendentes/buscarCallsParaNoShow, T-03-09).
 */
export async function buscarResgatesPendentes(): Promise<any[]> {
  if (!SUPABASE_URL) return [];
  try {
    const agoraIso = new Date().toISOString();
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_resgates?` +
      `status=eq.pendente` +
      `&resgatar_em=lte.${agoraIso}` +
      `&select=*` +
      `&order=resgatar_em.asc` +
      `&limit=200`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) {
      console.error('[supabase] buscarResgatesPendentes:', await res.text());
      return [];
    }
    return (await res.json()) as any[];
  } catch (e) {
    console.error('[supabase] Erro buscarResgatesPendentes:', e);
    return [];
  }
}

/**
 * Marca um resgate como terminal: 'feito' (task pro SDR humano criada com
 * sucesso) ou 'cancelado' (lead ja GANHO — fechou antes do disparo). WR-01:
 * checa res.ok e retorna boolean HONESTO — um PATCH perdido re-dispararia o
 * resgate a cada tick sem nenhum log.
 */
export async function marcarResgateFeito(id: string, status: 'feito' | 'cancelado'): Promise<boolean> {
  if (!SUPABASE_URL || !id) return false;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_resgates?id=eq.${id}`;
    const res = await fetchTimeout(url, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) {
      console.error(`[supabase] marcarResgateFeito ${id} (${status}) falhou: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (e) { console.error('[supabase] Erro marcarResgateFeito:', e); return false; }
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
// WR-04 (4a rodada): registrarObjecao (writer) foi REMOVIDA — o unico caller
// era a tool tools/registrar-objecao.ts do Closer, deletada no CLEAN-01.
// Os helpers de LEITURA (buscarObjecoesRecentes/contarObjecoesPorCategoria)
// seguem na secao DASHBOARD abaixo enquanto a section de objecoes historicas
// existir no dashboard.

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

// WR-03 (4a rodada): contarConversoes (cards "Links enviados"/"checkouts")
// foi REMOVIDA — lia link_enviado, coluna sem NENHUM writer desde a delecao
// da tool enviar-checkout do Closer (CLEAN-01). A metrica de conversao do
// SDR AUTON e call agendada (auton_sdr_call_reminders) — implementar como
// metrica propria quando o dashboard for re-desenhado pro SDR.

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
 * Salva 1 metrica de interacao LLM (HARD-08, Fase 5 plano 05-06). Espelha
 * salvarErro 1:1 (guarda SUPABASE_URL, POST via fetchTimeout+headers(),
 * try/catch silencioso => void). FAIL-OPEN: a tabela auton_sdr_llm_metrics
 * (migracao 11) e [BLOCKING]/user_setup — enquanto o banco estiver
 * read-only/ausente, esta funcao lanca dentro do try e o catch engole a
 * excecao silenciosamente. Chamada por registrarMetricaLLM
 * (observabilidade.ts) como o `persist` injetado — o log JSON estruturado
 * `[metrica-llm]` ja rodou ANTES desta chamada, entao a falha aqui nunca
 * derruba a observabilidade nem o pipeline (T-05-06-02). NUNCA recebe/loga
 * texto bruto de mensagem/resposta (LGPD, T-05-06-01).
 */
export async function salvarMetricaLLM(dados: {
  telefone?: string;
  modelo: string;
  tipo: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  custoEstimado?: number;
  latenciaMs?: number;
  promptVersao?: string;
  cacheHit?: boolean;
  conversationId?: string | null;
  customerId?: string | null;
  /** WR-05: false quando o modelo/deployment nao tem preco na tabela de custo (custo_estimado=0 e uma INCOGNITA, nao um zero real). */
  custoConhecido?: boolean;
  /** WR-05: true quando os tokens sao estimativa (usage ausente na resposta do provider), nao valor exato. */
  tokensEstimados?: boolean;
}): Promise<void> {
  if (!SUPABASE_URL) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_llm_metrics`;
    await fetchTimeout(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        telefone: dados.telefone || null,
        modelo: dados.modelo,
        tipo: dados.tipo,
        prompt_tokens: dados.promptTokens ?? null,
        completion_tokens: dados.completionTokens ?? null,
        total_tokens: dados.totalTokens ?? null,
        custo_estimado: dados.custoEstimado ?? null,
        latencia_ms: dados.latenciaMs ?? null,
        prompt_versao: dados.promptVersao || null,
        cache_hit: dados.cacheHit ?? false,
        conversation_id: dados.conversationId || null,
        customer_id: dados.customerId || null,
        // WR-05: sem estas 2 colunas, uma linha de cache HIT (custo 0 real)
        // e uma de deployment sem preco (custo 0 incognita) eram
        // indistinguiveis na tabela.
        custo_conhecido: dados.custoConhecido ?? null,
        tokens_estimados: dados.tokensEstimados ?? null,
      }),
    });
  } catch (e) {
    console.error('[supabase] Erro salvarMetricaLLM (silencioso, fail-open):', e);
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

// ==================== DASHBOARD — FUNIL ====================

/**
 * Funil do dashboard — 2 etapas, historico total.
 *
 * Etapas:
 *   1. total   - todas as conversas iniciadas
 *   2. engajou - lead respondeu mais que so a primeira msg (last_lead_message_at > started_at)
 *
 * WR-03 (4a rodada): a etapa "linkEnviado" foi removida — link_enviado nao
 * tem writer desde a delecao da tool enviar-checkout (CLEAN-01) e congelava
 * a metrica-titulo do dashboard em valores historicos do Closer. A etapa
 * final do funil do SDR AUTON e call agendada (auton_sdr_call_reminders).
 */
export async function contarFunil(): Promise<{
  total: number;
  engajou: number;
}> {
  if (!SUPABASE_URL) return { total: 0, engajou: 0 };
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_conversations?select=id,started_at,last_lead_message_at&limit=10000`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) return { total: 0, engajou: 0 };
    const conversas = await res.json() as Array<{
      id: string;
      started_at: string | null;
      last_lead_message_at: string | null;
    }>;

    const total = conversas.length;
    const engajou = conversas.filter((c) => {
      if (!c.last_lead_message_at || !c.started_at) return false;
      return new Date(c.last_lead_message_at).getTime() > new Date(c.started_at).getTime();
    }).length;
    return { total, engajou };
  } catch (e) {
    console.error('[supabase] contarFunil:', e);
    return { total: 0, engajou: 0 };
  }
}

// WR-03 (4a rodada): contarFollowUps (section "Follow-ups automaticos") foi
// REMOVIDA — as colunas fup_*_sent_at/handoff_silencio_em nao tem mais
// writer (FUP-Sofia removido no CLEAN-01) enquanto marcarMsgLead ainda as
// zera, entao a contagem so DECAIA silenciosamente parecendo dado vivo. Os
// equivalentes do SDR sao os lembretes de call (lembretes.ts) e o loop de
// no-show/resgates — metricas proprias quando o dashboard for re-desenhado.

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

// ==================== CORRELACAO CALL<->RECORD DA WAVOIP ====================
// O evento RECORD do webhook Wavoip NAO traz telefone — so whatsapp_call_id. O
// evento CALL (que traz caller/receiver) chega antes/junto. Guardamos aqui o
// par whatsapp_call_id -> telefone (duravel, sobrevive restart do PM2) pra que o
// handler do RECORD resolva o contato e persista a transcricao no lead certo.

/**
 * Registra/atualiza a correlacao whatsapp_call_id -> telefone (upsert por
 * whatsapp_call_id). Idempotente. NUNCA lanca — falha de Supabase so loga.
 */
export async function salvarWavoipCall(whatsappCallId: string, telefone: string): Promise<void> {
  if (!SUPABASE_URL || !whatsappCallId || !telefone) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_wavoip_calls?on_conflict=whatsapp_call_id`;
    const res = await fetchTimeout(url, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ whatsapp_call_id: whatsappCallId, telefone }),
    });
    if (!res.ok) {
      console.error('[supabase] salvarWavoipCall falhou:', await res.text());
    }
  } catch (e) {
    console.error('[supabase] salvarWavoipCall erro:', e);
  }
}

/**
 * Resolve o telefone (apenas digitos) de uma call Wavoip pelo whatsapp_call_id.
 * Retorna null se ainda nao houver correlacao (evento CALL nao chegou/perdido).
 */
export async function buscarTelefonePorWavoipCall(whatsappCallId: string): Promise<string | null> {
  if (!SUPABASE_URL || !whatsappCallId) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/auton_sdr_wavoip_calls?whatsapp_call_id=eq.${encodeURIComponent(whatsappCallId)}&select=telefone&limit=1`;
    const res = await fetchTimeout(url, { headers: headers() });
    if (!res.ok) {
      console.error('[supabase] buscarTelefonePorWavoipCall falhou:', await res.text());
      return null;
    }
    const data = await res.json();
    return Array.isArray(data) && data[0]?.telefone ? String(data[0].telefone) : null;
  } catch (e) {
    console.error('[supabase] buscarTelefonePorWavoipCall erro:', e);
    return null;
  }
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

// ==================== FORMULARIO — GATE DE FOLLOW-UP ====================
// A tabela de respostas do formulario (public.usi_pesquisa_respostas) vive no
// Supabase do dashboard/forms, que PODE ser um projeto diferente do
// SUPABASE_URL principal deste servico. Por isso ha vars dedicadas
// FORMS_SUPABASE_URL / FORMS_SUPABASE_KEY, com FALLBACK para as principais
// (SUPABASE_URL / SERVICE_ROLE / ANON) quando nao setadas — ou seja, se a
// tabela estiver no MESMO projeto, nao precisa configurar nada novo.
const FORMS_SUPABASE_URL = process.env.FORMS_SUPABASE_URL || SUPABASE_URL;
const FORMS_SUPABASE_KEY =
  process.env.FORMS_SUPABASE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  '';

function formsHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'apikey': FORMS_SUPABASE_KEY,
    'Authorization': `Bearer ${FORMS_SUPABASE_KEY}`,
  };
}

export interface StatusFormulario {
  encontrado: boolean;
  status: string | null;
  respondido: boolean;
  iniciado: boolean;
}

/**
 * Consulta o status do formulario 14q de um contato pelo ghl_contact_id na
 * tabela usi_pesquisa_respostas (Supabase do forms). Usado pelo gate de
 * follow-up (/api/fup/pode-enviar): o Workflow [04] do GHL so envia o
 * lembrete/convite se `respondido` for false.
 *
 * respondido = status === 'respondido' OU respondido_at != null
 * iniciado   = status === 'iniciado'   OU iniciado_at   != null
 *
 * FAIL-SAFE: em erro/sem URL/sem contato, retorna respondido=false. A regra
 * de negocio (deliberada) e NAO barrar o follow-up por falha de infra —
 * preferimos um lembrete a mais a silenciar todo o funil por um erro pontual.
 * O lado ruim (reenvio) e mitigado pela idempotencia/cadencia do proprio
 * Workflow; o lado bom (nunca abandonar o lead) e o core value do SDR.
 */
export async function statusFormularioPorContato(ghlContactId: string): Promise<StatusFormulario> {
  const vazio: StatusFormulario = { encontrado: false, status: null, respondido: false, iniciado: false };
  if (!FORMS_SUPABASE_URL || !ghlContactId) return vazio;
  try {
    const url = `${FORMS_SUPABASE_URL}/rest/v1/usi_pesquisa_respostas` +
      `?ghl_contact_id=eq.${encodeURIComponent(ghlContactId)}` +
      `&select=status,respondido_at,iniciado_at&limit=1`;
    const res = await fetchTimeout(url, { headers: formsHeaders() });
    if (!res.ok) {
      console.error('[supabase] statusFormularioPorContato HTTP', res.status);
      return vazio;
    }
    const rows = await res.json() as Array<{ status: string | null; respondido_at: string | null; iniciado_at: string | null }>;
    const row = rows[0];
    if (!row) return vazio;
    const respondido = row.status === 'respondido' || row.respondido_at != null;
    const iniciado = row.status === 'iniciado' || row.iniciado_at != null;
    return { encontrado: true, status: row.status ?? null, respondido, iniciado };
  } catch (e) {
    console.error('[supabase] statusFormularioPorContato:', e);
    return vazio;
  }
}
