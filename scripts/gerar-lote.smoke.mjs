#!/usr/bin/env node
// scripts/gerar-lote.smoke.mjs
//
// Smoke determinístico (sem rede) do gerador de tasks do lote diário (LOTE-02/03,
// Fase 02 Plano 02). Prova, via fixtures, que:
// - `montarPromptScript` monta um prompt estruturado nas 5 seções fixas
//   (abertura -> contexto -> objetivo -> objeções -> fechamento), PT-BR, tom
//   cordial/consultivo (D-P2-05).
// - `montarTaskLigacao` produz o payload de `criarTask` com name/description/
//   assignees/custom_fields corretos (D-P2-06), field-ids injetados (D-07).
// - `deveCriar` implementa o dedupe idempotente (D-P2-03): pula lead que já
//   tem Ligação ABERTA referenciando-o.
//
// Uso: node --experimental-strip-types scripts/gerar-lote.smoke.mjs

import { montarPromptScript, montarTaskLigacao, deveCriar } from '../src/mastra/lote.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function leadFixture(overrides) {
  return {
    taskId: 'task-lead-1',
    idLead: 'ghl-lead-1',
    nome: 'Maria Souza',
    telefone: '11988887777',
    score: 80,
    tentativas: 1,
    proximoContato: new Date('2026-08-09T12:00:00Z'),
    retornoNecessario: true,
    ...overrides,
  };
}

// Field-ids de exemplo (fixture) — injetados como argumento (D-07), não
// importados de clickup.ts, para provar que lote.ts continua puro/genérico.
const CAMPOS_LIGACOES_FIXTURE = {
  ID_LEAD: 'field-id-lead-ligacoes',
  TELEFONE: 'field-telefone-ligacoes',
};

function testarMontarPromptScript() {
  const lead = leadFixture();
  const { system, prompt } = montarPromptScript(lead);

  checar(typeof system === 'string' && system.length > 0, 'montarPromptScript: system deveria ser uma string não vazia');
  checar(typeof prompt === 'string' && prompt.length > 0, 'montarPromptScript: prompt deveria ser uma string não vazia');
  checar(/português|pt-br/i.test(system), 'montarPromptScript: system deveria fixar o tom PT-BR da campanha');
  checar(/cordial/i.test(system) && /consultiv/i.test(system), 'montarPromptScript: system deveria fixar tom cordial/consultivo');
  checar(/romerocall/i.test(system) || /romerocall/i.test(prompt), 'montarPromptScript: deveria mencionar a campanha RomeroCall');

  const secoes = ['abertura', 'contexto', 'objetivo', 'objeç', 'fechamento'];
  for (const secao of secoes) {
    checar(new RegExp(secao, 'i').test(prompt), `montarPromptScript: prompt deveria mencionar a seção "${secao}"`);
  }

  checar(prompt.includes(lead.nome), 'montarPromptScript: prompt deveria incluir o nome do lead');
  checar(prompt.includes(lead.telefone), 'montarPromptScript: prompt deveria incluir o telefone do lead');
}

function testarMontarTaskLigacao() {
  const lead = leadFixture();
  const payload = montarTaskLigacao(lead, 'roteiro gerado de teste...', '88123456', CAMPOS_LIGACOES_FIXTURE);

  checar(typeof payload.name === 'string' && payload.name.includes(lead.nome), `montarTaskLigacao: name deveria conter o nome do lead, recebido "${payload.name}"`);
  checar(payload.description === 'roteiro gerado de teste...', `montarTaskLigacao: description incorreta, recebido "${payload.description}"`);
  checar(
    Array.isArray(payload.assignees) && payload.assignees.includes(88123456),
    `montarTaskLigacao: assignees deveria conter 88123456, recebido ${JSON.stringify(payload.assignees)}`,
  );

  const campoIdLead = payload.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES_FIXTURE.ID_LEAD);
  checar(
    campoIdLead?.value === lead.idLead,
    `montarTaskLigacao: custom_fields deveria ter ID_LEAD=${lead.idLead} no field-id ${CAMPOS_LIGACOES_FIXTURE.ID_LEAD}, recebido ${JSON.stringify(campoIdLead)}`,
  );

  const campoTelefone = payload.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES_FIXTURE.TELEFONE);
  checar(
    campoTelefone?.value === lead.telefone,
    `montarTaskLigacao: custom_fields deveria ter TELEFONE=${lead.telefone} no field-id ${CAMPOS_LIGACOES_FIXTURE.TELEFONE}, recebido ${JSON.stringify(campoTelefone)}`,
  );
}

function testarDeveCriar() {
  const lead = leadFixture();

  checar(
    deveCriar(lead, [], CAMPOS_LIGACOES_FIXTURE.ID_LEAD) === true,
    'deveCriar: deveria retornar true quando não há Ligações abertas',
  );

  const ligacaoAbertaComMesmoIdLead = {
    id: 'ligacao-aberta-1',
    custom_fields: [{ id: CAMPOS_LIGACOES_FIXTURE.ID_LEAD, value: lead.idLead }],
  };
  checar(
    deveCriar(lead, [ligacaoAbertaComMesmoIdLead], CAMPOS_LIGACOES_FIXTURE.ID_LEAD) === false,
    'deveCriar: deveria retornar false quando já há Ligação aberta referenciando o lead (dedupe)',
  );

  const ligacaoAbertaOutroLead = {
    id: 'ligacao-aberta-2',
    custom_fields: [{ id: CAMPOS_LIGACOES_FIXTURE.ID_LEAD, value: 'outro-lead-id' }],
  };
  checar(
    deveCriar(lead, [ligacaoAbertaOutroLead], CAMPOS_LIGACOES_FIXTURE.ID_LEAD) === true,
    'deveCriar: deveria retornar true quando a Ligação aberta é de outro lead',
  );
}

testarMontarPromptScript();
testarMontarTaskLigacao();
testarDeveCriar();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
