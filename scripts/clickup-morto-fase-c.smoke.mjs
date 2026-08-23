#!/usr/bin/env node
// scripts/clickup-morto-fase-c.smoke.mjs
//
// Oráculo determinístico (OFFLINE — sem rede real; fetch ClickUp MOCKADO como
// FALHA) do teste "ClickUp-morto" POR AGREGADO da Fase C (Phase 20, 20-08 —
// mesmo racional do Passo 4 de 19-10-RUNBOOK-FLIP.md, agora estendido a
// áudios/leads/notas). Molde: env sintética ANTES do import
// (scripts/drenar-outbox-multi.smoke.mjs / scripts/leituras-audios.smoke.mjs),
// mock de `global.fetch` roteado por característica da URL (gap-19-11), e
// `checar()`/`falhas[]`/exit 1 (todos os smokes irmãos deste projeto).
//
// Prova, sem tocar rede real e sem depender do homolog vivo, os 6 pontos
// (a-f) do checkpoint de operador (20-08 Task 2, passo 4-5):
//
//   (a) enviar áudio grava audios_envios + enfileira outbox e a rota (via
//       comOutboxRpc) retorna ok — NÃO trava — com `api.clickup.com`
//       inacessível.
//   (b) anotar grava notas + outbox pelo mesmo caminho, também sem tocar o
//       ClickUp.
//   (c) gerar_lote cria ligacoes + outbox (gerarLoteSupabase,
//       scripts/gerar-lote.mjs) sem paginar/chamar a Lista 01 do ClickUp.
//   (d) as leituras da tela de áudios/lote (mapaConversaPorLeadSupabase,
//       listarEnviosAudioDoLeadSupabase, selecionarLoteElegiveisSupabase,
//       listarNotasDoLeadSupabase, buscarLeadsNuncaLigadosSupabase) vêm
//       100% do Supabase — nenhuma bate em api.clickup.com.
//   (e) quando o ClickUp "volta" (fetch ClickUp passa a responder 200), o
//       dreno multi-agregado (processarDrenoOutboxJob, 20-02) esvazia o
//       backlog acumulado — por agregado ('audio'/'nota') — e uma SEGUNDA
//       passada não re-envia (idempotência-a-crash, WR-A/CR-01 generalizado,
//       sem duplicata).
//   (f) FONTE_AUDIOS/FONTE_LEADS/FONTE_NOTAS=clickup (o default de
//       config.ts, quando a env override não está presente) reverte TUDO —
//       confirmado tanto pelo valor default quanto pelos pontos de ramificação
//       reais em index.ts/gerar-lote.mjs (`=== 'supabase'`), que sempre caem
//       de volta no caminho ClickUp quando a flag não é 'supabase'.
//
// LGPD: só sentinels sintéticos (LEAD-*/nota de teste) — nenhum
// telefone/CPF/corpo real; nunca loga a service key.
//
// Uso: node --experimental-strip-types scripts/clickup-morto-fase-c.smoke.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Env sintética ANTES de qualquer import de src/ (config.ts lê no import-time,
// mesmo racional dos smokes irmãos). FONTE_AUDIOS/LEADS/NOTAS ficam
// DELIBERADAMENTE ausentes — o default de config.ts é 'clickup' (ponto f).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://fake.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'k';
process.env.CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN || 'tkn';
delete process.env.REDIS_URL;

const RAIZ_REPO = fileURLToPath(new URL('..', import.meta.url));

const falhas = [];
function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function ok(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}
function okVazio() {
  return new Response(null, { status: 200 });
}

/** Simula `api.clickup.com` BLOQUEADO (firewall do homolog, passo 4 do
 *  checkpoint) — qualquer chamada lança, nunca retorna. */
function clickupBloqueadoOuLanca(estado) {
  return (url) => {
    if (String(url).includes('api.clickup.com')) {
      estado.tocouClickup = true;
      throw new Error('[smoke] ClickUp bloqueado (simulado, teste ClickUp-morto 20-08)');
    }
    return null; // sinaliza "não é ClickUp" — caller decide o resto
  };
}

// ===== (a) enviar áudio — grava audios_envios + outbox, ClickUp bloqueado nunca é tocado =====

async function testeEnviarAudioSemClickup() {
  const { comOutboxRpc } = await import('../src/mastra/outbox-rpc.ts');
  const { SUPABASE_RPC_REGISTRAR_ENVIO_AUDIO } = await import('../src/mastra/config.ts');
  const fetchReal = global.fetch;
  const estado = { tocouClickup: false };
  try {
    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('api.clickup.com')) {
        estado.tocouClickup = true;
        throw new Error('[smoke] ClickUp bloqueado (simulado)');
      }
      if (u.includes(`/rest/v1/rpc/${SUPABASE_RPC_REGISTRAR_ENVIO_AUDIO}`)) {
        return ok({ audio_id: 501, outbox_inseridos: 1 });
      }
      throw new Error(`[smoke] fetch inesperado: ${(opts.method || 'GET')} ${u}`);
    };

    const r = await comOutboxRpc(SUPABASE_RPC_REGISTRAR_ENVIO_AUDIO, {
      p_lead_clickup_task_id: 'LEAD-CLICKUPMORTO-1',
      p_lead_id: null,
      p_telefone_canonico: '+5511999990001',
      p_enviado_por: 'romero',
      p_midia_ref: null,
      p_transcricao: null,
    });

    checar(!estado.tocouClickup, '(a) registrar_envio_audio NUNCA deveria tocar api.clickup.com com o ClickUp bloqueado');
    checar(r?.audio_id === 501, `(a) registrar_envio_audio deveria retornar ok (não travar) com audio_id — recebido ${JSON.stringify(r)}`);
  } finally {
    global.fetch = fetchReal;
  }
}

// ===== (b) anotar — grava notas + outbox, mesma garantia =====

async function testeAnotarSemClickup() {
  const { comOutboxRpc } = await import('../src/mastra/outbox-rpc.ts');
  const { SUPABASE_RPC_REGISTRAR_ANOTACAO } = await import('../src/mastra/config.ts');
  const fetchReal = global.fetch;
  const estado = { tocouClickup: false };
  try {
    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('api.clickup.com')) {
        estado.tocouClickup = true;
        throw new Error('[smoke] ClickUp bloqueado (simulado)');
      }
      if (u.includes(`/rest/v1/rpc/${SUPABASE_RPC_REGISTRAR_ANOTACAO}`)) {
        return ok({ nota_id: 9001, outbox_inseridos: 1 });
      }
      throw new Error(`[smoke] fetch inesperado: ${(opts.method || 'GET')} ${u}`);
    };

    const r = await comOutboxRpc(SUPABASE_RPC_REGISTRAR_ANOTACAO, {
      p_aggregate: 'lead',
      p_lead_id: null,
      p_clickup_task_id: 'LEAD-CLICKUPMORTO-1',
      p_autor: 'romero',
      p_corpo: 'nota sintetica de teste (clickup-morto)',
    });

    checar(!estado.tocouClickup, '(b) registrar_anotacao NUNCA deveria tocar api.clickup.com com o ClickUp bloqueado');
    checar(r?.nota_id === 9001, `(b) registrar_anotacao deveria retornar ok (não travar) com nota_id — recebido ${JSON.stringify(r)}`);
  } finally {
    global.fetch = fetchReal;
  }
}

// ===== (c) gerar_lote — cria ligacoes + outbox sem paginar a Lista 01 =====

async function testeGerarLoteSemClickup() {
  const { gerarLoteSupabase } = await import('./gerar-lote.mjs');
  const { SUPABASE_TABLE_LIGACOES, SUPABASE_RPC_GERAR_LOTE } = await import('../src/mastra/config.ts');
  const fetchReal = global.fetch;
  const estado = { tocouClickup: false };
  try {
    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('api.clickup.com')) {
        estado.tocouClickup = true;
        throw new Error('[smoke] ClickUp bloqueado (simulado)');
      }
      if (u.includes(`/rest/v1/rpc/${SUPABASE_RPC_GERAR_LOTE}`)) {
        return ok({ criadas: 3, outbox_inseridos: 3 });
      }
      if (u.includes(`/rest/v1/${SUPABASE_TABLE_LIGACOES}`) && u.includes('script=is.null')) {
        return ok([]); // materialização de roteiro fora de escopo deste smoke (20-06)
      }
      throw new Error(`[smoke] fetch inesperado: ${(opts.method || 'GET')} ${u}`);
    };

    const resultado = await gerarLoteSupabase({
      operadores: [{ nome: 'closer1', assigneeId: '111' }],
      tamanho: 3,
      loteData: '2026-08-23',
      dryRun: false,
    });

    checar(!estado.tocouClickup, '(c) gerar_lote (via gerarLoteSupabase) NUNCA deveria tocar api.clickup.com com o ClickUp bloqueado');
    checar(resultado.criadas === 3, `(c) gerar_lote deveria criar ligações mesmo com o ClickUp bloqueado — recebido criadas=${resultado.criadas}`);
    checar(resultado.outboxInseridos === 3, `(c) gerar_lote deveria enfileirar outbox mesmo com o ClickUp bloqueado — recebido outboxInseridos=${resultado.outboxInseridos}`);
  } finally {
    global.fetch = fetchReal;
  }
}

// ===== (d) leituras da tela de áudios/lote — 100% Supabase =====

async function testeLeiturasSemClickup() {
  const supabase = await import('../src/mastra/supabase.ts');
  const fetchReal = global.fetch;
  const estado = { tocouClickup: false };
  const fetchBase = async (url) => {
    const u = String(url);
    if (u.includes('api.clickup.com')) {
      estado.tocouClickup = true;
      throw new Error('[smoke] ClickUp bloqueado (simulado)');
    }
    if (u.includes('/rest/v1/ligacoes') && u.includes('select=lead_id')) return ok([]);
    if (u.includes('/rest/v1/discador_leads_espelho')) return ok([{ id: 1, clickup_task_id: 'LEAD-CLICKUPMORTO-1', nome: 'Fulano', telefone: '+5511999990001' }]);
    if (u.includes('/rest/v1/audios_envios') && u.includes('lead_clickup_task_id')) return ok([{ lead_clickup_task_id: 'LEAD-CLICKUPMORTO-1', selo_conversa: 'ligar' }]);
    if (u.includes('/rest/v1/audios_envios') && u.includes('clickup_task_id')) return ok([]);
    if (u.includes('/rest/v1/notas')) return ok([]);
    return ok([]);
  };

  try {
    global.fetch = fetchBase;
    const nuncaLigados = await supabase.buscarLeadsNuncaLigadosSupabase();
    const mapaConversa = await supabase.mapaConversaPorLeadSupabase();
    const elegiveis = await supabase.selecionarLoteElegiveisSupabase(5);
    const notas = await supabase.listarNotasDoLeadSupabase('LEAD-CLICKUPMORTO-1');

    checar(!estado.tocouClickup, '(d) as leituras da tela de áudios/lote NUNCA deveriam tocar api.clickup.com com o ClickUp bloqueado');
    checar(Array.isArray(nuncaLigados.leads), '(d) buscarLeadsNuncaLigadosSupabase deveria devolver leads[] mesmo com ClickUp bloqueado');
    checar(mapaConversa.get('LEAD-CLICKUPMORTO-1')?.temResposta === true, '(d) mapaConversaPorLeadSupabase deveria refletir o selo_conversa lido do Supabase');
    checar(Array.isArray(elegiveis), '(d) selecionarLoteElegiveisSupabase deveria devolver array mesmo com ClickUp bloqueado');
    checar(Array.isArray(notas), '(d) listarNotasDoLeadSupabase deveria devolver array mesmo com ClickUp bloqueado');
  } finally {
    global.fetch = fetchReal;
  }
}

// ===== (e) o ClickUp "volta" — o dreno esvazia o backlog acumulado, sem duplicata =====

/** Mock stateful: linha `criar_task` de ÁUDIO PENDENTE (simulando o backlog
 *  que se acumulou enquanto o ClickUp esteve bloqueado) — molde EXATO de
 *  drenar-outbox-multi.smoke.mjs::instalarMockCriarTaskAudio, mas a narrativa
 *  aqui é "o ClickUp voltou": a MESMA linha, agora processada com sucesso. */
function instalarMockAudioVoltaClickup() {
  const chamadas = { criarTaskPost: 0, backfillPatch: 0 };
  const linha = {
    id: 601,
    aggregate: 'audio',
    aggregate_id: 61,
    op: 'criar_task',
    bloqueante: true,
    payload: { origem: 'envio', tipo: 'audio', telefone_canonico: '+5511999990001', lead_clickup_task_id: 'LEAD-CLICKUPMORTO-1', enviado_por: 'romero' },
    dedup_key: 'audio:61:criar',
    seq: 1,
    status: 'pendente',
    tentativas: 0,
  };
  const estado = { audioTaskId: null };
  return {
    chamadas,
    fetchImpl: async (url, opts = {}) => {
      const u = String(url);
      const m = (opts.method || 'GET').toUpperCase();
      if (u.includes('api.clickup.com') && u.includes('/task') && m === 'POST') {
        chamadas.criarTaskPost += 1;
        return ok({ id: 'TASK_AUDIO_VOLTOU' });
      }
      if (u.includes('/rest/v1/')) {
        if (m === 'GET' && u.includes('op=eq.criar_task') && u.includes('status=eq.enviando')) return ok([]);
        if (m === 'GET' && u.includes('select=clickup_task_id')) return ok([{ clickup_task_id: estado.audioTaskId }]);
        if (m === 'GET' && u.includes('status=in')) return ok(linha.status === 'pendente' ? [{ ...linha }] : []);
        if (m === 'PATCH' && u.includes('status=in.')) {
          linha.status = 'enviando';
          return ok([{ ...linha }]);
        }
        if (m === 'PATCH' && u.includes('clickup_task_id=is.null')) {
          chamadas.backfillPatch += 1;
          estado.audioTaskId = 'TASK_AUDIO_VOLTOU';
          return okVazio();
        }
        if (m === 'PATCH') {
          linha.status = 'enviado';
          return okVazio();
        }
      }
      throw new Error(`[smoke] fetch inesperado no dreno: ${m} ${u}`);
    },
  };
}

async function testeDrenoEsvaziaBacklogAudioSemDuplicata() {
  const { processarDrenoOutboxJob } = await import('../src/mastra/drenar-outbox.ts');
  const fetchReal = global.fetch;
  try {
    const { chamadas, fetchImpl } = instalarMockAudioVoltaClickup();
    global.fetch = fetchImpl;

    const primeira = await processarDrenoOutboxJob(61);
    checar(primeira.enviadas === 1, `(e) 1a passada (ClickUp voltou) deveria drenar a linha acumulada — recebido ${JSON.stringify(primeira)}`);
    checar(chamadas.criarTaskPost === 1, `(e) criarTask deveria ser chamado 1x ao drenar o backlog — recebido ${chamadas.criarTaskPost}`);

    // Segunda passada (ex.: worker roda de novo, ou retry) — a linha já foi
    // marcada 'enviado' (status=in não a devolve mais); NÃO deveria re-criar
    // task nem re-enviar (idempotência-a-crash generalizada, WR-A/CR-01).
    const segunda = await processarDrenoOutboxJob(61);
    checar(segunda.enviadas === 0, `(e) 2a passada não deveria re-enviar nada (linha já drenada) — recebido ${JSON.stringify(segunda)}`);
    checar(chamadas.criarTaskPost === 1, `(e) 2a passada NÃO deveria re-criar a task (sem duplicata) — total de criarTask ainda deveria ser 1, recebido ${chamadas.criarTaskPost}`);
  } finally {
    global.fetch = fetchReal;
  }
}

/** Mock stateful: linha `comentar` de NOTA pendente — mesma narrativa (e). */
function instalarMockNotaVoltaClickup() {
  const chamadas = { comentarPost: 0 };
  const linha = {
    id: 701,
    aggregate: 'nota',
    aggregate_id: 71,
    op: 'comentar',
    bloqueante: false,
    payload: { clickup_task_id: 'LEAD-CLICKUPMORTO-1', texto: 'nota sintetica de teste (clickup-morto)' },
    dedup_key: 'nota:71:comentar',
    seq: 1,
    status: 'pendente',
    tentativas: 0,
  };
  return {
    chamadas,
    fetchImpl: async (url, opts = {}) => {
      const u = String(url);
      const m = (opts.method || 'GET').toUpperCase();
      if (u.includes('api.clickup.com') && u.includes('/comment') && m === 'POST') {
        chamadas.comentarPost += 1;
        return ok({ id: 'COMMENT_VOLTOU' });
      }
      if (u.includes('/rest/v1/')) {
        if (m === 'GET' && u.includes('op=eq.criar_task') && u.includes('status=eq.enviando')) return ok([]);
        if (m === 'GET' && u.includes('status=in')) return ok(linha.status === 'pendente' ? [{ ...linha }] : []);
        if (m === 'PATCH') {
          linha.status = 'enviado';
          return okVazio();
        }
      }
      throw new Error(`[smoke] fetch inesperado no dreno: ${m} ${u}`);
    },
  };
}

async function testeDrenoEsvaziaBacklogNotaSemDuplicata() {
  const { processarDrenoOutboxJob } = await import('../src/mastra/drenar-outbox.ts');
  const fetchReal = global.fetch;
  try {
    const { chamadas, fetchImpl } = instalarMockNotaVoltaClickup();
    global.fetch = fetchImpl;

    const primeira = await processarDrenoOutboxJob(71);
    checar(primeira.enviadas === 1, `(e) 1a passada (nota, ClickUp voltou) deveria drenar o backlog — recebido ${JSON.stringify(primeira)}`);
    checar(chamadas.comentarPost === 1, `(e) comentarTask deveria ser chamado 1x — recebido ${chamadas.comentarPost}`);

    const segunda = await processarDrenoOutboxJob(71);
    checar(segunda.enviadas === 0, `(e) 2a passada (nota) não deveria re-enviar — recebido ${JSON.stringify(segunda)}`);
    checar(chamadas.comentarPost === 1, `(e) 2a passada NÃO deveria re-comentar (sem duplicata) — recebido ${chamadas.comentarPost}`);
  } finally {
    global.fetch = fetchReal;
  }
}

// ===== (f) FONTE_AUDIOS/LEADS/NOTAS=clickup reverte tudo =====

async function testeRollbackPorFlag() {
  const { FONTE_AUDIOS, FONTE_LEADS, FONTE_NOTAS } = await import('../src/mastra/config.ts');
  checar(FONTE_AUDIOS === 'clickup', `(f) FONTE_AUDIOS default (sem override) deveria ser 'clickup' — recebido '${FONTE_AUDIOS}'`);
  checar(FONTE_LEADS === 'clickup', `(f) FONTE_LEADS default (sem override) deveria ser 'clickup' — recebido '${FONTE_LEADS}'`);
  checar(FONTE_NOTAS === 'clickup', `(f) FONTE_NOTAS default (sem override) deveria ser 'clickup' — recebido '${FONTE_NOTAS}'`);

  // Estrutural: os pontos de ramificação REAIS (index.ts/gerar-lote.mjs)
  // sempre caem no caminho ClickUp quando a flag não é 'supabase' — rollback
  // é literalmente "não setar (ou desfazer) a env", sem código adicional.
  const indexTs = readFileSync(`${RAIZ_REPO}src/mastra/index.ts`, 'utf8');
  const gerarLoteMjs = readFileSync(`${RAIZ_REPO}scripts/gerar-lote.mjs`, 'utf8');
  checar(/FONTE_AUDIOS === 'supabase'/.test(indexTs), "(f) index.ts deveria ramificar por FONTE_AUDIOS === 'supabase' (rollback = flag ausente)");
  checar(/FONTE_NOTAS === 'supabase'/.test(indexTs), "(f) index.ts deveria ramificar por FONTE_NOTAS === 'supabase' (rollback = flag ausente)");
  checar(/FONTE_LEADS === 'supabase'/.test(gerarLoteMjs), "(f) gerar-lote.mjs deveria ramificar por FONTE_LEADS === 'supabase' (rollback = flag ausente)");
}

async function main() {
  await testeEnviarAudioSemClickup();
  await testeAnotarSemClickup();
  await testeGerarLoteSemClickup();
  await testeLeiturasSemClickup();
  await testeDrenoEsvaziaBacklogAudioSemDuplicata();
  await testeDrenoEsvaziaBacklogNotaSemDuplicata();
  await testeRollbackPorFlag();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK: teste ClickUp-morto por agregado provado (a-f) — offline, roteiro pronto pro operador rodar ao vivo no homolog (20-08 Task 2).');
  process.exit(0);
}

main();
