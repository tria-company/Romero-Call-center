#!/usr/bin/env node
// scripts/boot-espelho.smoke.mjs
//
// Smoke determinístico (sem rede/Supabase real) do healthcheck de boot do
// espelho (17-03, PORTAO-03/R11 — src/mastra/boot-espelho.ts). Prova
// `avaliarHealthcheck` (PURA):
//   1. Todas as tabelas visíveis+escrevíveis -> todasOk=true, ok=true em cada.
//   2. Uma tabela com SELECT 404 (selecionavel=false) -> ok=false só nela,
//      todasOk=false (mantém o fallback ClickUp).
//   3. Uma tabela selecionável mas NÃO escrevível -> ok=false só nela,
//      todasOk=false.
//   4. Mapa vazio (nenhuma tabela avaliada) -> todasOk=false (nunca "ok" por
//      vacuidade).
//
// Uso: node scripts/boot-espelho.smoke.mjs

import { avaliarHealthcheck } from '../src/mastra/boot-espelho.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function resultadoBase() {
  return {
    ligacoes: { selecionavel: true, escrevivel: true },
    audios_envios: { selecionavel: true, escrevivel: true },
    clickup_outbox: { selecionavel: true, escrevivel: true },
    clickup_campo_mapa: { selecionavel: true, escrevivel: true },
    notas: { selecionavel: true, escrevivel: true },
  };
}

function testeTodasOkTodasVisiveisEscreviveis() {
  const avaliacao = avaliarHealthcheck(resultadoBase());
  checar(avaliacao.todasOk === true, `esperado todasOk=true quando todas as tabelas estao ok, recebido: ${avaliacao.todasOk}`);
  checar(avaliacao.tabelas.length === 5, `esperado 5 tabelas avaliadas, recebido ${avaliacao.tabelas.length}`);
  checar(avaliacao.tabelas.every((t) => t.ok === true), `todas as tabelas deveriam ter ok=true: ${JSON.stringify(avaliacao.tabelas)}`);
}

function teste404NaoSelecionavelFalhaSoNaquelaTabela() {
  const resultados = resultadoBase();
  resultados.clickup_outbox = { selecionavel: false, escrevivel: false }; // 404 = fora do cache
  const avaliacao = avaliarHealthcheck(resultados);
  checar(avaliacao.todasOk === false, 'uma tabela 404 deveria fazer todasOk=false (fallback ClickUp mantido)');
  const status = avaliacao.tabelas.find((t) => t.tabela === 'clickup_outbox');
  checar(!!status && status.ok === false, 'clickup_outbox 404 deveria ter ok=false');
  const outras = avaliacao.tabelas.filter((t) => t.tabela !== 'clickup_outbox');
  checar(outras.every((t) => t.ok === true), 'as demais tabelas nao deveriam ser afetadas pela falha de uma tabela');
}

function testeSelecionavelMasNaoEscrivelFalha() {
  const resultados = resultadoBase();
  resultados.notas = { selecionavel: true, escrevivel: false }; // visivel mas sem permissao de escrita
  const avaliacao = avaliarHealthcheck(resultados);
  checar(avaliacao.todasOk === false, 'tabela visivel mas nao-escrivel deveria fazer todasOk=false');
  const status = avaliacao.tabelas.find((t) => t.tabela === 'notas');
  checar(!!status && status.ok === false, 'notas nao-escrivel deveria ter ok=false');
}

function testeMapaVazioNuncaOk() {
  const avaliacao = avaliarHealthcheck({});
  checar(avaliacao.todasOk === false, 'mapa vazio nunca deveria ser todasOk=true (vacuidade nao e sucesso)');
  checar(avaliacao.tabelas.length === 0, 'mapa vazio deveria devolver 0 tabelas avaliadas');
}

function main() {
  testeTodasOkTodasVisiveisEscreviveis();
  teste404NaoSelecionavelFalhaSoNaquelaTabela();
  testeSelecionavelMasNaoEscrivelFalha();
  testeMapaVazioNuncaOk();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
