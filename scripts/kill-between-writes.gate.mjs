#!/usr/bin/env node
// scripts/kill-between-writes.gate.mjs
//
// Gate kill-between-writes SERVER-SIDE (Fase 18 — Portão 1, Plano 02).
//
// MECANISMO: este gate NÃO mata o processo/cliente Node. Matar o cliente não
// prova nada — quando o socket cai, se a RPC já tiver commitado no servidor,
// a "prova" seria falsa (a tx já terminou). Em vez disso, o gate:
//
//  1. Cria (via /pg/query, o mesmo canal pg-meta do Kong que
//     scripts/aplicar-sql.mjs já usa) uma RPC de TESTE instrumentada —
//     espelho de hml_registrar_desfecho (sql/escala/12_rpc_registrar_desfecho.sql)
//     com uma janela `pg_sleep` POSICIONADA ENTRE o UPDATE do agregado
//     (hml_ligacoes) e o INSERT no outbox (hml_clickup_outbox).
//  2. Dispara a RPC de teste (sem await) e, EM PARALELO, faz polling em
//     `pg_stat_activity` até achar o backend em voo (casado por um marcador
//     único da iteração embutido na própria query SQL).
//  3. Chama `pg_terminate_backend(pid)` NA JANELA — o servidor aborta a
//     transação aberta, um ROLLBACK REAL acontece: o UPDATE do passo (2) da
//     RPC de teste (já aplicado dentro da tx, mas não commitado) volta junto
//     com o INSERT que nunca chegou a rodar. Prova both-or-neither de verdade.
//  4. Roda também uma classe CONTROLE (sem kill, sempre 'both') e uma classe
//     SANIDADE que exercita o CAMINHO REAL de produção — a RPC
//     hml_registrar_desfecho de fato exposta em /rest/v1/rpc/, via o helper
//     comOutboxRpc (src/mastra/outbox-rpc.ts) — para pegar drift entre a
//     RPC de teste-espelho e a RPC de produção.
//  5. Ao fim, DROPA a RPC de teste (nunca altera a RPC de produção do 18-01)
//     e limpa todos os registros semeados (finally por-iteração + sweep
//     final por runId).
//
// SEGURANÇA (T-18-02-Th/T-18-02-Ti, 18-02-PLAN.md threat_model): os nomes de
// tabela/RPC vêm do env e são interpolados na DDL da RPC de teste — por isso
// TODOS são validados contra /^hml_[a-z0-9_]+$/ ANTES de qualquer uso. O gate
// RECUSA rodar se qualquer nome não for hml_ (nunca contra produção). O
// pg_terminate_backend só mira o pid cujo `query` casa o marcador único
// GATEKILL:<runId>:<i> da própria iteração — nunca um backend de produção.
//
// DB-ONLY / SEGURO A QUALQUER HORA: a RPC (de teste e a de produção
// hml_registrar_desfecho) só escreve nas tabelas hml_ligacoes/
// hml_clickup_outbox — NUNCA chama a API do ClickUp (api.clickup.com). O
// worker de dreno do outbox é Phase 19, fora de escopo aqui.
//
// LGPD: sentinels sintéticos (GATETEST-<runId>-<i>), nunca telefone/CPF real.
// O gate só loga status/contagens/ids — nunca a service key nem payload.
//
// Uso: node --experimental-strip-types --env-file=deploy/homolog.env scripts/kill-between-writes.gate.mjs

import { comOutboxRpc } from '../src/mastra/outbox-rpc.ts';

// ===== Config env =====

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TABELA_LIGACOES = process.env.SUPABASE_TABLE_LIGACOES || '';
const TABELA_OUTBOX = process.env.SUPABASE_TABLE_CLICKUP_OUTBOX || '';
const RPC_PRODUCAO = process.env.SUPABASE_RPC_REGISTRAR_DESFECHO || '';

const GATE_CONTROLE_ITERS = Number(process.env.GATE_CONTROLE_ITERS) || 8;
const GATE_KILL_ITERS = Number(process.env.GATE_KILL_ITERS) || 12;
const GATE_SANIDADE_ITERS = Number(process.env.GATE_SANIDADE_ITERS) || 4;
const GATE_WINDOW_MS = Number(process.env.GATE_WINDOW_MS) || 2000;
const GATE_POLL_INTERVAL_MS = Number(process.env.GATE_POLL_INTERVAL_MS) || 50;
const GATE_POLL_DEADLINE_MS = Number(process.env.GATE_POLL_DEADLINE_MS) || 1500;
const GATE_MIN_KILL_NEITHER = Number(process.env.GATE_MIN_KILL_NEITHER) || 3;

// ===== GUARDA DE SEGURANÇA — identificador seguro, sempre hml_ (T-18-02-Th/Ti) =====
// Interpolados na DDL da RPC de teste abaixo — anti-injeção + anti-produção.

const RE_IDENTIFICADOR_HML = /^hml_[a-z0-9_]+$/;

function exigirIdentificadorHml(valor, rotulo) {
  if (!valor || !RE_IDENTIFICADOR_HML.test(valor)) {
    console.error(
      `[gate] ABORTANDO: ${rotulo}="${valor}" não é um identificador hml_ seguro ` +
        `(precisa casar ${RE_IDENTIFICADOR_HML}) — gate exige tabelas/RPC hml_ com ` +
        'identificador seguro — recusando rodar contra producao.',
    );
    process.exit(1);
  }
}

if (!SUPABASE_URL) {
  console.error('[gate] ABORTANDO: SUPABASE_URL ausente.');
  process.exit(1);
}
if (!SUPABASE_SERVICE_KEY) {
  console.error('[gate] ABORTANDO: SUPABASE_SERVICE_KEY ausente.');
  process.exit(1);
}
exigirIdentificadorHml(TABELA_LIGACOES, 'SUPABASE_TABLE_LIGACOES');
exigirIdentificadorHml(TABELA_OUTBOX, 'SUPABASE_TABLE_CLICKUP_OUTBOX');
exigirIdentificadorHml(RPC_PRODUCAO, 'SUPABASE_RPC_REGISTRAR_DESFECHO');

// Nome da RPC de teste — derivado, também hml_ (validado abaixo por
// construção: prefixo hml_ + sufixo seguro `_gatetest`).
const RPC_TESTE = `${RPC_PRODUCAO}_gatetest`;
exigirIdentificadorHml(RPC_TESTE, 'RPC_TESTE (derivado)');

if (GATE_POLL_DEADLINE_MS >= GATE_WINDOW_MS) {
  console.error(
    `[gate] ABORTANDO: GATE_POLL_DEADLINE_MS (${GATE_POLL_DEADLINE_MS}) precisa ser ` +
      `< GATE_WINDOW_MS (${GATE_WINDOW_MS}) — senão o poll nunca teria tempo de achar ` +
      'o backend antes da RPC de teste terminar sozinha a janela.',
  );
  process.exit(1);
}

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ===== Canal pg-meta (molde EXATO de scripts/aplicar-sql.mjs) =====

const HEADERS_PG = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

/** POST /pg/query — roda SQL arbitrário via pg-meta (service key). Para
 *  SELECT/RETURNING devolve o array de linhas (pg-meta). NUNCA loga a key
 *  nem PII — só status/corpo truncado em erro. */
async function pgQuery(sql) {
  const r = await fetch(`${SUPABASE_URL}/pg/query`, {
    method: 'POST',
    headers: HEADERS_PG,
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(30_000),
  });
  const texto = await r.text();
  if (!r.ok) {
    throw new Error(`[gate] pgQuery HTTP ${r.status} — ${texto.slice(0, 300)}`);
  }
  if (!texto) return [];
  return JSON.parse(texto);
}

// ===== Helper de sleep (poll) =====

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== SETUP — cria a RPC de teste instrumentada (espelho de hml_registrar_desfecho,
// com o pg_sleep ENTRE o UPDATE do agregado e o INSERT do outbox) =====

async function criarRpcTeste() {
  const ddl = `
create or replace function ${RPC_TESTE}(p_ligacao_id bigint, p_sleep_ms int)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_lead_id bigint;
  v_dups    bigint[];
begin
  -- (1) resolve o lead — ligação inexistente aborta tudo (RAISE = rollback).
  select lead_id into v_lead_id from ${TABELA_LIGACOES} where id = p_ligacao_id;
  if not found then
    raise exception '${RPC_TESTE}: ligacao % inexistente', p_ligacao_id;
  end if;

  -- (2) UPDATE do agregado — desfecho de teste fixo (resultado='recusou').
  update ${TABELA_LIGACOES}
     set status='fechada',
         resultado='recusou',
         atendeu=false,
         motivo_falha='gate-test',
         atualizado_em=now()
   where id = p_ligacao_id;

  -- (3) fecha duplicatas abertas e virgens do mesmo lead (mesma lógica da
  -- RPC de produção — sql/escala/12_rpc_registrar_desfecho.sql passo 3).
  with dups as (
    update ${TABELA_LIGACOES}
       set status='fechada', atualizado_em=now()
     where lead_id = v_lead_id
       and status='aberta'
       and inicio is null
       and id <> p_ligacao_id
     returning id
  )
  select array_agg(id) into v_dups from dups;

  -- (4) A JANELA — POSICIONADA AQUI, ENTRE o(s) UPDATE(s) do agregado (passos
  -- 2/3) e o INSERT do outbox (passo 5) abaixo. É o ponto que o
  -- pg_terminate_backend do gate mira: o desfecho já foi aplicado NA
  -- TRANSAÇÃO ABERTA (ainda não commitada), o outbox ainda NÃO — matar aqui
  -- prova que o UPDATE também rola de volta junto (both-or-neither real).
  if p_sleep_ms > 0 then
    perform pg_sleep(p_sleep_ms / 1000.0);
  end if;

  -- (5) outbox — linha do desfecho principal + uma linha 'fechar' por
  -- duplicata, mesma forma da RPC de produção. ON CONFLICT DO NOTHING.
  insert into ${TABELA_OUTBOX} (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'ligacao',
    p_ligacao_id,
    'set_status',
    true,
    jsonb_build_object('resultado', 'recusou', 'atendeu', false, 'motivo_falha', 'gate-test'),
    'ligacao:' || p_ligacao_id || ':desfecho',
    coalesce((select max(seq) from ${TABELA_OUTBOX} where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
  )
  on conflict (dedup_key) do nothing;

  insert into ${TABELA_OUTBOX} (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  select
    'ligacao',
    dup_id,
    'fechar',
    true,
    jsonb_build_object('motivo', 'duplicata_fechada_no_desfecho', 'ligacao_principal', p_ligacao_id),
    'ligacao:' || dup_id || ':fechar-dup',
    coalesce((select max(seq) from ${TABELA_OUTBOX} where aggregate='ligacao' and aggregate_id=dup_id), 0) + 1
  from unnest(v_dups) as dup_id
  on conflict (dedup_key) do nothing;
end;
$$;

revoke all on function ${RPC_TESTE}(bigint, int) from public;
grant execute on function ${RPC_TESTE}(bigint, int) to service_role;
`;
  await pgQuery(ddl);
  await pgQuery(`notify pgrst, 'reload schema'`);
  console.log(`[gate] RPC de teste criada: ${RPC_TESTE} (referencia ${TABELA_LIGACOES}/${TABELA_OUTBOX})`);
}

/** DROP no finally de topo — nunca deixa a RPC de teste residual em hml_. */
async function dropRpcTeste() {
  try {
    await pgQuery(`drop function if exists ${RPC_TESTE}(bigint, int);`);
    console.log(`[gate] RPC de teste dropada: ${RPC_TESTE}`);
  } catch (e) {
    console.error(`[gate] AVISO: falha ao dropar ${RPC_TESTE}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ===== Semeadura / verificação / limpeza por iteração =====

/** Insere a ligação principal (e, em iterações pares, uma duplicata aberta
 *  virgem do mesmo lead) em hml_ligacoes. Retorna { vPrincipal, vDup|null }. */
async function semear(i) {
  const leadId = 900000000 + i;
  const canonPrincipal = `GATETEST-${runId}-${i}`;
  const comDup = i % 2 === 0;

  const linhasPrincipal = await pgQuery(`
    insert into ${TABELA_LIGACOES} (clickup_task_id, lead_id, telefone_canonico, status, inicio, origem)
    values (null, ${leadId}, '${canonPrincipal}', 'aberta', null, 'lote')
    returning id;
  `);
  const vPrincipal = linhasPrincipal[0]?.id;
  if (!vPrincipal) throw new Error(`[gate] semear: falha ao inserir ligação principal (iteração ${i})`);

  let vDup = null;
  if (comDup) {
    const canonDup = `${canonPrincipal}-dup`;
    const linhasDup = await pgQuery(`
      insert into ${TABELA_LIGACOES} (clickup_task_id, lead_id, telefone_canonico, status, inicio, origem)
      values (null, ${leadId}, '${canonDup}', 'aberta', null, 'inbound_whatsapp')
      returning id;
    `);
    vDup = linhasDup[0]?.id ?? null;
  }

  return { vPrincipal, vDup };
}

/** Verifica o invariante both-or-neither para v_principal (e v_dup, se
 *  houver). Retorna { desfechoAplicado, orfao, perdido, parcial }. */
async function verificar({ vPrincipal, vDup }) {
  const linhasPrincipal = await pgQuery(`
    select status, resultado from ${TABELA_LIGACOES} where id = ${vPrincipal};
  `);
  const principal = linhasPrincipal[0] || {};
  const linhasOutbox = await pgQuery(`
    select count(*)::int as n from ${TABELA_OUTBOX}
     where dedup_key = 'ligacao:${vPrincipal}:desfecho';
  `);
  const outboxPrincipal = linhasOutbox[0]?.n ?? 0;

  const desfechoAplicado = principal.status === 'fechada' && principal.resultado === 'recusou';
  const outboxPresente = outboxPrincipal === 1;

  let orfao = false;
  let perdido = false;
  if (outboxPresente && !desfechoAplicado) orfao = true;
  if (desfechoAplicado && !outboxPresente) perdido = true;

  let parcial = false;
  if (vDup) {
    const linhasDup = await pgQuery(`select status from ${TABELA_LIGACOES} where id = ${vDup};`);
    const dup = linhasDup[0] || {};
    const linhasOutboxDup = await pgQuery(`
      select count(*)::int as n from ${TABELA_OUTBOX}
       where dedup_key = 'ligacao:${vDup}:fechar-dup';
    `);
    const outboxDup = linhasOutboxDup[0]?.n ?? 0;

    if (desfechoAplicado) {
      if (dup.status !== 'fechada' || outboxDup !== 1) parcial = true;
    } else {
      if (dup.status !== 'aberta' || outboxDup !== 0) parcial = true;
    }
  }

  return { desfechoAplicado, orfao, perdido, parcial };
}

/** Limpeza por iteração — SEMPRE roda (finally do chamador). */
async function limpar({ vPrincipal, vDup }) {
  const ids = vDup ? `${vPrincipal},${vDup}` : `${vPrincipal}`;
  try {
    await pgQuery(`delete from ${TABELA_OUTBOX} where aggregate_id in (${ids});`);
    await pgQuery(`delete from ${TABELA_LIGACOES} where id in (${ids});`);
  } catch (e) {
    console.error(`[gate] AVISO: falha na limpeza da iteração (ids=${ids}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Sweep final — resíduos por telefone_canonico (defesa extra, cobre falhas
 *  de limpeza por-iteração). */
async function sweepFinal() {
  try {
    await pgQuery(`
      delete from ${TABELA_OUTBOX}
       where aggregate_id in (
         select id from ${TABELA_LIGACOES} where telefone_canonico like 'GATETEST-${runId}-%'
       );
    `);
    await pgQuery(`delete from ${TABELA_LIGACOES} where telefone_canonico like 'GATETEST-${runId}-%';`);
  } catch (e) {
    console.error(`[gate] AVISO: falha no sweep final: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ===== CLASSE CONTROLE — sem kill, DEVE resultar 'both' =====

async function rodarControle() {
  const resultado = { total: 0, both: 0, neither: 0, orfao: 0, perdido: 0 };
  for (let i = 0; i < GATE_CONTROLE_ITERS; i++) {
    resultado.total++;
    const seed = await semear(i);
    try {
      await pgQuery(`select ${RPC_TESTE}(${seed.vPrincipal}, 0);`);
      const v = await verificar(seed);
      if (v.orfao) resultado.orfao++;
      if (v.perdido) resultado.perdido++;
      if (v.parcial) resultado.orfao++; // parcial em controle = falha de atomicidade
      if (v.desfechoAplicado && !v.orfao && !v.perdido && !v.parcial) resultado.both++;
      else if (!v.desfechoAplicado && !v.orfao && !v.perdido && !v.parcial) resultado.neither++;
    } finally {
      await limpar(seed);
    }
  }
  return resultado;
}

// ===== CLASSE KILL-MID-TX — pg_terminate_backend na janela, DEVE resultar 'neither' =====

async function rodarKillMidTx() {
  const resultado = { total: 0, neither: 0, both: 0, orfao: 0, perdido: 0, janelaPerdida: 0 };
  for (let i = 0; i < GATE_KILL_ITERS; i++) {
    resultado.total++;
    const seed = await semear(i);
    const marker = `GATEKILL:${runId}:${i}`;
    try {
      // Dispara (NÃO-await) — a RPC de teste entra na janela pg_sleep entre
      // o UPDATE e o INSERT. O marcador único fica embutido como comentário
      // SQL na própria query, casável em pg_stat_activity.query.
      const firePromise = pgQuery(
        `select /* ${marker} */ ${RPC_TESTE}(${seed.vPrincipal}, ${GATE_WINDOW_MS});`,
      ).catch((e) => ({ erro: e }));

      // Poll serial até achar o backend em voo desta iteração (exclui o
      // próprio backend do poll via pg_backend_pid(); NOT LIKE evita casar a
      // própria query de poll, que também contém o marcador como literal).
      let pid = null;
      const deadline = Date.now() + GATE_POLL_DEADLINE_MS;
      while (Date.now() < deadline && pid === null) {
        const linhas = await pgQuery(`
          select pid from pg_stat_activity
           where query like '%${marker}%'
             and query not like '%pg_stat_activity%'
             and state = 'active'
             and pid <> pg_backend_pid()
           limit 1;
        `);
        pid = linhas[0]?.pid ?? null;
        if (pid === null) await sleep(GATE_POLL_INTERVAL_MS);
      }

      let killOk = false;
      if (pid !== null) {
        await pgQuery(`select pg_terminate_backend(${pid});`);
        killOk = true;
      }

      // Aguarda a RPC disparada (espera-se rejeição — conexão morta pelo kill).
      await firePromise;

      const v = await verificar(seed);
      if (v.orfao) resultado.orfao++;
      if (v.perdido) resultado.perdido++;
      if (v.parcial) {
        resultado.orfao++; // parcial em kill-mid-tx também é falha de atomicidade
      } else if (!v.desfechoAplicado) {
        resultado.neither++;
      } else {
        // desfecho aplicado apesar do kill == janela perdida (fire commitou
        // antes do kill atingir a tx) — conta como 'both', serve de controle
        // interno de mesma-janela, não é falha do invariante.
        resultado.both++;
        if (!killOk) resultado.janelaPerdida++;
      }
    } finally {
      await limpar(seed);
    }
  }
  return resultado;
}

// ===== CLASSE SANIDADE — caminho REAL de produção via comOutboxRpc =====

async function rodarSanidade() {
  const resultado = { total: 0, both: 0, neither: 0, orfao: 0, perdido: 0 };
  for (let i = 0; i < GATE_SANIDADE_ITERS; i++) {
    resultado.total++;
    const seed = await semear(1000 + i); // faixa própria, longe das outras classes
    try {
      await comOutboxRpc(RPC_PRODUCAO, {
        p_ligacao_id: seed.vPrincipal,
        p_resultado: 'recusou',
        p_atendeu: false,
        p_motivo_falha: 'gate-test',
      });
      const v = await verificar(seed);
      if (v.orfao) resultado.orfao++;
      if (v.perdido) resultado.perdido++;
      if (v.parcial) resultado.orfao++;
      if (v.desfechoAplicado && !v.orfao && !v.perdido && !v.parcial) resultado.both++;
      else if (!v.desfechoAplicado && !v.orfao && !v.perdido && !v.parcial) resultado.neither++;
    } finally {
      await limpar(seed);
    }
  }
  return resultado;
}

// ===== Orquestração =====

async function main() {
  console.log(
    `[gate] kill-between-writes — runId=${runId} — DB-only (nunca chama o ClickUp), ` +
      'rollback SERVER-SIDE via pg_terminate_backend (nao kill de cliente)',
  );
  console.log(`[gate] tabelas: ${TABELA_LIGACOES} / ${TABELA_OUTBOX} — RPC producao: ${RPC_PRODUCAO} — RPC teste: ${RPC_TESTE}`);

  await criarRpcTeste();

  let controle;
  let killMidTx;
  let sanidade;
  try {
    console.log(`[gate] rodando CONTROLE (${GATE_CONTROLE_ITERS} iteracoes, serial, sem kill)...`);
    controle = await rodarControle();

    console.log(`[gate] rodando KILL-MID-TX (${GATE_KILL_ITERS} iteracoes, serial, pg_terminate_backend na janela)...`);
    killMidTx = await rodarKillMidTx();

    console.log(`[gate] rodando SANIDADE (${GATE_SANIDADE_ITERS} iteracoes, serial, via comOutboxRpc -> RPC producao real)...`);
    sanidade = await rodarSanidade();
  } finally {
    await sweepFinal();
    await dropRpcTeste();
  }

  console.log(
    `[gate] controle:    both=${controle.both}  neither=${controle.neither}  ` +
      `orfao=${controle.orfao}  perdido=${controle.perdido}   (esperado: todos both)`,
  );
  console.log(
    `[gate] kill-mid-tx: neither=${killMidTx.neither}  both=${killMidTx.both}(janela perdida=${killMidTx.janelaPerdida})  ` +
      `orfao=${killMidTx.orfao}  perdido=${killMidTx.perdido}`,
  );
  console.log(
    `[gate] sanidade:    both=${sanidade.both}  neither=${sanidade.neither}  ` +
      `orfao=${sanidade.orfao}  perdido=${sanidade.perdido}   (comOutboxRpc -> RPC de producao real)`,
  );

  const falhas = [];
  if (controle.orfao > 0 || controle.perdido > 0) falhas.push('controle teve orfao/perdido/parcial');
  if (controle.both !== controle.total) falhas.push(`controle.both (${controle.both}) !== controle.total (${controle.total})`);
  if (killMidTx.orfao > 0 || killMidTx.perdido > 0) falhas.push('kill-mid-tx teve orfao/perdido/parcial');
  if (killMidTx.neither === 0) falhas.push('kill-mid-tx.neither === 0 — o invariante NUNCA foi exercitado (anti-superclaim)');
  if (killMidTx.neither < GATE_MIN_KILL_NEITHER) {
    falhas.push(`kill-mid-tx.neither (${killMidTx.neither}) < GATE_MIN_KILL_NEITHER (${GATE_MIN_KILL_NEITHER})`);
  }
  if (sanidade.orfao > 0 || sanidade.perdido > 0) falhas.push('sanidade teve orfao/perdido/parcial');
  if (sanidade.both === 0) falhas.push('sanidade.both === 0 — o caminho real de producao nao foi provado');

  if (falhas.length > 0) {
    console.error('=== GATE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(
    `GATE OK: both-or-neither PROVADO POR CLASSE (controle both=${controle.both}; ` +
      `kill-mid-tx neither=${killMidTx.neither} via pg_terminate_backend server-side na janela ` +
      `entre UPDATE e INSERT; sanidade both=${sanidade.both}), orfaos=0, perdidos=0`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(`[gate] ERRO FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
