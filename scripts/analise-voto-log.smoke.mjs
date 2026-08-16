#!/usr/bin/env node
// scripts/analise-voto-log.smoke.mjs
//
// Smoke determinístico (sem rede) do log de voto IA×closer (D1/D2,
// quick-260815-oq4). Prova, via fixtures, que `montarLinhaLogVoto` cobre a
// matriz de status (preencheu/concordam/diverge+evidência/IA-sem-base/
// valor-não-reconhecido), que `montarSecaoLogVoto` compõe a seção corretamente
// (vazio vs. com linhas), e que `parseResultadoAnalise` coage a evidência
// (`votoEvidencia`) defensivamente (string vazia/ausente -> null).
//
// Sem PII real nas fixtures — só textos fabricados. NÃO loga objetos com
// transcrição (LGPD, mesmo racional do processador).
//
// Uso: node --experimental-strip-types scripts/analise-voto-log.smoke.mjs

import { montarLinhaLogVoto, montarSecaoLogVoto, parseResultadoAnalise } from '../src/mastra/analise.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ===== montarLinhaLogVoto — matriz de status =====

function testarPreencheu() {
  const linha = montarLinhaLogVoto({
    candidato: 'Romero',
    ia: 'sim',
    closerDefinido: false,
    closerEscolha: null,
    closerIrressoluvel: false,
    evidencia: null,
  });
  checar(linha.includes('preencheu'), `linha "preencheu" deveria conter "preencheu": ${linha}`);
  checar(linha.includes('não marcou'), `linha "preencheu" deveria conter "não marcou": ${linha}`);
  checar(linha.includes('IA ouviu "Sim"'), `linha "preencheu" deveria conter IA ouviu "Sim": ${linha}`);
}

function testarConcordam() {
  const linha = montarLinhaLogVoto({
    candidato: 'Romero',
    ia: 'sim',
    closerDefinido: true,
    closerEscolha: 'sim',
    closerIrressoluvel: false,
    evidencia: null,
  });
  checar(linha.includes('concordam'), `linha "concordam" deveria conter "concordam": ${linha}`);
  checar(linha.includes('marcou "Sim"'), `linha "concordam" deveria conter marcou "Sim": ${linha}`);
}

function testarDivergeComEvidencia() {
  const linha = montarLinhaLogVoto({
    candidato: 'Andressa',
    ia: 'nao',
    closerDefinido: true,
    closerEscolha: 'sim',
    closerIrressoluvel: false,
    evidencia: 'lead disse que vota no outro',
  });
  checar(linha.includes('diverge'), `linha "diverge" deveria conter "diverge": ${linha}`);
  checar(
    linha.includes('lead disse que vota no outro'),
    `linha "diverge" deveria anexar a evidência: ${linha}`,
  );
}

function testarIaSemBase() {
  const linha = montarLinhaLogVoto({
    candidato: 'Romero',
    ia: null,
    closerDefinido: false,
    closerEscolha: null,
    closerIrressoluvel: false,
    evidencia: null,
  });
  checar(linha.includes('IA não identificou'), `linha "IA sem base" deveria conter "IA não identificou": ${linha}`);
  checar(linha.includes('IA sem base'), `linha "IA sem base" deveria conter status "IA sem base": ${linha}`);
  checar(!linha.includes('diverge'), `linha "IA sem base" NÃO deveria conter "diverge": ${linha}`);
}

function testarValorNaoReconhecido() {
  const linha = montarLinhaLogVoto({
    candidato: 'Andressa',
    ia: 'sim',
    closerDefinido: true,
    closerEscolha: null,
    closerIrressoluvel: true,
    evidencia: null,
  });
  checar(
    linha.includes('valor não reconhecido'),
    `linha "valor não reconhecido" deveria conter "valor não reconhecido": ${linha}`,
  );
  checar(
    !linha.includes('diverge'),
    `linha "valor não reconhecido" NÃO deveria conter "diverge" (anti falso-positivo): ${linha}`,
  );
}

// ===== montarSecaoLogVoto =====

function testarSecaoVazia() {
  checar(montarSecaoLogVoto([]) === '', 'montarSecaoLogVoto([]) deveria retornar string vazia');
}

function testarSecaoComLinhas() {
  const l1 = 'Voto — Romero: não marcou | IA ouviu "Sim" → preencheu';
  const l2 = 'Voto — Andressa: marcou "Sim" | IA ouviu "Sim" → concordam';
  const secao = montarSecaoLogVoto([l1, l2]);
  checar(secao.includes(l1), `seção deveria conter a linha 1: ${secao}`);
  checar(secao.includes(l2), `seção deveria conter a linha 2: ${secao}`);
  checar(secao.includes('Voto (IA × closer)'), `seção deveria conter o cabeçalho: ${secao}`);
}

// ===== parseResultadoAnalise — coerção de votoEvidencia =====

function testarCoercaoEvidenciaParcial() {
  const bruto = JSON.stringify({
    aderencia: 7,
    resumoAnalise: 'Resumo fabricado para o smoke.',
    retorno: {},
    votoEvidencia: { romero: 'trecho', andressa: '' },
  });
  const resultado = parseResultadoAnalise(bruto);
  checar(
    resultado.votoEvidencia.romero === 'trecho',
    `votoEvidencia.romero deveria ser "trecho": ${resultado.votoEvidencia.romero}`,
  );
  checar(
    resultado.votoEvidencia.andressa === null,
    `votoEvidencia.andressa (string vazia) deveria virar null: ${resultado.votoEvidencia.andressa}`,
  );
}

function testarCoercaoEvidenciaAusente() {
  const bruto = JSON.stringify({ aderencia: 5, resumoAnalise: 'Resumo sem votoEvidencia.', retorno: {} });
  const resultado = parseResultadoAnalise(bruto);
  checar(
    resultado.votoEvidencia.romero === null && resultado.votoEvidencia.andressa === null,
    `votoEvidencia ausente deveria virar { romero: null, andressa: null }: ${JSON.stringify(resultado.votoEvidencia)}`,
  );
  checar(resultado.falhaTecnica === false, 'votoEvidencia ausente NÃO deveria marcar falhaTecnica');
}

testarPreencheu();
testarConcordam();
testarDivergeComEvidencia();
testarIaSemBase();
testarValorNaoReconhecido();
testarSecaoVazia();
testarSecaoComLinhas();
testarCoercaoEvidenciaParcial();
testarCoercaoEvidenciaAusente();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
