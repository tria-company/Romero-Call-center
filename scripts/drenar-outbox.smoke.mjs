#!/usr/bin/env node
// scripts/drenar-outbox.smoke.mjs
//
// Smoke determinístico (OFFLINE — sem rede/Supabase/ClickUp real) do worker
// de dreno do transactional outbox (ESCRITA-02/LGPD-03, Fase B, Phase 19
// Plano 03 — src/mastra/drenar-outbox.ts + outbox-repo.ts + o kick em
// fila.ts). Molde de scripts/fila-assincrona.smoke.mjs (checar()/falhas[],
// exit 1 em falha) e scripts/outbox-rpc.smoke.mjs (env sintética antes do
// import, já que as constantes de config.ts são lidas no IMPORT-TIME).
//
// Como este processo roda SEM REDIS_URL (mesmo espírito de
// fila-assincrona.smoke.mjs), `enfileirarDrenoOutbox` fica em MODO 'inline'
// — a prova central deste smoke: sem Redis, o kick NUNCA lança e retorna
// `{ enfileirado:false }`, obrigando o CALLER a cair no fallback inline
// (processarDrenoOutboxJob) — sem isso, dev/homolog sem Redis nunca
// drenariam (T-19-03-Av).
//
// Prova (sem rede real):
//   (a) enfileirarDrenoOutbox existe e, em modo inline, retorna
//       { enfileirado:false } sem lançar;
//   (b) processarDrenoOutboxJob (drenar-outbox.ts) e as exports de
//       outbox-repo.ts carregam (strip-types, sem exceção de import);
//   (c) grep-nível: drenar-outbox.ts/outbox-repo.ts não fazem listagem de
//       tasks; outbox-repo marca payload:null (scrub pós-drain, LGPD-03).
//
// NUNCA loga a service key sintética nem qualquer payload — só booleans/ids
// de teste.
//
// Uso: node --experimental-strip-types scripts/drenar-outbox.smoke.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Env sintética ANTES do import — SUPABASE_URL/SUPABASE_SERVICE_KEY são lidas
// no IMPORT-TIME por config.ts (module-level `const`), mesmo racional de
// outbox-rpc.smoke.mjs regime (b). Nunca aponta para infra real.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://fake.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'k';

const RAIZ_REPO = fileURLToPath(new URL('..', import.meta.url));

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

async function testeKickInlineSemRedis() {
  const { enfileirarDrenoOutbox, modoFila } = await import('../src/mastra/fila.ts');

  checar(
    modoFila() === 'inline',
    `modoFila() deveria ser 'inline' sem REDIS_URL, recebido: '${modoFila()}'`,
  );

  const resultado = await enfileirarDrenoOutbox({ aggregateId: 42 });
  checar(
    resultado.enfileirado === false,
    `enfileirarDrenoOutbox em modo inline deveria ser { enfileirado:false } (o caller cai no processarDrenoOutboxJob inline), recebido: ${JSON.stringify(resultado)}`,
  );
}

async function testeModulosCarregam() {
  const drenar = await import('../src/mastra/drenar-outbox.ts');
  checar(
    typeof drenar.processarDrenoOutboxJob === 'function',
    'drenar-outbox.ts deveria exportar processarDrenoOutboxJob (usável no worker E no fallback inline dos callers)',
  );

  const repo = await import('../src/mastra/outbox-repo.ts');
  for (const nome of ['proximasPendentes', 'marcarEnviado', 'backfillClickupTaskId', 'resolverClickupTaskId', 'marcarErro']) {
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
  await testeKickInlineSemRedis();
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
