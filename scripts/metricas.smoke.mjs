#!/usr/bin/env node
// scripts/metricas.smoke.mjs
//
// Smoke determinístico (sem rede/Redis) do módulo de métricas operacionais
// (`src/mastra/metricas.ts`, Fase 10, OBS-02, D-06). Roda SEM REDIS_URL no
// ambiente (modo memória) e prova:
//   1. Degradação graciosa — `modoMetricas() === 'memoria'` sem REDIS_URL
//      (mesmo molde de estado-webhook.ts/fila.ts/rate-limiter-clickup.ts).
//   2. Coleta+leitura de erro/sucesso por etapa reflete em lerMetricas()
//      (total e taxa corretos).
//   3. Coleta+leitura de 429 do ClickUp reflete na contagem.
//   4. Coleta+leitura de presença reflete em atendentesOnline.
//   5. lerMetricas() NUNCA rejeita — sempre resolve com um snapshot completo
//      (T-10-02-D1), mesmo sem Redis.
//   6. `fecharMetricas()` roda sem lançar (no-op em modo memória).
//
// Nomeado `metricas.smoke.mjs` — não colide com `fila.smoke.mjs` (fila de
// Ligações no ClickUp) nem `fila-assincrona.smoke.mjs` (fila BullMQ).
//
// Uso: node --experimental-strip-types scripts/metricas.smoke.mjs

import {
  registrarPresenca,
  registrarErroEtapa,
  registrarSucessoEtapa,
  registrar429ClickUp,
  lerMetricas,
  modoMetricas,
  fecharMetricas,
} from '../src/mastra/metricas.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function testeModoDegradacao() {
  checar(
    modoMetricas() === 'memoria',
    `modoMetricas() deveria ser 'memoria' sem REDIS_URL, recebido: '${modoMetricas()}'`,
  );
}

async function testeTaxaErroPorEtapa() {
  registrarErroEtapa('transcricao');
  registrarSucessoEtapa('transcricao');

  const snapshot = await lerMetricas();
  const etapa = snapshot.taxaErroPorEtapa?.transcricao;

  checar(!!etapa, 'lerMetricas().taxaErroPorEtapa.transcricao deveria existir');
  checar(etapa?.total === 2, `taxaErroPorEtapa.transcricao.total deveria ser 2, recebido: ${etapa?.total}`);
  checar(etapa?.erros === 1, `taxaErroPorEtapa.transcricao.erros deveria ser 1, recebido: ${etapa?.erros}`);
  checar(etapa?.taxa === 0.5, `taxaErroPorEtapa.transcricao.taxa deveria ser 0.5, recebido: ${etapa?.taxa}`);
}

async function testeContagem429() {
  const N = 3;
  for (let i = 0; i < N; i++) registrar429ClickUp();

  const snapshot = await lerMetricas();
  checar(
    snapshot.contagem429 >= N,
    `lerMetricas().contagem429 deveria ser >= ${N}, recebido: ${snapshot.contagem429}`,
  );
}

async function testeAtendentesOnline() {
  registrarPresenca('op1');

  const snapshot = await lerMetricas();
  checar(
    snapshot.atendentesOnline >= 1,
    `lerMetricas().atendentesOnline deveria ser >= 1, recebido: ${snapshot.atendentesOnline}`,
  );
}

async function testeSnapshotCompletoNuncaRejeita() {
  let lancou = false;
  let snapshot;
  try {
    snapshot = await lerMetricas();
  } catch {
    lancou = true;
  }
  checar(!lancou, 'lerMetricas() não deveria rejeitar mesmo sem Redis');
  checar(typeof snapshot?.atendentesOnline === 'number', 'snapshot.atendentesOnline deveria ser number');
  checar(typeof snapshot?.chamadasAtivas === 'number', 'snapshot.chamadasAtivas deveria ser number');
  checar(typeof snapshot?.profundidadeFila === 'number', 'snapshot.profundidadeFila deveria ser number');
  checar(typeof snapshot?.errosDia === 'number', 'snapshot.errosDia deveria ser number');
  checar(typeof snapshot?.contagem429 === 'number', 'snapshot.contagem429 deveria ser number');
  checar(typeof snapshot?.taxaErroPorEtapa === 'object', 'snapshot.taxaErroPorEtapa deveria ser object');
  for (const etapa of ['webhook', 'transcricao', 'analise', 'sync']) {
    checar(
      typeof snapshot?.taxaErroPorEtapa?.[etapa]?.taxa === 'number',
      `snapshot.taxaErroPorEtapa.${etapa}.taxa deveria ser number`,
    );
  }
}

async function testeFechar() {
  let lancou = false;
  try {
    await fecharMetricas();
  } catch {
    lancou = true;
  }
  checar(!lancou, 'fecharMetricas() não deveria lançar em modo memoria (no-op)');
}

async function main() {
  testeModoDegradacao();
  await testeTaxaErroPorEtapa();
  await testeContagem429();
  await testeAtendentesOnline();
  await testeSnapshotCompletoNuncaRejeita();
  await testeFechar();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('PASS');
  process.exit(0);
}

main();
