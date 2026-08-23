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

async function main() {
  await testeResolverPorAgregado();
  await testeResolverLeadNotaLanca();
  await testePresasOrphanPorAgregado();
  await testeBackfillPorAgregado();
  await testeModulosCarregam();
  testeGrepSemListagemDeTasks();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
