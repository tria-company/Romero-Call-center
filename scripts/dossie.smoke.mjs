#!/usr/bin/env node
// scripts/dossie.smoke.mjs
//
// Smoke determinístico (sem rede) do montador do Dossiê 360° (DOSS-01,
// Fase 04 Plano 02, D-P4-03/06). Prova, via fixtures, que
// `montarPromptDossie` (src/mastra/dossie.ts) monta as 6 seções do modelo
// do Miro (04-CONTEXT.md §domain), que uma fonte ausente/indisponível gera
// um marcador explícito de degradação NA SEÇÃO correspondente (nunca texto
// inventado), que o histórico RomeroCall (observação consolidada / último
// resultado) entra nas seções 3 e 6 (D-P4-03), e que o `system` blinda
// contra prompt injection (trata conteúdo de fontes como DADO, nunca
// instrução) e proíbe explicitamente inventar conteúdo (D-P4-06).
//
// Uso: node --experimental-strip-types scripts/dossie.smoke.mjs

import { montarPromptDossie, variantesTelefoneBr } from '../src/mastra/dossie.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

const FONTES_COMPLETAS = {
  ghlContato: { nome: 'Fulano de Tal', tags: ['militante', 'zona-sul'] },
  ghlConversas: { resumo: 'Conversa recente sobre agenda de eventos', mensagens: [{ texto: 'Oi, tudo bem?', data: '2026-08-01' }] },
  ghlOportunidades: [{ titulo: 'Chamado suporte', status: 'aberto', data: '2026-07-01' }],
  supabaseMilitante: { zona: '12', secao: '034' },
  supabaseFollowUps: [{ descricao: 'Ligar semana que vem', data: '2026-08-15' }],
  observacaoConsolidada: 'Lead engajado, já confirmou presença em 2 eventos anteriores.',
  ultimoResultado: 'atendeu',
};

// ===== (a) todas as fontes presentes → 6 seções nomeadas =====

function testarSeisSecoesComTodasAsFontes() {
  const { prompt } = montarPromptDossie(FONTES_COMPLETAS);
  checar(prompt.includes('Perfil e classificação'), 'prompt deveria citar a seção 1 (Perfil e classificação)');
  checar(prompt.includes('Síntese'), 'prompt deveria citar a seção 2 (Síntese)');
  checar(prompt.includes('Última interação'), 'prompt deveria citar a seção 3 (Última interação)');
  checar(prompt.includes('Histórico de chamados'), 'prompt deveria citar a seção 4 (Histórico de chamados)');
  checar(prompt.includes('Follow-ups e serviços prestados'), 'prompt deveria citar a seção 5 (Follow-ups e serviços prestados)');
  checar(prompt.includes('Gancho'), 'prompt deveria citar a seção 6 (Gancho / próxima ação)');
}

// ===== (b) fonte ausente/indisponível → marcador de degradação na seção correta =====

function testarDegradacaoQuandoFollowUpsAusente() {
  const fontes = { ...FONTES_COMPLETAS, supabaseFollowUps: null };
  const { prompt } = montarPromptDossie(fontes);
  checar(prompt.includes('sem dados de follow-ups'), 'prompt deveria injetar marcador explícito de degradação para a seção 5 quando supabaseFollowUps é null');
  checar(prompt.toLowerCase().includes('indisponível'), 'marcador de degradação deveria dizer que a fonte está indisponível');
  checar(!prompt.includes('Ligar semana que vem'), 'prompt NÃO deveria conter dado inventado/de outra fixture para a seção sem fonte');
}

function testarDegradacaoQuandoContatoAusente() {
  const fontes = { ...FONTES_COMPLETAS, ghlContato: null };
  const { prompt } = montarPromptDossie(fontes);
  checar(prompt.includes('sem dados de contato'), 'prompt deveria injetar marcador de degradação para a seção 1 quando ghlContato é null');
  checar(!prompt.includes('Fulano de Tal'), 'prompt NÃO deveria conter o nome do fixture anterior quando ghlContato está ausente');
}

// ===== (c) histórico RomeroCall aparece nas seções 3/6 (D-P4-03) =====

function testarHistoricoRomeroCallAparece() {
  const { prompt } = montarPromptDossie(FONTES_COMPLETAS);
  checar(prompt.includes('Lead engajado, já confirmou presença em 2 eventos anteriores.'), 'observacaoConsolidada deveria aparecer no prompt (D-P4-03)');
  checar(prompt.includes('atendeu'), 'ultimoResultado deveria aparecer no prompt (D-P4-03)');
}

function testarSemHistoricoRomeroCallNaoInventa() {
  const fontes = { ...FONTES_COMPLETAS, observacaoConsolidada: null, ultimoResultado: null };
  const { prompt } = montarPromptDossie(fontes);
  checar(!prompt.includes('Lead engajado, já confirmou presença em 2 eventos anteriores.'), 'sem histórico RomeroCall, o prompt não deveria conter observação de outra fixture');
}

// ===== (d) system blinda anti-injeção + proíbe inventar (D-P4-06) =====

function testarSystemAntiInjecaoENaoInventar() {
  const { system } = montarPromptDossie(FONTES_COMPLETAS);
  checar(typeof system === 'string' && system.length > 0, 'montarPromptDossie deveria retornar system não-vazio');
  checar(/dado/i.test(system) && /instru/i.test(system), 'system deveria instruir a tratar conteúdo das fontes como DADO, nunca instrução (anti-injeção)');
  checar(/nunca invente|não invente/i.test(system), 'system deveria proibir explicitamente inventar conteúdo (D-P4-06)');
}

// ===== (e) variantesTelefoneBr — normalização de telefone BR (quick 260811-l7k) =====

function testarVariantesTelefoneBr11Digitos() {
  const variantes = variantesTelefoneBr('11988887777');
  checar(variantes.includes('11988887777'), 'variantes (11 díg) deveria incluir a forma só-dígitos original');
  checar(variantes.includes('5511988887777'), 'variantes (11 díg) deveria incluir a forma com prefixo 55');
}

function testarVariantesTelefoneBr13DigitosComMais() {
  const variantes = variantesTelefoneBr('+5511988887777');
  checar(variantes.includes('5511988887777'), "variantes ('+', 13 díg) deveria incluir a forma com prefixo 55");
  checar(variantes.includes('11988887777'), "variantes ('+', 13 díg) deveria incluir a forma sem prefixo 55");
}

function testarVariantesTelefoneBr15Digitos() {
  const entrada = '123456789012345';
  const variantes = variantesTelefoneBr(entrada);
  checar(variantes.includes(entrada), 'variantes (15 díg) deveria incluir ao menos a forma só-dígitos original');
  checar(variantes.some((v) => v !== entrada), 'variantes (15 díg) deveria incluir ao menos a forma com/sem prefixo 55');
}

function testarVariantesTelefoneBrDedupeSemRepetidas() {
  const variantes = variantesTelefoneBr('5511988887777');
  const unicas = new Set(variantes);
  checar(unicas.size === variantes.length, 'variantesTelefoneBr NÃO deveria conter variantes repetidas (dedupe)');
}

function testarVariantesTelefoneBrEntradaVazia() {
  checar(variantesTelefoneBr('').length === 0, 'variantesTelefoneBr de entrada vazia deveria devolver []');
  checar(variantesTelefoneBr('---').length === 0, 'variantesTelefoneBr de entrada só-símbolos deveria devolver []');
}

// ===== (f) seção 5 — serviços prestados (romero_db_*, quick 260811-l7k) =====

const SERVICO_FIXTURE = {
  tabela: 'romero_db_castracao',
  servico: 'Castração felina',
  status: 'concluído',
  fase: 'finalizada',
  criadoEm: '2026-01-01',
  atualizadoEm: '2026-01-02',
  observacao: '',
  feedback: '',
};

function testarSecaoServicosPrestadosPresente() {
  const fontes = { ...FONTES_COMPLETAS, servicosPrestados: [SERVICO_FIXTURE], tabelasComErro: null };
  const { prompt } = montarPromptDossie(fontes);
  checar(prompt.includes('Follow-ups e serviços prestados'), 'prompt com serviços presentes deveria titular a seção 5 como "Follow-ups e serviços prestados"');
  checar(prompt.includes('Castração felina'), 'prompt com serviços presentes deveria conter o valor de serviço da fixture');
}

function testarSecaoServicosPrestadosVaziaNaoInventa() {
  const fontes = { ...FONTES_COMPLETAS, servicosPrestados: null, tabelasComErro: null };
  const { prompt } = montarPromptDossie(fontes);
  checar(prompt.includes('sem dados de serviços prestados'), 'prompt sem serviços deveria injetar marcador de degradação da seção 5');
  checar(!prompt.includes('Castração felina'), 'prompt sem serviços NÃO deveria conter valor de serviço de outra fixture');
}

function testarTabelasComErroAparecemNoPrompt() {
  const fontes = { ...FONTES_COMPLETAS, servicosPrestados: [SERVICO_FIXTURE], tabelasComErro: [{ tabela: 'romero_db_resgate', erro: 'HTTP 500' }] };
  const { prompt } = montarPromptDossie(fontes);
  checar(prompt.includes('romero_db_resgate'), 'prompt com tabelasComErro deveria citar explicitamente o nome da tabela que falhou (degradação por tabela)');
}

testarSeisSecoesComTodasAsFontes();
testarDegradacaoQuandoFollowUpsAusente();
testarDegradacaoQuandoContatoAusente();
testarHistoricoRomeroCallAparece();
testarSemHistoricoRomeroCallNaoInventa();
testarSystemAntiInjecaoENaoInventar();
testarVariantesTelefoneBr11Digitos();
testarVariantesTelefoneBr13DigitosComMais();
testarVariantesTelefoneBr15Digitos();
testarVariantesTelefoneBrDedupeSemRepetidas();
testarVariantesTelefoneBrEntradaVazia();
testarSecaoServicosPrestadosPresente();
testarSecaoServicosPrestadosVaziaNaoInventa();
testarTabelasComErroAparecemNoPrompt();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
