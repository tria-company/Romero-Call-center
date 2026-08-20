#!/usr/bin/env node
// scripts/backfill-espelho.mjs
//
// Backfill INICIAL fail-closed do espelho (17-04, RECON-03/R9): popula
// ligacoes/audios_envios/leads-full de UMA vez, paginando as Listas 02/03/01
// COMPLETAS (include_closed=true) via `sincronizarEspelhoLigacoes/Audios/Leads`
// (17-02, src/mastra/espelho.ts). É A MESMA varredura que causou o incidente
// 2026-08-20 (endpoint frágil sob listagem grande) — por isso este runner só
// executa de verdade dentro de uma JANELA DE MANUTENÇÃO, com um LOCK que
// recusa operação concorrente, e delega o gate fail-closed a
// `executarBackfillFailClosed` (src/mastra/backfill-guardas.ts, puro/testável —
// ver scripts/backfill-espelho.smoke.mjs).
//
// SEGURO POR PADRÃO (molde backfill-votos-ligacao.mjs): sem `--confirmar-janela`
// só RELATA (dry-run de fato), nunca grava — mesmo com `--alvo todos`.
//
// FAIL-CLOSED: fora da janela, sem lock, ou se um alvo falhar após o retry do
// sync (17-02: `tentativas` já embutido em `sincronizarEspelho*`), o runner
// RECUSA/ABORTA e sai com código != 0 — nunca segue "no melhor esforço".
//
// Uso:
//   node --env-file=deploy/homolog.env --experimental-strip-types scripts/backfill-espelho.mjs \
//     --alvo ligacoes|audios|leads|todos [--confirmar-janela] [--dry-run] [--paginas N]
//
// Recomendado (janela real, CLICKUP_TIMEOUT_MS elevado — molde 4x/90s do
// backfill-votos-ligacao.mjs):
//   CLICKUP_TIMEOUT_MS=90000 node --env-file=deploy/homolog.env --experimental-strip-types \
//     scripts/backfill-espelho.mjs --alvo todos --confirmar-janela
//
// Env:
//   BACKFILL_JANELA_INICIO / BACKFILL_JANELA_FIM  hora local (0-23) da janela de manutenção
//                                                  (default 1-5 — madrugada; suporta cruzar
//                                                  meia-noite, ex.: 23-5)
//   BACKFILL_LOCK_PATH        path do lockfile de exclusão mútua (default os.tmpdir())
//   BACKFILL_PAUSA_PAGINA_MS  teto de page-rate DURO entre páginas de UM alvo (default 2000ms,
//                              passado como pausaEntrePaginasMs pro sync do 17-02)
//   BACKFILL_PAUSA_ALVO_MS    pausa entre ALVOS quando --alvo todos (default 5000ms)
//   BACKFILL_TENTATIVAS       tentativas de retry ADICIONAIS por página (default 3 = 4
//                              tentativas totais, molde 4x/90s de backfill-votos-ligacao.mjs)
//   BACKFILL_MAX_PAGINAS_ALVO teto de páginas por alvo — proteção contra laço infinito por
//                              bug de paginação (default 3000 ~= 300 mil tasks)
//
// LGPD: imprime só contagem/página — nunca telefone/cpf/transcrição/gravação.

import { openSync, closeSync, writeSync, readFileSync, unlinkSync, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { janelaDeManutencaoAberta, executarBackfillFailClosed } from '../src/mastra/backfill-guardas.ts';
import { sincronizarEspelhoLeads, sincronizarEspelhoLigacoes, sincronizarEspelhoAudios } from '../src/mastra/espelho.ts';
import {
  CLICKUP_API_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUPABASE_TABLE_LEADS_ESPELHO,
  SUPABASE_TABLE_LIGACOES,
  SUPABASE_TABLE_AUDIOS_ENVIOS,
} from '../src/mastra/config.ts';

function arg(nome) {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? (process.argv[i + 1] ?? '') : null;
}
function numeroEnv(nome, def) {
  const n = Number(process.env[nome]);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

const CONFIRMAR_JANELA = process.argv.includes('--confirmar-janela');
const DRY_RUN = process.argv.includes('--dry-run') || !CONFIRMAR_JANELA;
const ALVO = arg('--alvo') || 'todos';
const PAGINAS_TESTE = Number(arg('--paginas')) || 0; // teto opcional pra teste rápido (todos os alvos)

const JANELA = {
  inicioHora: numeroEnv('BACKFILL_JANELA_INICIO', 1),
  fimHora: numeroEnv('BACKFILL_JANELA_FIM', 5),
};
const PAUSA_PAGINA_MS = numeroEnv('BACKFILL_PAUSA_PAGINA_MS', 2000);
const PAUSA_ALVO_MS = numeroEnv('BACKFILL_PAUSA_ALVO_MS', 5000);
const TENTATIVAS = numeroEnv('BACKFILL_TENTATIVAS', 3);
const MAX_PAGINAS_ALVO = numeroEnv('BACKFILL_MAX_PAGINAS_ALVO', 3000);
const LOCK_PATH = process.env.BACKFILL_LOCK_PATH || path.join(os.tmpdir(), 'romerocall-backfill-espelho.lock');
const LOCK_ORFAO_MS = 6 * 60 * 60 * 1000; // 6h — acima disso o lock provavelmente é órfão (processo morto sem limpar)

const ALVOS = {
  leads: { sync: sincronizarEspelhoLeads, tabela: SUPABASE_TABLE_LEADS_ESPELHO },
  ligacoes: { sync: sincronizarEspelhoLigacoes, tabela: SUPABASE_TABLE_LIGACOES },
  audios: { sync: sincronizarEspelhoAudios, tabela: SUPABASE_TABLE_AUDIOS_ENVIOS },
};
// Ordem: ligacoes/audios primeiro (as listas que NUNCA foram espelhadas — o
// ganho real desta fase), leads-full por último (já existe um espelho parcial,
// menor risco se o backfill abortar no meio).
const ORDEM_TODOS = ['ligacoes', 'audios', 'leads'];

// ===== Lock de exclusão mútua (I/O real — fora de backfill-guardas.ts, que é puro) =====
//
// Fail-closed: um lock existente NUNCA é removido automaticamente por este processo
// (isso seria fail-open — "acho que morreu, sigo em frente"). Um lock órfão exige
// remoção HUMANA explícita depois de confirmar que não há operação em curso.

function adquirirLock() {
  try {
    const fd = openSync(LOCK_PATH, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    writeSync(fd, JSON.stringify({ pid: process.pid, iniciadoEm: new Date().toISOString() }));
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let idadeMin = '?';
    try {
      const conteudo = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
      idadeMin = Math.round((Date.now() - new Date(conteudo.iniciadoEm).getTime()) / 60000);
      const orfao = Date.now() - new Date(conteudo.iniciadoEm).getTime() > LOCK_ORFAO_MS;
      console.error(
        `[backfill] lock já existe (pid=${conteudo.pid}, idade=${idadeMin}min)${orfao ? ' — PARECE ÓRFÃO (>6h); confirme que não há backfill em curso e remova manualmente: rm ' + LOCK_PATH : ''} — recusando (sem operação concorrente)`,
      );
    } catch {
      console.error(`[backfill] lock já existe em ${LOCK_PATH} (conteúdo ilegível) — recusando (sem operação concorrente)`);
    }
    return false;
  }
}

function liberarLock() {
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    /* já não existe — tudo bem */
  }
}

// ===== Runner =====

async function main() {
  const alvosAExecutar = ALVO === 'todos' ? ORDEM_TODOS : [ALVO];
  for (const nome of alvosAExecutar) {
    if (!ALVOS[nome]) {
      console.error(`--alvo inválido: '${ALVO}' — use um de: leads, ligacoes, audios, todos`);
      process.exit(1);
    }
  }

  console.log(
    `[backfill:espelho] alvo(s)=${alvosAExecutar.join(',')} modo=${DRY_RUN ? 'DRY-RUN/relatório (nada grava)' : 'GRAVANDO'} ` +
      `janela=${JANELA.inicioHora}h-${JANELA.fimHora}h`,
  );

  if (!CLICKUP_API_TOKEN) {
    console.error('CLICKUP_API_TOKEN ausente — rode com --env-file=deploy/homolog.env (ou .env)');
    process.exit(1);
  }
  if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)) {
    console.error('SUPABASE_URL/SUPABASE_SERVICE_KEY ausentes — sem isso não dá pra gravar o backfill');
    process.exit(1);
  }

  if (!CONFIRMAR_JANELA) {
    console.log(
      '[backfill:espelho] --confirmar-janela ausente: modo relatório/dry-run por padrão (seguro).\n' +
        '  Fora de uma janela de manutenção real, com lock adquirido e --confirmar-janela, este runner\n' +
        '  NUNCA grava — é a mesma varredura que causou o incidente 2026-08-20 (RECON-03/R9).',
    );
  }

  // Fora do modo "vai gravar de verdade", nem tenta lock/janela — só reporta volume via dry-run
  // do próprio sync do 17-02 (mesmo comportamento de scripts/sincronizar-espelho.mjs --dry-run).
  if (DRY_RUN) {
    for (const nome of alvosAExecutar) {
      const alvo = ALVOS[nome];
      const t0 = Date.now();
      const r = await alvo.sync({
        maxPaginas: PAGINAS_TESTE || 0,
        dryRun: true,
        pausaEntrePaginasMs: PAUSA_PAGINA_MS,
        tentativas: TENTATIVAS,
        onProgress: (pag, registros) => {
          if (pag <= 3 || pag % 10 === 0) console.log(`[backfill:espelho:${nome}] (dry-run) página ${pag} — ${registros} registro(s) acumulado(s)`);
        },
      });
      const seg = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[backfill:espelho:${nome}] (dry-run) pronto: ${r.paginas} página(s), ${r.registros} registro(s) em ${seg}s — nada gravado`);
    }
    return;
  }

  // ===== Modo GRAVANDO: janela + lock + guardas fail-closed de verdade =====
  const agora = new Date();
  if (!janelaDeManutencaoAberta(agora, JANELA)) {
    console.error(
      `[backfill:espelho] RECUSADO: fora da janela de manutenção (${JANELA.inicioHora}h-${JANELA.fimHora}h, agora=${agora.toISOString()}, hora local=${agora.getHours()}h). ` +
        'Ajuste BACKFILL_JANELA_INICIO/BACKFILL_JANELA_FIM ou rode dentro da janela combinada.',
    );
    process.exit(1);
  }

  const lockAdquirido = adquirirLock();
  if (!lockAdquirido) {
    console.error('[backfill:espelho] RECUSADO: lock de concorrência não adquirido (outro backfill/operação em curso).');
    process.exit(1);
  }

  try {
    const resultadosPorAlvo = {};
    const resultado = await executarBackfillFailClosed({
      agora,
      janela: JANELA,
      lockAdquirido,
      minIntervaloPaginaMs: alvosAExecutar.length > 1 ? PAUSA_ALVO_MS : 0,
      maxPaginas: alvosAExecutar.length,
      onPagina: (pagina, registrosAcumulados) => {
        console.log(`[backfill:espelho] alvo ${pagina}/${alvosAExecutar.length} concluído — ${registrosAcumulados} registro(s) acumulado(s) no total`);
      },
      sync: async (indice) => {
        const nome = alvosAExecutar[indice];
        const alvo = ALVOS[nome];
        console.log(`[backfill:espelho:${nome}] iniciando (gravando em ${alvo.tabela})...`);
        const t0 = Date.now();
        const r = await alvo.sync({
          maxPaginas: PAGINAS_TESTE || MAX_PAGINAS_ALVO,
          dryRun: false,
          pausaEntrePaginasMs: PAUSA_PAGINA_MS,
          tentativas: TENTATIVAS,
          onProgress: (pag, registros) => {
            if (pag <= 3 || pag % 10 === 0) console.log(`[backfill:espelho:${nome}] página ${pag} — ${registros} registro(s) acumulado(s)`);
          },
        });
        const seg = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[backfill:espelho:${nome}] pronto: ${r.paginas} página(s), ${r.registros} registro(s) em ${seg}s`);
        resultadosPorAlvo[nome] = r;
        return { registros: r.registros, ultimaPagina: indice === alvosAExecutar.length - 1 };
      },
    });

    console.log(
      `[backfill:espelho] CONCLUÍDO: ${resultado.paginas} alvo(s) processado(s), ${resultado.registros} registro(s) no total. ` +
        `Detalhe: ${JSON.stringify(resultadosPorAlvo)}`,
    );
  } catch (e) {
    console.error(`[backfill:espelho] ABORTADO: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  } finally {
    liberarLock();
  }
}

main().catch((e) => {
  console.error('[backfill:espelho] erro fatal:', e instanceof Error ? e.message : String(e));
  liberarLock();
  process.exit(1);
});
