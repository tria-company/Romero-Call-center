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

import {
  derivarAtendeu,
  derivarMotivoFalha,
  derivarDuracao,
  ehStatusFalhaTerminal,
  deveProcessarFalhaTerminal,
} from '../src/mastra/analise.ts';

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

// (f) CR-01 — predicado explícito de falha terminal (ehStatusFalhaTerminal):
// status de transição (RINGING/CALLING), desconhecido ou ausente NUNCA é
// falha terminal, mesmo com duration=0; só STATUS_NAO_ATENDIDA conhecido é.
function testarStatusTerminalDeFalha() {
  checar(
    ehStatusFalhaTerminal({ status: 'NOT_ANSWERED', duration: 0 }) === true,
    'NOT_ANSWERED deveria ser falha terminal',
  );
  checar(ehStatusFalhaTerminal({ status: 'UNANSWERED' }) === true, 'UNANSWERED deveria ser falha terminal');
  checar(ehStatusFalhaTerminal({ status: 'REJECTED' }) === true, 'REJECTED deveria ser falha terminal');
  checar(ehStatusFalhaTerminal({ status: 'MISSED' }) === true, 'MISSED deveria ser falha terminal');
  checar(
    ehStatusFalhaTerminal({ status: 'RINGING', duration: 0 }) === false,
    'RINGING (transição) NÃO deveria ser falha terminal',
  );
  checar(
    ehStatusFalhaTerminal({ status: 'CALLING', duration: 0 }) === false,
    'CALLING (transição) NÃO deveria ser falha terminal',
  );
  checar(
    ehStatusFalhaTerminal({ status: 'ALGO_NOVO' }) === false,
    'status desconhecido NÃO deveria ser falha terminal',
  );
  checar(ehStatusFalhaTerminal({}) === false, 'status ausente NÃO deveria ser falha terminal');
  checar(ehStatusFalhaTerminal({ status: 'ACTIVE' }) === false, 'ACTIVE (atendida) NÃO deveria ser falha terminal');
  checar(
    ehStatusFalhaTerminal({ status: 'ANSWERED' }) === false,
    'ANSWERED (atendida) NÃO deveria ser falha terminal',
  );
}

// (g) CR-02 — decisão pura de dedup (deveProcessarFalhaTerminal): primeira
// vez processa, segunda vez para o mesmo callId é no-op; sem callId sempre
// processa (a limpeza de taskAtivaPorTelefone no caller cobre o retry).
function testarDedupFalhaTerminal() {
  checar(
    deveProcessarFalhaTerminal('c1', new Set()) === true,
    'primeira vez (Set vazio) deveria processar',
  );
  checar(
    deveProcessarFalhaTerminal('c1', new Set(['c1'])) === false,
    'segundo evento terminal para o mesmo callId deveria ser no-op (CR-02)',
  );
  checar(
    deveProcessarFalhaTerminal('', new Set(['c1'])) === true,
    'callId vazio deveria sempre processar (sem chave de dedup)',
  );
}

testarAtendidoComGravacao();
testarNaoAtendidoSemGravacao();
testarRecusada();
testarSemDuration();
testarStatusDesconhecidoComGravacao();
testarStatusTerminalDeFalha();
testarDedupFalhaTerminal();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
