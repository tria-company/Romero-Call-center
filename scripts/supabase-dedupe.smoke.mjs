#!/usr/bin/env node
// scripts/supabase-dedupe.smoke.mjs
//
// Smoke determinístico (sem rede) da cascata de dedupe e da mesclagem
// não-destrutiva (DOSS-02, Fase 04 Plano 02, D-P4-08/09). Prova, via
// fixtures, que `resolverDedupe` (src/mastra/dossie.ts) casa um registro
// Supabase contra os leads existentes na cascata ID_SUPABASE -> CPF
// normalizado -> telefone normalizado (respeitando a ORDEM da cascata), e
// que `mesclarCamposVazios` só preenche campos vazios do lead — NUNCA
// sobrescreve um campo já preenchido (ClickUp é a fonte da verdade).
//
// Uso: node --experimental-strip-types scripts/supabase-dedupe.smoke.mjs

import { resolverDedupe, mesclarCamposVazios, planejarIngestao } from '../src/mastra/dossie.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

const ID_SUPABASE_FIELD = 'campo-id-supabase';

function leadFixture(overrides = {}) {
  return {
    taskId: 'task-1',
    idSupabase: '',
    cpf: '',
    telefone: '',
    campos: {},
    ...overrides,
  };
}

// ===== resolverDedupe — match por nível =====

function testarMatchNivelIdSupabase() {
  const leadA = leadFixture({ taskId: 'task-A', idSupabase: 'sb-100', cpf: '', telefone: '11999990000' });
  const leadB = leadFixture({ taskId: 'task-B', idSupabase: 'sb-999', cpf: '', telefone: '11888880000' });
  const resultado = resolverDedupe({ idSupabase: 'sb-100', cpf: '999.999.999-99', telefone: '11777770000' }, [leadA, leadB]);
  checar(resultado.nivel === 'id_supabase', `nível deveria ser id_supabase, recebido ${resultado.nivel}`);
  checar(resultado.match?.taskId === 'task-A', 'match deveria ser o lead com ID_SUPABASE igual, mesmo com CPF/telefone diferentes');
}

function testarMatchNivelCpf() {
  const leadA = leadFixture({ taskId: 'task-A', idSupabase: 'sb-100', cpf: '12345678900', telefone: '11999990000' });
  const leadB = leadFixture({ taskId: 'task-B', idSupabase: '', cpf: '98765432100', telefone: '11888880000' });
  const resultado = resolverDedupe({ idSupabase: '', cpf: '987.654.321-00', telefone: '11777770000' }, [leadA, leadB]);
  checar(resultado.nivel === 'cpf', `nível deveria ser cpf, recebido ${resultado.nivel}`);
  checar(resultado.match?.taskId === 'task-B', 'match deveria ser o lead com CPF normalizado igual (sem overlap de ID_SUPABASE)');
}

function testarMatchNivelTelefone() {
  const leadA = leadFixture({ taskId: 'task-A', idSupabase: 'sb-100', cpf: '12345678900', telefone: '11999990000' });
  const leadB = leadFixture({ taskId: 'task-B', idSupabase: '', cpf: '', telefone: '(11) 98888-0000' });
  const resultado = resolverDedupe({ idSupabase: '', cpf: '', telefone: '11988880000' }, [leadA, leadB]);
  checar(resultado.nivel === 'telefone', `nível deveria ser telefone, recebido ${resultado.nivel}`);
  checar(resultado.match?.taskId === 'task-B', 'match deveria ser o lead com telefone normalizado igual (sem overlap de ID_SUPABASE/CPF)');
}

function testarNoMatchSinalizaCriarNovo() {
  const leadA = leadFixture({ taskId: 'task-A', idSupabase: 'sb-100', cpf: '12345678900', telefone: '11999990000' });
  const resultado = resolverDedupe({ idSupabase: 'sb-outro', cpf: '00011122233', telefone: '11700000000' }, [leadA]);
  checar(resultado.match === null, 'sem match em nenhum nível deveria retornar match null');
  checar(resultado.nivel === null, 'sem match em nenhum nível deveria retornar nivel null (sinaliza criar novo)');
}

function testarChaveVaziaNuncaCasa() {
  // Lead existente com CPF/telefone vazios NÃO deveria "casar" com um registro que também não tem chave vazia comparável.
  const leadVazio = leadFixture({ taskId: 'task-vazio', idSupabase: '', cpf: '', telefone: '' });
  const resultado = resolverDedupe({ idSupabase: '', cpf: '', telefone: '' }, [leadVazio]);
  checar(resultado.match === null, 'chave vazia (registro) nunca deveria casar, mesmo contra lead com campos vazios');
  checar(resultado.nivel === null, 'chave vazia (registro) nunca deveria produzir um nível de match');
}

function testarPrecedenciaDaCascata() {
  // ID_SUPABASE casa com o lead A; telefone casaria com o lead B (se a cascata não parasse em A) — A deve vencer.
  const leadA = leadFixture({ taskId: 'task-A', idSupabase: 'sb-100', cpf: '', telefone: '11999990000' });
  const leadB = leadFixture({ taskId: 'task-B', idSupabase: '', cpf: '', telefone: '11555550000' });
  const resultado = resolverDedupe({ idSupabase: 'sb-100', cpf: '', telefone: '11555550000' }, [leadA, leadB]);
  checar(resultado.nivel === 'id_supabase', `a cascata deveria parar em id_supabase, recebido ${resultado.nivel}`);
  checar(resultado.match?.taskId === 'task-A', 'ID_SUPABASE deveria vencer sobre um match de telefone em outro lead (ordem da cascata)');
}

// ===== mesclarCamposVazios =====

function testarMesclarSoPreencheCampoVazio() {
  const leadExistente = leadFixture({
    taskId: 'task-A',
    idSupabase: '',
    campos: {
      NOME: 'Fulano de Tal',
      CEP: '',
    },
  });
  const patchCandidato = {
    NOME: 'Fulano de Tal (Supabase)',
    CEP: '01310-000',
    [ID_SUPABASE_FIELD]: 'sb-100',
  };
  const patch = mesclarCamposVazios(leadExistente, patchCandidato, ID_SUPABASE_FIELD);

  checar(patch.CEP === '01310-000', 'patch deveria conter CEP (estava vazio no lead existente)');
  checar(patch[ID_SUPABASE_FIELD] === 'sb-100', 'patch deveria conter ID_SUPABASE quando o lead ainda não tem um');
  checar(patch.NOME === undefined, 'patch NÃO deveria conter NOME — já estava preenchido no lead (D-P4-09)');
}

function testarMesclarNaoIncluiIdSupabaseQuandoJaPresente() {
  const leadExistente = leadFixture({
    taskId: 'task-A',
    idSupabase: 'sb-existente',
    campos: { NOME: '', CEP: '' },
  });
  const patchCandidato = { NOME: 'Nome Novo', [ID_SUPABASE_FIELD]: 'sb-outro-id' };
  const patch = mesclarCamposVazios(leadExistente, patchCandidato, ID_SUPABASE_FIELD);

  checar(patch.NOME === 'Nome Novo', 'patch deveria preencher NOME vazio normalmente');
  checar(patch[ID_SUPABASE_FIELD] === undefined, 'patch NÃO deveria sobrescrever ID_SUPABASE já gravado no lead');
}

function testarMesclarNuncaMutaEntrada() {
  const leadExistente = leadFixture({ taskId: 'task-A', idSupabase: '', campos: { NOME: '', CEP: '' } });
  const campanhaOriginal = JSON.stringify(leadExistente);
  mesclarCamposVazios(leadExistente, { NOME: 'X', [ID_SUPABASE_FIELD]: 'sb-1' }, ID_SUPABASE_FIELD);
  checar(JSON.stringify(leadExistente) === campanhaOriginal, 'mesclarCamposVazios NUNCA deveria mutar leadExistente');
}

// ===== planejarIngestao — dedupe incremental (coleção viva) — fecha CR-03 =====
// (04-06-PLAN.md Task 2: Test A-D)

function registroFixture(overrides = {}) {
  return {
    idSupabase: '',
    cpf: '',
    telefone: '',
    nome: '',
    patchCandidato: {},
    ...overrides,
  };
}

function testarPlanejarIngestaoDuasPessoaIguaisMesmaRodadaSemLeadExistente() {
  // Test A: 2 registros da mesma pessoa (mesmo CPF, ids diferentes), sem lead existente
  // -> EXATAMENTE 1 ação 'criar' e 1 ação que casa (aponta para o ref recém-criado).
  const regX = registroFixture({ cpf: '11122233344', patchCandidato: { NOME: 'Fulano' } });
  const regX2 = registroFixture({ cpf: '111.222.333-44', patchCandidato: { CEP: '01310-000' } });
  const plano = planejarIngestao([regX, regX2], [], ID_SUPABASE_FIELD);

  const criar = plano.filter((a) => a.acao === 'criar');
  checar(criar.length === 1, `planejarIngestao (Test A): deveria ter exatamente 1 ação 'criar', recebido ${criar.length}`);

  const segundaAcao = plano[1];
  checar(
    segundaAcao.acao !== 'criar',
    `planejarIngestao (Test A): o 2º registro (mesma pessoa) NÃO deveria criar um 2º lead, recebido acao='${segundaAcao.acao}'`,
  );
  checar(
    segundaAcao.alvoRefNovo === criar[0].refNovo,
    `planejarIngestao (Test A): o 2º registro deveria apontar via alvoRefNovo para o ref do 1º ('${criar[0].refNovo}'), recebido '${segundaAcao.alvoRefNovo}'`,
  );
}

function testarPlanejarIngestaoNaoSobrescreveNaMesmaRodada() {
  // Test B (D-P4-09 intra-run): 2 registros casam o MESMO lead existente; o registro 1 preenche
  // um campo vazio (CEP), o registro 2 traz outro valor pro MESMO campo -> o patch do registro 2
  // NÃO inclui esse campo (já foi preenchido pelo registro 1 na coleção viva).
  const leadExistente = { taskId: 'task-existente-1', idSupabase: 'sb-1', cpf: '11122233344', telefone: '', campos: { CEP: '' } };
  const reg1 = registroFixture({ cpf: '11122233344', patchCandidato: { CEP: '01310-000' } });
  const reg2 = registroFixture({ cpf: '11122233344', patchCandidato: { CEP: '99999-999' } });
  const plano = planejarIngestao([reg1, reg2], [leadExistente], ID_SUPABASE_FIELD);

  checar(plano[0].acao === 'mesclar' && plano[0].patch.CEP === '01310-000', 'planejarIngestao (Test B): o 1º registro deveria mesclar CEP=01310-000');
  const acao2 = plano[1];
  checar(
    acao2.acao === 'sem-alteracao' || acao2.patch?.CEP === undefined,
    `planejarIngestao (Test B): o patch do 2º registro NÃO deveria incluir CEP (já preenchido pelo 1º na coleção viva) — recebido acao='${acao2.acao}', patch=${JSON.stringify(acao2.patch)}`,
  );
}

function testarPlanejarIngestaoPureza() {
  // Test C: NÃO muta o array leadsExistentes de entrada nem os objetos dentro dele.
  const leadsExistentes = [{ taskId: 'task-1', idSupabase: 'sb-1', cpf: '11122233344', telefone: '', campos: { NOME: '' } }];
  const antes = JSON.stringify(leadsExistentes);
  const registros = [registroFixture({ cpf: '11122233344', patchCandidato: { NOME: 'Novo Nome' } })];
  planejarIngestao(registros, leadsExistentes, ID_SUPABASE_FIELD);
  checar(JSON.stringify(leadsExistentes) === antes, 'planejarIngestao (Test C): NÃO deveria mutar leadsExistentes nem os objetos dentro dele');
}

function testarPlanejarIngestaoMatchContraLeadExistenteReal() {
  // Test D: registro que casa um lead existente por CPF -> ação com alvoTaskId (não alvoRefNovo) e nível 'cpf'.
  const leadExistente = { taskId: 'task-real-1', idSupabase: '', cpf: '55566677788', telefone: '', campos: { NOME: '' } };
  const registro = registroFixture({ cpf: '55566677788', patchCandidato: { NOME: 'Ciclano' } });
  const plano = planejarIngestao([registro], [leadExistente], ID_SUPABASE_FIELD);

  checar(plano[0].acao === 'mesclar', `planejarIngestao (Test D): deveria mesclar, recebido acao='${plano[0].acao}'`);
  checar(plano[0].alvoTaskId === 'task-real-1', `planejarIngestao (Test D): alvoTaskId deveria ser 'task-real-1', recebido '${plano[0].alvoTaskId}'`);
  checar(plano[0].alvoRefNovo === undefined, 'planejarIngestao (Test D): alvoRefNovo NÃO deveria estar presente (é um lead existente real)');
  checar(plano[0].nivel === 'cpf', `planejarIngestao (Test D): nível deveria ser 'cpf', recebido '${plano[0].nivel}'`);
}

testarMatchNivelIdSupabase();
testarMatchNivelCpf();
testarMatchNivelTelefone();
testarNoMatchSinalizaCriarNovo();
testarChaveVaziaNuncaCasa();
testarPrecedenciaDaCascata();
testarMesclarSoPreencheCampoVazio();
testarMesclarNaoIncluiIdSupabaseQuandoJaPresente();
testarMesclarNuncaMutaEntrada();
testarPlanejarIngestaoDuasPessoaIguaisMesmaRodadaSemLeadExistente();
testarPlanejarIngestaoNaoSobrescreveNaMesmaRodada();
testarPlanejarIngestaoPureza();
testarPlanejarIngestaoMatchContraLeadExistenteReal();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
