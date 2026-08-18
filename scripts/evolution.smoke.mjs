#!/usr/bin/env node
// scripts/evolution.smoke.mjs
//
// Smoke determinístico (sem rede/Redis) do client Evolution API
// (`src/mastra/evolution.ts`, Fase 12, canal-de-envio-evolution-api). Roda
// SEM REDIS_URL no ambiente (modo memoria) e SEM rede real — `globalThis.fetch`
// é mockado. Prova:
//   1. THROTTLE segura o cap (D-06) — com EVOLUTION_MAX_POR_MINUTO baixo,
//      chamadas consecutivas a adquirirTokenEvolution() acima do teto NÃO
//      resolvem todas imediatamente: a que esgota o bounded-wait LANÇA (nunca
//      faz fail-open, diferente de rate-limiter-clickup.ts). modoRateLimiterEvolution()
//      === 'memoria' sem Redis.
//   2. STATUS normaliza (D-08) — connectionState state:'open' -> { conectado:
//      true }; state:'close' -> { conectado: false }.
//   3. ENVIO LANÇA em falha (D-08) — fetch mockado com { ok:false, status:400 }
//      faz enviarAudio() lançar um Error com prefixo [evolution] (nunca
//      resolve em null/silêncio).
//
// LGPD: telefone/áudio usados aqui são fake (nunca dados reais).
//
// Nota de design: config.ts/evolution.ts leem EVOLUTION_MAX_POR_MINUTO/
// RL_EVOLUTION_WAIT_MAX_MS uma ÚNICA vez no import (consts de módulo) — e o
// balde do modo memória é estado de módulo compartilhado por TODA chamada
// no processo (é exatamente isso que prova D-06: nenhum caminho escapa do
// mesmo limiter). Por isso o teste (1) THROTTLE roda num PROCESSO FILHO
// isolado, com seu próprio cap baixo (EVOLUTION_MAX_POR_MINUTO=2,
// RL_EVOLUTION_WAIT_MAX_MS=300) — sem isso, exaurir o balde nesse teste
// deixaria os testes (2)/(3) no mesmo processo throttlados também (falso
// negativo). Os testes (2)/(3) rodam no processo principal com o cap
// default (generoso), onde throttle nunca é o fator limitante.
//
// Uso: node --experimental-strip-types scripts/evolution.smoke.mjs

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = fileURLToPath(new URL('.', import.meta.url));

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ===== (1) THROTTLE segura o cap — processo filho isolado com cap baixo =====

const SNIPPET_CAP = `
process.env.EVOLUTION_MAX_POR_MINUTO = '2';
process.env.RL_EVOLUTION_WAIT_MAX_MS = '300';
process.env.EVOLUTION_API_URL = 'http://evolution.smoke.local';
process.env.EVOLUTION_API_KEY = 'smoke-fake-key';
process.env.EVOLUTION_INSTANCE = 'smoke-instance';
delete process.env.REDIS_URL;

const { adquirirTokenEvolution, modoRateLimiterEvolution } = await import('../src/mastra/evolution.ts');

if (modoRateLimiterEvolution() !== 'memoria') {
  console.error('RESULT ' + JSON.stringify({ ok: false, motivo: "modo != 'memoria'" }));
  process.exit(1);
}

// Consome os 2 tokens do cap (devem resolver rápido).
await adquirirTokenEvolution();
await adquirirTokenEvolution();

// A 3a chamada excede o cap — deve esperar o teto e então LANÇAR (nunca
// resolver silenciosamente / fail-open).
const inicio = performance.now();
let lancou = false;
let mensagem = '';
try {
  await adquirirTokenEvolution();
} catch (e) {
  lancou = true;
  mensagem = e instanceof Error ? e.message : String(e);
}
const duracaoMs = performance.now() - inicio;

console.error('RESULT ' + JSON.stringify({ ok: true, lancou, mensagem, duracaoMs }));
process.exit(0);
`;

function testeCapSeguraProcessoFilho() {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', SNIPPET_CAP],
    { cwd: SCRIPTS_DIR, encoding: 'utf8', env: process.env },
  );

  const linhaResultado = (r.stderr || '').split('\n').find((l) => l.startsWith('RESULT '));
  if (!linhaResultado) {
    checar(false, `processo filho do teste de throttle não devolveu RESULT (exit=${r.status}); stderr:\n${r.stderr}`);
    return;
  }
  const resultado = JSON.parse(linhaResultado.slice('RESULT '.length));

  checar(resultado.ok, `processo filho do teste de throttle falhou: ${JSON.stringify(resultado)}`);
  checar(
    resultado.lancou === true,
    'adquirirTokenEvolution() deveria LANÇAR ao esgotar o teto de espera acima do cap (cap segura, sem fail-open)',
  );
  checar(
    typeof resultado.mensagem === 'string' && resultado.mensagem.startsWith('[evolution]'),
    `mensagem de erro do throttle deveria ter prefixo [evolution], recebido: '${resultado.mensagem}'`,
  );
  checar(
    resultado.duracaoMs >= 250,
    `a chamada acima do cap deveria esperar perto do teto (RL_EVOLUTION_WAIT_MAX_MS=300ms) antes de lançar — não resolver de imediato (fail-open); resolveu em ${Number(resultado.duracaoMs).toFixed(0)}ms`,
  );

  console.log(
    `[evolution.smoke] throttle-cap: modo=memoria, chamada acima do cap lançou após ${Number(resultado.duracaoMs).toFixed(0)}ms (sem fail-open)`,
  );
}

// ===== (2)/(3) status normaliza + envio lança — processo principal, fetch mockado =====
//
// Cap default (generoso) neste processo — throttle nunca é o fator limitante
// aqui, só EVOLUTION_INSTANCE/API_URL/API_KEY precisam existir pra enviarAudio()/
// statusInstancia() não abortarem por config ausente antes de chegar no fetch mockado.
process.env.EVOLUTION_API_URL ||= 'http://evolution.smoke.local';
process.env.EVOLUTION_API_KEY ||= 'smoke-fake-key';
process.env.EVOLUTION_INSTANCE ||= 'smoke-instance';

const { enviarAudio, statusInstancia } = await import('../src/mastra/evolution.ts');

/** Mocka globalThis.fetch para devolver um payload fixo (status/ok/json) numa única chamada. */
function mockarFetchUmaVez({ ok, status, json }) {
  globalThis.fetch = async () => ({
    ok,
    status,
    json: async () => json,
  });
}

async function testeStatusNormaliza() {
  mockarFetchUmaVez({ ok: true, status: 200, json: { instance: { state: 'open' } } });
  const abertoStatus = await statusInstancia();
  checar(
    abertoStatus.conectado === true,
    `statusInstancia() com state:'open' deveria retornar conectado:true, recebido: ${JSON.stringify(abertoStatus)}`,
  );

  mockarFetchUmaVez({ ok: true, status: 200, json: { instance: { state: 'close' } } });
  const fechadoStatus = await statusInstancia();
  checar(
    fechadoStatus.conectado === false,
    `statusInstancia() com state:'close' deveria retornar conectado:false, recebido: ${JSON.stringify(fechadoStatus)}`,
  );

  console.log('[evolution.smoke] statusInstancia() normaliza open/close corretamente');
}

async function testeEnvioLanca() {
  mockarFetchUmaVez({ ok: false, status: 400, json: {} });

  let lancou = false;
  let mensagemErro = '';
  try {
    await enviarAudio('+5511999990000', 'ZmFrZS1hdWRpby1iYXNlNjQ=', 'audio/ogg');
  } catch (e) {
    lancou = true;
    mensagemErro = e instanceof Error ? e.message : String(e);
  }

  checar(lancou, 'enviarAudio() deveria LANÇAR em falha HTTP (nunca resolver em null/silêncio)');
  checar(
    mensagemErro.startsWith('[evolution]'),
    `mensagem de erro de enviarAudio() deveria ter prefixo [evolution], recebido: '${mensagemErro}'`,
  );

  console.log('[evolution.smoke] enviarAudio() lança em falha HTTP (400) com prefixo [evolution]');
}

async function main() {
  console.log('=== Smoke Evolution API — throttle-cap + status + envio-lança (Fase 12) ===');
  testeCapSeguraProcessoFilho();
  await testeStatusNormaliza();
  await testeEnvioLanca();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('erro inesperado:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
