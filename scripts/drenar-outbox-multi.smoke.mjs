#!/usr/bin/env node
// scripts/drenar-outbox-multi.smoke.mjs
//
// Smoke determinístico (OFFLINE — sem rede/Supabase/ClickUp/Redis real) do
// dreno multi-agregado do outbox (Fase C, Phase 20 Plano 02 — ESCRITA-02/05):
// generaliza src/mastra/drenar-outbox.ts + outbox-repo.ts, hoje hardcoded pro
// aggregate 'ligacao', pra também empurrar 'audio'/'lead'/'nota'. Molde de
// scripts/drenar-outbox.smoke.mjs (19-03: checar()/falhas[], exit 1, env
// sintética ANTES do import — config.ts lê no IMPORT-TIME) e
// scripts/gap-19-13.smoke.mjs (mock de fetch roteado por característica da
// URL/método, capturando a URL pra provar QUAL tabela foi lida/escrita).
//
// ORÁCULO deste plano (20-02): criado JÁ na Task 1 com as asserções de
// OUTBOX-REPO (resolverClickupTaskId/linhasPresasEnviando/
// marcarOrphanEnviando/backfillClickupTaskId por agregado), ESTENDIDO na
// Task 2 com as asserções (a-f) do switch de op multi-agregado em
// drenar-outbox.ts (criar_task/comentar/set_campo/anexar por agregado, sem
// listagem, scrub preservado).
//
// NUNCA loga service key sintética nem payload/telefone/URL crua — só
// booleans/ids/nomes de tabela de teste.
//
// Uso: node --experimental-strip-types scripts/drenar-outbox-multi.smoke.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Env sintética ANTES do import — SUPABASE_URL/SUPABASE_SERVICE_KEY são lidas
// no IMPORT-TIME por config.ts (module-level `const`), mesmo racional dos
// smokes irmãos (19-03/19-13). Nunca aponta para infra real.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://fake.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'k';
process.env.CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN || 'tkn';
delete process.env.REDIS_URL;

const RAIZ_REPO = fileURLToPath(new URL('..', import.meta.url));

const falhas = [];
function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ===== Task 1 — asserções de OUTBOX-REPO =====

/** (a) resolverClickupTaskId('audio') lê de audios_envios; ('ligacao') inalterado (lê de ligacoes). */
async function testeResolverPorAgregado() {
  const repo = await import('../src/mastra/outbox-repo.ts');
  const fetchReal = global.fetch;
  try {
    const urlsChamadas = [];
    global.fetch = async (url) => {
      urlsChamadas.push(String(url));
      return new Response(JSON.stringify([{ clickup_task_id: 'TASK_X' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const idAudio = await repo.resolverClickupTaskId('audio', 7);
    checar(idAudio === 'TASK_X', `(a) resolverClickupTaskId('audio') deveria devolver o clickup_task_id lido — recebido ${idAudio}`);
    checar(
      urlsChamadas.some((u) => u.includes('/audios_envios?') && u.includes('id=eq.7')),
      `(a) resolverClickupTaskId('audio') deveria ler de audios_envios — URLs vistas: ${JSON.stringify(urlsChamadas)}`,
    );

    urlsChamadas.length = 0;
    const idLigacao = await repo.resolverClickupTaskId('ligacao', 9);
    checar(idLigacao === 'TASK_X', `(a) resolverClickupTaskId('ligacao') inalterado deveria devolver o id — recebido ${idLigacao}`);
    checar(
      urlsChamadas.some((u) => u.includes('/ligacoes?') && u.includes('id=eq.9')),
      `(a) resolverClickupTaskId('ligacao') deveria continuar lendo de ligacoes (regressão zero) — URLs vistas: ${JSON.stringify(urlsChamadas)}`,
    );
  } finally {
    global.fetch = fetchReal;
  }
}

/** (b) resolverClickupTaskId('lead'|'nota') LANÇA — o alvo vem do payload, nunca de tabela. */
async function testeResolverLeadNotaLanca() {
  const repo = await import('../src/mastra/outbox-repo.ts');
  const fetchReal = global.fetch;
  try {
    global.fetch = async () => {
      throw new Error('resolverClickupTaskId de lead/nota NUNCA deveria fazer I/O');
    };
    for (const aggregate of ['lead', 'nota']) {
      let lancou = false;
      try {
        await repo.resolverClickupTaskId(aggregate, 1);
      } catch {
        lancou = true;
      }
      checar(lancou, `(b) resolverClickupTaskId('${aggregate}') deveria LANÇAR (alvo vem do payload, nunca de tabela)`);
    }
  } finally {
    global.fetch = fetchReal;
  }
}

/** (c) linhasPresasEnviando/marcarOrphanEnviando filtram por aggregate=eq.<agg> passado por parâmetro. */
async function testePresasOrphanPorAgregado() {
  const repo = await import('../src/mastra/outbox-repo.ts');
  const fetchReal = global.fetch;
  try {
    let urlPresas = '';
    global.fetch = async (url, opts = {}) => {
      const m = (opts.method || 'GET').toUpperCase();
      urlPresas = String(url);
      if (m === 'GET') return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    await repo.linhasPresasEnviando('audio', 3);
    checar(
      urlPresas.includes('aggregate=eq.audio') && urlPresas.includes('aggregate_id=eq.3'),
      `(c) linhasPresasEnviando('audio', 3) deveria filtrar aggregate=eq.audio&aggregate_id=eq.3 — URL: ${urlPresas}`,
    );

    let urlOrphan = '';
    global.fetch = async (url) => {
      urlOrphan = String(url);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await repo.marcarOrphanEnviando('audio', 3);
    checar(
      urlOrphan.includes('aggregate=eq.audio') && urlOrphan.includes('aggregate_id=eq.3'),
      `(c) marcarOrphanEnviando('audio', 3) deveria filtrar aggregate=eq.audio&aggregate_id=eq.3 — URL: ${urlOrphan}`,
    );

    // 'ligacao' inalterado (regressão zero).
    let urlPresasLigacao = '';
    global.fetch = async (url) => {
      urlPresasLigacao = String(url);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await repo.linhasPresasEnviando('ligacao', 42);
    checar(
      urlPresasLigacao.includes('aggregate=eq.ligacao') && urlPresasLigacao.includes('aggregate_id=eq.42'),
      `(c) linhasPresasEnviando('ligacao', 42) deveria continuar filtrando aggregate=eq.ligacao (regressão zero) — URL: ${urlPresasLigacao}`,
    );
  } finally {
    global.fetch = fetchReal;
  }
}

/** (d) backfillClickupTaskId grava na tabela certa do agregado (ligacoes vs audios_envios). */
async function testeBackfillPorAgregado() {
  const repo = await import('../src/mastra/outbox-repo.ts');
  const fetchReal = global.fetch;
  try {
    let urlAudio = '';
    global.fetch = async (url) => {
      urlAudio = String(url);
      return new Response(null, { status: 200 });
    };
    await repo.backfillClickupTaskId('audio', 7, 'TASK_AUDIO');
    checar(
      urlAudio.includes('/audios_envios?') && urlAudio.includes('id=eq.7') && urlAudio.includes('clickup_task_id=is.null'),
      `(d) backfillClickupTaskId('audio', ...) deveria gravar em audios_envios — URL: ${urlAudio}`,
    );

    let urlLigacao = '';
    global.fetch = async (url) => {
      urlLigacao = String(url);
      return new Response(null, { status: 200 });
    };
    await repo.backfillClickupTaskId('ligacao', 9, 'TASK_LIG');
    checar(
      urlLigacao.includes('/ligacoes?') && urlLigacao.includes('id=eq.9'),
      `(d) backfillClickupTaskId('ligacao', ...) deveria continuar gravando em ligacoes (regressão zero) — URL: ${urlLigacao}`,
    );

    // 'lead'/'nota' não têm tabela de back-fill — LANÇA.
    for (const aggregate of ['lead', 'nota']) {
      let lancou = false;
      try {
        await repo.backfillClickupTaskId(aggregate, 1, 'X');
      } catch {
        lancou = true;
      }
      checar(lancou, `(d) backfillClickupTaskId('${aggregate}', ...) deveria LANÇAR (sem tabela de back-fill)`);
    }
  } finally {
    global.fetch = fetchReal;
  }
}

async function testeModulosCarregam() {
  const drenar = await import('../src/mastra/drenar-outbox.ts');
  checar(
    typeof drenar.processarDrenoOutboxJob === 'function',
    'drenar-outbox.ts deveria exportar processarDrenoOutboxJob',
  );
  const repo = await import('../src/mastra/outbox-repo.ts');
  for (const nome of ['proximasPendentes', 'marcarEnviado', 'backfillClickupTaskId', 'resolverClickupTaskId', 'linhasPresasEnviando', 'marcarOrphanEnviando']) {
    checar(typeof repo[nome] === 'function', `outbox-repo.ts deveria exportar ${nome}`);
  }
}

function testeGrepSemListagemDeTasks() {
  const arquivos = ['src/mastra/drenar-outbox.ts', 'src/mastra/outbox-repo.ts'];
  for (const rel of arquivos) {
    const conteudo = readFileSync(`${RAIZ_REPO}${rel}`, 'utf8');
    checar(
      !/listartasks/i.test(conteudo),
      `${rel} não deveria referenciar a listagem de tasks (ESCRITA-02 — só primitivas por-ID)`,
    );
  }
  const outboxRepo = readFileSync(`${RAIZ_REPO}src/mastra/outbox-repo.ts`, 'utf8');
  checar(
    outboxRepo.includes('payload: null'),
    'outbox-repo.ts::marcarEnviado deveria NULAR o payload (scrub de PII pós-drain, LGPD-03)',
  );
}

// ===== Task 2 — asserções do switch multi-agregado (a-f) =====
//
// Mocks de fetch com estado, molde de gap-19-13.smoke.mjs (roteia por
// característica da URL/método). Cada teste isola global.fetch e restaura no
// finally — nunca vaza estado entre testes.

/** (a) criar_task 'audio' → Lista 03 AUDIOS + back-fill em audios_envios. */
function instalarMockCriarTaskAudio() {
  const chamadas = { criarTaskPost: 0, urlCriarTask: '', backfillPatch: 0, urlBackfill: '' };
  const linha = {
    id: 101,
    aggregate: 'audio',
    aggregate_id: 7,
    op: 'criar_task',
    bloqueante: true,
    payload: {
      origem: 'lote',
      tipo: 'audio',
      telefone_canonico: '+5511999999999',
      lead_clickup_task_id: 'LEAD_1',
      enviado_por: 'romero',
    },
    dedup_key: 'audio:7:criar',
    seq: 1,
    status: 'pendente',
    tentativas: 0,
  };
  const estado = { audioTaskId: null };

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const m = (opts.method || 'GET').toUpperCase();
    const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    const okVazio = () => new Response(null, { status: 200 });

    if (u.includes('api.clickup.com') && u.includes('/task') && m === 'POST') {
      chamadas.criarTaskPost += 1;
      chamadas.urlCriarTask = u;
      return ok({ id: 'TASK_AUDIO_NOVA' });
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
        chamadas.urlBackfill = u;
        estado.audioTaskId = 'TASK_AUDIO_NOVA';
        return okVazio();
      }
      if (m === 'PATCH') {
        linha.status = 'enviado';
        return okVazio();
      }
    }
    throw new Error(`fetch inesperado no smoke: ${m} ${u}`);
  };
  return { chamadas };
}

async function testeCriarTaskAudio() {
  const { processarDrenoOutboxJob } = await import('../src/mastra/drenar-outbox.ts');
  const fetchReal = global.fetch;
  try {
    const { chamadas } = instalarMockCriarTaskAudio();
    const r = await processarDrenoOutboxJob(7);
    checar(chamadas.criarTaskPost === 1, `(a) criar_task audio: criarTask deveria ser chamado 1x — recebido ${chamadas.criarTaskPost}`);
    checar(
      chamadas.urlCriarTask.includes('/list/1000320000003180/task'),
      `(a) criar_task audio deveria criar na Lista 03 AUDIOS — URL: ${chamadas.urlCriarTask}`,
    );
    checar(chamadas.backfillPatch === 1, `(a) criar_task audio deveria back-fillar 1x — recebido ${chamadas.backfillPatch}`);
    checar(
      chamadas.urlBackfill.includes('/audios_envios?'),
      `(a) back-fill de audio deveria gravar em audios_envios — URL: ${chamadas.urlBackfill}`,
    );
    checar(r.enviadas === 1, `(a) deveria reportar 1 enviada — recebido ${JSON.stringify(r)}`);
  } finally {
    global.fetch = fetchReal;
  }
}

/** (b) comentar 'nota' resolve o alvo por payload.clickup_task_id (sem criar_task/back-fill). */
function instalarMockComentarNota() {
  const chamadas = { comentarPost: 0, urlComentar: '' };
  const linha = {
    id: 201,
    aggregate: 'nota',
    aggregate_id: 55,
    op: 'comentar',
    bloqueante: false,
    payload: { clickup_task_id: 'LEAD_ALVO', texto: 'nota de teste' },
    dedup_key: 'nota:55:comentar',
    seq: 1,
    status: 'pendente',
    tentativas: 0,
  };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const m = (opts.method || 'GET').toUpperCase();
    const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    const okVazio = () => new Response(null, { status: 200 });

    if (u.includes('api.clickup.com') && u.includes('/comment') && m === 'POST') {
      chamadas.comentarPost += 1;
      chamadas.urlComentar = u;
      return ok({ id: 'COMMENT_1' });
    }
    if (u.includes('/rest/v1/')) {
      if (m === 'GET' && u.includes('op=eq.criar_task') && u.includes('status=eq.enviando')) return ok([]);
      if (m === 'GET' && u.includes('status=in')) return ok(linha.status === 'pendente' ? [{ ...linha }] : []);
      if (m === 'PATCH') {
        linha.status = 'enviado';
        return okVazio();
      }
    }
    throw new Error(`fetch inesperado no smoke: ${m} ${u}`);
  };
  return { chamadas };
}

async function testeComentarNotaPorPayload() {
  const { processarDrenoOutboxJob } = await import('../src/mastra/drenar-outbox.ts');
  const fetchReal = global.fetch;
  try {
    const { chamadas } = instalarMockComentarNota();
    const r = await processarDrenoOutboxJob(55);
    checar(chamadas.comentarPost === 1, `(b) comentar nota: comentarTask deveria ser chamado 1x — recebido ${chamadas.comentarPost}`);
    checar(
      chamadas.urlComentar.includes('/task/LEAD_ALVO/comment'),
      `(b) comentar nota deveria resolver o alvo por payload.clickup_task_id (sem criar_task) — URL: ${chamadas.urlComentar}`,
    );
    checar(r.enviadas === 1, `(b) deveria reportar 1 enviada — recebido ${JSON.stringify(r)}`);
  } finally {
    global.fetch = fetchReal;
  }
}

/** (c) set_campo 'lead' escolhe CAMPOS_LEADS e resolve o alvo por payload.clickup_task_id. */
function instalarMockSetCampoLead() {
  const chamadas = { setCampoPost: 0, urlSetCampo: '' };
  const linha = {
    id: 301,
    aggregate: 'lead',
    aggregate_id: 88,
    op: 'set_campo',
    bloqueante: true,
    payload: { clickup_task_id: 'LEAD_ALVO_2', campo: 'SCORE', valor: 42 },
    dedup_key: 'lead:88:campo:SCORE',
    seq: 1,
    status: 'pendente',
    tentativas: 0,
  };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const m = (opts.method || 'GET').toUpperCase();
    const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    const okVazio = () => new Response(null, { status: 200 });

    if (u.includes('api.clickup.com') && u.includes('/field/') && m === 'POST') {
      chamadas.setCampoPost += 1;
      chamadas.urlSetCampo = u;
      return ok({});
    }
    if (u.includes('/rest/v1/')) {
      if (m === 'GET' && u.includes('op=eq.criar_task') && u.includes('status=eq.enviando')) return ok([]);
      if (m === 'GET' && u.includes('status=in')) return ok(linha.status === 'pendente' ? [{ ...linha }] : []);
      if (m === 'PATCH') {
        linha.status = 'enviado';
        return okVazio();
      }
    }
    throw new Error(`fetch inesperado no smoke: ${m} ${u}`);
  };
  return { chamadas };
}

async function testeSetCampoLeadPorPayload() {
  const { processarDrenoOutboxJob } = await import('../src/mastra/drenar-outbox.ts');
  const { CAMPOS_LEADS } = await import('../src/mastra/clickup.ts');
  const fetchReal = global.fetch;
  try {
    const { chamadas } = instalarMockSetCampoLead();
    const r = await processarDrenoOutboxJob(88);
    checar(chamadas.setCampoPost === 1, `(c) set_campo lead: setCustomField deveria ser chamado 1x — recebido ${chamadas.setCampoPost}`);
    checar(
      chamadas.urlSetCampo.includes(`/task/LEAD_ALVO_2/field/${CAMPOS_LEADS.SCORE}`),
      `(c) set_campo lead deveria usar CAMPOS_LEADS.SCORE e o alvo de payload.clickup_task_id — URL: ${chamadas.urlSetCampo}`,
    );
    checar(r.enviadas === 1, `(c) deveria reportar 1 enviada — recebido ${JSON.stringify(r)}`);
  } finally {
    global.fetch = fetchReal;
  }
}

/** (d) anexar não-bloqueante que falha (download do store canônico) cai na DLQ por-linha, sem travar o agregado. */
function instalarMockAnexarFalha() {
  const chamadas = { storageGet: 0, dlqPatch: 0 };
  const linha = {
    id: 401,
    aggregate: 'audio',
    aggregate_id: 9,
    op: 'anexar',
    bloqueante: false,
    payload: { midia_ref: 'gravacoes/foo/bar.ogg' },
    dedup_key: 'audio:9:anexar',
    seq: 2,
    status: 'pendente',
    tentativas: 0,
  };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const m = (opts.method || 'GET').toUpperCase();
    const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

    // Supabase Storage — falha proposital (simula binário indisponível/erro de infra).
    if (u.includes('/storage/v1/object/')) {
      chamadas.storageGet += 1;
      return new Response('erro', { status: 500 });
    }
    if (u.includes('/rest/v1/')) {
      if (m === 'GET' && u.includes('op=eq.criar_task') && u.includes('status=eq.enviando')) return ok([]);
      if (m === 'GET' && u.includes('select=clickup_task_id')) return ok([{ clickup_task_id: 'TASK_AUDIO_EXIST' }]);
      if (m === 'GET' && u.includes('status=in')) return ok(linha.status === 'pendente' ? [{ ...linha }] : []);
      if (m === 'PATCH') {
        chamadas.dlqPatch += 1;
        linha.status = 'dlq';
        return new Response(null, { status: 200 });
      }
    }
    throw new Error(`fetch inesperado no smoke: ${m} ${u}`);
  };
  return { chamadas };
}

async function testeAnexarFalhaVaiParaDlq() {
  const { processarDrenoOutboxJob } = await import('../src/mastra/drenar-outbox.ts');
  const fetchReal = global.fetch;
  try {
    const { chamadas } = instalarMockAnexarFalha();
    const r = await processarDrenoOutboxJob(9);
    checar(chamadas.storageGet === 1, `(d) anexar deveria tentar baixar do store canônico 1x — recebido ${chamadas.storageGet}`);
    checar(
      chamadas.dlqPatch === 1,
      `(d) anexar não-bloqueante que falha deveria cair na DLQ por-linha 1x, sem travar o agregado — recebido ${chamadas.dlqPatch}`,
    );
    checar(r.emDlq === 1, `(d) deveria reportar 1 em DLQ — recebido ${JSON.stringify(r)}`);
    checar(r.enviadas === 0, `(d) nada deveria ser marcado enviado nesta passada — recebido ${JSON.stringify(r)}`);
  } finally {
    global.fetch = fetchReal;
  }
}

/** (e) nenhum caminho chama a listagem geral de tasks — coberto por testeGrepSemListagemDeTasks (!/listartasks/i). */

/** (f) marcarEnviado NULA o payload (scrub pós-drain, LGPD-03) — prova funcional do corpo do PATCH. */
async function testeMarcarEnviadoNulaPayload() {
  const repo = await import('../src/mastra/outbox-repo.ts');
  const fetchReal = global.fetch;
  try {
    let corpoEnviado = null;
    global.fetch = async (_url, opts = {}) => {
      corpoEnviado = opts.body ? JSON.parse(opts.body) : null;
      return new Response(null, { status: 200 });
    };
    await repo.marcarEnviado(999);
    checar(
      Boolean(corpoEnviado) && corpoEnviado.payload === null && corpoEnviado.status === 'enviado',
      `(f) marcarEnviado deveria NULAR o payload no PATCH (scrub pós-drain, LGPD-03) — recebido ${JSON.stringify(corpoEnviado)}`,
    );
  } finally {
    global.fetch = fetchReal;
  }
}

async function main() {
  await testeResolverPorAgregado();
  await testeResolverLeadNotaLanca();
  await testePresasOrphanPorAgregado();
  await testeBackfillPorAgregado();
  await testeModulosCarregam();
  testeGrepSemListagemDeTasks();

  await testeCriarTaskAudio();
  await testeComentarNotaPorPayload();
  await testeSetCampoLeadPorPayload();
  await testeAnexarFalhaVaiParaDlq();
  await testeMarcarEnviadoNulaPayload();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
