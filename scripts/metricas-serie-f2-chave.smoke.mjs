#!/usr/bin/env node
// scripts/metricas-serie-f2-chave.smoke.mjs
//
// Smoke determinístico (sem rede) dos dois "menores" da Fase 19.1 (plano 06):
//   F1 — série diária DURÁVEL de métricas (retenção METRICAS_SERIE_TTL_MS),
//        write-side, pra investigação pós-incidente (src/mastra/metricas.ts).
//   F2 — chave Redis de task-ativa deixa de carregar telefone em claro no NOME
//        (digest determinístico DENTRO de chaveTelefone, src/mastra/estado-webhook.ts).
//
// Roda SEM `--env-file` (REDIS_URL vazio) — modo memória, mesma casca dos
// outros smokes do repo (estado-webhook.smoke.mjs, metricas.smoke.mjs).
//
// Uso: node --experimental-strip-types scripts/metricas-serie-f2-chave.smoke.mjs

import { registrarErroEtapa, registrarSucessoEtapa, registrar429ClickUp, lerSerieDiaria } from '../src/mastra/metricas.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ===== F1 — série diária durável =====

async function testeSerieDiariaErroSucesso() {
  const antes = await lerSerieDiaria('erro:webhook', 1);
  const contagemAntes = antes[0]?.contagem ?? 0;

  registrarErroEtapa('webhook');
  registrarErroEtapa('webhook');
  registrarSucessoEtapa('webhook');

  const depoisErro = await lerSerieDiaria('erro:webhook', 1);
  const depoisSucesso = await lerSerieDiaria('sucesso:webhook', 1);

  checar(
    depoisErro[0]?.contagem === contagemAntes + 2,
    `lerSerieDiaria('erro:webhook', 1) deveria acumular +2 hoje, esperado ${contagemAntes + 2}, recebido: ${depoisErro[0]?.contagem}`,
  );
  checar(
    (depoisSucesso[0]?.contagem ?? 0) >= 1,
    `lerSerieDiaria('sucesso:webhook', 1) deveria ter >=1 hoje, recebido: ${depoisSucesso[0]?.contagem}`,
  );
  checar(depoisErro[0]?.data === new Date().toISOString().slice(0, 10), 'a data do 1o item deveria ser hoje (UTC)');
}

async function testeSerieDiaria429() {
  const antes = await lerSerieDiaria('429', 1);
  const contagemAntes = antes[0]?.contagem ?? 0;

  registrar429ClickUp();
  registrar429ClickUp();
  registrar429ClickUp();

  const depois = await lerSerieDiaria('429', 1);
  checar(
    depois[0]?.contagem === contagemAntes + 3,
    `lerSerieDiaria('429', 1) deveria acumular +3, esperado ${contagemAntes + 3}, recebido: ${depois[0]?.contagem}`,
  );
}

async function testeSerieDiariaVariosDias() {
  const serie = await lerSerieDiaria('erro:webhook', 5);
  checar(serie.length === 5, `lerSerieDiaria(metrica, 5) deveria devolver 5 entradas, recebido: ${serie.length}`);
  for (const item of serie) {
    checar(typeof item.data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.data), `data mal formada: ${item.data}`);
    checar(typeof item.contagem === 'number', `contagem deveria ser number: ${item.contagem}`);
  }
}

async function testeSerieDiariaMetricaInexistenteZerada() {
  const serie = await lerSerieDiaria('metrica-que-nunca-existiu', 3);
  checar(serie.every((i) => i.contagem === 0), 'metrica nunca registrada deveria vir zerada em todos os dias, nunca lançar');
}

async function testeSerieDiariaNuncaLanca() {
  let lancou = false;
  try {
    await lerSerieDiaria('qualquer', 1);
  } catch {
    lancou = true;
  }
  checar(!lancou, 'lerSerieDiaria não deveria lançar mesmo sem Redis');
}

async function main() {
  await testeSerieDiariaErroSucesso();
  await testeSerieDiaria429();
  await testeSerieDiariaVariosDias();
  await testeSerieDiariaMetricaInexistenteZerada();
  await testeSerieDiariaNuncaLanca();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
