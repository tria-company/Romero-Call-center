#!/usr/bin/env node
// scripts/backfill-notas.mjs
//
// Backfill fail-closed de NOTAS (comentarios historicos) + migracao dos
// binarios de gravacao para o Supabase Storage (Fase 17-A, Plano 05 —
// MODELO-07/R7). SO POPULA: escreve em `notas` + no bucket de gravacoes;
// nenhuma rota le essas fontes ainda (a inversao de leitura e a Phase 19).
//
// COMO LE (sem re-listar o ClickUp — T-17-05-D): os `clickup_task_id` saem do
// ESPELHO JA POPULADO (hml_discador_leads_espelho + hml_ligacoes, 17-02/17-04)
// via SELECT REST. Para cada task-id, faz `GET /task/{id}/comment` POR-ID (raw
// fetch com retry 4x/90s, molde de backfill-votos-ligacao.mjs) — endpoint que
// SOBREVIVEU ao incidente 2026-08-20; NUNCA a listagem paginada que o causou.
// Para cada `url_gravacao` de hml_ligacoes, migra o binario em streaming via
// `subirGravacaoStorage` e atualiza o ponteiro na linha.
//
// FAIL-CLOSED (RECON-03/R9): tudo sob as guardas do 17-04
// (`executarBackfillFailClosed` / janela de manutencao / lock de exclusao /
// pacing per-ID / abort-nao-parcial). Fora da janela, sem lock, ou se um alvo
// falhar apos o retry, o runner RECUSA/ABORTA e sai com codigo != 0.
//
// SEGURO POR PADRAO (molde backfill-espelho.mjs): sem `--confirmar-janela` so
// RELATA o volume a migrar LENDO O ESPELHO (nao toca o ClickUp) — dry-run de
// fato, nada grava. So `--confirmar-janela` + janela + lock hit o ClickUp/Storage.
//
// Uso:
//   node --env-file=deploy/homolog.env --experimental-strip-types scripts/backfill-notas.mjs [--dry-run]
//   node --env-file=deploy/homolog.env --experimental-strip-types scripts/backfill-notas.mjs --confirmar-janela
//
// Env:
//   BACKFILL_JANELA_INICIO / BACKFILL_JANELA_FIM  hora local (0-23) da janela (default 1-5)
//   BACKFILL_LOCK_PATH        lockfile de exclusao mutua (default os.tmpdir())
//   BACKFILL_PAUSA_ID_MS      teto de page-rate DURO entre IDs no ClickUp (default 250ms)
//   BACKFILL_PAUSA_ALVO_MS    pausa entre alvos (comentarios -> gravacoes) (default 5000ms)
//   BACKFILL_MAX_IDS          teto de ids por alvo — proteção anti-laço (default 200000)
//
// LGPD: imprime so contagem/ids — nunca telefone/cpf/corpo de comentario/gravacao.

import { openSync, closeSync, writeSync, readFileSync, unlinkSync, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { janelaDeManutencaoAberta, executarBackfillFailClosed } from '../src/mastra/backfill-guardas.ts';
import {
  mapaComentarioParaNota,
  upsertNotas,
  garantirBucketGravacoes,
  subirGravacaoStorage,
} from '../src/mastra/notas.ts';
import {
  CLICKUP_API_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUPABASE_TABLE_LEADS_ESPELHO,
  SUPABASE_TABLE_LIGACOES,
  SUPABASE_TABLE_NOTAS,
} from '../src/mastra/config.ts';

const CLICKUP_BASE_URL = 'https://api.clickup.com/api/v2';

function numeroEnv(nome, def) {
  const n = Number(process.env[nome]);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

const CONFIRMAR_JANELA = process.argv.includes('--confirmar-janela');
const DRY_RUN = process.argv.includes('--dry-run') || !CONFIRMAR_JANELA;

const JANELA = {
  inicioHora: numeroEnv('BACKFILL_JANELA_INICIO', 1),
  fimHora: numeroEnv('BACKFILL_JANELA_FIM', 5),
};
const PAUSA_ID_MS = numeroEnv('BACKFILL_PAUSA_ID_MS', 250);
const PAUSA_ALVO_MS = numeroEnv('BACKFILL_PAUSA_ALVO_MS', 5000);
const MAX_IDS = numeroEnv('BACKFILL_MAX_IDS', 200000);
const LOCK_PATH = process.env.BACKFILL_LOCK_PATH || path.join(os.tmpdir(), 'romerocall-backfill-notas.lock');
const LOCK_ORFAO_MS = 6 * 60 * 60 * 1000; // 6h — acima disso o lock provavelmente e orfao

const SUPA = (SUPABASE_URL || '').replace(/\/+$/, '');
const SUPA_HEADERS = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };

const pausar = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== ClickUp per-ID com retry 4x/90s (molde de backfill-votos-ligacao.mjs) =====
//
// O gateway do ClickUp devolve 500 (timeout interno) quando esta frio; sem retry
// o backfill morre no meio. get_task_comments e POR-ID (sobreviveu ao incidente).
async function pegarClickUp(url) {
  let ultimoErro;
  for (let t = 1; t <= 4; t += 1) {
    try {
      const r = await fetch(url, { headers: { Authorization: CLICKUP_API_TOKEN }, signal: AbortSignal.timeout(90_000) });
      if (r.ok) return await r.json();
      ultimoErro = `HTTP ${r.status}`;
    } catch (e) {
      ultimoErro = e instanceof Error ? e.message : String(e);
    }
    if (t < 4) await pausar(2500 * t);
  }
  throw new Error(`ClickUp falhou apos 4 tentativas (${ultimoErro})`);
}

// ===== Leitura do ESPELHO ja populado (SELECT REST paginado) =====

async function lerColunaEspelho(tabela, coluna, extraFiltro = '') {
  const out = [];
  const passo = 1000;
  let offset = 0;
  while (out.length < MAX_IDS) {
    const url = `${SUPA}/rest/v1/${tabela}?select=${coluna}${extraFiltro}&limit=${passo}&offset=${offset}`;
    let r;
    try {
      r = await fetch(url, { headers: SUPA_HEADERS });
    } catch (e) {
      throw new Error(`falha de rede ao ler ${coluna} de ${tabela}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!r.ok) throw new Error(`HTTP ${r.status} ao ler ${coluna} de ${tabela}`);
    const linhas = await r.json();
    if (!Array.isArray(linhas) || linhas.length === 0) break;
    for (const l of linhas) {
      const v = l?.[coluna];
      if (v !== null && v !== undefined && String(v).trim() !== '') out.push(String(v));
    }
    if (linhas.length < passo) break;
    offset += passo;
  }
  return out;
}

// ===== Alvo 1: comentarios (per-ID, sob pacing) =====

async function backfillComentariosAlvo() {
  const leads = await lerColunaEspelho(SUPABASE_TABLE_LEADS_ESPELHO, 'clickup_task_id');
  const ligacoes = await lerColunaEspelho(SUPABASE_TABLE_LIGACOES, 'clickup_task_id');
  console.log(`[backfill:notas:comentarios] ${leads.length} lead(s) + ${ligacoes.length} ligacao(oes) no espelho — get_task_comments POR-ID`);

  let notasGravadas = 0;
  const processar = async (taskId, aggregate) => {
    const j = await pegarClickUp(`${CLICKUP_BASE_URL}/task/${taskId}/comment`);
    const comentarios = Array.isArray(j?.comments) ? j.comments : [];
    const rows = [];
    for (const c of comentarios) {
      const nota = mapaComentarioParaNota(c, aggregate, taskId);
      if (nota) rows.push(nota);
    }
    if (rows.length > 0) notasGravadas += await upsertNotas(rows);
    await pausar(PAUSA_ID_MS); // teto de page-rate duro per-ID (T-17-05-D)
  };

  for (const id of leads) await processar(id, 'lead');
  for (const id of ligacoes) await processar(id, 'ligacao');

  console.log(`[backfill:notas:comentarios] pronto: ${notasGravadas} nota(s) materializada(s) em ${SUPABASE_TABLE_NOTAS}`);
  return notasGravadas;
}

// ===== Alvo 2: gravacoes -> Supabase Storage (streaming) =====

async function backfillGravacoesAlvo() {
  await garantirBucketGravacoes();
  const linhas = [];
  const passo = 1000;
  let offset = 0;
  while (linhas.length < MAX_IDS) {
    const url = `${SUPA}/rest/v1/${SUPABASE_TABLE_LIGACOES}?select=clickup_task_id,url_gravacao&url_gravacao=not.is.null&limit=${passo}&offset=${offset}`;
    const r = await fetch(url, { headers: SUPA_HEADERS });
    if (!r.ok) throw new Error(`HTTP ${r.status} ao ler gravacoes de ${SUPABASE_TABLE_LIGACOES}`);
    const lote = await r.json();
    if (!Array.isArray(lote) || lote.length === 0) break;
    linhas.push(...lote);
    if (lote.length < passo) break;
    offset += passo;
  }
  console.log(`[backfill:notas:gravacoes] ${linhas.length} ligacao(oes) com url_gravacao a migrar`);

  let migradas = 0;
  for (const l of linhas) {
    const taskId = String(l.clickup_task_id ?? '');
    const url = String(l.url_gravacao ?? '');
    if (!taskId || !url) continue;
    // Idempotencia: se url_gravacao ja e um ponteiro do Storage (nao-http), pula.
    if (!/^https?:\/\//i.test(url)) continue;

    const ponteiro = await subirGravacaoStorage(url, `${taskId}.audio`);
    // Atualiza o ponteiro na linha da ligacao (url_gravacao vira ponteiro do store canonico).
    const patch = await fetch(
      `${SUPA}/rest/v1/${SUPABASE_TABLE_LIGACOES}?clickup_task_id=eq.${encodeURIComponent(taskId)}`,
      {
        method: 'PATCH',
        headers: { ...SUPA_HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ url_gravacao: ponteiro }),
      },
    );
    if (!patch.ok && patch.status !== 404) throw new Error(`HTTP ${patch.status} ao atualizar ponteiro da gravacao`);
    migradas += 1;
    await pausar(PAUSA_ID_MS);
  }
  console.log(`[backfill:notas:gravacoes] pronto: ${migradas} gravacao(oes) migrada(s) para o Storage`);
  return migradas;
}

// ===== Lock de exclusao mutua (I/O real — fora das guardas puras) =====
//
// Fail-closed: um lock existente NUNCA e removido automaticamente por este
// processo (isso seria fail-open). Lock orfao exige remocao HUMANA explicita.

function adquirirLock() {
  try {
    const fd = openSync(LOCK_PATH, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    writeSync(fd, JSON.stringify({ pid: process.pid, iniciadoEm: new Date().toISOString() }));
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      const conteudo = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
      const idadeMin = Math.round((Date.now() - new Date(conteudo.iniciadoEm).getTime()) / 60000);
      const orfao = Date.now() - new Date(conteudo.iniciadoEm).getTime() > LOCK_ORFAO_MS;
      console.error(
        `[backfill:notas] lock ja existe (pid=${conteudo.pid}, idade=${idadeMin}min)${orfao ? ' — PARECE ORFAO (>6h); confirme que nao ha backfill em curso e remova manualmente: rm ' + LOCK_PATH : ''} — recusando (sem operacao concorrente)`,
      );
    } catch {
      console.error(`[backfill:notas] lock ja existe em ${LOCK_PATH} (conteudo ilegivel) — recusando (sem operacao concorrente)`);
    }
    return false;
  }
}

function liberarLock() {
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    /* ja nao existe — tudo bem */
  }
}

// ===== Dry-run: so RELATA o volume LENDO O ESPELHO (nao toca o ClickUp) =====

async function relatarDryRun() {
  const leads = await lerColunaEspelho(SUPABASE_TABLE_LEADS_ESPELHO, 'clickup_task_id');
  const ligacoes = await lerColunaEspelho(SUPABASE_TABLE_LIGACOES, 'clickup_task_id');
  const comGravacao = await lerColunaEspelho(SUPABASE_TABLE_LIGACOES, 'clickup_task_id', '&url_gravacao=not.is.null');
  const comGravacaoHttp = await lerColunaEspelho(SUPABASE_TABLE_LIGACOES, 'url_gravacao', '&url_gravacao=not.is.null');
  const aMigrar = comGravacaoHttp.filter((u) => /^https?:\/\//i.test(u)).length;
  console.log('[backfill:notas] (dry-run) volume a migrar (lido do espelho, ClickUp NAO tocado):');
  console.log(`  task-ids p/ get_task_comments POR-ID : ${leads.length} lead(s) + ${ligacoes.length} ligacao(oes)`);
  console.log(`  ligacoes com url_gravacao            : ${comGravacao.length} (${aMigrar} ainda em URL http a migrar)`);
  console.log('  nada foi gravado. rode com --confirmar-janela (dentro da janela + com lock) para persistir.');
}

// ===== Runner =====

async function main() {
  console.log(
    `[backfill:notas] modo=${DRY_RUN ? 'DRY-RUN/relatorio (nada grava)' : 'GRAVANDO'} janela=${JANELA.inicioHora}h-${JANELA.fimHora}h`,
  );

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL/SUPABASE_SERVICE_KEY ausentes — rode com --env-file=deploy/homolog.env');
    process.exit(1);
  }

  if (DRY_RUN) {
    if (!CONFIRMAR_JANELA) {
      console.log(
        '[backfill:notas] --confirmar-janela ausente: modo relatorio/dry-run por padrao (seguro).\n' +
          '  So dentro de uma janela real, com lock adquirido e --confirmar-janela, este runner hit o\n' +
          '  ClickUp (per-ID) e o Storage — nunca em horario de operacao (RECON-03/R9).',
      );
    }
    await relatarDryRun();
    return;
  }

  if (!CLICKUP_API_TOKEN) {
    console.error('CLICKUP_API_TOKEN ausente — necessario para get_task_comments POR-ID');
    process.exit(1);
  }

  // ===== Modo GRAVANDO: janela + lock + guardas fail-closed do 17-04 =====
  const agora = new Date();
  if (!janelaDeManutencaoAberta(agora, JANELA)) {
    console.error(
      `[backfill:notas] RECUSADO: fora da janela de manutencao (${JANELA.inicioHora}h-${JANELA.fimHora}h, hora local=${agora.getHours()}h). ` +
        'Ajuste BACKFILL_JANELA_INICIO/FIM ou rode dentro da janela combinada.',
    );
    process.exit(1);
  }

  const lockAdquirido = adquirirLock();
  if (!lockAdquirido) {
    console.error('[backfill:notas] RECUSADO: lock de concorrencia nao adquirido (outro backfill/operacao em curso).');
    process.exit(1);
  }

  // Cada alvo (comentarios, gravacoes) e UMA "pagina" da guarda fail-closed:
  // abort-nao-parcial entre alvos + janela/lock revalidados pela guarda.
  const ALVOS = [
    { nome: 'comentarios', fn: backfillComentariosAlvo },
    { nome: 'gravacoes', fn: backfillGravacoesAlvo },
  ];

  try {
    const resultadosPorAlvo = {};
    const resultado = await executarBackfillFailClosed({
      agora,
      janela: JANELA,
      lockAdquirido,
      minIntervaloPaginaMs: PAUSA_ALVO_MS,
      maxPaginas: ALVOS.length,
      onPagina: (pagina, registros) => {
        console.log(`[backfill:notas] alvo ${pagina}/${ALVOS.length} concluido — ${registros} registro(s) acumulado(s)`);
      },
      sync: async (indice) => {
        const alvo = ALVOS[indice];
        console.log(`[backfill:notas:${alvo.nome}] iniciando...`);
        const registros = await alvo.fn();
        resultadosPorAlvo[alvo.nome] = registros;
        return { registros, ultimaPagina: indice === ALVOS.length - 1 };
      },
    });
    console.log(
      `[backfill:notas] CONCLUIDO: ${resultado.paginas} alvo(s), ${resultado.registros} registro(s) no total. ` +
        `Detalhe: ${JSON.stringify(resultadosPorAlvo)}`,
    );
  } catch (e) {
    console.error(`[backfill:notas] ABORTADO: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  } finally {
    liberarLock();
  }
}

main().catch((e) => {
  console.error('[backfill:notas] erro fatal:', e instanceof Error ? e.message : String(e));
  liberarLock();
  process.exit(1);
});
