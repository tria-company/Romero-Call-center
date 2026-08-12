#!/usr/bin/env node
// scripts/rotular-papeis.smoke.mjs
//
// Smoke determinístico (sem rede) de `rotularPapeis` (src/mastra/deepgram.ts)
// — pós-processamento dos rótulos "Falante N" de um transcript diarizado em
// papéis "Atendente"/"Lead" via keyword-score (sem LLM). Textos sintéticos
// SEM PII (quick-260812-ilt).
//
// Uso: node --experimental-strip-types scripts/rotular-papeis.smoke.mjs

import { rotularPapeis } from '../src/mastra/deepgram.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// (a) 2 falantes, Falante 0 abre com o script do gabinete → Falante 0 vira
// Atendente, Falante 1 vira Lead, textos preservados.
function testarAtendenteFalante0() {
  const transcript = [
    'Falante 0: Olá, aqui é do gabinete do deputado Romero Albuquerque',
    'Falante 1: Oi, tudo bem?',
  ].join('\n');
  const out = rotularPapeis(transcript);
  checar(
    out === [
      'Atendente: Olá, aqui é do gabinete do deputado Romero Albuquerque',
      'Lead: Oi, tudo bem?',
    ].join('\n'),
    `(a) saída inesperada: ${JSON.stringify(out)}`,
  );
}

// (b) mesma abertura dita pelo Falante 1 → Falante 1 vira Atendente (o score
// decide, não a ordem/numeração).
function testarAtendenteFalante1() {
  const transcript = [
    'Falante 0: Oi, tudo bem?',
    'Falante 1: Olá, aqui é do gabinete do deputado Romero Albuquerque',
  ].join('\n');
  const out = rotularPapeis(transcript);
  checar(
    out === [
      'Lead: Oi, tudo bem?',
      'Atendente: Olá, aqui é do gabinete do deputado Romero Albuquerque',
    ].join('\n'),
    `(b) saída inesperada: ${JSON.stringify(out)}`,
  );
}

// (c) 1 falante só → inalterado.
function testarUmFalanteInalterado() {
  const transcript = 'Falante 0: Olá, aqui é do gabinete do deputado Romero Albuquerque';
  const out = rotularPapeis(transcript);
  checar(out === transcript, `(c) deveria devolver o transcript inalterado: ${JSON.stringify(out)}`);
}

// (d) 2 falantes sem nenhuma keyword → inalterado (maior score === 0).
function testarSemKeywordInalterado() {
  const transcript = [
    'Falante 0: Oi, tudo bem?',
    'Falante 1: Tudo certo, e você?',
  ].join('\n');
  const out = rotularPapeis(transcript);
  checar(out === transcript, `(d) deveria devolver o transcript inalterado: ${JSON.stringify(out)}`);
}

// (e) empate de score no topo → inalterado.
function testarEmpateInalterado() {
  const transcript = [
    'Falante 0: aqui fala do gabinete',
    'Falante 1: aqui fala do gabinete',
  ].join('\n');
  const out = rotularPapeis(transcript);
  checar(out === transcript, `(e) deveria devolver o transcript inalterado (empate): ${JSON.stringify(out)}`);
}

// (f) 3 falantes com vencedor claro → Atendente + Lead 1 + Lead 2 na ordem
// de aparição (não pela numeração do Falante N).
function testarTresFalantes() {
  const transcript = [
    'Falante 2: Oi, bom dia.',
    'Falante 0: Olá, aqui é do gabinete do deputado Romero Albuquerque.',
    'Falante 1: Boa tarde.',
    'Falante 2: Tudo bem por aqui.',
  ].join('\n');
  const out = rotularPapeis(transcript);
  checar(
    out === [
      'Lead 1: Oi, bom dia.',
      'Atendente: Olá, aqui é do gabinete do deputado Romero Albuquerque.',
      'Lead 2: Boa tarde.',
      'Lead 1: Tudo bem por aqui.',
    ].join('\n'),
    `(f) saída inesperada: ${JSON.stringify(out)}`,
  );
}

// (g) transcript plano sem prefixo "Falante N:" → inalterado.
function testarSemPrefixoInalterado() {
  const transcript = 'Olá, aqui é do gabinete do deputado Romero Albuquerque, sem prefixo de falante.';
  const out = rotularPapeis(transcript);
  checar(out === transcript, `(g) deveria devolver o transcript inalterado (sem prefixo): ${JSON.stringify(out)}`);
}

// (h) acentos/caixa: GABINETE/gabinète contam no score (normalização
// case + acento-insensitive funciona).
function testarNormalizacaoAcentoCaixa() {
  const transcript = [
    'Falante 0: AQUI É DO GABINETE DO DEPUTADO ROMERO ALBUQUERQUE',
    'Falante 1: só um teste sem keyword',
  ].join('\n');
  const out = rotularPapeis(transcript);
  checar(
    out === [
      'Atendente: AQUI É DO GABINETE DO DEPUTADO ROMERO ALBUQUERQUE',
      'Lead: só um teste sem keyword',
    ].join('\n'),
    `(h-maiuscula) saída inesperada: ${JSON.stringify(out)}`,
  );

  const transcriptAcento = [
    'Falante 0: aqui e do gabinète do deputado romero albuquerque',
    'Falante 1: nada relevante aqui',
  ].join('\n');
  const outAcento = rotularPapeis(transcriptAcento);
  checar(
    outAcento === [
      'Atendente: aqui e do gabinète do deputado romero albuquerque',
      'Lead: nada relevante aqui',
    ].join('\n'),
    `(h-acento) saída inesperada: ${JSON.stringify(outAcento)}`,
  );
}

testarAtendenteFalante0();
testarAtendenteFalante1();
testarUmFalanteInalterado();
testarSemKeywordInalterado();
testarEmpateInalterado();
testarTresFalantes();
testarSemPrefixoInalterado();
testarNormalizacaoAcentoCaixa();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
