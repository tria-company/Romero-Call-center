#!/usr/bin/env node
// scripts/resgatar-sem-correlacao.mjs
//
// Fase 19.1 Plano 08 (DUR-07) — resgate REAL dos RECORDs antigos que
// completaram CALADOS por falta de correlação call->task (a correlação
// Redis telefone->task, TTL ~6h, expirou antes do RECORD chegar — ver
// 19.1-08-PLAN.md/19.1-CONTEXT.md). Reconstrói a correlação via ClickUp
// (telefone do evento CALL correspondente + janela de date_created da
// Ligação) e re-enfileira com `taskId` JÁ RESOLVIDO — o worker rewired
// (Plano 08 Task 1, decidirTaskIdRecord) usa `dados.taskId` direto, sem
// depender de novo do TTL da correlação.
//
// RESTRIÇÃO DURA (aprendida no deploy de 22/08): a imagem de produção é
// `.mastra/output` copiada pra /app — SEM `src/` e SEM `scripts/`. Este
// arquivo é STANDALONE: importa SÓ de node_modules empacotados (`bullmq`,
// `ioredis`) + `fetch`/`AbortController` nativos do Node. NUNCA importa
// `src/*.ts` — toda lógica de negócio necessária (extração de telefone,
// nome/ids de campo do ClickUp, nome da chave de dedup) é DUPLICADA aqui,
// com comentário citando a fonte-de-verdade em `src/mastra/*.ts`. Roda
// copiado pra dentro do container (`docker cp`/`docker exec`), não pelo
// bundle do Mastra.
//
// Fluxo por evento RECORD (webhook_eventos, tipo='RECORD', status READY +
// record_url presente — mesmo filtro que o webhook aplica em index.ts):
//   1. Acha o evento CALL de mesmo whatsapp_call_id (webhook_eventos,
//      tipo='CALL') e extrai o telefone do payload dele (RECORD não carrega
//      o telefone — só o webhook original tinha a correlação Redis, já
//      expirada). Sem CALL correspondente/telefone extraível -> SEM-TELEFONE
//      (decisão humana, não força nada às cegas).
//   2. Busca na Lista 02 LIGACOES (ClickUp) as tasks cujo custom field
//      TELEFONE case algum dos candidatos E.164 do telefone (com/sem o 9º
//      dígito móvel — mesmo par de candidatos que o dedupe de inbound de
//      index.ts já usa).
//   3. Casa por JANELA: entre as tasks encontradas, filtra as cujo
//      `date_created` cai no MESMO DIA (UTC) do `recebido_em` do evento
//      RECORD. Achou exatamente 1 -> RESGATÁVEL. 0 ou >1 -> NÃO-RESGATÁVEL
//      (decisão humana — NUNCA chuta a task errada).
//   4. Resgatável e não --dry-run: apaga a chave de dedup `wh:rec:{callId}`
//      (senão `recordJaProcessado` do worker completaria calado de novo) e
//      re-enfileira `record` com `taskId` resolvido, jobId VERSIONADO
//      (`resgate:{callId}:{timestamp}`, nunca colide com o job antigo já
//      completado/removido da fila).
//
// --dry-run: só lista/decide, nunca apaga dedup nem enfileira.
// --ids callId1,callId2,...: alvo explícito por whatsapp_call_id.
// --desde/--ate AAAA-MM-DD: janela de `recebido_em` do evento RECORD.
// Rate-spaced (espaço entre re-enqueues) — mesmo espírito do redrive da DLQ,
// nunca uma rajada que estoura o rate limiter do ClickUp (22/08).
//
// Uso:
//   node --env-file=.env --experimental-strip-types scripts/resgatar-sem-correlacao.mjs --dry-run
//   node --env-file=.env --experimental-strip-types scripts/resgatar-sem-correlacao.mjs \
//     --desde 2026-08-13 --ate 2026-08-21
//
// LGPD: NUNCA imprime telefone nem a recordUrl completa — só
// callId/taskId/contagens/status/motivo (mesmo padrão de resgatar-record-dlq.mjs).

import { Queue } from 'bullmq';
import Redis from 'ioredis';

// ===== Duplicado de src/mastra/config.ts (fonte da verdade) — script standalone =====
const REDIS_URL = process.env.REDIS_URL || '';
const FILA_NOME = process.env.FILA_NOME || 'processamento-ligacao';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_TABLE_WEBHOOK_EVENTOS = process.env.SUPABASE_TABLE_WEBHOOK_EVENTOS || 'webhook_eventos';
const CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN || '';
const CLICKUP_LIST_LIGACOES = process.env.CLICKUP_LIST_LIGACOES || '1000320000002834'; // config.ts:181
const CLICKUP_TIMEOUT_MS = Number(process.env.CLICKUP_TIMEOUT_MS) || 60000; // config.ts
const ESPACO_MS_PADRAO = Number(process.env.DLQ_REDRIVE_ESPACO_MS) || 1500; // config.ts DLQ_REDRIVE_ESPACO_MS
// FILA_MAX_TENTATIVAS (config.ts, Fase 19.1 Plano 04) — retry-infinito capado; duplicado (script
// standalone, sem import de src). O worker em produção já registra `settings.backoffStrategy`
// 'capado' (worker.ts) — este job só referencia o NOME da estratégia, quem calcula o delay é o
// worker rodando de verdade.
const FILA_ATTEMPTS_GRANDE = 1_000_000;

// CAMPOS_LIGACOES.TELEFONE (clickup.ts:98) — field_id fixo, NUNCA resolvido por nome (D-07).
const CAMPO_TELEFONE_LIGACOES = 'e29b4882-bbb9-402e-8ba9-dda2d8418b4b';
const CLICKUP_BASE_URL = 'https://api.clickup.com/api/v2';

// PREFIXO_REC (estado-webhook.ts:263) — dedup app-level do RECORD (SETNX). Precisa ser apagado
// ANTES do re-enqueue, senão `recordJaProcessado` do worker completa calado de novo.
const PREFIXO_REC = 'wh:rec:';

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Duplicado de src/mastra/http.ts (fonte da verdade) — timeout via AbortController. */
async function fetchTimeoutLocal(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Parser de flags — mesmo molde de resgatar-record-dlq.mjs/gerar-lote.mjs. */
export function parseArgs(argv) {
  const opts = { dryRun: false, ids: null, desde: null, ate: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--ids') {
      const valor = String(argv[++i] || '');
      opts.ids = new Set(valor.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg === '--desde') {
      const data = new Date(`${argv[++i]}T00:00:00.000Z`);
      opts.desde = Number.isNaN(data.getTime()) ? null : data.getTime();
    } else if (arg === '--ate') {
      const data = new Date(`${argv[++i]}T23:59:59.999Z`);
      opts.ate = Number.isNaN(data.getTime()) ? null : data.getTime();
    }
  }
  return opts;
}

/**
 * Duplicado de `telefoneDoEventoCall` (src/mastra/index.ts:792, fonte da
 * verdade) — extrai o telefone (só dígitos) do payload de um evento CALL
 * conforme a direção. PURO.
 */
export function extrairTelefoneDoPayloadCall(payload) {
  const direction = String(payload?.direction || '').toUpperCase();
  const raw = direction === 'INCOMING' ? String(payload?.caller || '') : String(payload?.receiver || payload?.caller || '');
  return raw.replace(/[^\d]/g, '');
}

/** Duplicado de `semNonoDigito` (estado-webhook.ts:51) — remove o 9º dígito móvel BR quando presente. PURO. */
function semNonoDigito(digitos) {
  if (digitos.length === 13 && digitos.startsWith('55') && digitos[4] === '9') {
    return digitos.slice(0, 4) + digitos.slice(5);
  }
  if (digitos.length === 11 && digitos[2] === '9') {
    return digitos.slice(0, 2) + digitos.slice(3);
  }
  return digitos;
}

/**
 * Duplicado do par de candidatos E.164 usado pelo dedupe de inbound
 * (index.ts:248-252) — a Ligação pode ter o TELEFONE gravado COM ou SEM o
 * 9º dígito móvel, então consultamos os dois. PURO.
 */
export function candidatosTelefoneE164(telefoneDigitos) {
  const d = String(telefoneDigitos || '').replace(/\D/g, '');
  if (!d) return [];
  const comPais = d.length >= 12 ? d : `55${d}`;
  const cands = new Set([`+${comPais}`]);
  if (comPais.length === 12) cands.add(`+${comPais.slice(0, 4)}9${comPais.slice(4)}`);
  if (comPais.length === 13 && comPais[4] === '9') cands.add(`+${comPais.slice(0, 4)}${comPais.slice(5)}`);
  return [...cands];
}

/** Dia UTC (YYYY-MM-DD) de um epoch ms — usado para casar a JANELA de date_created x recebido_em. PURO. */
export function diaUtc(msEpoch) {
  return new Date(msEpoch).toISOString().slice(0, 10);
}

/**
 * Casa a Ligação por JANELA de data: entre as tasks candidatas (já
 * filtradas por TELEFONE no ClickUp), mantém só as cujo `date_created` cai
 * no MESMO DIA (UTC) de `recebidoEmMs` (recebido_em do evento RECORD).
 * Exatamente 1 -> resgatável. 0 ou >1 -> NÃO-RESGATÁVEL (decisão humana,
 * T-19.1-08-Wrong — nunca chuta a task errada). PURO.
 */
export function casarLigacaoPorJanela(tasksCandidatas, recebidoEmMs) {
  const diaAlvo = diaUtc(recebidoEmMs);
  const naJanela = (tasksCandidatas || []).filter((t) => {
    const dc = Number(t?.date_created);
    return Number.isFinite(dc) && diaUtc(dc) === diaAlvo;
  });
  if (naJanela.length === 0) return { resgatavel: false, motivo: 'nao-encontrada', candidatos: 0 };
  if (naJanela.length > 1) return { resgatavel: false, motivo: 'ambigua', candidatos: naJanela.length };
  return { resgatavel: true, taskId: naJanela[0].id, candidatos: 1 };
}

/** jobId VERSIONADO (T-19.1-08-Dup) — nunca colide com o job antigo (já completado/removido). PURO. */
export function montarJobIdResgate(callId, agoraMs = Date.now()) {
  return `resgate:${callId}:${agoraMs}`;
}

/**
 * Elegibilidade do evento RECORD — mesmo gate que o webhook aplica em
 * index.ts (`recordStatus !== 'READY' || !recordUrl` -> ignorado). PURO.
 */
export function recordElegivel(payload) {
  const recordStatus = String(payload?.record_status || payload?.status || '').toUpperCase();
  const recordUrl = String(payload?.record_url || payload?.recordUrl || '');
  return { elegivel: recordStatus === 'READY' && Boolean(recordUrl), recordUrl };
}

/** Chave de dedup app-level do RECORD (estado-webhook.ts PREFIXO_REC). PURO. */
export function chaveDedupRecord(callId) {
  return PREFIXO_REC + callId;
}

/**
 * Orquestração principal — seam injetável (`buscarEventosRecordImpl`/
 * `buscarEventoCallImpl`/`buscarTasksPorTelefoneImpl`/`fila`/`redis`) para o
 * smoke offline exercitar a lógica real sem Supabase/ClickUp/Redis/BullMQ.
 * Em produção, `main()` chama com as implementações reais (REST/Queue/ioredis).
 */
export async function resgatarSemCorrelacao({
  buscarEventosRecordImpl,
  buscarEventoCallImpl,
  buscarTasksPorTelefoneImpl,
  fila = null,
  redis = null,
  dryRun = false,
  ids = null,
  desde = null,
  ate = null,
  espacoMs = ESPACO_MS_PADRAO,
  logger = console,
} = {}) {
  const resultado = {
    totalEventos: 0,
    elegiveis: 0,
    semTelefone: 0,
    resgatados: 0,
    naoResgatavelAmbigua: 0,
    naoResgatavelNaoAchada: 0,
  };

  const eventos = await buscarEventosRecordImpl({ ids, desde, ate });
  resultado.totalEventos = eventos.length;
  logger.log(`[resgatar-sem-correlacao] ${eventos.length} evento(s) RECORD encontrados (apos filtro)`);

  for (const evt of eventos) {
    const callId = String(evt.whatsapp_call_id || '');
    const { elegivel, recordUrl } = recordElegivel(evt.payload);
    if (!elegivel) continue; // mesmo gate do webhook (status!=READY ou sem record_url) — nao e alvo
    resultado.elegiveis++;

    const callPayload = await buscarEventoCallImpl(callId);
    const telefone = callPayload ? extrairTelefoneDoPayloadCall(callPayload) : '';
    if (!telefone) {
      resultado.semTelefone++;
      logger.warn(`[resgatar-sem-correlacao] call=${callId} SEM telefone extraivel (evento CALL ausente/sem direcao util) -> NAO-RESGATAVEL-AUTOMATICAMENTE`);
      continue;
    }

    const candidatos = candidatosTelefoneE164(telefone);
    const tasks = await buscarTasksPorTelefoneImpl(candidatos);
    const decisao = casarLigacaoPorJanela(tasks, new Date(evt.recebido_em).getTime());

    if (!decisao.resgatavel) {
      if (decisao.motivo === 'ambigua') resultado.naoResgatavelAmbigua++;
      else resultado.naoResgatavelNaoAchada++;
      logger.warn(
        `[resgatar-sem-correlacao] call=${callId} NAO-RESGATAVEL-AUTOMATICAMENTE motivo=${decisao.motivo} candidatos=${decisao.candidatos} -> decisao humana`,
      );
      continue;
    }

    if (dryRun) {
      resultado.resgatados++;
      logger.log(`[resgatar-sem-correlacao] call=${callId} taskId=${decisao.taskId} -> RESGATAVEL (dry-run, nao re-enfileirado)`);
      continue;
    }

    if (redis) {
      try {
        await redis.del(chaveDedupRecord(callId));
      } catch (e) {
        logger.error(`[resgatar-sem-correlacao] call=${callId} falha ao limpar dedup (seguindo mesmo assim):`, e instanceof Error ? e.message : String(e));
      }
    }

    const jobId = montarJobIdResgate(callId);
    try {
      await fila.add(
        'record',
        {
          whatsappCallId: callId,
          telefone,
          recordUrl,
          payload: evt.payload,
          eventoDuravelId: evt.id ?? null,
          taskId: decisao.taskId,
        },
        {
          jobId,
          attempts: FILA_ATTEMPTS_GRANDE,
          backoff: { type: 'capado' },
          removeOnComplete: { count: 1000 },
          removeOnFail: false,
        },
      );
      resultado.resgatados++;
      logger.log(`[resgatar-sem-correlacao] call=${callId} taskId=${decisao.taskId} jobId=${jobId} -> RE-ENFILEIRADO`);
    } catch (e) {
      logger.error(`[resgatar-sem-correlacao] call=${callId} falha ao re-enfileirar:`, e instanceof Error ? e.message : String(e));
      continue;
    }

    // Rate-spacing: mesmo espirito do redrive da DLQ — nunca uma rajada que
    // estoura o rate limiter do ClickUp (aconteceu no re-drive manual de 22/08).
    await esperar(espacoMs);
  }

  return resultado;
}

// ===== Implementacoes REAIS (Supabase REST + ClickUp REST + BullMQ/ioredis) =====

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function buscarEventosRecordReal({ ids, desde, ate }) {
  const params = new URLSearchParams({
    select: 'id,whatsapp_call_id,payload,recebido_em',
    tipo: 'eq.RECORD',
    order: 'recebido_em.asc',
  });
  if (ids && ids.size > 0) params.set('whatsapp_call_id', `in.(${[...ids].join(',')})`);
  if (desde !== null) params.append('recebido_em', `gte.${new Date(desde).toISOString()}`);
  if (ate !== null) params.append('recebido_em', `lte.${new Date(ate).toISOString()}`);

  const res = await fetchTimeoutLocal(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE_WEBHOOK_EVENTOS}?${params.toString()}`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) {
    throw new Error(`[supabase] HTTP ${res.status} ao buscar eventos RECORD em ${SUPABASE_TABLE_WEBHOOK_EVENTOS}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function buscarEventoCallReal(callId) {
  if (!callId) return null;
  const params = new URLSearchParams({
    select: 'payload',
    tipo: 'eq.CALL',
    whatsapp_call_id: `eq.${callId}`,
    order: 'recebido_em.desc',
    limit: '1',
  });
  const res = await fetchTimeoutLocal(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE_WEBHOOK_EVENTOS}?${params.toString()}`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) {
    throw new Error(`[supabase] HTTP ${res.status} ao buscar evento CALL correlato`);
  }
  const data = await res.json();
  return Array.isArray(data) && data[0] ? data[0].payload : null;
}

async function listarTasksClickUpPorTelefone(telefoneE164) {
  const params = new URLSearchParams({
    page: '0',
    include_closed: 'true',
    custom_fields: JSON.stringify([{ field_id: CAMPO_TELEFONE_LIGACOES, operator: '=', value: telefoneE164 }]),
  });
  const res = await fetchTimeoutLocal(
    `${CLICKUP_BASE_URL}/list/${CLICKUP_LIST_LIGACOES}/task?${params.toString()}`,
    { headers: { Authorization: CLICKUP_API_TOKEN, 'Content-Type': 'application/json' } },
    CLICKUP_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`[clickup] GET /list/${CLICKUP_LIST_LIGACOES}/task falhou (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

async function buscarTasksPorTelefoneReal(candidatosE164) {
  const porId = new Map();
  for (const cand of candidatosE164) {
    const tasks = await listarTasksClickUpPorTelefone(cand);
    for (const t of tasks) {
      if (t?.id) porId.set(t.id, { id: t.id, date_created: t.date_created });
    }
    // Serializa as consultas por candidato — este script NAO tem acesso ao
    // rate-limiter global (adquirirToken, src/mastra/rate-limiter-clickup.ts,
    // fora do alcance standalone); um pequeno espaco evita rajada.
    await esperar(300);
  }
  return [...porId.values()];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!REDIS_URL) {
    console.error('[resgatar-sem-correlacao] REDIS_URL ausente — sem fila BullMQ, nao ha o que resgatar');
    process.exitCode = 1;
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[resgatar-sem-correlacao] SUPABASE_URL/SUPABASE_SERVICE_KEY ausentes — sem acesso a webhook_eventos');
    process.exitCode = 1;
    return;
  }
  if (!CLICKUP_API_TOKEN) {
    console.error('[resgatar-sem-correlacao] CLICKUP_API_TOKEN ausente — nao da para casar telefone->Ligacao');
    process.exitCode = 1;
    return;
  }

  console.log(
    `[resgatar-sem-correlacao] iniciando: dry-run=${opts.dryRun}` +
      (opts.ids ? ` ids=${opts.ids.size}` : '') +
      (opts.desde !== null ? ` desde=${new Date(opts.desde).toISOString().slice(0, 10)}` : '') +
      (opts.ate !== null ? ` ate=${new Date(opts.ate).toISOString().slice(0, 10)}` : ''),
  );

  const fila = new Queue(FILA_NOME, {
    connection: { url: REDIS_URL, maxRetriesPerRequest: 2, enableOfflineQueue: false, connectTimeout: 5000 },
  });
  fila.on('error', (e) => {
    console.error('[resgatar-sem-correlacao] erro de conexao Redis (fila):', e instanceof Error ? e.message : String(e));
  });
  const redis = opts.dryRun ? null : new Redis(REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 5000 });
  if (redis) {
    redis.on('error', (e) => {
      console.error('[resgatar-sem-correlacao] erro de conexao Redis (dedup):', e instanceof Error ? e.message : String(e));
    });
  }

  try {
    const resultado = await resgatarSemCorrelacao({
      buscarEventosRecordImpl: buscarEventosRecordReal,
      buscarEventoCallImpl: buscarEventoCallReal,
      buscarTasksPorTelefoneImpl: buscarTasksPorTelefoneReal,
      fila,
      redis,
      dryRun: opts.dryRun,
      ids: opts.ids,
      desde: opts.desde,
      ate: opts.ate,
    });
    console.log(
      `[resgatar-sem-correlacao] RESUMO: total-eventos=${resultado.totalEventos} elegiveis=${resultado.elegiveis} ` +
        `sem-telefone=${resultado.semTelefone} resgatados=${resultado.resgatados} ` +
        `nao-resgatavel-ambigua=${resultado.naoResgatavelAmbigua} nao-resgatavel-nao-achada=${resultado.naoResgatavelNaoAchada}` +
        (opts.dryRun ? ' (dry-run — nenhum job foi re-enfileirado de fato)' : ''),
    );
  } finally {
    await fila.close();
    if (redis) await redis.quit();
  }
}

const chamadoDiretamente = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (chamadoDiretamente) {
  main().catch((e) => {
    console.error('[resgatar-sem-correlacao] falha fatal:', e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
