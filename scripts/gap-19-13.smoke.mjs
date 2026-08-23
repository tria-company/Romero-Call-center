#!/usr/bin/env node
// scripts/gap-19-13.smoke.mjs
//
// Smoke determinístico (OFFLINE — sem rede/Supabase/ClickUp/Redis real) do
// gap-closure 19-13: fecha o WR-A (19-REVIEW-2.md) — a janela residual em que o
// dreno de `op='criar_task'` re-cria uma task ClickUp DUPLICADA após um crash
// ENTRE `criarTask` (task criada) e `backfillClickupTaskId` (id persistido).
// Molde de scripts/gap-19-11.smoke.mjs (fetch mock roteado por característica da
// URL/método; env sintética ANTES do import — config.ts lê no IMPORT-TIME).
//
// Estratégia do fix (revisor): CLAIM por compare-and-set (`pendente`/`erro`→
// `enviando`) ANTES de `criarTask`. Um crash na janela deixa a linha em
// `enviando` (fora do conjunto que `proximasPendentes` lê) — a próxima passada
// NÃO re-cria às cegas: `reconciliarCriarTaskPresa` a detecta e, sem id
// resolvido, a converte em `orphan` (órfão DETECTÁVEL do 19-06), NUNCA duplicata.
//
// Cenários:
//   (a) FELIZ — pendente→claim(enviando)→criarTask 1x→back-fill→enviado.
//   (b) CRASH entre criarTask e back-fill — a 2ª passada acha a linha `enviando`
//       SEM id resolvido → NÃO chama criarTask de novo (0 duplicatas) → roteia
//       para orphan (marcarOrphanEnviando).
//   (c) JÁ-RESOLVIDO (id presente, 19-11) — pula criarTask (short-circuit).
//   (d) PRIMITIVAS CAS — claimLinha retorna null quando 0 linhas afetadas (CAS
//       perdido p/ outra réplica) e a linha quando reivindica; marcarOrphanEnviando
//       conta a representação.
//   (e) GREP — sem listagem de tasks; claim/enviando presentes; short-circuit
//       19-11 e DLQ/head-of-line 19-06 preservados.
//
// NUNCA loga service key sintética nem payload — só booleans/ids de teste.
//
// Uso: node --experimental-strip-types scripts/gap-19-13.smoke.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Env sintética ANTES de qualquer import de src/. Nunca aponta para infra real;
// sem REDIS_URL (prova o caminho inline: garantirTokenDreno LIBERA — WR-03).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://fake.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'k';
process.env.CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN || 'tkn';
delete process.env.REDIS_URL;

const RAIZ_REPO = fileURLToPath(new URL('..', import.meta.url));

const falhas = [];
function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ===== Mock de fetch com estado (simula as transições de status da linha) =====
//
// Roteia por característica da URL/método. Mantém UMA linha `criar_task` e o
// `clickup_task_id` da ligação (resolverClickupTaskId), mutando o estado nas
// transições reais do dreno.
function instalarMock({ statusInicial, ligacaoTaskId }) {
  const estado = {
    outbox: {
      id: 1,
      aggregate: 'ligacao',
      aggregate_id: 42,
      op: 'criar_task',
      bloqueante: true,
      payload: { origem: 'avulsa', telefone_canonico: '+5511999999999' },
      dedup_key: 'ligacao:42:criar',
      seq: 1,
      status: statusInicial,
      tentativas: 0,
    },
    ligacaoTaskId, // null = ainda não criada; string = já persistida
  };
  const chamadas = {
    presasGet: 0,
    resolverGet: 0,
    orphanPatch: 0,
    proximasGet: 0,
    claimPatch: 0,
    criarTaskPost: 0,
    backfillPatch: 0,
    marcarEnviadoPatch: 0,
    liberarPatch: 0,
  };

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const m = (opts.method || 'GET').toUpperCase();
    const ok = (data) =>
      new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    const okVazio = () => new Response(null, { status: 200 }); // PATCH return=minimal

    // ClickUp POST /list/{id}/task — criarTask (NÃO pode ser chamado no crash/reuse).
    if (u.includes('api.clickup.com') && u.includes('/task') && m === 'POST') {
      chamadas.criarTaskPost += 1;
      return ok({ id: 'TASK_NOVA' });
    }

    if (u.includes('/rest/v1/')) {
      // linhasPresasEnviando — GET ...op=eq.criar_task&status=eq.enviando
      if (m === 'GET' && u.includes('op=eq.criar_task') && u.includes('status=eq.enviando')) {
        chamadas.presasGet += 1;
        return ok(estado.outbox.status === 'enviando' ? [{ ...estado.outbox }] : []);
      }
      // resolverClickupTaskId — GET ...?id=eq.42&select=clickup_task_id
      if (m === 'GET' && u.includes('select=clickup_task_id')) {
        chamadas.resolverGet += 1;
        return ok([{ clickup_task_id: estado.ligacaoTaskId }]);
      }
      // proximasPendentes — GET ...?aggregate_id=eq.42&status=in.(pendente,erro)...
      if (m === 'GET' && u.includes('status=in')) {
        chamadas.proximasGet += 1;
        const st = estado.outbox.status;
        return ok(st === 'pendente' || st === 'erro' ? [{ ...estado.outbox }] : []);
      }
      // marcarOrphanEnviando — PATCH ...op=eq.criar_task&status=eq.enviando (ANTES do liberar)
      if (m === 'PATCH' && u.includes('op=eq.criar_task') && u.includes('status=eq.enviando')) {
        chamadas.orphanPatch += 1;
        if (estado.outbox.status === 'enviando') {
          estado.outbox.status = 'orphan';
          return ok([{ ...estado.outbox }]);
        }
        return ok([]);
      }
      // claimLinha — PATCH ...?id=eq.1&status=in.(pendente,erro)  (CAS)
      if (m === 'PATCH' && u.includes('status=in.')) {
        chamadas.claimPatch += 1;
        if (estado.outbox.status === 'pendente' || estado.outbox.status === 'erro') {
          estado.outbox.status = 'enviando';
          return ok([{ ...estado.outbox }]);
        }
        return ok([]); // CAS perdido
      }
      // liberarLinha — PATCH ...?id=eq.1&status=eq.enviando  (revert do claim)
      if (m === 'PATCH' && u.includes('status=eq.enviando')) {
        chamadas.liberarPatch += 1;
        if (estado.outbox.status === 'enviando') estado.outbox.status = 'pendente';
        return okVazio();
      }
      // backfillClickupTaskId — PATCH ...?id=eq.42&clickup_task_id=is.null
      if (m === 'PATCH' && u.includes('clickup_task_id=is.null')) {
        chamadas.backfillPatch += 1;
        if (estado.ligacaoTaskId === null) estado.ligacaoTaskId = 'TASK_NOVA';
        return okVazio();
      }
      // marcarEnviado — PATCH ...clickup_outbox?id=eq.1 (genérico, por último)
      if (m === 'PATCH') {
        chamadas.marcarEnviadoPatch += 1;
        estado.outbox.status = 'enviado';
        return okVazio();
      }
    }
    throw new Error(`fetch inesperado no smoke: ${m} ${u}`);
  };

  return { estado, chamadas };
}

// ===== (a) FELIZ — pendente→claim→criarTask 1x→back-fill→enviado =====
async function testeFeliz() {
  const { processarDrenoOutboxJob } = await import('../src/mastra/drenar-outbox.ts');
  const fetchReal = global.fetch;
  try {
    const { estado, chamadas } = instalarMock({ statusInicial: 'pendente', ligacaoTaskId: null });
    const r = await processarDrenoOutboxJob(42);
    checar(chamadas.claimPatch === 1, `(a) feliz: a linha deve ser reivindicada (claim) 1x (recebido ${chamadas.claimPatch})`);
    checar(chamadas.criarTaskPost === 1, `(a) feliz: criarTask deve ser chamado exatamente 1x (recebido ${chamadas.criarTaskPost})`);
    checar(chamadas.backfillPatch === 1, `(a) feliz: back-fill do id deve rodar 1x (recebido ${chamadas.backfillPatch})`);
    checar(chamadas.orphanPatch === 0, `(a) feliz: NENHUMA reconciliação de órfão no caminho feliz (recebido ${chamadas.orphanPatch})`);
    checar(chamadas.marcarEnviadoPatch === 1, `(a) feliz: a linha deve ser marcada enviada 1x (recebido ${chamadas.marcarEnviadoPatch})`);
    checar(r.enviadas === 1, `(a) feliz: deve reportar 1 enviada (recebido ${JSON.stringify(r)})`);
    checar(estado.outbox.status === 'enviado', `(a) feliz: estado final da linha deve ser 'enviado' (recebido '${estado.outbox.status}')`);
  } finally {
    global.fetch = fetchReal;
  }
}

// ===== (b) CRASH entre criarTask e back-fill → NÃO re-cria, roteia p/ órfão =====
async function testeCrashSemDuplicata() {
  const { processarDrenoOutboxJob } = await import('../src/mastra/drenar-outbox.ts');
  const fetchReal = global.fetch;
  try {
    // Estado logo APÓS o crash: a linha ficou 'enviando' (claim feito) e o
    // clickup_task_id NUNCA foi persistido (back-fill não rodou).
    const { estado, chamadas } = instalarMock({ statusInicial: 'enviando', ligacaoTaskId: null });
    const r = await processarDrenoOutboxJob(42);
    checar(
      chamadas.criarTaskPost === 0,
      `(b) crash: criarTask NÃO pode ser re-chamado (0 duplicatas) — recebido ${chamadas.criarTaskPost}`,
    );
    checar(chamadas.orphanPatch === 1, `(b) crash: a linha 'enviando' sem id deve ser roteada para órfão 1x (recebido ${chamadas.orphanPatch})`);
    checar(chamadas.claimPatch === 0, `(b) crash: nada a reivindicar (a linha já está 'enviando') — claim=${chamadas.claimPatch}`);
    checar(r.enviadas === 0, `(b) crash: nada enviado nesta passada (recebido ${JSON.stringify(r)})`);
    checar(estado.outbox.status === 'orphan', `(b) crash: estado final da linha deve ser 'orphan' (recebido '${estado.outbox.status}')`);
  } finally {
    global.fetch = fetchReal;
  }
}

// ===== (c) JÁ-RESOLVIDO (19-11 short-circuit) — pula criarTask =====
async function testeJaResolvido() {
  const { processarDrenoOutboxJob } = await import('../src/mastra/drenar-outbox.ts');
  const fetchReal = global.fetch;
  try {
    const { estado, chamadas } = instalarMock({ statusInicial: 'pendente', ligacaoTaskId: 'TASK_EXISTENTE' });
    const r = await processarDrenoOutboxJob(42);
    checar(chamadas.criarTaskPost === 0, `(c) já-resolvido: criarTask NÃO deve ser chamado (id já existe) — recebido ${chamadas.criarTaskPost}`);
    checar(chamadas.claimPatch === 0, `(c) já-resolvido: sem claim (short-circuit ANTES do claim) — recebido ${chamadas.claimPatch}`);
    checar(chamadas.orphanPatch === 0, `(c) já-resolvido: sem reconciliação de órfão — recebido ${chamadas.orphanPatch}`);
    checar(chamadas.marcarEnviadoPatch === 1, `(c) já-resolvido: a linha deve ser marcada enviada 1x (recebido ${chamadas.marcarEnviadoPatch})`);
    checar(r.enviadas === 1, `(c) já-resolvido: deve reportar 1 enviada (recebido ${JSON.stringify(r)})`);
    checar(estado.outbox.status === 'enviado', `(c) já-resolvido: estado final 'enviado' (recebido '${estado.outbox.status}')`);
  } finally {
    global.fetch = fetchReal;
  }
}

// ===== (d) PRIMITIVAS CAS — claimLinha null quando 0 linhas / orphan conta =====
async function testePrimitivasCas() {
  const repo = await import('../src/mastra/outbox-repo.ts');
  const fetchReal = global.fetch;
  try {
    const okJson = (data) =>
      new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

    // CAS perdido: PATCH afeta 0 linhas (status já não era pendente/erro) => null.
    global.fetch = async (_url, opts = {}) => {
      if ((opts.method || 'GET').toUpperCase() === 'PATCH') return okJson([]);
      throw new Error('inesperado');
    };
    const nada = await repo.claimLinha(1);
    checar(nada === null, `(d) claimLinha deve retornar null quando 0 linhas afetadas (CAS perdido) — recebido ${JSON.stringify(nada)}`);

    // CAS ganho: PATCH afeta 1 linha => retorna a linha reivindicada.
    global.fetch = async (_url, opts = {}) => {
      if ((opts.method || 'GET').toUpperCase() === 'PATCH') return okJson([{ id: 1, status: 'enviando' }]);
      throw new Error('inesperado');
    };
    const linha = await repo.claimLinha(1);
    checar(
      linha && linha.id === 1 && linha.status === 'enviando',
      `(d) claimLinha deve retornar a linha reivindicada (enviando) — recebido ${JSON.stringify(linha)}`,
    );

    // marcarOrphanEnviando conta a representação das linhas convertidas.
    // (Fase C, Phase 20 Plano 02: assinatura ganhou o parâmetro `aggregate`.)
    global.fetch = async () => okJson([{ id: 1 }, { id: 2 }]);
    const n = await repo.marcarOrphanEnviando('ligacao', 42);
    checar(n === 2, `(d) marcarOrphanEnviando deve retornar a contagem convertida — recebido ${n}`);
  } finally {
    global.fetch = fetchReal;
  }
}

// ===== (e) GREP — invariantes de código preservadas =====
function testeGrep() {
  const drenar = readFileSync(`${RAIZ_REPO}src/mastra/drenar-outbox.ts`, 'utf8');
  const repo = readFileSync(`${RAIZ_REPO}src/mastra/outbox-repo.ts`, 'utf8');

  for (const [rel, conteudo] of [
    ['src/mastra/drenar-outbox.ts', drenar],
    ['src/mastra/outbox-repo.ts', repo],
  ]) {
    checar(!/listartasks/i.test(conteudo), `${rel} não deve referenciar listagem de tasks (ESCRITA-02 — só primitivas por-ID)`);
    checar(conteudo.includes('enviando'), `${rel} deve conter o estado 'enviando' (WR-A)`);
    checar(conteudo.includes('claimLinha'), `${rel} deve referenciar claimLinha (WR-A compare-and-set)`);
  }
  // 19-11 short-circuit preservado (id já resolvido pula criarTask).
  checar(
    drenar.includes('resolverClickupTaskId') && drenar.includes('if (taskIdAtual)'),
    'drenar-outbox.ts deve manter o short-circuit do 19-11 (resolverClickupTaskId + if (taskIdAtual))',
  );
  // 19-06 head-of-line/DLQ preservado.
  checar(drenar.includes('marcarDlqLinha'), 'drenar-outbox.ts deve manter a DLQ por-linha do 19-06 (marcarDlqLinha)');
  // O claim vem ANTES de criarTask (ordem correta do WR-A).
  const idxClaim = drenar.indexOf('claimLinha(linha.id)');
  const idxCriar = drenar.indexOf('criarTask(CLICKUP_LIST_LIGACOES');
  checar(idxClaim > 0 && idxCriar > 0 && idxClaim < idxCriar, 'drenar-outbox.ts deve reivindicar (claim) ANTES de criarTask (WR-A)');
}

async function main() {
  await testeFeliz();
  await testeCrashSemDuplicata();
  await testeJaResolvido();
  await testePrimitivasCas();
  testeGrep();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('SMOKE OK');
  process.exit(0);
}

main();
