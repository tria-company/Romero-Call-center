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

import { montarPromptScript, montarTaskLigacao, deveCriar, chaveDedupeLigacao } from '../src/mastra/lote.ts';

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

// ===== chaveDedupeLigacao / dedupe do lead Supabase (idLead vazio) — fecha CR-01 =====
// (04-06-PLAN.md Task 1: Test A-E)

function testarMontarTaskLigacaoLeadSupabase() {
  // Test A: lead Supabase (idLead vazio) -> ID_LEAD grava o taskId (fallback), nunca vazio.
  const leadSupabase = leadFixture({ taskId: 'lista01-A', idLead: '' });
  const payload = montarTaskLigacao(leadSupabase, 'roteiro...', '88123456', CAMPOS_LIGACOES_FIXTURE);
  const campoIdLead = payload.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES_FIXTURE.ID_LEAD);
  checar(
    campoIdLead?.value === 'lista01-A',
    `montarTaskLigacao (lead Supabase): ID_LEAD deveria usar o taskId como fallback ('lista01-A'), recebido ${JSON.stringify(campoIdLead)}`,
  );
  checar(campoIdLead?.value !== '', 'montarTaskLigacao (lead Supabase): ID_LEAD NUNCA deveria ficar vazio');
}

function testarMontarTaskLigacaoLeadGhlRetrocompativel() {
  // Test B: lead GHL (idLead presente) -> ID_LEAD continua usando o idLead (retrocompatível).
  const leadGhl = leadFixture({ taskId: 'lista01-C', idLead: 'ghl-1' });
  const payload = montarTaskLigacao(leadGhl, 'roteiro...', '88123456', CAMPOS_LIGACOES_FIXTURE);
  const campoIdLead = payload.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES_FIXTURE.ID_LEAD);
  checar(
    campoIdLead?.value === 'ghl-1',
    `montarTaskLigacao (lead GHL): ID_LEAD deveria continuar usando idLead ('ghl-1'), recebido ${JSON.stringify(campoIdLead)}`,
  );
}

function testarDeveCriarIdempotenteLeadSupabaseRerun() {
  // Test C: lead Supabase com Ligação aberta já vinculada ao próprio taskId -> pula (idempotente na 2a rodada).
  const leadSupabase = leadFixture({ taskId: 'lista01-A', idLead: '' });
  const ligacaoAberta = {
    id: 'ligacao-1',
    custom_fields: [{ id: CAMPOS_LIGACOES_FIXTURE.ID_LEAD, value: 'lista01-A' }],
  };
  checar(
    deveCriar(leadSupabase, [ligacaoAberta], CAMPOS_LIGACOES_FIXTURE.ID_LEAD) === false,
    'deveCriar (lead Supabase, rerun): deveria retornar false quando já há Ligação aberta vinculada ao taskId do lead',
  );
}

function testarDeveCriarSemStarvationCruzada() {
  // Test D: lead Supabase B não deveria ser bloqueado por Ligação aberta de outro lead Supabase (A) -- sem starvation cruzada.
  const leadSupabaseB = leadFixture({ taskId: 'lista01-B', idLead: '' });
  const ligacaoAbertaDeA = {
    id: 'ligacao-A',
    custom_fields: [{ id: CAMPOS_LIGACOES_FIXTURE.ID_LEAD, value: 'lista01-A' }],
  };
  checar(
    deveCriar(leadSupabaseB, [ligacaoAbertaDeA], CAMPOS_LIGACOES_FIXTURE.ID_LEAD) === true,
    'deveCriar (lead Supabase B): NÃO deveria starvar por causa da Ligação aberta de outro lead Supabase (A) -- chave é o próprio taskId de B',
  );
}

function testarDeveCriarLigacaoComValueVazioNuncaCasa() {
  // Test E: Ligação aberta com ID_LEAD value:'' nunca deveria casar com um lead Supabase (chave do lead é o taskId, nunca '').
  const leadSupabase = leadFixture({ taskId: 'lista01-D', idLead: '' });
  const ligacaoComValueVazio = {
    id: 'ligacao-vazia',
    custom_fields: [{ id: CAMPOS_LIGACOES_FIXTURE.ID_LEAD, value: '' }],
  };
  checar(
    deveCriar(leadSupabase, [ligacaoComValueVazio], CAMPOS_LIGACOES_FIXTURE.ID_LEAD) === true,
    "deveCriar: uma Ligação com ID_LEAD value:'' nunca deveria casar com um lead Supabase (a chave do lead é o taskId, não '')",
  );
}

function testarChaveDedupeLigacaoExportada() {
  checar(
    chaveDedupeLigacao(leadFixture({ taskId: 'lista01-A', idLead: '' })) === 'lista01-A',
    'chaveDedupeLigacao: deveria retornar o taskId quando idLead está vazio',
  );
  checar(
    chaveDedupeLigacao(leadFixture({ taskId: 'lista01-A', idLead: 'ghl-9' })) === 'ghl-9',
    'chaveDedupeLigacao: deveria retornar idLead quando presente (retrocompatível)',
  );
}

testarMontarPromptScript();
testarMontarTaskLigacao();
testarDeveCriar();
testarMontarTaskLigacaoLeadSupabase();
testarMontarTaskLigacaoLeadGhlRetrocompativel();
testarDeveCriarIdempotenteLeadSupabaseRerun();
testarDeveCriarSemStarvationCruzada();
testarDeveCriarLigacaoComValueVazioNuncaCasa();
testarChaveDedupeLigacaoExportada();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
