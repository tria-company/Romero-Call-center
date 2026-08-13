#!/usr/bin/env node
// scripts/wiring-cache-sync.smoke.mjs
//
// Smoke determinístico (sem rede/Redis) da fiação cache↔escrita do Plano 04
// (CACHE-04, Fase 08). A fiação em si vive DENTRO dos handlers Hono de
// /api/discador/ligando e /api/discador/voto (index.ts) — difícil de
// invocar isolado sem subir o servidor inteiro. Este smoke prova os
// INVARIANTES das superfícies que essa fiação consome, em modo degradado
// (sem REDIS_URL no ambiente):
//
//   1. `enfileirarSyncClickup` é no-op (`{ enfileirado: false }`) sem Redis
//      — garante que o /voto toma o caminho de fallback inline
//      (`processarSyncClickupJob`) quando não há Redis (D-07a/SC5).
//   2. `removerDaFilaCache`/`invalidarFilaCache` (consumidos pelo /ligando,
//      Task 1) resolvem sem lançar — no-op em modo memória.
//   3. `aquecerFilaCache` (o warm do D-07b, consumido pelo /voto, Task 2)
//      resolve sem lançar tanto no merge (objeto parcial) quanto no remove
//      (`null`) — garante que o warm nunca quebra o /voto mesmo sem Redis.
//
// A validação E2E da rota de fato (curl no /voto enfileirando + aquecendo o
// cache de verdade; /ligando invalidando o cache de verdade) fica FORA
// deste smoke — precisa de servidor + Redis reais rodando (mesmo padrão de
// 05-04/06-05/08-01/08-02/08-03).
//
// Uso: node --experimental-strip-types scripts/wiring-cache-sync.smoke.mjs

import { enfileirarSyncClickup } from '../src/mastra/fila.ts';
import { removerDaFilaCache, invalidarFilaCache, aquecerFilaCache } from '../src/mastra/cache-fila.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

async function testeEnqueueNoOpSemRedis() {
  // Garante que o /voto vai tomar o fallback inline (processarSyncClickupJob)
  // sem Redis — a mesma condicao que a rota checa (`if (!enfileirado)`).
  const resultado = await enfileirarSyncClickup({
    taskId: 't',
    assigneeId: 'a',
    voto: { romero: 'sim' },
  });
  checar(
    resultado.enfileirado === false,
    `enfileirarSyncClickup sem Redis deveria ser no-op ({enfileirado:false}), recebido: ${JSON.stringify(resultado)}`,
  );
}

async function testeInvalidacaoLigandoNeverThrows() {
  let lancou = false;
  try {
    await removerDaFilaCache('a', 't');
    await invalidarFilaCache('a');
  } catch {
    lancou = true;
  }
  checar(
    !lancou,
    'removerDaFilaCache/invalidarFilaCache (fiação do /ligando) não deveriam lançar sem Redis (no-op em memória, SC5)',
  );
}

async function testeWarmVotoNeverThrows() {
  let lancouMerge = false;
  try {
    // Merge (objeto parcial) — caminho hipotético de "a fila mostra o
    // desfecho"; provado aqui só pelo invariante never-throws da superfície
    // (a fiação real do /voto usa o remove — ver decisão abaixo).
    await aquecerFilaCache('a', 't', {});
  } catch {
    lancouMerge = true;
  }
  checar(
    !lancouMerge,
    'aquecerFilaCache (merge) não deveria lançar sem Redis (warm-on-write D-07b, no-op em memória)',
  );

  let lancouRemove = false;
  try {
    // Remove (`null`) — é o que a fiação do /voto de fato usa (Task 2):
    // buscarFilaLigacoes já exclui a Ligação da fila por status "em
    // processamento" (setado no /ligando) e ItemFila não carrega campo de
    // resultado pra mesclar, então o warm do resultado remove a task da
    // fila acionável do operador (read-your-writes "sumiu da minha fila").
    await aquecerFilaCache('a', 't', null);
  } catch {
    lancouRemove = true;
  }
  checar(
    !lancouRemove,
    'aquecerFilaCache (remove, null) não deveria lançar sem Redis (warm-on-write D-07b, no-op em memória)',
  );
}

async function main() {
  await testeEnqueueNoOpSemRedis();
  await testeInvalidacaoLigandoNeverThrows();
  await testeWarmVotoNeverThrows();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
