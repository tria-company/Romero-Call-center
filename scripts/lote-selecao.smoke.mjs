#!/usr/bin/env node
// scripts/lote-selecao.smoke.mjs
//
// Smoke determinístico (sem rede) da priorização do lote diário (LOTE-01,
// Fase 02 Plano 01). Prova, via fixtures, que `selecionarLoteElegivel`
// (src/mastra/lote.ts) filtra corretamente por elegibilidade e ordena por
// retorno_necessario -> score -> tentativas (D-P2-04), e que
// `parseLeadDaTask` extrai os campos certos por field-id (D-07) de uma
// TaskClickUp simulada.
//
// Uso: node --experimental-strip-types scripts/lote-selecao.smoke.mjs

import { parseLeadDaTask, selecionarLoteElegivel } from '../src/mastra/lote.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

const HOJE = new Date('2026-08-10T12:00:00Z');
const ONTEM = new Date('2026-08-09T12:00:00Z');
const AMANHA = new Date('2026-08-11T12:00:00Z');

function leadFixture(overrides) {
  return {
    taskId: 'task-base',
    idLead: 'lead-base',
    nome: 'Lead Base',
    telefone: '11999999999',
    score: 50,
    tentativas: 0,
    proximoContato: ONTEM,
    retornoNecessario: false,
    ...overrides,
  };
}

// (a) proximoContato futuro -> EXCLUÍDO
const leadFuturo = leadFixture({ taskId: 'futuro', proximoContato: AMANHA });

// (b) tentativas >= limiteTentativas -> EXCLUÍDO
const leadEstourouTentativas = leadFixture({ taskId: 'estourou', tentativas: 5 });

// (c) três leads elegíveis para provar ordem: retorno primeiro -> score desc -> tentativas asc
const leadRetornoScoreBaixo = leadFixture({
  taskId: 'retorno-score-baixo',
  score: 10,
  tentativas: 2,
  retornoNecessario: true,
});
const leadSemRetornoScoreAlto = leadFixture({
  taskId: 'sem-retorno-score-alto',
  score: 90,
  tentativas: 1,
  retornoNecessario: false,
});
const leadSemRetornoScoreAltoDesempate1 = leadFixture({
  taskId: 'sem-retorno-desempate-1',
  score: 40,
  tentativas: 3,
  retornoNecessario: false,
});
const leadSemRetornoScoreAltoDesempate2 = leadFixture({
  taskId: 'sem-retorno-desempate-2',
  score: 40,
  tentativas: 1,
  retornoNecessario: false,
});

// (d) tamanho menor que o total -> corta a cauda
const todosElegiveis = [
  leadFuturo,
  leadEstourouTentativas,
  leadRetornoScoreBaixo,
  leadSemRetornoScoreAlto,
  leadSemRetornoScoreAltoDesempate1,
  leadSemRetornoScoreAltoDesempate2,
];

function testarExclusaoPorData() {
  const resultado = selecionarLoteElegivel([leadFuturo], {
    hoje: HOJE,
    limiteTentativas: 5,
    tamanho: 30,
  });
  checar(
    resultado.every((l) => l.taskId !== 'futuro'),
    'lead com proximoContato futuro deveria ser EXCLUÍDO do lote',
  );
}

function testarExclusaoPorTentativas() {
  const resultado = selecionarLoteElegivel([leadEstourouTentativas], {
    hoje: HOJE,
    limiteTentativas: 5,
    tamanho: 30,
  });
  checar(
    resultado.every((l) => l.taskId !== 'estourou'),
    'lead com tentativas >= limiteTentativas deveria ser EXCLUÍDO do lote',
  );
}

function testarOrdenacao() {
  const elegiveis = [
    leadSemRetornoScoreAltoDesempate2,
    leadSemRetornoScoreAlto,
    leadRetornoScoreBaixo,
    leadSemRetornoScoreAltoDesempate1,
  ];
  const resultado = selecionarLoteElegivel(elegiveis, {
    hoje: HOJE,
    limiteTentativas: 5,
    tamanho: 30,
  });
  const ordemIds = resultado.map((l) => l.taskId);
  const ordemEsperada = [
    'retorno-score-baixo', // retornoNecessario=true vem primeiro, mesmo com score baixo
    'sem-retorno-score-alto', // maior score entre os sem retorno
    'sem-retorno-desempate-1', // score empatado com desempate-2, menos tentativas asc (3 vs 1) -> desempate-2 primeiro
    'sem-retorno-desempate-2',
  ];
  // desempate-1 tem tentativas=3, desempate-2 tem tentativas=1 -> asc: desempate-2 antes de desempate-1
  const ordemEsperadaCorrigida = [
    'retorno-score-baixo',
    'sem-retorno-score-alto',
    'sem-retorno-desempate-2',
    'sem-retorno-desempate-1',
  ];
  checar(
    JSON.stringify(ordemIds) === JSON.stringify(ordemEsperadaCorrigida),
    `ordenação incorreta: esperado ${JSON.stringify(ordemEsperadaCorrigida)}, recebido ${JSON.stringify(ordemIds)}`,
  );
}

function testarCorteTamanho() {
  const resultado = selecionarLoteElegivel(todosElegiveis, {
    hoje: HOJE,
    limiteTentativas: 5,
    tamanho: 2,
  });
  checar(resultado.length === 2, `tamanho deveria cortar em 2, recebido ${resultado.length}`);
}

// Fixture de TaskClickUp (D-07: extração por field-id, não por nome) para provar parseLeadDaTask.
const CAMPOS_FIXTURE = {
  NOME: 'field-nome',
  TELEFONE: 'field-telefone',
  ID_LEAD_GHL: 'field-id-lead',
  SCORE: 'field-score',
  QTD_TENTATIVAS: 'field-tentativas',
  PROXIMO_CONTATO: 'field-proximo-contato',
};

function testarParseLeadDaTask() {
  const epochProximoContato = ONTEM.getTime();
  const taskFixture = {
    id: 'task-clickup-123',
    name: 'Fulano de Tal',
    custom_fields: [
      { id: CAMPOS_FIXTURE.NOME, value: 'Fulano de Tal' },
      { id: CAMPOS_FIXTURE.TELEFONE, value: '11988887777' },
      { id: CAMPOS_FIXTURE.ID_LEAD_GHL, value: 'ghl-abc123' },
      { id: CAMPOS_FIXTURE.SCORE, value: 77 },
      { id: CAMPOS_FIXTURE.QTD_TENTATIVAS, value: 2 },
      { id: CAMPOS_FIXTURE.PROXIMO_CONTATO, value: String(epochProximoContato) },
    ],
  };

  const lead = parseLeadDaTask(taskFixture, CAMPOS_FIXTURE);

  checar(lead.taskId === 'task-clickup-123', `taskId incorreto: ${lead.taskId}`);
  checar(lead.nome === 'Fulano de Tal', `nome incorreto: ${lead.nome}`);
  checar(lead.telefone === '11988887777', `telefone incorreto: ${lead.telefone}`);
  checar(lead.idLead === 'ghl-abc123', `idLead incorreto: ${lead.idLead}`);
  checar(lead.score === 77, `score incorreto: ${lead.score}`);
  checar(lead.tentativas === 2, `tentativas incorreto: ${lead.tentativas}`);
  checar(
    lead.proximoContato instanceof Date && lead.proximoContato.getTime() === epochProximoContato,
    `proximoContato incorreto: ${lead.proximoContato}`,
  );
}

testarExclusaoPorData();
testarExclusaoPorTentativas();
testarOrdenacao();
testarCorteTamanho();
testarParseLeadDaTask();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
