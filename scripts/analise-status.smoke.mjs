#!/usr/bin/env node
// scripts/analise-status.smoke.mjs
//
// Smoke determinístico (sem rede) do vocabulário REAL de status Wavoip
// confirmado nos logs de produção (2026-08-12) — caminho "não atendida"
// do webhook (quick-260812-fre). Prova, via fixtures, que
// `ehStatusFalhaTerminal`/`derivarMotivoFalha`/`derivarAtendeu`
// (src/mastra/analise.ts) tratam corretamente CANCELLED (não atendida),
// FAILED dur=0 (falha real) vs FAILED dur>0 (queda no meio de chamada
// atendida) e as transições (RINGING/CALLING/ACTIVE).
//
// Uso: node --experimental-strip-types scripts/analise-status.smoke.mjs

import {
  derivarAtendeu,
  derivarMotivoFalha,
  ehStatusFalhaTerminal,
} from '../src/mastra/analise.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// CANCELLED dur=0 — não atendida (quem liga desistiu).
function testarCancelled() {
  const payload = { status: 'CANCELLED', duration: 0 };
  checar(ehStatusFalhaTerminal(payload) === true, 'CANCELLED dur=0 deveria ser falha terminal');
  checar(
    derivarMotivoFalha(payload) === 'não atendida',
    `CANCELLED motivoFalha incorreto: ${derivarMotivoFalha(payload)}`,
  );
  checar(derivarAtendeu(payload, false) === false, 'CANCELLED deveria derivarAtendeu === false');
}

// FAILED dur=0 com reason — falha real da chamada.
function testarFailedDur0ComReason() {
  const payload = { status: 'FAILED', duration: 0, reason: 'timeout' };
  checar(ehStatusFalhaTerminal(payload) === true, 'FAILED dur=0 deveria ser falha terminal');
  checar(
    derivarMotivoFalha(payload) === 'falha na chamada (timeout)',
    `FAILED dur=0 motivoFalha incorreto: ${derivarMotivoFalha(payload)}`,
  );
}

// FAILED dur>0 — queda no MEIO de chamada atendida (RECORD cuida da task).
function testarFailedDurPositiva() {
  const payload = { status: 'FAILED', duration: 40.22 };
  checar(ehStatusFalhaTerminal(payload) === false, 'FAILED dur>0 NÃO deveria ser falha terminal');
  checar(
    derivarAtendeu(payload, false) === true,
    'FAILED dur>0 deveria derivarAtendeu === true (heurística duration)',
  );
  checar(derivarMotivoFalha(payload) === '', `FAILED dur>0 motivoFalha deveria ser vazio: ${derivarMotivoFalha(payload)}`);
}

// ENDED dur>0 — atendida encerrada.
function testarEnded() {
  const payload = { status: 'ENDED', duration: 20.885 };
  checar(ehStatusFalhaTerminal(payload) === false, 'ENDED NÃO deveria ser falha terminal');
  checar(derivarAtendeu(payload, false) === true, 'ENDED deveria derivarAtendeu === true');
}

// Transições (RINGING/CALLING/ACTIVE) dur=0 — nunca falha terminal.
function testarTransicoes() {
  for (const status of ['RINGING', 'CALLING', 'ACTIVE']) {
    checar(
      ehStatusFalhaTerminal({ status, duration: 0 }) === false,
      `${status} (transição) NÃO deveria ser falha terminal`,
    );
  }
}

testarCancelled();
testarFailedDur0ComReason();
testarFailedDurPositiva();
testarEnded();
testarTransicoes();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
