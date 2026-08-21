#!/usr/bin/env node
// scripts/telefone-canonico.smoke.mjs
//
// Smoke determinístico (sem rede) do módulo compartilhado de normalização de
// telefone da Fase B (src/mastra/telefone-canonico.ts — R4, design §5.3).
// Prova o requisito CENTRAL da inversão de `ligacoes`: as formas de 12 e 13
// dígitos do MESMO número precisam colapsar no MESMO `telefone_canonico`,
// senão a correlação do webhook (19-05) casa a ligação errada ou não casa
// nenhuma. Também prova `variantesTelefone` (conjunto ±9º dígito, usado na
// correlação multi-candidato) e que nenhuma entrada faz as funções lançarem.
//
// LGPD: nunca imprime o telefone completo — só o resultado booleano/mascarado
// de cada caso.
//
// Uso: node --experimental-strip-types scripts/telefone-canonico.smoke.mjs

import { canonizarTelefone, variantesTelefone } from '../src/mastra/telefone-canonico.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ===== (a) 12 e 13 dígitos do MESMO número colapsam no MESMO canônico (R4, teste obrigatório) =====

function testarDozeETrezeDigitosCasam() {
  const com9 = canonizarTelefone('5581987654321'); // 13 díg, DDD 81, com o 9º
  const sem9 = canonizarTelefone('558187654321'); // 12 díg, sem o 9º
  checar(com9 !== null, 'canonizarTelefone(13 díg) não deveria ser null');
  checar(sem9 !== null, 'canonizarTelefone(12 díg) não deveria ser null');
  checar(com9 === sem9, '12 e 13 dígitos do mesmo número deveriam produzir o MESMO telefone_canonico (R4)');
  checar(com9 === '+558187654321', 'telefone_canonico deveria ser E.164 pós-normalização do 9º dígito');
}

// ===== (b) limpa '@'/espaços/'+'/não-dígitos antes de normalizar =====

function testarLimpaFormatacaoAntesDeNormalizar() {
  const doWavoip = canonizarTelefone('558187654321@c.us'); // sufixo do Wavoip
  const doClickup = canonizarTelefone('+55 (81) 8765-4321'); // formatado, com '+'
  const digitosPuros = canonizarTelefone('558187654321');
  checar(doWavoip === digitosPuros, 'sufixo @c.us deveria ser removido antes de normalizar');
  checar(doClickup === digitosPuros, "formatação ('+', espaços, parênteses, hífen) deveria ser removida antes de normalizar");
}

// ===== (c) entrada vazia/não-normalizável -> null, NUNCA lança =====

function testarEntradaVaziaOuInvalidaNuncaLanca() {
  checar(canonizarTelefone('') === null, "canonizarTelefone('') deveria devolver null");
  checar(canonizarTelefone('abc') === null, "canonizarTelefone('abc') (sem dígitos) deveria devolver null");
  checar(canonizarTelefone('123') === null, 'canonizarTelefone(dígitos insuficientes p/ E.164) deveria devolver null');
  let lancou = false;
  try {
    canonizarTelefone(undefined);
  } catch {
    lancou = true;
  }
  checar(!lancou, 'canonizarTelefone(undefined) NUNCA deveria lançar');
}

// ===== (d) determinismo — mesma entrada, mesma saída sempre =====

function testarDeterminismo() {
  const a1 = canonizarTelefone('5581987654321');
  const a2 = canonizarTelefone('5581987654321');
  checar(a1 === a2, 'canonizarTelefone deveria ser determinístico (mesma entrada -> mesma saída)');
  const v1 = JSON.stringify([...variantesTelefone('558187654321')].sort());
  const v2 = JSON.stringify([...variantesTelefone('558187654321')].sort());
  checar(v1 === v2, 'variantesTelefone deveria ser determinístico (mesmo conjunto sempre)');
}

// ===== (e) variantesTelefone — conjunto ±9º dígito (correlação multi-candidato, §5.3) =====

function testarVariantesIncluiFormaComESemNono() {
  const variantes = variantesTelefone('558187654321'); // 12 díg, sem o 9º
  checar(Array.isArray(variantes), 'variantesTelefone deveria devolver um array');
  checar(variantes.includes('+558187654321'), 'variantes deveria incluir a forma SEM o 9º dígito');
  checar(variantes.includes('+5581987654321'), 'variantes deveria incluir a forma COM o 9º dígito (±9, correlação multi-candidato)');
}

function testarVariantesComTrezeDigitosIncluiFormaSemNono() {
  const variantes = variantesTelefone('5581987654321'); // 13 díg, com o 9º
  checar(variantes.includes('+5581987654321'), 'variantes (13 díg) deveria incluir a forma original (COM o 9º)');
  checar(variantes.includes('+558187654321'), 'variantes (13 díg) deveria incluir a forma SEM o 9º dígito');
}

function testarVariantesEntradaVaziaNuncaLanca() {
  let lancou = false;
  let resultado;
  try {
    resultado = variantesTelefone('');
  } catch {
    lancou = true;
  }
  checar(!lancou, 'variantesTelefone("") NUNCA deveria lançar');
  checar(Array.isArray(resultado) && resultado.length === 0, 'variantesTelefone("") deveria devolver []');
}

testarDozeETrezeDigitosCasam();
testarLimpaFormatacaoAntesDeNormalizar();
testarEntradaVaziaOuInvalidaNuncaLanca();
testarDeterminismo();
testarVariantesIncluiFormaComESemNono();
testarVariantesComTrezeDigitosIncluiFormaSemNono();
testarVariantesEntradaVaziaNuncaLanca();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
