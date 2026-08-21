#!/usr/bin/env node
// scripts/leituras-ligacoes.smoke.mjs
//
// Smoke determinístico (SEM rede) das 5 leituras de `ligacoes` do Supabase da
// Fase B (19-05, .planning/phases/19-fase-b-inverter-ligacoes-escrita-leitura-
// juntas/19-05-PLAN.md, design §4): buscarFilaSupabase, lerLigacaoSupabase,
// buscarLigacoesDoLeadSupabase, buscarLigacaoAbertaPorTelefoneSupabase,
// resolverLeadDaLigacaoSupabase.
//
// Prova o requisito CENTRAL da correlação do webhook (LEITURA-05, §5.3,
// Riscos R4, teste obrigatório): 12 e 13 dígitos do MESMO número precisam
// produzir o MESMO filtro de correlação (`telefone_canonico.eq.$canon`) —
// senão a gravação vira avulsa órfã ou casa a ligação errada. Como as
// funções de I/O fazem chamadas de rede reais ao Supabase, este smoke prova
// o comportamento por meio da função PURA extraível
// `montarFiltroCorrelacaoTelefone` (mesma normalização de
// telefone-canonico.ts, 19-01) — sem precisar de rede/credenciais.
//
// LGPD: nunca imprime o telefone completo — só o resultado booleano/parcial
// de cada caso.
//
// Uso: node --experimental-strip-types scripts/leituras-ligacoes.smoke.mjs

import {
  buscarFilaSupabase,
  lerLigacaoSupabase,
  buscarLigacoesDoLeadSupabase,
  buscarLigacaoAbertaPorTelefoneSupabase,
  resolverLeadDaLigacaoSupabase,
  montarFiltroCorrelacaoTelefone,
} from '../src/mastra/supabase.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ===== (a) as 5 leituras existem e são funções (contrato do plano 19-05) =====

function testarFuncoesExistem() {
  const funcoes = {
    buscarFilaSupabase,
    lerLigacaoSupabase,
    buscarLigacoesDoLeadSupabase,
    buscarLigacaoAbertaPorTelefoneSupabase,
    resolverLeadDaLigacaoSupabase,
  };
  for (const [nome, fn] of Object.entries(funcoes)) {
    checar(typeof fn === 'function', `${nome} deveria ser exportada como função de src/mastra/supabase.ts`);
  }
}

// ===== (b) 12 e 13 dígitos do MESMO número geram o MESMO filtro de correlação (R4, teste obrigatório) =====

function testarFiltroCorrelacaoDozeETrezeDigitosCasam() {
  checar(typeof montarFiltroCorrelacaoTelefone === 'function', 'montarFiltroCorrelacaoTelefone deveria ser exportada (função pura, testável sem rede)');
  const com13 = montarFiltroCorrelacaoTelefone('5581987654321'); // 13 díg, com o 9º
  const com12 = montarFiltroCorrelacaoTelefone('558187654321'); // 12 díg, sem o 9º
  checar(com13 !== null, 'montarFiltroCorrelacaoTelefone(13 díg) não deveria ser null');
  checar(com12 !== null, 'montarFiltroCorrelacaoTelefone(12 díg) não deveria ser null');
  // O componente telefone_canonico.eq.$canon do filtro precisa ser IDÊNTICO nos
  // dois formatos — é o que garante que a query `OR` do Postgres casa a MESMA
  // ligação aberta independente de o webhook mandar 12 ou 13 dígitos.
  const canonDe = (filtro) => (filtro?.or.match(/telefone_canonico\.eq\.([^,)]+)/) ?? [])[1];
  const canon13 = canonDe(com13);
  const canon12 = canonDe(com12);
  checar(!!canon13 && !!canon12, 'o filtro deveria conter telefone_canonico.eq.<canonico>');
  checar(canon13 === canon12, '12 e 13 dígitos do mesmo número deveriam casar o MESMO telefone_canonico no filtro (R4)');
  checar(canon13 === '+558187654321', 'telefone_canonico no filtro deveria ser E.164 pós-normalização do 9º dígito');
}

// ===== (c) o filtro também cobre telefone_variantes (correlação multi-candidato ±9º) =====

function testarFiltroIncluiVariantesOverlap() {
  const filtro = montarFiltroCorrelacaoTelefone('558187654321'); // 12 díg
  checar(filtro !== null, 'filtro não deveria ser null');
  checar(filtro.or.includes('telefone_variantes.ov.'), 'o filtro deveria usar o operador overlap (ov) sobre telefone_variantes — multi-candidato ±9º dígito');
}

// ===== (d) telefone vazio/não-normalizável nunca lança — devolve null =====

function testarFiltroEntradaVaziaNuncaLanca() {
  let lancou = false;
  let resultado;
  try {
    resultado = montarFiltroCorrelacaoTelefone('');
  } catch {
    lancou = true;
  }
  checar(!lancou, 'montarFiltroCorrelacaoTelefone("") NUNCA deveria lançar');
  checar(resultado === null, 'montarFiltroCorrelacaoTelefone("") deveria devolver null (sem candidato)');
}

testarFuncoesExistem();
testarFiltroCorrelacaoDozeETrezeDigitosCasam();
testarFiltroIncluiVariantesOverlap();
testarFiltroEntradaVaziaNuncaLanca();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
