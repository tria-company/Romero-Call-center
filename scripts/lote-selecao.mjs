#!/usr/bin/env node
// scripts/lote-selecao.mjs
//
// Runner de preview do lote diário (LOTE-01, Fase 02 Plano 01): lê a Lista 01
// LEADS real do ClickUp, prioriza com a lógica pura de src/mastra/lote.ts e
// imprime o lote do dia — "quem será ligado hoje e em que ordem".
//
// Uso: node --env-file=.env --experimental-strip-types scripts/lote-selecao.mjs [--tamanho N]
//
// LGPD (T-02-01-I): telefone impresso MASCARADO (só os últimos 4 dígitos),
// nunca CPF, nunca o token do ClickUp em log/erro.

import { listarTasks, CLICKUP_LIST_LEADS, CAMPOS_LEADS } from '../src/mastra/clickup.ts';
import { parseLeadDaTask, selecionarLoteElegivel } from '../src/mastra/lote.ts';
import { LOTE_LIMITE_TENTATIVAS, LOTE_TAMANHO_DEFAULT } from '../src/mastra/config.ts';
import { mascararTelefone } from '../src/mastra/mascarar.ts';

function lerTamanhoArgv() {
  const idx = process.argv.indexOf('--tamanho');
  if (idx === -1) return LOTE_TAMANHO_DEFAULT;
  const valor = Number(process.argv[idx + 1]);
  return Number.isFinite(valor) && valor > 0 ? valor : LOTE_TAMANHO_DEFAULT;
}

/** Lê TODAS as tasks da Lista 01, paginando (listarTasks LANÇA em falha — WR-03). */
async function lerTodosOsLeads() {
  const todasAsTasks = [];
  let page = 0;
  let lastPage = false;
  while (!lastPage) {
    const resultado = await listarTasks(CLICKUP_LIST_LEADS, { page });
    todasAsTasks.push(...resultado.tasks);
    lastPage = resultado.lastPage;
    page += 1;
  }
  return todasAsTasks;
}

function imprimirTabela(lote) {
  if (lote.length === 0) {
    console.log('(lote vazio — nenhum lead elegível hoje)');
    return;
  }
  console.log('\npos | nome                           | telefone      | score | tentativas | retorno');
  console.log('----|--------------------------------|---------------|-------|------------|--------');
  lote.forEach((lead, i) => {
    const pos = String(i + 1).padStart(3);
    const nome = (lead.nome || '(sem nome)').padEnd(30).slice(0, 30);
    const telefone = mascararTelefone(lead.telefone).padEnd(13);
    const score = String(lead.score).padStart(5);
    const tentativas = String(lead.tentativas).padStart(10);
    const retorno = lead.retornoNecessario ? 'sim' : 'não';
    console.log(`${pos} | ${nome} | ${telefone} | ${score} | ${tentativas} | ${retorno}`);
  });
}

async function main() {
  const tamanho = lerTamanhoArgv();
  console.log('=== Lote diário priorizado (RomeroCall — LOTE-01) ===');
  console.log(`Lendo Lista 01 LEADS (lista ${CLICKUP_LIST_LEADS})...`);

  const tasks = await lerTodosOsLeads();
  console.log(`  ${tasks.length} lead(s) lido(s) da Lista 01 (contagem apenas, sem PII).`);

  const leads = tasks.map((task) => parseLeadDaTask(task, CAMPOS_LEADS));
  const lote = selecionarLoteElegivel(leads, {
    hoje: new Date(),
    limiteTentativas: LOTE_LIMITE_TENTATIVAS,
    tamanho,
  });

  console.log(`\nLote do dia: ${lote.length} lead(s) elegível(is) (tamanho máx. ${tamanho}).`);
  imprimirTabela(lote);
  process.exit(0);
}

main().catch((e) => {
  // Nunca deixar o erro colapsar num "lote vazio" silencioso (WR-03/T-02-01-D)
  // e nunca vazar o token do ClickUp na mensagem de erro.
  const mensagem = e instanceof Error ? e.message : String(e);
  console.error(`\n=== FALHA ao gerar o lote — ${mensagem} ===`);
  process.exit(1);
});
