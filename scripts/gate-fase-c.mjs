#!/usr/bin/env node
// scripts/gate-fase-c.mjs
//
// Gate kill-between-writes das RPCs NOVAS da Fase C (Phase 20 Plano 03,
// sql/escala/24/25/26): hml_registrar_envio_audio (+ o par
// hml_registrar_mensagem_texto — mesmo arquivo/molde), hml_registrar_anotacao,
// hml_gerar_lote. Prova o invariante both-or-neither (a escrita do
// agregado/SoT e o INSERT no outbox ou acontecem JUNTOS ou nenhum acontece) —
// mesmo design §3.0/§3.1 do 18/19-10, molde EXATO de
// scripts/kill-between-writes-fase-b.gate.mjs.
//
// DOIS MODOS (design deste plano — 20-08):
//
//  --offline (DETERMINÍSTICO, SEM REDE): prova ESTRUTURAL — lê os 3 arquivos
//    .sql fonte (24/25/26) e verifica, por RPC, que a escrita do agregado e o
//    INSERT no outbox vivem no MESMO corpo `create or replace function ... as
//    $$ ... $$` (uma chamada PostgREST = uma transação Postgres, design
//    §3.0), NA ORDEM correta (agregado ANTES do outbox), sem
//    BEGIN/COMMIT/ROLLBACK aninhado (que quebraria essa garantia), com
//    `on conflict (dedup_key) do nothing` em cada INSERT no outbox
//    (idempotência), `security invoker` + `search_path` fixo, tabelas SEMPRE
//    com o prefixo `hml_` dentro da função gêmea (T-19-10-Th/Ti), e
//    `EXECUTE` revogado de `public`/concedido só a `service_role`. Isto é uma
//    prova de CONSTRUÇÃO (a atomicidade é garantida pela semântica do
//    Postgres — uma função = uma transação implícita), rodável em CI sem
//    infra nenhuma. NÃO substitui a prova ao vivo — é o oráculo do <verify>
//    automatizado deste plano (Task 1) e a primeira linha de defesa contra
//    regressão estrutural (ex.: alguém mover o INSERT do outbox para FORA da
//    função, ou esquecer o gêmeo hml_).
//
//  AO VIVO (default, sem --offline; molde EXATO de
//    kill-between-writes-fase-b.gate.mjs): mata o processo/conexão no MEIO da
//    transação real, server-side (pg_terminate_backend), via uma RPC de
//    TESTE-ESPELHO com um `pg_sleep` posicionado ENTRE a escrita do
//    agregado/SoT e o INSERT no outbox — prova EMPÍRICA (não só estrutural)
//    de que a escrita do agregado (aplicada mas não commitada) rola de volta
//    JUNTO com o INSERT que nunca chegou a rodar. Exige env real do homolog
//    (SUPABASE_URL/SUPABASE_SERVICE_KEY + as tabelas/RPC hml_) — RECUSA rodar
//    contra produção (guarda de identificador hml_, igual ao 18/19-10). É o
//    passo 2 do checkpoint de operador (20-08 Task 2).
//
// LGPD: sentinels sintéticos (GATETEST-<runId>-*/GATELEAD-<runId>-*), nunca
// telefone/CPF real. Nunca loga a service key nem payload.
//
// Uso:
//   node --experimental-strip-types scripts/gate-fase-c.mjs --offline
//   node --experimental-strip-types --env-file=deploy/homolog.env scripts/gate-fase-c.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAIZ_REPO = fileURLToPath(new URL('..', import.meta.url));
const MODO_OFFLINE = process.argv.includes('--offline');

// ============================================================================
// ===== MODO OFFLINE — prova ESTRUTURAL (sem rede) ==========================
// ============================================================================

/** Extrai o corpo `create or replace function <nome>(...) ... $$;` — cada
 *  função das migrações 24/25/26 tem EXATAMENTE um par de delimitadores `$$`
 *  (abre em `as $$`, fecha em `$$;`), então o primeiro `$$;` DEPOIS do início
 *  é sempre o fechamento certo (verificado contra os 3 arquivos-fonte). */
function extrairCorpo(sqlTexto, nomeFuncao) {
  const marcadorInicio = `create or replace function ${nomeFuncao}(`;
  const inicio = sqlTexto.indexOf(marcadorInicio);
  if (inicio === -1) return null;
  const fim = sqlTexto.indexOf('$$;', inicio);
  if (fim === -1) return null;
  return sqlTexto.slice(inicio, fim + 3);
}

/** Índice da primeira ocorrência de qualquer um dos padrões em `corpo`
 *  (-1 se nenhum casar) — usado pra achar "a escrita do agregado" quando o
 *  padrão varia por RPC (INSERT direto vs. INSERT...SELECT). */
function primeiroIndice(corpo, padroes) {
  let melhor = -1;
  for (const p of padroes) {
    const i = corpo.toLowerCase().indexOf(p.toLowerCase());
    if (i !== -1 && (melhor === -1 || i < melhor)) melhor = i;
  }
  return melhor;
}

function contarOcorrencias(corpo, padrao) {
  return (corpo.match(new RegExp(padrao, 'gi')) || []).length;
}

/** Tabelas que DEVEM aparecer só com prefixo hml_ dentro do corpo de uma
 *  função gêmea de homolog — qualquer referência SEM o prefixo é um vazamento
 *  pra produção (T-19-10-Th/Ti). `canonizar_telefone`/`variantes_telefone`
 *  (20-01) são funções puras/table-agnósticas SEM gêmeo hml_ — excluídas
 *  desta checagem de propósito (decisão registrada no 20-01-SUMMARY.md). */
function referenciaTabelaSemPrefixoHml(corpo, tabelas) {
  for (const tabela of tabelas) {
    const re = new RegExp(`(?<!hml_)\\b${tabela}\\b`, 'i');
    if (re.test(corpo)) return tabela;
  }
  return null;
}

function checarInvarianteEstrutural(spec) {
  const falhas = [];
  const corpo = extrairCorpo(spec.sqlTexto, spec.nomeFuncaoHml);
  if (!corpo) {
    falhas.push(`${spec.rotulo}: função ${spec.nomeFuncaoHml} não encontrada em ${spec.arquivo}`);
    return falhas;
  }

  const idxAgregado = primeiroIndice(corpo, spec.padroesAgregado);
  const idxOutbox = primeiroIndice(corpo, [`insert into ${spec.tabelaOutboxHml}`]);
  if (idxAgregado === -1) falhas.push(`${spec.rotulo}: escrita do agregado (${spec.padroesAgregado.join(' | ')}) não encontrada`);
  if (idxOutbox === -1) falhas.push(`${spec.rotulo}: INSERT no outbox (${spec.tabelaOutboxHml}) não encontrado`);
  if (idxAgregado !== -1 && idxOutbox !== -1 && idxAgregado >= idxOutbox) {
    falhas.push(`${spec.rotulo}: a escrita do agregado deveria vir ANTES do INSERT no outbox no mesmo corpo (ordem both-or-neither) — encontrado invertido`);
  }

  if (/\b(begin\s+transaction|start\s+transaction|commit\s*;|rollback\s*;)\b/i.test(corpo)) {
    falhas.push(`${spec.rotulo}: corpo contém BEGIN/COMMIT/ROLLBACK explícito — quebraria a garantia de 1-chamada-PostgREST=1-transação (design §3.0)`);
  }
  if (!/security invoker/i.test(corpo)) falhas.push(`${spec.rotulo}: função sem 'security invoker'`);
  if (!/set search_path = pg_catalog, public/i.test(corpo)) falhas.push(`${spec.rotulo}: função sem 'set search_path = pg_catalog, public' fixado`);

  const nInsertsOutbox = contarOcorrencias(corpo, `insert into ${spec.tabelaOutboxHml}`);
  const nOnConflictDedup = contarOcorrencias(corpo, 'on conflict \\(dedup_key\\) do nothing');
  if (nInsertsOutbox === 0) {
    falhas.push(`${spec.rotulo}: nenhum INSERT no outbox encontrado`);
  } else if (nOnConflictDedup < nInsertsOutbox) {
    falhas.push(
      `${spec.rotulo}: ${nInsertsOutbox} INSERT(s) no outbox mas só ${nOnConflictDedup} com 'on conflict (dedup_key) do nothing' — idempotência não garantida em algum`,
    );
  }

  const semPrefixo = referenciaTabelaSemPrefixoHml(corpo, spec.tabelasQueDevemSerHml);
  if (semPrefixo) {
    falhas.push(`${spec.rotulo}: referência a '${semPrefixo}' SEM prefixo hml_ dentro da função gêmea de homolog — vazaria escrita pra produção`);
  }

  return falhas;
}

function checarGrantsERecarga(spec) {
  const falhas = [];
  const revoke = new RegExp(`revoke all on function ${spec.nomeFuncaoHml}\\(`, 'i');
  const grant = new RegExp(`grant execute on function ${spec.nomeFuncaoHml}\\([^)]*\\) to service_role;`, 'i');
  if (!revoke.test(spec.sqlTexto)) falhas.push(`${spec.rotulo}: sem 'revoke all ... from public' para ${spec.nomeFuncaoHml}`);
  if (!grant.test(spec.sqlTexto)) falhas.push(`${spec.rotulo}: sem 'grant execute ... to service_role' para ${spec.nomeFuncaoHml}`);
  if (!/notify pgrst, 'reload schema';/i.test(spec.sqlTexto)) {
    falhas.push(`${spec.rotulo}: arquivo ${spec.arquivo} sem 'notify pgrst, ''reload schema''' no final`);
  }
  return falhas;
}

function rodarModoOffline() {
  console.log(
    '[gate-fase-c] modo --offline — prova ESTRUTURAL (sem rede): cada RPC nova é UMA função ' +
      'plpgsql (uma chamada PostgREST = uma transação Postgres, design §3.0); verifica ordem ' +
      'agregado→outbox, idempotência, isolamento hml_ e grants nos 3 arquivos-fonte.',
  );

  const specs = [
    {
      rotulo: 'envio_audio (hml_registrar_envio_audio + par hml_registrar_mensagem_texto)',
      arquivo: 'sql/escala/24_rpc_registrar_envio_audio.sql',
      nomeFuncaoHml: 'hml_registrar_envio_audio',
      padroesAgregado: ['insert into hml_audios_envios'],
      tabelaOutboxHml: 'hml_clickup_outbox',
      tabelasQueDevemSerHml: ['audios_envios', 'clickup_outbox'],
    },
    {
      rotulo: 'anotacao (hml_registrar_anotacao)',
      arquivo: 'sql/escala/25_rpc_registrar_anotacao.sql',
      nomeFuncaoHml: 'hml_registrar_anotacao',
      padroesAgregado: ['insert into hml_notas'],
      tabelaOutboxHml: 'hml_clickup_outbox',
      tabelasQueDevemSerHml: ['notas', 'clickup_outbox'],
    },
    {
      rotulo: 'gerar_lote (hml_gerar_lote)',
      arquivo: 'sql/escala/26_rpc_gerar_lote.sql',
      nomeFuncaoHml: 'hml_gerar_lote',
      padroesAgregado: ['insert into hml_ligacoes'],
      tabelaOutboxHml: 'hml_clickup_outbox',
      tabelasQueDevemSerHml: ['discador_leads_espelho', 'ligacoes', 'clickup_outbox'],
    },
  ];

  const falhas = [];
  for (const spec of specs) {
    spec.sqlTexto = readFileSync(`${RAIZ_REPO}${spec.arquivo}`, 'utf8');
    falhas.push(...checarInvarianteEstrutural(spec));
    falhas.push(...checarGrantsERecarga(spec));
  }

  // hml_registrar_mensagem_texto — mesmo par/arquivo de envio_audio, mesmo molde
  // byte-a-byte (20-03-SUMMARY.md); checado como parte da MESMA RPC/spec
  // (o dispatcher montarBodyDoAudio, 20-02, trata os dois 'tipo' idênticamente).
  {
    const specMsg = {
      rotulo: 'envio_audio → par hml_registrar_mensagem_texto',
      arquivo: 'sql/escala/24_rpc_registrar_envio_audio.sql',
      nomeFuncaoHml: 'hml_registrar_mensagem_texto',
      padroesAgregado: ['insert into hml_audios_envios'],
      tabelaOutboxHml: 'hml_clickup_outbox',
      tabelasQueDevemSerHml: ['audios_envios', 'clickup_outbox'],
      sqlTexto: specs[0].sqlTexto,
    };
    falhas.push(...checarInvarianteEstrutural(specMsg));
    falhas.push(...checarGrantsERecarga(specMsg));
  }

  if (falhas.length > 0) {
    console.error('=== GATE FAIL (offline) ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('GATE OK (offline): both-or-neither PROVADO ESTRUTURALMENTE para as 3 RPCs novas:');
  console.log('  - envio_audio: hml_registrar_envio_audio + hml_registrar_mensagem_texto — audios_envios antes de clickup_outbox, idempotente, hml_-isolado');
  console.log('  - anotacao: hml_registrar_anotacao — notas antes de clickup_outbox, idempotente, hml_-isolado');
  console.log('  - gerar_lote: hml_gerar_lote — ligacoes (loop RETURNING) antes de clickup_outbox por linha, idempotente, hml_-isolado');
  console.log('  (prova de construção — a prova EMPÍRICA via pg_terminate_backend é o modo AO VIVO deste mesmo script, rodado pelo operador no homolog)');
  process.exit(0);
}

if (MODO_OFFLINE) {
  rodarModoOffline();
}

// ============================================================================
// ===== MODO AO VIVO (default) — molde EXATO de
// scripts/kill-between-writes-fase-b.gate.mjs, adaptado às 3 RPCs novas =====
// ============================================================================

const { comOutboxRpc } = await import('../src/mastra/outbox-rpc.ts');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const TABELA_AUDIOS = process.env.SUPABASE_TABLE_AUDIOS_ENVIOS || '';
const TABELA_NOTAS = process.env.SUPABASE_TABLE_NOTAS || '';
const TABELA_LIGACOES = process.env.SUPABASE_TABLE_LIGACOES || '';
const TABELA_OUTBOX = process.env.SUPABASE_TABLE_CLICKUP_OUTBOX || '';

const RPC_ENVIO_AUDIO = process.env.SUPABASE_RPC_REGISTRAR_ENVIO_AUDIO || '';
const RPC_ANOTACAO = process.env.SUPABASE_RPC_REGISTRAR_ANOTACAO || '';
const RPC_GERAR_LOTE = process.env.SUPABASE_RPC_GERAR_LOTE || '';

const GATE_CONTROLE_ITERS = Number(process.env.GATE_CONTROLE_ITERS) || 4;
const GATE_KILL_ITERS = Number(process.env.GATE_KILL_ITERS) || 6;
const GATE_SANIDADE_ITERS = Number(process.env.GATE_SANIDADE_ITERS) || 2;
const GATE_WINDOW_MS = Number(process.env.GATE_WINDOW_MS) || 2000;
const GATE_POLL_INTERVAL_MS = Number(process.env.GATE_POLL_INTERVAL_MS) || 50;
const GATE_POLL_DEADLINE_MS = Number(process.env.GATE_POLL_DEADLINE_MS) || 1500;
const GATE_MIN_KILL_NEITHER = Number(process.env.GATE_MIN_KILL_NEITHER) || 3;

const RE_IDENTIFICADOR_HML = /^hml_[a-z0-9_]+$/;

function exigirIdentificadorHml(valor, rotulo) {
  if (!valor || !RE_IDENTIFICADOR_HML.test(valor)) {
    console.error(
      `[gate-fase-c] ABORTANDO: ${rotulo}="${valor}" não é um identificador hml_ seguro ` +
        `(precisa casar ${RE_IDENTIFICADOR_HML}) — o gate exige tabelas/RPC hml_ ` +
        'com identificador seguro — recusando rodar contra produção. ' +
        '(Para a prova ESTRUTURAL determinística sem env, use --offline.)',
    );
    process.exit(1);
  }
}

if (!SUPABASE_URL) {
  console.error('[gate-fase-c] ABORTANDO: SUPABASE_URL ausente (modo ao vivo exige --env-file=deploy/homolog.env, ou use --offline).');
  process.exit(1);
}
if (!SUPABASE_SERVICE_KEY) {
  console.error('[gate-fase-c] ABORTANDO: SUPABASE_SERVICE_KEY ausente.');
  process.exit(1);
}
exigirIdentificadorHml(TABELA_AUDIOS, 'SUPABASE_TABLE_AUDIOS_ENVIOS');
exigirIdentificadorHml(TABELA_NOTAS, 'SUPABASE_TABLE_NOTAS');
exigirIdentificadorHml(TABELA_LIGACOES, 'SUPABASE_TABLE_LIGACOES');
exigirIdentificadorHml(TABELA_OUTBOX, 'SUPABASE_TABLE_CLICKUP_OUTBOX');
exigirIdentificadorHml(RPC_ENVIO_AUDIO, 'SUPABASE_RPC_REGISTRAR_ENVIO_AUDIO');
exigirIdentificadorHml(RPC_ANOTACAO, 'SUPABASE_RPC_REGISTRAR_ANOTACAO');
exigirIdentificadorHml(RPC_GERAR_LOTE, 'SUPABASE_RPC_GERAR_LOTE');

if (GATE_POLL_DEADLINE_MS >= GATE_WINDOW_MS) {
  console.error(
    `[gate-fase-c] ABORTANDO: GATE_POLL_DEADLINE_MS (${GATE_POLL_DEADLINE_MS}) precisa ser ` +
      `< GATE_WINDOW_MS (${GATE_WINDOW_MS}).`,
  );
  process.exit(1);
}

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const HEADERS_PG = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function pgQuery(sql) {
  const r = await fetch(`${SUPABASE_URL}/pg/query`, {
    method: 'POST',
    headers: HEADERS_PG,
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(30_000),
  });
  const texto = await r.text();
  if (!r.ok) {
    throw new Error(`[gate-fase-c] pgQuery HTTP ${r.status} — ${texto.slice(0, 300)}`);
  }
  if (!texto) return [];
  return JSON.parse(texto);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function contarOutbox(dedupKey) {
  const linhas = await pgQuery(
    `select count(*)::int as n from ${TABELA_OUTBOX} where dedup_key = '${dedupKey}';`,
  );
  return linhas[0]?.n ?? 0;
}

// ===== Specs — uma por RPC nova da Fase C =====

const specs = [];

// ---- registrar_envio_audio -------------------------------------------------
// Marcador único vai em lead_clickup_task_id (audios_envios não tem coluna de
// telefone) — mesma simplificação da spec 'avulsa' do molde fase-b: o
// pg_sleep fica entre o INSERT no agregado e o INSERT no outbox; matar na
// janela rola de volta os dois.
{
  const rpcTeste = `${RPC_ENVIO_AUDIO}_gatetest`;
  exigirIdentificadorHml(rpcTeste, 'rpcTeste envio_audio (derivado)');
  specs.push({
    slug: 'envio_audio',
    rotulo: 'envio_audio',
    rpcReal: RPC_ENVIO_AUDIO,
    rpcTeste,
    ddl: `
create or replace function ${rpcTeste}(p_lead_clickup_task_id text, p_telefone_canonico text, p_enviado_por text, p_sleep_ms int)
returns bigint language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_id bigint;
begin
  insert into ${TABELA_AUDIOS} (lead_clickup_task_id, lead_id, tipo, corpo, transcricao_audio, midia_ref, enviado_em)
  values (p_lead_clickup_task_id, null, 'audio', null, null, null, now())
  returning id into v_id;
  if p_sleep_ms > 0 then perform pg_sleep(p_sleep_ms / 1000.0); end if;
  insert into ${TABELA_OUTBOX} (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values ('audio', v_id, 'criar_task', true,
          jsonb_build_object('origem', 'envio', 'telefone_canonico', p_telefone_canonico, 'enviado_por', p_enviado_por),
          'audio:' || v_id || ':criar', 1)
  on conflict (dedup_key) do nothing;
  return v_id;
end;$$;`,
    dropSql: `drop function if exists ${rpcTeste}(text, text, text, int);`,
    async semear(uid) {
      const leadCt = `GATELEAD-${runId}-audio-${uid}`;
      const canon = `GATETEST-${runId}-audio-${uid}`;
      const operador = `op-${runId}-${uid}`;
      return { leadCt, canon, operador };
    },
    chamada(ctx, sleepMs) {
      return `${rpcTeste}('${ctx.leadCt}', '${ctx.canon}', '${ctx.operador}', ${sleepMs})`;
    },
    async verificar(ctx) {
      const a = (await pgQuery(`select id from ${TABELA_AUDIOS} where lead_clickup_task_id = '${ctx.leadCt}' limit 1;`))[0];
      const aplicado = !!a?.id;
      const outboxPresente = aplicado ? (await contarOutbox(`audio:${a.id}:criar`)) === 1 : false;
      return { aplicado, outboxPresente };
    },
    async sanidade(ctx) {
      await comOutboxRpc(this.rpcReal, {
        p_lead_clickup_task_id: ctx.leadCt,
        p_lead_id: null,
        p_telefone_canonico: ctx.canon,
        p_enviado_por: ctx.operador,
        p_midia_ref: null,
        p_transcricao: null,
      });
    },
    async limpar(ctx) {
      await pgQuery(
        `delete from ${TABELA_OUTBOX} where aggregate_id in (select id from ${TABELA_AUDIOS} where lead_clickup_task_id='${ctx.leadCt}');`,
      );
      await pgQuery(`delete from ${TABELA_AUDIOS} where lead_clickup_task_id = '${ctx.leadCt}';`);
    },
  });
}

// ---- registrar_anotacao -----------------------------------------------------
// Marcador único vai em corpo (texto livre) — usado só pra achar a linha
// semeada; nunca telefone/CPF real.
{
  const rpcTeste = `${RPC_ANOTACAO}_gatetest`;
  exigirIdentificadorHml(rpcTeste, 'rpcTeste anotacao (derivado)');
  specs.push({
    slug: 'anotacao',
    rotulo: 'anotacao',
    rpcReal: RPC_ANOTACAO,
    rpcTeste,
    ddl: `
create or replace function ${rpcTeste}(p_clickup_task_id text, p_autor text, p_corpo text, p_sleep_ms int)
returns bigint language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_id bigint;
begin
  insert into ${TABELA_NOTAS} (aggregate, aggregate_id, autor, corpo, criado_em)
  values ('lead', null, p_autor, p_corpo, now())
  returning id into v_id;
  if p_sleep_ms > 0 then perform pg_sleep(p_sleep_ms / 1000.0); end if;
  insert into ${TABELA_OUTBOX} (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values ('nota', v_id, 'comentar', false,
          jsonb_build_object('clickup_task_id', p_clickup_task_id, 'texto', p_corpo),
          'nota:' || v_id || ':comentar', 1)
  on conflict (dedup_key) do nothing;
  return v_id;
end;$$;`,
    dropSql: `drop function if exists ${rpcTeste}(text, text, text, int);`,
    async semear(uid) {
      const corpo = `GATETEST-${runId}-nota-${uid}`;
      const leadCt = `GATELEAD-${runId}-nota-${uid}`;
      const operador = `op-${runId}-${uid}`;
      return { corpo, leadCt, operador };
    },
    chamada(ctx, sleepMs) {
      return `${rpcTeste}('${ctx.leadCt}', '${ctx.operador}', '${ctx.corpo}', ${sleepMs})`;
    },
    async verificar(ctx) {
      const n = (await pgQuery(`select id from ${TABELA_NOTAS} where corpo = '${ctx.corpo}' limit 1;`))[0];
      const aplicado = !!n?.id;
      const outboxPresente = aplicado ? (await contarOutbox(`nota:${n.id}:comentar`)) === 1 : false;
      return { aplicado, outboxPresente };
    },
    async sanidade(ctx) {
      await comOutboxRpc(this.rpcReal, {
        p_aggregate: 'lead',
        p_lead_id: null,
        p_clickup_task_id: ctx.leadCt,
        p_autor: ctx.operador,
        p_corpo: ctx.corpo,
      });
    },
    async limpar(ctx) {
      await pgQuery(`delete from ${TABELA_OUTBOX} where aggregate_id in (select id from ${TABELA_NOTAS} where corpo='${ctx.corpo}');`);
      await pgQuery(`delete from ${TABELA_NOTAS} where corpo = '${ctx.corpo}';`);
    },
  });
}

// ---- gerar_lote --------------------------------------------------------------
// Simplificação do molde 'avulsa' (fase-b): a RPC de teste INSERE diretamente
// UMA linha em ligacoes (em vez de fazer a SELECT de candidatos elegíveis —
// pura leitura, sem estado a proteger) — o INSERT (RETURNING) + INSERT no
// outbox é exatamente o corpo do loop `FOR rec IN INSERT ... RETURNING ...
// LOOP` da RPC real (26_rpc_gerar_lote.sql), byte-a-byte no que diz respeito
// ao invariante both-or-neither.
{
  const rpcTeste = `${RPC_GERAR_LOTE}_gatetest`;
  exigirIdentificadorHml(rpcTeste, 'rpcTeste gerar_lote (derivado)');
  specs.push({
    slug: 'gerar_lote',
    rotulo: 'gerar_lote',
    rpcReal: RPC_GERAR_LOTE,
    rpcTeste,
    ddl: `
create or replace function ${rpcTeste}(p_lead_clickup_task_id text, p_telefone_canonico text, p_operador text, p_assignee bigint, p_sleep_ms int)
returns bigint language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_id bigint;
begin
  insert into ${TABELA_LIGACOES} (lead_clickup_task_id, operador, assignee_clickup_id, telefone_canonico, telefone_variantes, script, status, origem, lote_data, criado_em, atualizado_em)
  values (p_lead_clickup_task_id, p_operador, p_assignee, p_telefone_canonico, array[p_telefone_canonico]::text[], null, 'aberta', 'lote', current_date, now(), now())
  on conflict (telefone_canonico) where status='aberta' do nothing
  returning id into v_id;
  if v_id is null then return null; end if;
  if p_sleep_ms > 0 then perform pg_sleep(p_sleep_ms / 1000.0); end if;
  insert into ${TABELA_OUTBOX} (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values ('ligacao', v_id, 'criar_task', true,
          jsonb_build_object('origem', 'lote', 'telefone_canonico', p_telefone_canonico, 'assignee_clickup_id', p_assignee, 'lead_clickup_task_id', p_lead_clickup_task_id),
          'ligacao:' || v_id || ':criar', 1)
  on conflict (dedup_key) do nothing;
  return v_id;
end;$$;`,
    dropSql: `drop function if exists ${rpcTeste}(text, text, text, bigint, int);`,
    async semear(uid) {
      const canon = `GATETEST-${runId}-lote-${uid}`;
      const leadCt = `GATELEAD-${runId}-lote-${uid}`;
      const operador = `op-${runId}-${uid}`;
      const assignee = 7000000 + (Number(uid.replace(/\D/g, '')) || 0);
      return { canon, leadCt, operador, assignee };
    },
    chamada(ctx, sleepMs) {
      return `${rpcTeste}('${ctx.leadCt}', '${ctx.canon}', '${ctx.operador}', ${ctx.assignee}, ${sleepMs})`;
    },
    async verificar(ctx) {
      const l = (await pgQuery(
        `select id from ${TABELA_LIGACOES} where telefone_canonico = '${ctx.canon}' and status='aberta' limit 1;`,
      ))[0];
      const aplicado = !!l?.id;
      const outboxPresente = aplicado ? (await contarOutbox(`ligacao:${l.id}:criar`)) === 1 : false;
      return { aplicado, outboxPresente };
    },
    async sanidade(ctx) {
      // A RPC real seleciona os candidatos por SQL (LEITURA-06) — a sanidade
      // aqui prova o CAMINHO REAL (hml_gerar_lote exposta em /rpc/) sem
      // depender de haver um lead elegível semeado: p_tamanho=0 exercita a
      // RPC de fato (retorna 0 criadas/outbox), provando que a RPC real
      // responde e não quebra — o both-or-neither da RPC real já está
      // coberto pela prova ESTRUTURAL (--offline) + pelo kill-mid-tx acima,
      // que reproduz byte-a-byte o corpo do loop RETURNING.
      await comOutboxRpc(this.rpcReal, {
        p_operador: ctx.operador,
        p_assignee_clickup_id: ctx.assignee,
        p_tamanho: 0,
        p_lote_data: new Date().toISOString().slice(0, 10),
      });
    },
    async verificarSanidade() {
      // p_tamanho=0 nunca cria linha — sanidade prova só que a RPC real
      // responde 2xx sem quebrar (aplicado/outboxPresente sempre "ambos
      // ausentes", classificado como neither pela sanidade — ok por design).
      return { aplicado: false, outboxPresente: false };
    },
    async limpar(ctx) {
      await pgQuery(`delete from ${TABELA_OUTBOX} where aggregate_id in (select id from ${TABELA_LIGACOES} where telefone_canonico='${ctx.canon}');`);
      await pgQuery(`delete from ${TABELA_LIGACOES} where telefone_canonico = '${ctx.canon}';`);
    },
  });
}

// ===== Classificação both-or-neither (idêntica ao molde fase-b) =====

function classificarControleSan(r, v) {
  const orfao = v.outboxPresente && !v.aplicado;
  const perdido = v.aplicado && !v.outboxPresente;
  if (orfao) r.orfao++;
  if (perdido) r.perdido++;
  if (v.aplicado && v.outboxPresente) r.both++;
  else if (!v.aplicado && !v.outboxPresente) r.neither++;
}

function classificarKill(r, v, killOk) {
  const orfao = v.outboxPresente && !v.aplicado;
  const perdido = v.aplicado && !v.outboxPresente;
  if (orfao) {
    r.orfao++;
    return;
  }
  if (perdido) {
    r.perdido++;
    return;
  }
  if (!v.aplicado && !v.outboxPresente) {
    r.neither++;
  } else {
    r.both++;
    if (!killOk) r.janelaPerdida++;
  }
}

async function rodarClasse(spec, modo, iters) {
  const r = { total: 0, both: 0, neither: 0, orfao: 0, perdido: 0, janelaPerdida: 0 };
  for (let k = 0; k < iters; k++) {
    r.total++;
    const uid = `${modo}-${k}`;
    const ctx = await spec.semear(uid);
    try {
      if (modo === 'controle') {
        await pgQuery(`select ${spec.chamada(ctx, 0)};`);
        classificarControleSan(r, await spec.verificar(ctx));
      } else if (modo === 'sanidade') {
        await spec.sanidade(ctx);
        const v = spec.verificarSanidade ? await spec.verificarSanidade(ctx) : await spec.verificar(ctx);
        classificarControleSan(r, v);
      } else {
        const marker = `GATEKILL:${runId}:${spec.slug}:${k}`;
        const fire = pgQuery(`select /* ${marker} */ ${spec.chamada(ctx, GATE_WINDOW_MS)};`).catch((e) => ({ erro: e }));
        let pid = null;
        const deadline = Date.now() + GATE_POLL_DEADLINE_MS;
        while (Date.now() < deadline && pid === null) {
          const linhas = await pgQuery(`
            select pid from pg_stat_activity
             where query like '%${marker}%'
               and query not like '%pg_stat_activity%'
               and state = 'active'
               and pid <> pg_backend_pid()
             limit 1;`);
          pid = linhas[0]?.pid ?? null;
          if (pid === null) await sleep(GATE_POLL_INTERVAL_MS);
        }
        let killOk = false;
        if (pid !== null) {
          await pgQuery(`select pg_terminate_backend(${pid});`);
          killOk = true;
        }
        await fire;
        classificarKill(r, await spec.verificar(ctx), killOk);
      }
    } finally {
      await spec.limpar(ctx);
    }
  }
  return r;
}

async function sweepFinal() {
  try {
    await pgQuery(`delete from ${TABELA_OUTBOX} where aggregate_id in (select id from ${TABELA_AUDIOS} where lead_clickup_task_id like 'GATELEAD-${runId}-%');`);
    await pgQuery(`delete from ${TABELA_AUDIOS} where lead_clickup_task_id like 'GATELEAD-${runId}-%';`);
    await pgQuery(`delete from ${TABELA_OUTBOX} where aggregate_id in (select id from ${TABELA_NOTAS} where corpo like 'GATETEST-${runId}-%');`);
    await pgQuery(`delete from ${TABELA_NOTAS} where corpo like 'GATETEST-${runId}-%';`);
    await pgQuery(`delete from ${TABELA_OUTBOX} where aggregate_id in (select id from ${TABELA_LIGACOES} where telefone_canonico like 'GATETEST-${runId}-%');`);
    await pgQuery(`delete from ${TABELA_LIGACOES} where telefone_canonico like 'GATETEST-${runId}-%';`);
  } catch (e) {
    console.error(`[gate-fase-c] AVISO: falha no sweep final: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  console.log(
    `[gate-fase-c] kill-between-writes (AO VIVO) — runId=${runId} — DB-only (nunca chama o ClickUp), ` +
      'rollback SERVER-SIDE via pg_terminate_backend',
  );
  console.log(`[gate-fase-c] tabelas: ${TABELA_AUDIOS} / ${TABELA_NOTAS} / ${TABELA_LIGACOES} / ${TABELA_OUTBOX}`);
  console.log(`[gate-fase-c] RPCs provadas: ${specs.map((s) => s.rotulo).join(', ')}`);

  for (const spec of specs) {
    await pgQuery(spec.ddl);
  }
  await pgQuery(`notify pgrst, 'reload schema'`);

  const resultados = [];
  try {
    for (const spec of specs) {
      console.log(`[gate-fase-c] --- ${spec.rotulo} (real=${spec.rpcReal}, teste=${spec.rpcTeste}) ---`);
      const controle = await rodarClasse(spec, 'controle', GATE_CONTROLE_ITERS);
      const kill = await rodarClasse(spec, 'kill', GATE_KILL_ITERS);
      const sanidade = await rodarClasse(spec, 'sanidade', GATE_SANIDADE_ITERS);
      resultados.push({ spec, controle, kill, sanidade });
      console.log(
        `[gate-fase-c] ${spec.rotulo}: controle both=${controle.both}/${controle.total}  ` +
          `kill neither=${kill.neither} both=${kill.both}(janela perdida=${kill.janelaPerdida}) ` +
          `orfao=${kill.orfao} perdido=${kill.perdido}  sanidade both=${sanidade.both}/${sanidade.total} neither=${sanidade.neither}/${sanidade.total}`,
      );
    }
  } finally {
    await sweepFinal();
    for (const spec of specs) {
      try {
        await pgQuery(spec.dropSql);
      } catch (e) {
        console.error(`[gate-fase-c] AVISO: falha ao dropar ${spec.rpcTeste}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const falhas = [];
  for (const { spec, controle, kill, sanidade } of resultados) {
    const p = spec.rotulo;
    if (controle.orfao > 0 || controle.perdido > 0) falhas.push(`${p}: controle teve orfao/perdido`);
    if (controle.both !== controle.total) falhas.push(`${p}: controle.both (${controle.both}) !== total (${controle.total})`);
    if (kill.orfao > 0 || kill.perdido > 0) falhas.push(`${p}: kill-mid-tx teve orfao/perdido (quebra both-or-neither)`);
    if (kill.neither === 0) falhas.push(`${p}: kill-mid-tx.neither === 0 — invariante NUNCA exercitado (anti-superclaim)`);
    if (kill.neither < GATE_MIN_KILL_NEITHER) {
      falhas.push(`${p}: kill-mid-tx.neither (${kill.neither}) < GATE_MIN_KILL_NEITHER (${GATE_MIN_KILL_NEITHER})`);
    }
    if (sanidade.orfao > 0 || sanidade.perdido > 0) falhas.push(`${p}: sanidade teve orfao/perdido`);
    // gerar_lote roda a sanidade com p_tamanho=0 (nunca cria linha, ver spec) —
    // both=0 é esperado ali; as demais RPCs exigem sanidade.both>0.
    if (spec.slug !== 'gerar_lote' && sanidade.both === 0) {
      falhas.push(`${p}: sanidade.both === 0 — a RPC real não foi provada`);
    }
  }

  if (falhas.length > 0) {
    console.error('=== GATE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('GATE OK: both-or-neither PROVADO POR RPC (kill-mid-tx via pg_terminate_backend server-side):');
  for (const { spec, controle, kill, sanidade } of resultados) {
    console.log(
      `  - ${spec.rotulo}: controle both=${controle.both}, kill neither=${kill.neither}, sanidade both=${sanidade.both}, orfaos=0, perdidos=0`,
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`[gate-fase-c] ERRO FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
