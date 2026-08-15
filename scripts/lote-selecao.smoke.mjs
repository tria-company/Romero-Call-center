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

import {
  parseLeadDaTask,
  selecionarLoteElegivel,
  filtrarLeadsPorTelefones,
  filtrarTasksPorTag,
  selecionarPorQuantidade,
  distribuirRoundRobin,
} from '../src/mastra/lote.ts';

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

// ===== Novos helpers de seleção explícita + round-robin (D4/D6, Quick 260815-hea) =====

function testarFiltrarLeadsPorTelefones() {
  const leadSemDDI = leadFixture({ taskId: 'sem-ddi', telefone: '11999999999' });
  const leadComDDI = leadFixture({ taskId: 'com-ddi', telefone: '5511988887777' });
  const leads = [leadSemDDI, leadComDDI];

  // '11900000000' não casa com nenhum lead -> ignorado (ordem de entrada preservada).
  // '11999999999' casa direto com leadSemDDI.
  // '11988887777' casa com leadComDDI SÓ por tolerância ao DDI 55 líder.
  const telefonesColados = ['11900000000', '11999999999', '11988887777'];
  const resultado = filtrarLeadsPorTelefones(leads, telefonesColados);
  const ids = resultado.map((l) => l.taskId);
  checar(
    JSON.stringify(ids) === JSON.stringify(['sem-ddi', 'com-ddi']),
    `filtrarLeadsPorTelefones: esperado ['sem-ddi','com-ddi'], recebido ${JSON.stringify(ids)}`,
  );
}

function testarFiltrarTasksPorTag() {
  const taskComTagCaseDiferente = { id: 'task-1', tags: [{ name: 'Lote-Hoje' }] };
  const taskComOutraTag = { id: 'task-2', tags: [{ name: 'outro' }] };
  const taskSemTag = { id: 'task-3', tags: [] };
  const taskComVariasTags = { id: 'task-4', tags: [{ name: 'lote-hoje' }, { name: 'vip' }] };
  const tasks = [taskComTagCaseDiferente, taskComOutraTag, taskSemTag, taskComVariasTags];

  const resultado = filtrarTasksPorTag(tasks, 'lote-hoje');
  const ids = resultado.map((t) => t.id);
  checar(
    JSON.stringify(ids) === JSON.stringify(['task-1', 'task-4']),
    `filtrarTasksPorTag: esperado ['task-1','task-4'], recebido ${JSON.stringify(ids)}`,
  );
}

const ID_LEAD_LIGACOES_FIXTURE = 'field-id-lead-ligacoes';

const leadQ1 = leadFixture({ taskId: 'q1', idLead: 'lead-q1' });
const leadQ2 = leadFixture({ taskId: 'q2', idLead: 'lead-q2' }); // já tem Ligação aberta -> pulado
const leadQ3 = leadFixture({ taskId: 'q3', idLead: 'lead-q3' });
const leadQ4 = leadFixture({ taskId: 'q4', idLead: 'lead-q4' });
const leadQ5 = leadFixture({ taskId: 'q5', idLead: 'lead-q5' });

function testarSelecionarPorQuantidade() {
  const ligacoesAbertas = [
    { id: 'lig-q2', custom_fields: [{ id: ID_LEAD_LIGACOES_FIXTURE, value: 'lead-q2' }] },
  ];
  const resultado = selecionarPorQuantidade(
    [leadQ1, leadQ2, leadQ3, leadQ4, leadQ5],
    3,
    ligacoesAbertas,
    ID_LEAD_LIGACOES_FIXTURE,
  );
  const ids = resultado.map((l) => l.taskId);
  checar(
    JSON.stringify(ids) === JSON.stringify(['q1', 'q3', 'q4']),
    `selecionarPorQuantidade: esperado ['q1','q3','q4'] (q2 pulado por dedupe), recebido ${JSON.stringify(ids)}`,
  );
}

function testarDistribuirRoundRobin() {
  // 5 leads, 2 operadores -> ciclagem [op0, op1, op0, op1, op0] na ordem de entrada.
  const leadsCinco = [leadQ1, leadQ2, leadQ3, leadQ4, leadQ5];
  const pares = distribuirRoundRobin(leadsCinco, ['op0', 'op1']);
  const operadoresAtribuidos = pares.map((p) => p.operador);
  checar(
    JSON.stringify(operadoresAtribuidos) === JSON.stringify(['op0', 'op1', 'op0', 'op1', 'op0']),
    `distribuirRoundRobin (5 leads/2 operadores): esperado ['op0','op1','op0','op1','op0'], recebido ${JSON.stringify(operadoresAtribuidos)}`,
  );
  checar(
    pares.every((p, i) => p.lead.taskId === leadsCinco[i].taskId),
    'distribuirRoundRobin: ordem dos leads deveria ser preservada',
  );

  // Caso identidade: N leads, N operadores -> lead[i] <-> operadores[i].
  const leadsDois = [leadQ1, leadQ2];
  const paresIdentidade = distribuirRoundRobin(leadsDois, ['opA', 'opB']);
  const operadoresIdentidade = paresIdentidade.map((p) => p.operador);
  checar(
    JSON.stringify(operadoresIdentidade) === JSON.stringify(['opA', 'opB']),
    `distribuirRoundRobin (caso identidade): esperado ['opA','opB'], recebido ${JSON.stringify(operadoresIdentidade)}`,
  );

  // Lista de operadores vazia -> LANÇA (defensivo, D6).
  let lancou = false;
  try {
    distribuirRoundRobin(leadsDois, []);
  } catch {
    lancou = true;
  }
  checar(lancou, 'distribuirRoundRobin: deveria LANÇAR com lista de operadores vazia');
}

testarExclusaoPorData();
testarExclusaoPorTentativas();
testarOrdenacao();
testarCorteTamanho();
testarParseLeadDaTask();
testarFiltrarLeadsPorTelefones();
testarFiltrarTasksPorTag();
testarSelecionarPorQuantidade();
testarDistribuirRoundRobin();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
