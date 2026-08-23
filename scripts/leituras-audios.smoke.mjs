#!/usr/bin/env node
// scripts/leituras-audios.smoke.mjs
//
// Smoke determinístico (fetch MOCKADO — sem rede/Supabase real) das 5
// leituras da Fase C em src/mastra/supabase.ts (20-04-PLAN.md, design §4):
// buscarLeadsNuncaLigadosSupabase, mapaConversaPorLeadSupabase,
// listarEnviosAudioDoLeadSupabase (Task 1, casos a-c) +
// selecionarLoteElegiveisSupabase, listarNotasDoLeadSupabase (Task 2, d-e).
//
// ORÁCULO dos <verify> deste plano (MEDIUM-2): cada <verify> roda este mesmo
// arquivo — Task 1 cobre a-c, Task 2 estende com d-e (verde a cada fronteira,
// sem "cannot find module").
//
// Monkeypatch de global.fetch (molde scripts/gap-19-11.smoke.mjs): roteia
// por CARACTERÍSTICA da URL/query PostgREST — qualquer chamada a
// api.clickup.com (a listagem geral que caiu no incidente) FALHA o smoke.
//
// LGPD: nunca imprime telefone/nome/corpo de nota real — só valores
// sintéticos e booleans/URLs PostgREST.
//
// Uso: node --experimental-strip-types scripts/leituras-audios.smoke.mjs

// Env sintética ANTES de qualquer import de src/ (config.ts lê no import-time).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://fake.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'k';

const falhas = [];
function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function ok(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}

function fetchInesperado(url, metodo) {
  throw new Error(`fetch inesperado no smoke: ${metodo} ${url}`);
}

/** Decodifica a URL capturada (URLSearchParams escapa `,`/`(`/`)`) para as
 *  asserções ficarem legíveis e não dependerem de %XX exato. */
function dec(url) {
  return decodeURIComponent(url);
}

// ===== (a) nunca-ligados: anti-join por lead_id (NUNCA telefone/listagem ClickUp) =====

async function testarNuncaLigadosAntiJoinPorLeadId() {
  const { buscarLeadsNuncaLigadosSupabase } = await import('../src/mastra/supabase.ts');
  const fetchReal = global.fetch;
  const urls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const metodo = (opts.method || 'GET').toUpperCase();
    urls.push(u);
    if (u.includes('api.clickup.com')) fetchInesperado(u, metodo);
    if (u.includes('/rest/v1/ligacoes') && u.includes('select=lead_id')) {
      return ok([{ lead_id: 1 }, { lead_id: 2 }]);
    }
    if (u.includes('/rest/v1/discador_leads_espelho')) {
      return ok([{ id: 3, clickup_task_id: 'T3', nome: 'Fulano', telefone: '+5511999999999' }]);
    }
    fetchInesperado(u, metodo);
  };
  try {
    const { leads, origens } = await buscarLeadsNuncaLigadosSupabase();
    const urlLeads = dec(urls.find((u) => u.includes('/rest/v1/discador_leads_espelho')) ?? '');
    checar(!!urlLeads, 'buscarLeadsNuncaLigadosSupabase deveria consultar discador_leads_espelho');
    checar(
      urlLeads.includes('id=not.in.(1,2)'),
      `o anti-join deveria filtrar id=not.in.(<lead_id com ligacao>) — recebido: ${urlLeads}`,
    );
    checar(
      // `select=...,telefone` (coluna trazida na resposta) é esperado; o que
      // NUNCA pode existir é um FILTRO por telefone (`?telefone=` / `&telefone=`).
      !urls.some((u) => /[?&]telefone=/.test(u)),
      'buscarLeadsNuncaLigadosSupabase NUNCA deveria FILTRAR por telefone (o critério é lead_id, não mais telefone-fallback)',
    );
    checar(
      leads.length === 1 && leads[0].leadTaskId === 'T3',
      'a leitura deveria devolver o lead 3 (fora do conjunto com ligacao)',
    );
    checar(Array.isArray(origens), 'origens deveria ser um array (mesmo shape de buscarLeadsNuncaLigados)');
  } finally {
    global.fetch = fetchReal;
  }
}

// ===== (b) selo de conversa lê audios_envios =====

async function testarMapaConversaLeAudiosEnvios() {
  const { mapaConversaPorLeadSupabase } = await import('../src/mastra/supabase.ts');
  const fetchReal = global.fetch;
  let urlChamada = '';
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const metodo = (opts.method || 'GET').toUpperCase();
    if (u.includes('api.clickup.com')) fetchInesperado(u, metodo);
    if (u.includes('/rest/v1/audios_envios')) {
      urlChamada = u;
      return ok([{ lead_clickup_task_id: 'T3', selo_conversa: 'ligar' }]);
    }
    fetchInesperado(u, metodo);
  };
  try {
    const mapa = await mapaConversaPorLeadSupabase();
    checar(urlChamada.includes('/rest/v1/audios_envios'), 'mapaConversaPorLeadSupabase deveria consultar audios_envios');
    checar(mapa instanceof Map, 'mapaConversaPorLeadSupabase deveria devolver um Map (mesmo shape de mapaConversaPorLead)');
    checar(mapa.get('T3')?.temResposta === true, 'selo_conversa=ligar deveria marcar temResposta=true');
  } finally {
    global.fetch = fetchReal;
  }
}

// ===== (c) histórico de envios filtra lead_id + order=enviado_em =====

async function testarHistoricoFiltraLeadIdEOrdena() {
  const { listarEnviosAudioDoLeadSupabase } = await import('../src/mastra/supabase.ts');
  const fetchReal = global.fetch;
  let urlHistorico = '';
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const metodo = (opts.method || 'GET').toUpperCase();
    if (u.includes('api.clickup.com')) fetchInesperado(u, metodo);
    if (u.includes('/rest/v1/discador_leads_espelho')) {
      return ok([{ id: 7 }]);
    }
    if (u.includes('/rest/v1/audios_envios')) {
      urlHistorico = u;
      return ok([
        {
          id: 1,
          tipo: 'audio',
          corpo: null,
          transcricao_audio: null,
          midia_ref: 'bucket/a.ogg',
          enviado_em: '2026-08-22T10:00:00Z',
        },
      ]);
    }
    fetchInesperado(u, metodo);
  };
  try {
    const envios = await listarEnviosAudioDoLeadSupabase('T7');
    const dHistorico = dec(urlHistorico);
    checar(
      dHistorico.includes('lead_id=eq.7'),
      `o histórico deveria filtrar lead_id=eq.<id resolvido> — recebido: ${dHistorico}`,
    );
    checar(dHistorico.includes('order=enviado_em'), `o histórico deveria ordenar por enviado_em — recebido: ${dHistorico}`);
    checar(envios.length === 1 && envios[0].taskId === '1', 'a leitura deveria devolver o envio mapeado');
  } finally {
    global.fetch = fetchReal;
  }
}

// ===== (d) seleção do lote elegível filtra elegivel + order + limit =====

async function testarLoteSelecionaElegivelOrdemELimit() {
  const { selecionarLoteElegiveisSupabase } = await import('../src/mastra/supabase.ts');
  const fetchReal = global.fetch;
  let urlLote = '';
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const metodo = (opts.method || 'GET').toUpperCase();
    if (u.includes('api.clickup.com')) fetchInesperado(u, metodo);
    if (u.includes('/rest/v1/ligacoes')) {
      return ok([]); // nenhuma ligacao aberta no cenario sintetico
    }
    if (u.includes('/rest/v1/discador_leads_espelho')) {
      urlLote = u;
      return ok([
        {
          id: 9,
          clickup_task_id: 'T9',
          telefone: '+5511988887777',
          nome: 'Ciclana',
          score: 10,
          tentativas: 0,
          proximo_contato: '2026-08-20',
        },
      ]);
    }
    fetchInesperado(u, metodo);
  };
  try {
    const lote = await selecionarLoteElegiveisSupabase(5);
    const dLote = dec(urlLote);
    checar(dLote.includes('elegivel=eq.true'), `a selecao do lote deveria filtrar elegivel=eq.true — recebido: ${dLote}`);
    checar(
      dLote.includes('order=retorno_necessario.desc,score.desc,tentativas.asc'),
      `a selecao do lote deveria ordenar retorno_necessario desc, score desc, tentativas asc — recebido: ${dLote}`,
    );
    checar(dLote.includes('limit=5'), `a selecao do lote deveria limitar pelo tamanho pedido — recebido: ${dLote}`);
    checar(lote.length === 1 && lote[0].clickupTaskId === 'T9', 'a leitura deveria devolver o lead elegivel mapeado');
  } finally {
    global.fetch = fetchReal;
  }
}

// ===== (e) notas filtram aggregate=eq.lead =====

async function testarNotasFiltramAggregateLead() {
  const { listarNotasDoLeadSupabase } = await import('../src/mastra/supabase.ts');
  const fetchReal = global.fetch;
  let urlNotas = '';
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const metodo = (opts.method || 'GET').toUpperCase();
    if (u.includes('api.clickup.com')) fetchInesperado(u, metodo);
    if (u.includes('/rest/v1/discador_leads_espelho')) {
      return ok([{ id: 11 }]);
    }
    if (u.includes('/rest/v1/notas')) {
      urlNotas = u;
      return ok([{ id: 1, autor: 'romero', corpo: 'nota sintetica', criado_em: '2026-08-22T10:00:00Z' }]);
    }
    fetchInesperado(u, metodo);
  };
  try {
    const notas = await listarNotasDoLeadSupabase('T11');
    const dNotas = dec(urlNotas);
    checar(dNotas.includes('aggregate=eq.lead'), `as notas deveriam filtrar aggregate=eq.lead — recebido: ${dNotas}`);
    checar(
      dNotas.includes('aggregate_id=eq.11'),
      `as notas deveriam filtrar aggregate_id=eq.<id resolvido> — recebido: ${dNotas}`,
    );
    checar(notas.length === 1 && notas[0].corpo === 'nota sintetica', 'a leitura deveria devolver a nota mapeada');
  } finally {
    global.fetch = fetchReal;
  }
}

testarNuncaLigadosAntiJoinPorLeadId()
  .then(testarMapaConversaLeAudiosEnvios)
  .then(testarHistoricoFiltraLeadIdEOrdena)
  .then(testarLoteSelecionaElegivelOrdemELimit)
  .then(testarNotasFiltramAggregateLead)
  .then(() => {
    if (falhas.length > 0) {
      console.error('=== SMOKE FAIL ===');
      for (const f of falhas) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log('SMOKE OK');
    process.exit(0);
  })
  .catch((e) => {
    console.error('=== SMOKE ERROR ===');
    console.error(e instanceof Error ? e.stack : String(e));
    process.exit(1);
  });
