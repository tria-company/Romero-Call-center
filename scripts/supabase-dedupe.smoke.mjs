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

import { resolverDedupe, mesclarCamposVazios } from '../src/mastra/dossie.ts';

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

testarMatchNivelIdSupabase();
testarMatchNivelCpf();
testarMatchNivelTelefone();
testarNoMatchSinalizaCriarNovo();
testarChaveVaziaNuncaCasa();
testarPrecedenciaDaCascata();
testarMesclarSoPreencheCampoVazio();
testarMesclarNaoIncluiIdSupabaseQuandoJaPresente();
testarMesclarNuncaMutaEntrada();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
