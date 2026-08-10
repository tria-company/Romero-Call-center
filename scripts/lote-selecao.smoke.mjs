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

// (c) quatro leads elegíveis para provar ordem: retorno primeiro -> score desc -> tentativas asc.
// Nota: retornoNecessario é DERIVADO por selecionarLoteElegivel (tentativas > 0 &&
// proximoContato <= hoje — D-P2-04), não lido do campo `retornoNecessario` da fixture.
// Como todo lead elegível já tem proximoContato <= hoje, a derivação equivale a
// "tentativas > 0" dentro do conjunto elegível — por isso as fixtures abaixo controlam
// tentativas (0 = sem retorno) para produzir o grupo esperado.
const leadRetornoScoreAlto = leadFixture({
  taskId: 'retorno-score-alto',
  score: 95,
  tentativas: 1, // tentativas > 0 -> retorno necessário
});
const leadRetornoScoreMedioTentativasBaixa = leadFixture({
  taskId: 'retorno-score-medio-tentativas-baixa',
  score: 80,
  tentativas: 2, // tentativas > 0 -> retorno necessário
});
const leadRetornoScoreMedioTentativasAlta = leadFixture({
  taskId: 'retorno-score-medio-tentativas-alta',
  score: 80,
  tentativas: 4, // tentativas > 0 -> retorno necessário; empata score com o anterior
});
const leadSemRetornoScoreMaisAlto = leadFixture({
  taskId: 'sem-retorno-score-mais-alto',
  score: 99, // maior score de todos, mas SEM retorno (tentativas=0) -> deve ficar por último
  tentativas: 0,
});

// (d) tamanho menor que o total -> corta a cauda
const todosElegiveis = [
  leadFuturo,
  leadEstourouTentativas,
  leadRetornoScoreAlto,
  leadRetornoScoreMedioTentativasBaixa,
  leadRetornoScoreMedioTentativasAlta,
  leadSemRetornoScoreMaisAlto,
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
  // Ordem de entrada embaralhada de propósito — a saída deve ser determinada
  // só pela regra de ordenação, não pela ordem de entrada.
  const elegiveis = [
    leadSemRetornoScoreMaisAlto,
    leadRetornoScoreMedioTentativasAlta,
    leadRetornoScoreAlto,
    leadRetornoScoreMedioTentativasBaixa,
  ];
  const resultado = selecionarLoteElegivel(elegiveis, {
    hoje: HOJE,
    limiteTentativas: 5,
    tamanho: 30,
  });
  const ordemIds = resultado.map((l) => l.taskId);
  const ordemEsperada = [
    'retorno-score-alto', // grupo retorno=true, maior score (95) do grupo -> primeiro
    'retorno-score-medio-tentativas-baixa', // grupo retorno=true, score 80 empatado, menos tentativas (2) -> antes do próximo
    'retorno-score-medio-tentativas-alta', // grupo retorno=true, score 80 empatado, mais tentativas (4) -> depois do anterior
    'sem-retorno-score-mais-alto', // maior score de todos (99), mas retorno=false -> sempre por último
  ];
  checar(
    JSON.stringify(ordemIds) === JSON.stringify(ordemEsperada),
    `ordenação incorreta: esperado ${JSON.stringify(ordemEsperada)}, recebido ${JSON.stringify(ordemIds)}`,
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
