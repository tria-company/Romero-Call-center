#!/usr/bin/env node
// scripts/backfill-espelho.smoke.mjs
//
// Smoke determinístico (SEM rede, sem Supabase/ClickUp) das guardas fail-closed
// do backfill inicial do espelho (17-04, RECON-03/R9 — src/mastra/backfill-guardas.ts).
// Prova, com `agora`/`janela`/`lockAdquirido`/`sync` INJETADOS (nenhum I/O real),
// que o backfill:
//   (a) recusa fora da janela de manutenção;
//   (b) recusa sem o lock de concorrência adquirido;
//   (c) aborta numa página que falha, sem seguir varrendo a próxima;
//   (d) respeita a pausa de page-rate (minIntervaloPaginaMs) entre páginas.
// Fail-CLOSED de verdade: nos 4 casos, o comportamento esperado é RECUSAR/ABORTAR,
// nunca "deixar passar" — o oposto do rate-limiter fail-open que agravou o
// incidente 2026-08-20 (17-CONTEXT.md decisão 8).
//
// Uso: node --experimental-strip-types scripts/backfill-espelho.smoke.mjs

import { janelaDeManutencaoAberta, executarBackfillFailClosed } from '../src/mastra/backfill-guardas.ts';

const falhas = [];
function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

async function esperaLancar(promessa, mensagemSeNaoLancou) {
  try {
    await promessa;
    return { lancou: false, erro: null };
  } catch (e) {
    return { lancou: true, erro: e instanceof Error ? e.message : String(e) };
  }
}

// ===== janelaDeManutencaoAberta (pura) =====

function testarJanelaSemCruzarMeiaNoite() {
  const janela = { inicioHora: 1, fimHora: 5 };
  checar(janelaDeManutencaoAberta(new Date('2026-08-21T02:00:00'), janela) === true, 'janela 1-5h deveria estar ABERTA às 02h');
  checar(janelaDeManutencaoAberta(new Date('2026-08-21T01:00:00'), janela) === true, 'janela 1-5h deveria estar ABERTA no limite inferior (01h)');
  checar(janelaDeManutencaoAberta(new Date('2026-08-21T05:00:00'), janela) === false, 'janela 1-5h deveria estar FECHADA no limite superior (05h, exclusivo)');
  checar(janelaDeManutencaoAberta(new Date('2026-08-21T12:00:00'), janela) === false, 'janela 1-5h deveria estar FECHADA em horário de operação (12h)');
}

function testarJanelaCruzandoMeiaNoite() {
  const janela = { inicioHora: 23, fimHora: 5 };
  checar(janelaDeManutencaoAberta(new Date('2026-08-21T23:30:00'), janela) === true, 'janela 23-5h deveria estar ABERTA às 23h30');
  checar(janelaDeManutencaoAberta(new Date('2026-08-21T00:30:00'), janela) === true, 'janela 23-5h deveria estar ABERTA à meia-noite e meia');
  checar(janelaDeManutencaoAberta(new Date('2026-08-21T04:59:00'), janela) === true, 'janela 23-5h deveria estar ABERTA às 04h59');
  checar(janelaDeManutencaoAberta(new Date('2026-08-21T10:00:00'), janela) === false, 'janela 23-5h deveria estar FECHADA às 10h (operação)');
}

function testarJanelaConfigInvalidaFailClosed() {
  checar(janelaDeManutencaoAberta(new Date('2026-08-21T02:00:00'), { inicioHora: -1, fimHora: 5 }) === false, 'janela com inicioHora inválida deveria ser FECHADA (fail-closed)');
  checar(janelaDeManutencaoAberta(new Date('2026-08-21T02:00:00'), { inicioHora: 3, fimHora: 3 }) === false, 'janela de duração zero deveria ser FECHADA (fail-closed)');
}

// ===== executarBackfillFailClosed =====

const JANELA_ABERTA_02H = { inicioHora: 1, fimHora: 5 };
const AGORA_DENTRO = new Date('2026-08-21T02:00:00');
const AGORA_FORA = new Date('2026-08-21T12:00:00');

function pagerFixo(paginas) {
  // paginas: array de { registros, ultimaPagina } OU uma função que lança.
  return async (numeroPagina) => {
    const p = paginas[numeroPagina];
    if (!p) throw new Error(`pager fixo: sem página configurada para índice ${numeroPagina}`);
    if (p.lanca) throw new Error(p.lanca);
    return { registros: p.registros, ultimaPagina: p.ultimaPagina };
  };
}

async function testarRecusaForaDaJanela() {
  const chamadas = [];
  const { lancou, erro } = await esperaLancar(
    executarBackfillFailClosed({
      sync: async (n) => {
        chamadas.push(n);
        return { registros: 10, ultimaPagina: true };
      },
      agora: AGORA_FORA,
      janela: JANELA_ABERTA_02H,
      lockAdquirido: true,
    }),
  );
  checar(lancou === true, 'fora da janela: executarBackfillFailClosed deveria LANÇAR');
  checar(/janela de manutenção/.test(erro ?? ''), `mensagem deveria citar a janela de manutenção: ${erro}`);
  checar(chamadas.length === 0, `fora da janela: sync NUNCA deveria ser chamado (foi chamado ${chamadas.length}x)`);
}

async function testarRecusaSemLock() {
  const chamadas = [];
  const { lancou, erro } = await esperaLancar(
    executarBackfillFailClosed({
      sync: async (n) => {
        chamadas.push(n);
        return { registros: 10, ultimaPagina: true };
      },
      agora: AGORA_DENTRO,
      janela: JANELA_ABERTA_02H,
      lockAdquirido: false,
    }),
  );
  checar(lancou === true, 'sem lock: executarBackfillFailClosed deveria LANÇAR');
  checar(/lock/.test(erro ?? ''), `mensagem deveria citar o lock de concorrência: ${erro}`);
  checar(chamadas.length === 0, `sem lock: sync NUNCA deveria ser chamado (foi chamado ${chamadas.length}x)`);
}

async function testarAbortaSemVarrerProximaPagina() {
  const chamadas = [];
  const sync = async (n) => {
    chamadas.push(n);
    if (n === 1) throw new Error('HTTP 500 simulado na página 1');
    return { registros: 5, ultimaPagina: false };
  };
  const { lancou, erro } = await esperaLancar(
    executarBackfillFailClosed({
      sync,
      agora: AGORA_DENTRO,
      janela: JANELA_ABERTA_02H,
      lockAdquirido: true,
      maxPaginas: 10,
    }),
  );
  checar(lancou === true, 'página que falha: executarBackfillFailClosed deveria ABORTAR (lançar)');
  checar(/ABORTADO na página 1/.test(erro ?? ''), `mensagem deveria citar a página que abortou: ${erro}`);
  checar(chamadas.length === 2, `deveria ter tentado só páginas 0 e 1, nunca a 2 (chamou ${chamadas.length}x: ${JSON.stringify(chamadas)})`);
  checar(!chamadas.includes(2), 'não deveria ter varrido a página 2 depois do abort na página 1');
}

async function testarRespeitaPausaEntrePaginas() {
  const timestamps = [];
  const sync = async (n) => {
    timestamps.push(Date.now());
    return { registros: 1, ultimaPagina: n === 2 };
  };
  const PAUSA_MS = 60;
  const t0 = Date.now();
  const resultado = await executarBackfillFailClosed({
    sync,
    agora: AGORA_DENTRO,
    janela: JANELA_ABERTA_02H,
    lockAdquirido: true,
    minIntervaloPaginaMs: PAUSA_MS,
  });
  const duracaoTotal = Date.now() - t0;
  checar(resultado.paginas === 3, `deveria ter processado 3 páginas (0,1,2): processou ${resultado.paginas}`);
  checar(resultado.registros === 3, `deveria ter acumulado 3 registros: acumulou ${resultado.registros}`);
  // 2 pausas entre 3 páginas (0->1, 1->2) — sem pausa depois da última.
  checar(
    duracaoTotal >= PAUSA_MS * 2 - 15,
    `deveria ter esperado ao menos ~${PAUSA_MS * 2}ms entre as 3 páginas (2 pausas): levou ${duracaoTotal}ms`,
  );
  for (let i = 1; i < timestamps.length; i += 1) {
    const intervalo = timestamps[i] - timestamps[i - 1];
    checar(intervalo >= PAUSA_MS - 15, `intervalo entre página ${i - 1} e ${i} deveria ser >= ~${PAUSA_MS}ms (teto de page-rate): foi ${intervalo}ms`);
  }
}

async function testarCaminhoFelizAcumulaProgresso() {
  const progresso = [];
  const resultado = await executarBackfillFailClosed({
    sync: pagerFixo([
      { registros: 100, ultimaPagina: false },
      { registros: 100, ultimaPagina: false },
      { registros: 40, ultimaPagina: true },
    ]),
    agora: AGORA_DENTRO,
    janela: JANELA_ABERTA_02H,
    lockAdquirido: true,
    onPagina: (pagina, registrosAcumulados) => progresso.push({ pagina, registrosAcumulados }),
  });
  checar(resultado.paginas === 3, `caminho feliz: deveria processar 3 páginas, processou ${resultado.paginas}`);
  checar(resultado.registros === 240, `caminho feliz: deveria acumular 240 registros, acumulou ${resultado.registros}`);
  checar(progresso.length === 3, `onPagina deveria ter sido chamado 3x, foi ${progresso.length}x`);
  checar(progresso[2].registrosAcumulados === 240, `último onPagina deveria reportar o acumulado total 240: ${progresso[2]?.registrosAcumulados}`);
}

async function main() {
  testarJanelaSemCruzarMeiaNoite();
  testarJanelaCruzandoMeiaNoite();
  testarJanelaConfigInvalidaFailClosed();
  await testarRecusaForaDaJanela();
  await testarRecusaSemLock();
  await testarAbortaSemVarrerProximaPagina();
  await testarRespeitaPausaEntrePaginas();
  await testarCaminhoFelizAcumulaProgresso();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('SMOKE OK');
  process.exit(0);
}

main();
