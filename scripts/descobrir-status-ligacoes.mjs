#!/usr/bin/env node
// scripts/descobrir-status-ligacoes.mjs
//
// Runner de descoberta (D-P3-07, Fase 03 Plano 01): lê os statuses REAIS da
// Lista 02 LIGACOES via API do ClickUp e imprime uma sugestão de mapeamento
// — qual status usar como "em processamento" (D-P3-07, aberto/de progresso)
// e qual é o status "fechado" (conclusão). NÃO escreve nada — só lê e
// imprime, pra fixar OPER_STATUS_EM_PROCESSAMENTO no .env com o nome exato
// (nunca adivinhar status no código: escrever um status inexistente é
// rejeitado pela API do ClickUp).
//
// Uso:
//   node --env-file=.env --experimental-strip-types scripts/descobrir-status-ligacoes.mjs
//
// LGPD: imprime só nomes de status (sem PII — nenhum telefone/CPF/nome de lead).

import { listarStatusLista, CLICKUP_LIST_LIGACOES } from '../src/mastra/clickup.ts';

// Palavras que costumam indicar um status de progresso/intermediário (ex:
// "in progress", "em andamento", "processing"). Só uma SUGESTÃO — a decisão
// final é humana (checkpoint 03-05), porque nem toda workspace tem um status
// de progresso distinto.
const PISTAS_EM_PROGRESSO = ['progress', 'andamento', 'processando', 'processamento', 'discando', 'ligando'];
// Palavras que costumam indicar o status final/fechado (ex: "complete", "done").
const PISTAS_FECHADO = ['complete', 'concluí', 'conclu', 'done', 'closed', 'fechad', 'finalizad'];

function sugerir(statuses, pistas) {
  const lower = statuses.map((s) => s.toLowerCase());
  for (const pista of pistas) {
    const idx = lower.findIndex((s) => s.includes(pista));
    if (idx !== -1) return statuses[idx];
  }
  return null;
}

async function main() {
  console.log('=== Descobrir statuses reais da Lista 02 LIGACOES (D-P3-07, Fase 03 Plano 01) ===');
  console.log(`Lendo statuses da lista ${CLICKUP_LIST_LIGACOES}...`);

  const statuses = await listarStatusLista(CLICKUP_LIST_LIGACOES);

  if (!statuses.length) {
    throw new Error('a lista nao retornou nenhum status — verifique CLICKUP_LIST_LIGACOES/CLICKUP_API_TOKEN');
  }

  console.log(`\nStatuses reais encontrados (${statuses.length}):`);
  for (const s of statuses) {
    console.log(`  - "${s}"`);
  }

  const sugestaoProgresso = sugerir(statuses, PISTAS_EM_PROGRESSO);
  const sugestaoFechado = sugerir(statuses, PISTAS_FECHADO);

  console.log('\n=== Sugestão de mapeamento ===');
  if (sugestaoProgresso) {
    console.log(`  "em processamento" (D-P3-07) -> "${sugestaoProgresso}"`);
    console.log(`  Configure no .env: OPER_STATUS_EM_PROCESSAMENTO=${sugestaoProgresso}`);
  } else {
    console.log(
      '  "em processamento": NENHUM status de progresso distinto foi encontrado por heurística.\n' +
        '  DECISÃO A CONFIRMAR no checkpoint 03-05: reusar um status aberto existente como\n' +
        '  "em processamento" (ex.: o primeiro status aberto da lista) ou criar um status novo\n' +
        `  na Lista 02 no ClickUp. Statuses abertos disponíveis: ${statuses.map((s) => `"${s}"`).join(', ')}.`,
    );
  }
  if (sugestaoFechado) {
    console.log(`  "fechado" (conclusão) -> "${sugestaoFechado}"`);
  } else {
    console.log('  "fechado": nenhum status de conclusão óbvio encontrado por heurística — confirmar manualmente.');
  }

  console.log('\n(Nada foi escrito no ClickUp — este runner só lê.)');
  process.exit(0);
}

main().catch((e) => {
  const mensagem = e instanceof Error ? e.message : String(e);
  console.error(`\n=== FALHA ao descobrir statuses — ${mensagem} ===`);
  process.exit(1);
});
