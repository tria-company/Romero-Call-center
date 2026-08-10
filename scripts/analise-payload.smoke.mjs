#!/usr/bin/env node
// scripts/analise-payload.smoke.mjs
//
// Smoke determinístico (sem rede) das derivações puras de metadados da
// ligação a partir do payload Wavoip (OPER-02, Fase 03 Plano 02, D-P3-05).
// Prova, via fixtures, que `derivarAtendeu`/`derivarMotivoFalha`/
// `derivarDuracao` (src/mastra/analise.ts) cobrem os casos atendido-com-
// gravação, não-atendido-sem-gravação e payload sem `duration`.
//
// Uso: node --experimental-strip-types scripts/analise-payload.smoke.mjs

import { derivarAtendeu, derivarMotivoFalha, derivarDuracao } from '../src/mastra/analise.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// (a) Atendido, com gravação — CALL status=ACTIVE, duration>0, RECORD existiu.
const payloadAtendidoComGravacao = {
  status: 'ACTIVE',
  direction: 'OUTGOING',
  duration: 42,
  caller: '5511999999999',
  receiver: '5511988888888',
  record_url: 'https://exemplo.com/gravacao.mp3',
};

function testarAtendidoComGravacao() {
  checar(
    derivarAtendeu(payloadAtendidoComGravacao, true) === true,
    'atendido com gravação deveria derivarAtendeu === true',
  );
  checar(
    derivarMotivoFalha(payloadAtendidoComGravacao) === '',
    'atendido com gravação deveria ter motivoFalha vazio',
  );
  checar(
    derivarDuracao(payloadAtendidoComGravacao) === 42,
    `duração incorreta: esperado 42, recebido ${derivarDuracao(payloadAtendidoComGravacao)}`,
  );
}

// (b) Não-atendido, sem gravação — CALL status=NOT_ANSWERED, sem duration real, sem RECORD.
const payloadNaoAtendidoSemGravacao = {
  status: 'NOT_ANSWERED',
  direction: 'OUTGOING',
  duration: 0,
  caller: '5511999999999',
  receiver: '5511988888888',
};

function testarNaoAtendidoSemGravacao() {
  checar(
    derivarAtendeu(payloadNaoAtendidoSemGravacao, false) === false,
    'não-atendido sem gravação deveria derivarAtendeu === false',
  );
  checar(
    derivarMotivoFalha(payloadNaoAtendidoSemGravacao) !== '',
    'não-atendido sem gravação deveria ter motivoFalha NÃO vazio',
  );
  checar(
    derivarDuracao(payloadNaoAtendidoSemGravacao) >= 0,
    `duração deveria ser >= 0, recebido ${derivarDuracao(payloadNaoAtendidoSemGravacao)}`,
  );
}

// (c) Recusada — status=REJECTED, sem gravação.
const payloadRecusada = {
  status: 'REJECTED',
  direction: 'OUTGOING',
  duration: 0,
};

function testarRecusada() {
  checar(derivarAtendeu(payloadRecusada, false) === false, 'recusada deveria derivarAtendeu === false');
  checar(derivarMotivoFalha(payloadRecusada) === 'recusada', `motivoFalha incorreto: ${derivarMotivoFalha(payloadRecusada)}`);
}

// (d) Payload sem `duration` (ausente) — não deve quebrar, duração cai pra 0.
const payloadSemDuration = {
  status: 'MISSED',
};

function testarSemDuration() {
  checar(
    derivarDuracao(payloadSemDuration) === 0,
    `payload sem duration deveria derivar 0, recebido ${derivarDuracao(payloadSemDuration)}`,
  );
  checar(derivarAtendeu(payloadSemDuration, false) === false, 'MISSED sem gravação deveria derivarAtendeu === false');
  checar(derivarMotivoFalha(payloadSemDuration) === 'perdida', `motivoFalha incorreto: ${derivarMotivoFalha(payloadSemDuration)}`);
}

// (e) Status desconhecido mas com gravação (RECORD existiu) — heurística de fallback via teveGravacao.
const payloadStatusDesconhecidoComGravacao = {
  status: 'ALGO_NOVO',
  duration: 0,
};

function testarStatusDesconhecidoComGravacao() {
  checar(
    derivarAtendeu(payloadStatusDesconhecidoComGravacao, true) === true,
    'status desconhecido + gravação deveria derivarAtendeu === true (fallback por teveGravacao)',
  );
}

testarAtendidoComGravacao();
testarNaoAtendidoSemGravacao();
testarRecusada();
testarSemDuration();
testarStatusDesconhecidoComGravacao();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
