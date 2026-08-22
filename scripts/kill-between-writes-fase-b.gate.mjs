#!/usr/bin/env node
// scripts/kill-between-writes-fase-b.gate.mjs
//
// Gate kill-between-writes GENERALIZADO das RPCs de mutação da Fase B (Phase
// 19, Caminho B) — molde EXATO de scripts/kill-between-writes.gate.mjs (Phase
// 18, que provou hml_registrar_desfecho). Prova o invariante both-or-neither
// (a escrita do agregado/SoT e o INSERT no outbox ou acontecem JUNTOS ou
// nenhum acontece) para CADA RPC nova:
//
//   - hml_iniciar_ligacao            (SUPABASE_RPC_INICIAR_LIGACAO)
//   - hml_pular_ligacao              (SUPABASE_RPC_PULAR_LIGACAO)
//   - hml_criar_ligacao_avulsa       (SUPABASE_RPC_CRIAR_LIGACAO_AVULSA)
//   - hml_registrar_voto             (SUPABASE_RPC_REGISTRAR_VOTO) — os DOIS
//       caminhos determinísticos SEPARADAMENTE: voto[LIGACAO] (p_ligacao_id
//       setado, p_lead_clickup_task_id NULL) e voto[LEAD] (p_ligacao_id NULL +
//       p_lead_clickup_task_id setado). O caminho LEAD (novo na revisão do
//       19-08/19-02) NÃO fica sem prova both-or-neither.
//   - hml_consolidar_e_fechar_ligacao (SUPABASE_RPC_CONSOLIDAR_E_FECHAR)
//
// MECANISMO (idêntico ao molde da Phase 18): este gate NÃO mata o cliente
// Node — matar o socket não prova nada (se a RPC já commitou no servidor a
// "prova" seria falsa). Em vez disso, para cada RPC/caminho:
//
//  1. Cria (via /pg/query, o mesmo canal pg-meta do Kong que
//     scripts/aplicar-sql.mjs usa) uma RPC de TESTE-ESPELHO daquela mutação,
//     com uma janela `pg_sleep` POSICIONADA ENTRE a escrita do agregado/SoT e
//     o INSERT no outbox.
//  2. Dispara a RPC de teste (sem await) e, EM PARALELO, faz polling em
//     pg_stat_activity até achar o backend em voo (casado por um marcador
//     único da iteração embutido na própria query SQL).
//  3. Chama pg_terminate_backend(pid) NA JANELA — o servidor aborta a
//     transação aberta: a escrita do agregado (já aplicada dentro da tx, mas
//     não commitada) ROLA DE VOLTA junto com o INSERT que nunca chegou a rodar.
//     Prova both-or-neither de verdade, server-side.
//  4. Roda também uma classe CONTROLE (sem kill, sempre 'both') e uma classe
//     SANIDADE que exercita o CAMINHO REAL de produção — a RPC hml_ de fato
//     exposta em /rest/v1/rpc/, via o helper comOutboxRpc (outbox-rpc.ts) —
//     para pegar drift entre a RPC de teste-espelho e a RPC real.
//  5. Ao fim, DROPA as RPCs de teste (nunca altera as RPCs reais dos planos
//     19-02..19-08) e faz sweep de todos os registros semeados por runId.
//
// SEGURANÇA (T-19-10-Th/Ti): os nomes de tabela/RPC vêm do env e são
// interpolados na DDL — por isso TODOS são validados contra /^hml_[a-z0-9_]+$/
// ANTES de qualquer uso. O gate RECUSA rodar se qualquer nome não for hml_
// (nunca contra produção). O pg_terminate_backend só mira o pid cujo `query`
// casa o marcador único GATEKILL:<runId>:<slug>:<i> da própria iteração.
//
// DB-ONLY / SEGURO A QUALQUER HORA: as RPCs (de teste e as reais) só escrevem
// nas tabelas hml_ — NUNCA chamam a API HTTP do ClickUp. O worker de dreno do
// outbox (que é quem, noutro plano, empurra pro ClickUp) está fora de escopo.
//
// LGPD: sentinels sintéticos (GATETEST-<runId>-* / GATELEAD-<runId>-*), nunca
// telefone/CPF real. O gate só loga status/contagens/ids — nunca a service key
// nem payload.
//
// Uso: node --experimental-strip-types --env-file=deploy/homolog.env scripts/kill-between-writes-fase-b.gate.mjs

import { comOutboxRpc } from '../src/mastra/outbox-rpc.ts';

// ===== Config env =====

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const TABELA_LIGACOES = process.env.SUPABASE_TABLE_LIGACOES || '';
const TABELA_OUTBOX = process.env.SUPABASE_TABLE_CLICKUP_OUTBOX || '';
const TABELA_LEADS = process.env.SUPABASE_TABLE_LEADS_ESPELHO || '';
const TABELA_VOTOS = process.env.SUPABASE_TABLE_VOTOS_LIGACAO || '';

const RPC_INICIAR = process.env.SUPABASE_RPC_INICIAR_LIGACAO || '';
const RPC_PULAR = process.env.SUPABASE_RPC_PULAR_LIGACAO || '';
const RPC_AVULSA = process.env.SUPABASE_RPC_CRIAR_LIGACAO_AVULSA || '';
const RPC_VOTO = process.env.SUPABASE_RPC_REGISTRAR_VOTO || '';
const RPC_CONSOLIDAR = process.env.SUPABASE_RPC_CONSOLIDAR_E_FECHAR || '';

const GATE_CONTROLE_ITERS = Number(process.env.GATE_CONTROLE_ITERS) || 4;
const GATE_KILL_ITERS = Number(process.env.GATE_KILL_ITERS) || 6;
const GATE_SANIDADE_ITERS = Number(process.env.GATE_SANIDADE_ITERS) || 2;
const GATE_WINDOW_MS = Number(process.env.GATE_WINDOW_MS) || 2000;
const GATE_POLL_INTERVAL_MS = Number(process.env.GATE_POLL_INTERVAL_MS) || 50;
const GATE_POLL_DEADLINE_MS = Number(process.env.GATE_POLL_DEADLINE_MS) || 1500;
const GATE_MIN_KILL_NEITHER = Number(process.env.GATE_MIN_KILL_NEITHER) || 3;

// ===== GUARDA DE SEGURANÇA — identificador seguro, sempre hml_ (T-19-10-Th/Ti) =====

const RE_IDENTIFICADOR_HML = /^hml_[a-z0-9_]+$/;

function exigirIdentificadorHml(valor, rotulo) {
  if (!valor || !RE_IDENTIFICADOR_HML.test(valor)) {
    console.error(
      `[gate] ABORTANDO: ${rotulo}="${valor}" não é um identificador hml_ seguro ` +
        `(precisa casar ${RE_IDENTIFICADOR_HML}) — o gate exige tabelas/RPC hml_ ` +
        'com identificador seguro — recusando rodar contra produção.',
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
exigirIdentificadorHml(TABELA_LEADS, 'SUPABASE_TABLE_LEADS_ESPELHO');
exigirIdentificadorHml(TABELA_VOTOS, 'SUPABASE_TABLE_VOTOS_LIGACAO');
exigirIdentificadorHml(RPC_INICIAR, 'SUPABASE_RPC_INICIAR_LIGACAO');
exigirIdentificadorHml(RPC_PULAR, 'SUPABASE_RPC_PULAR_LIGACAO');
exigirIdentificadorHml(RPC_AVULSA, 'SUPABASE_RPC_CRIAR_LIGACAO_AVULSA');
exigirIdentificadorHml(RPC_VOTO, 'SUPABASE_RPC_REGISTRAR_VOTO');
exigirIdentificadorHml(RPC_CONSOLIDAR, 'SUPABASE_RPC_CONSOLIDAR_E_FECHAR');

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

/** POST /pg/query — roda SQL arbitrário via pg-meta (service key). Devolve o
 *  array de linhas (pg-meta) para SELECT/RETURNING. NUNCA loga a key nem PII —
 *  só status/corpo truncado em erro. */
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Conta linhas do outbox por dedup_key (invariante: 0 ou 1). */
async function contarOutbox(dedupKey) {
  const linhas = await pgQuery(
    `select count(*)::int as n from ${TABELA_OUTBOX} where dedup_key = '${dedupKey}';`,
  );
  return linhas[0]?.n ?? 0;
}

// ============================================================================
// SPECS — uma por RPC/caminho. Cada spec sabe: criar/dropar a RPC de teste
// (espelho com pg_sleep entre agregado e outbox), semear pré-requisitos,
// montar a chamada da RPC de teste, verificar both-or-neither, exercitar a RPC
// REAL (sanidade) e limpar. Slug único -> nome de RPC de teste hml_ próprio.
// ============================================================================

const specs = [];

// ---- iniciar_ligacao -------------------------------------------------------
{
  const rpcTeste = `${RPC_INICIAR}_gatetest`;
  exigirIdentificadorHml(rpcTeste, 'rpcTeste iniciar (derivado)');
  specs.push({
    slug: 'iniciar',
    rotulo: 'iniciar',
    rpcReal: RPC_INICIAR,
    rpcTeste,
    ddl: `
create or replace function ${rpcTeste}(p_ligacao_id bigint, p_operador text, p_sleep_ms int)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  update ${TABELA_LIGACOES}
     set inicio=now(), operador=p_operador, atualizado_em=now()
   where id = p_ligacao_id;
  if not found then raise exception '${rpcTeste}: ligacao % inexistente', p_ligacao_id; end if;
  if p_sleep_ms > 0 then perform pg_sleep(p_sleep_ms / 1000.0); end if;
  insert into ${TABELA_OUTBOX} (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values ('ligacao', p_ligacao_id, 'set_campo', true,
          jsonb_build_object('campo', 'INICIO'),
          'ligacao:' || p_ligacao_id || ':inicio',
          coalesce((select max(seq) from ${TABELA_OUTBOX} where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1)
  on conflict (dedup_key) do nothing;
end;$$;`,
    dropSql: `drop function if exists ${rpcTeste}(bigint, text, int);`,
    async semear(uid) {
      const canon = `GATETEST-${runId}-iniciar-${uid}`;
      const operador = `op-${runId}-${uid}`;
      const linhas = await pgQuery(`
        insert into ${TABELA_LIGACOES} (lead_id, telefone_canonico, status, inicio, operador, origem)
        values (${900000000 + Number(uid) || 900000000}, '${canon}', 'aberta', null, null, 'lote')
        returning id;`);
      const ligId = linhas[0]?.id;
      if (!ligId) throw new Error(`[gate] iniciar.semear falhou (uid=${uid})`);
      return { ligId, canon, operador };
    },
    chamada(ctx, sleepMs) {
      return `${rpcTeste}(${ctx.ligId}, '${ctx.operador}', ${sleepMs})`;
    },
    async verificar(ctx) {
      const l = (await pgQuery(`select inicio, operador from ${TABELA_LIGACOES} where id = ${ctx.ligId};`))[0] || {};
      const aplicado = l.inicio != null && l.operador === ctx.operador;
      const outboxPresente = (await contarOutbox(`ligacao:${ctx.ligId}:inicio`)) === 1;
      return { aplicado, outboxPresente };
    },
    async sanidade(ctx) {
      await comOutboxRpc(this.rpcReal, { p_ligacao_id: ctx.ligId, p_operador: ctx.operador });
    },
    async limpar(ctx) {
      await pgQuery(`delete from ${TABELA_OUTBOX} where aggregate_id = ${ctx.ligId};`);
      await pgQuery(`delete from ${TABELA_LIGACOES} where id = ${ctx.ligId};`);
    },
  });
}

// ---- pular_ligacao ---------------------------------------------------------
{
  const rpcTeste = `${RPC_PULAR}_gatetest`;
  exigirIdentificadorHml(rpcTeste, 'rpcTeste pular (derivado)');
  specs.push({
    slug: 'pular',
    rotulo: 'pular',
    rpcReal: RPC_PULAR,
    rpcTeste,
    ddl: `
create or replace function ${rpcTeste}(p_ligacao_id bigint, p_operador text, p_sleep_ms int)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  update ${TABELA_LIGACOES}
     set status='fechada', resultado='pulado', atendeu=false, motivo_falha='Pulado', atualizado_em=now()
   where id = p_ligacao_id;
  if not found then raise exception '${rpcTeste}: ligacao % inexistente', p_ligacao_id; end if;
  if p_sleep_ms > 0 then perform pg_sleep(p_sleep_ms / 1000.0); end if;
  insert into ${TABELA_OUTBOX} (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values ('ligacao', p_ligacao_id, 'fechar', true,
          jsonb_build_object('motivo', 'pulado'),
          'ligacao:' || p_ligacao_id || ':pular',
          coalesce((select max(seq) from ${TABELA_OUTBOX} where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1)
  on conflict (dedup_key) do nothing;
end;$$;`,
    dropSql: `drop function if exists ${rpcTeste}(bigint, text, int);`,
    async semear(uid) {
      const canon = `GATETEST-${runId}-pular-${uid}`;
      const operador = `op-${runId}-${uid}`;
      const linhas = await pgQuery(`
        insert into ${TABELA_LIGACOES} (lead_id, telefone_canonico, status, inicio, operador, origem)
        values (901000000, '${canon}', 'aberta', null, null, 'lote')
        returning id;`);
      const ligId = linhas[0]?.id;
      if (!ligId) throw new Error(`[gate] pular.semear falhou (uid=${uid})`);
      return { ligId, canon, operador };
    },
    chamada(ctx, sleepMs) {
      return `${rpcTeste}(${ctx.ligId}, '${ctx.operador}', ${sleepMs})`;
    },
    async verificar(ctx) {
      const l = (await pgQuery(`select status, resultado from ${TABELA_LIGACOES} where id = ${ctx.ligId};`))[0] || {};
      const aplicado = l.status === 'fechada' && l.resultado === 'pulado';
      const outboxPresente = (await contarOutbox(`ligacao:${ctx.ligId}:pular`)) === 1;
      return { aplicado, outboxPresente };
    },
    async sanidade(ctx) {
      await comOutboxRpc(this.rpcReal, { p_ligacao_id: ctx.ligId, p_operador: ctx.operador, p_motivo: 'gate-test' });
    },
    async limpar(ctx) {
      await pgQuery(`delete from ${TABELA_OUTBOX} where aggregate_id = ${ctx.ligId};`);
      await pgQuery(`delete from ${TABELA_LIGACOES} where id = ${ctx.ligId};`);
    },
  });
}

// ---- criar_ligacao_avulsa --------------------------------------------------
// A mutação do agregado AQUI é o próprio INSERT (não um UPDATE): o pg_sleep
// fica entre o INSERT em ${TABELA_LIGACOES} e o INSERT no outbox. Matar na
// janela rola de volta a criação INTEIRA (nenhuma linha, nenhum outbox).
{
  const rpcTeste = `${RPC_AVULSA}_gatetest`;
  exigirIdentificadorHml(rpcTeste, 'rpcTeste avulsa (derivado)');
  specs.push({
    slug: 'avulsa',
    rotulo: 'avulsa',
    rpcReal: RPC_AVULSA,
    rpcTeste,
    ddl: `
create or replace function ${rpcTeste}(p_telefone_canonico text, p_operador text, p_assignee bigint, p_sleep_ms int)
returns bigint language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_id bigint;
begin
  insert into ${TABELA_LIGACOES} (operador, assignee_clickup_id, telefone_canonico, status, origem, criado_em, atualizado_em)
  values (p_operador, p_assignee, p_telefone_canonico, 'aberta', 'avulsa', now(), now())
  on conflict (telefone_canonico) where status='aberta' do nothing
  returning id into v_id;
  if v_id is null then return null; end if;
  if p_sleep_ms > 0 then perform pg_sleep(p_sleep_ms / 1000.0); end if;
  insert into ${TABELA_OUTBOX} (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values ('ligacao', v_id, 'criar_task', true,
          jsonb_build_object('origem', 'avulsa'),
          'ligacao:' || v_id || ':criar', 1)
  on conflict (dedup_key) do nothing;
  return v_id;
end;$$;`,
    dropSql: `drop function if exists ${rpcTeste}(text, text, bigint, int);`,
    async semear(uid) {
      const canon = `GATETEST-${runId}-avulsa-${uid}`;
      const operador = `op-${runId}-${uid}`;
      const assignee = 7000000 + (Number(uid) || 0);
      // avulsa CRIA a ligação — não semeamos a linha aqui.
      return { canon, operador, assignee };
    },
    chamada(ctx, sleepMs) {
      return `${rpcTeste}('${ctx.canon}', '${ctx.operador}', ${ctx.assignee}, ${sleepMs})`;
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
      await comOutboxRpc(this.rpcReal, {
        p_telefone_canonico: ctx.canon,
        p_telefone_variantes: [ctx.canon],
        p_operador: ctx.operador,
        p_assignee_clickup_id: ctx.assignee,
      });
    },
    async limpar(ctx) {
      await pgQuery(
        `delete from ${TABELA_OUTBOX} where aggregate_id in (select id from ${TABELA_LIGACOES} where telefone_canonico='${ctx.canon}');`,
      );
      await pgQuery(`delete from ${TABELA_LIGACOES} where telefone_canonico = '${ctx.canon}';`);
    },
  });
}

// ---- registrar_voto — CAMINHO LIGAÇÃO --------------------------------------
// p_ligacao_id setado; ledger key = coalesce(clickup_task_id,'local:'||id).
// SoT (UPDATE leads.confirmou_*) + ledger (INSERT votos_ligacao) ANTES do
// pg_sleep; INSERT no outbox DEPOIS. Matar na janela rola de volta os três.
{
  const rpcTeste = `${RPC_VOTO}_gatetest_lig`;
  exigirIdentificadorHml(rpcTeste, 'rpcTeste voto[LIGACAO] (derivado)');
  specs.push({
    slug: 'voto_lig',
    rotulo: 'voto[LIGACAO]',
    rpcReal: RPC_VOTO,
    rpcTeste,
    ddl: `
create or replace function ${rpcTeste}(p_ligacao_id bigint, p_operador text, p_romero text, p_sleep_ms int)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_lead_ct text; v_lead_id bigint; v_lig_key text; v_agg bigint;
begin
  select lead_id, lead_clickup_task_id, coalesce(clickup_task_id, 'local:'||id)
    into v_lead_id, v_lead_ct, v_lig_key
    from ${TABELA_LIGACOES} where id = p_ligacao_id;
  if not found then raise exception '${rpcTeste}: ligacao % inexistente', p_ligacao_id; end if;
  update ${TABELA_LEADS}
     set confirmou_romero=coalesce(p_romero, confirmou_romero), atualizado_em=now()
   where clickup_task_id = v_lead_ct;
  insert into ${TABELA_VOTOS} (ligacao_task_id, lead_task_id, operador, candidato, escolha, origem)
    values (v_lig_key, coalesce(v_lead_ct,''), p_operador, 'romero', p_romero, 'ligacao')
    on conflict (ligacao_task_id, candidato) do update set escolha=excluded.escolha, operador=excluded.operador;
  v_agg := coalesce(v_lead_id, hashtextextended(v_lead_ct, 0));
  if p_sleep_ms > 0 then perform pg_sleep(p_sleep_ms / 1000.0); end if;
  insert into ${TABELA_OUTBOX} (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values ('lead', v_agg, 'set_campo', true,
            jsonb_build_object('campo', 'CONFIRMOU_VOTO_ROMERO', 'valor', p_romero),
            'lead:' || v_lead_ct || ':voto:romero:' || v_lig_key,
            coalesce((select max(seq) from ${TABELA_OUTBOX} where aggregate='lead' and aggregate_id=v_agg), 0) + 1)
    on conflict (dedup_key) do nothing;
end;$$;`,
    dropSql: `drop function if exists ${rpcTeste}(bigint, text, text, int);`,
    async semear(uid) {
      const leadCt = `GATELEAD-${runId}-votolig-${uid}`;
      const canon = `GATETEST-${runId}-votolig-${uid}`;
      const operador = `op-${runId}-${uid}`;
      await pgQuery(`insert into ${TABELA_LEADS} (clickup_task_id) values ('${leadCt}');`);
      const linhas = await pgQuery(`
        insert into ${TABELA_LIGACOES} (lead_id, lead_clickup_task_id, telefone_canonico, status, operador, origem)
        values (null, '${leadCt}', '${canon}', 'aberta', null, 'lote')
        returning id;`);
      const ligId = linhas[0]?.id;
      if (!ligId) throw new Error(`[gate] voto[LIGACAO].semear falhou (uid=${uid})`);
      const ligKey = `local:${ligId}`;
      return { ligId, leadCt, canon, ligKey, operador, romero: 'sim' };
    },
    chamada(ctx, sleepMs) {
      return `${rpcTeste}(${ctx.ligId}, '${ctx.operador}', '${ctx.romero}', ${sleepMs})`;
    },
    async verificar(ctx) {
      const lead = (await pgQuery(`select confirmou_romero from ${TABELA_LEADS} where clickup_task_id='${ctx.leadCt}';`))[0] || {};
      const voto = (await pgQuery(
        `select count(*)::int as n from ${TABELA_VOTOS} where ligacao_task_id='${ctx.ligKey}' and candidato='romero';`,
      ))[0]?.n ?? 0;
      const aplicado = lead.confirmou_romero === ctx.romero && voto === 1;
      const outboxPresente = (await contarOutbox(`lead:${ctx.leadCt}:voto:romero:${ctx.ligKey}`)) === 1;
      return { aplicado, outboxPresente };
    },
    async sanidade(ctx) {
      await comOutboxRpc(this.rpcReal, { p_operador: ctx.operador, p_ligacao_id: ctx.ligId, p_romero: ctx.romero });
    },
    async limpar(ctx) {
      await pgQuery(`delete from ${TABELA_OUTBOX} where dedup_key like 'lead:${ctx.leadCt}:%';`);
      await pgQuery(`delete from ${TABELA_VOTOS} where ligacao_task_id = '${ctx.ligKey}';`);
      await pgQuery(`delete from ${TABELA_LIGACOES} where id = ${ctx.ligId};`);
      await pgQuery(`delete from ${TABELA_LEADS} where clickup_task_id = '${ctx.leadCt}';`);
    },
  });
}

// ---- registrar_voto — CAMINHO LEAD -----------------------------------------
// p_ligacao_id NULO + p_lead_clickup_task_id setado; ledger key determinística
// 'lead:'||lead_clickup_task_id. SoT (UPDATE leads) + ledger (INSERT votos)
// ANTES do pg_sleep; INSERT no outbox DEPOIS. O caminho LEAD (novo na revisão
// do 19-08) tem prova both-or-neither PRÓPRIA — não herda a do caminho ligação.
{
  const rpcTeste = `${RPC_VOTO}_gatetest_lead`;
  exigirIdentificadorHml(rpcTeste, 'rpcTeste voto[LEAD] (derivado)');
  specs.push({
    slug: 'voto_lead',
    rotulo: 'voto[LEAD]',
    rpcReal: RPC_VOTO,
    rpcTeste,
    ddl: `
create or replace function ${rpcTeste}(p_lead_clickup_task_id text, p_operador text, p_romero text, p_sleep_ms int)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_lead_ct text; v_lig_key text; v_agg bigint;
begin
  select clickup_task_id into v_lead_ct from ${TABELA_LEADS} where clickup_task_id = p_lead_clickup_task_id;
  if not found then raise exception '${rpcTeste}: lead % inexistente', p_lead_clickup_task_id; end if;
  v_lig_key := 'lead:' || v_lead_ct;
  update ${TABELA_LEADS}
     set confirmou_romero=coalesce(p_romero, confirmou_romero), atualizado_em=now()
   where clickup_task_id = v_lead_ct;
  insert into ${TABELA_VOTOS} (ligacao_task_id, lead_task_id, operador, candidato, escolha, origem)
    values (v_lig_key, coalesce(v_lead_ct,''), p_operador, 'romero', p_romero, 'ligacao')
    on conflict (ligacao_task_id, candidato) do update set escolha=excluded.escolha, operador=excluded.operador;
  v_agg := hashtextextended(v_lead_ct, 0);
  if p_sleep_ms > 0 then perform pg_sleep(p_sleep_ms / 1000.0); end if;
  insert into ${TABELA_OUTBOX} (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values ('lead', v_agg, 'set_campo', true,
            jsonb_build_object('campo', 'CONFIRMOU_VOTO_ROMERO', 'valor', p_romero),
            'lead:' || v_lead_ct || ':voto:romero:' || v_lig_key,
            coalesce((select max(seq) from ${TABELA_OUTBOX} where aggregate='lead' and aggregate_id=v_agg), 0) + 1)
    on conflict (dedup_key) do nothing;
end;$$;`,
    dropSql: `drop function if exists ${rpcTeste}(text, text, text, int);`,
    async semear(uid) {
      const leadCt = `GATELEAD-${runId}-votolead-${uid}`;
      const operador = `op-${runId}-${uid}`;
      await pgQuery(`insert into ${TABELA_LEADS} (clickup_task_id) values ('${leadCt}');`);
      const ligKey = `lead:${leadCt}`;
      return { leadCt, ligKey, operador, romero: 'sim' };
    },
    chamada(ctx, sleepMs) {
      return `${rpcTeste}('${ctx.leadCt}', '${ctx.operador}', '${ctx.romero}', ${sleepMs})`;
    },
    async verificar(ctx) {
      const lead = (await pgQuery(`select confirmou_romero from ${TABELA_LEADS} where clickup_task_id='${ctx.leadCt}';`))[0] || {};
      const voto = (await pgQuery(
        `select count(*)::int as n from ${TABELA_VOTOS} where ligacao_task_id='${ctx.ligKey}' and candidato='romero';`,
      ))[0]?.n ?? 0;
      const aplicado = lead.confirmou_romero === ctx.romero && voto === 1;
      const outboxPresente = (await contarOutbox(`lead:${ctx.leadCt}:voto:romero:${ctx.ligKey}`)) === 1;
      return { aplicado, outboxPresente };
    },
    async sanidade(ctx) {
      await comOutboxRpc(this.rpcReal, {
        p_operador: ctx.operador,
        p_ligacao_id: null,
        p_lead_clickup_task_id: ctx.leadCt,
        p_romero: ctx.romero,
      });
    },
    async limpar(ctx) {
      await pgQuery(`delete from ${TABELA_OUTBOX} where dedup_key like 'lead:${ctx.leadCt}:%';`);
      await pgQuery(`delete from ${TABELA_VOTOS} where ligacao_task_id = '${ctx.ligKey}';`);
      await pgQuery(`delete from ${TABELA_LEADS} where clickup_task_id = '${ctx.leadCt}';`);
    },
  });
}

// ---- consolidar_e_fechar_ligacao -------------------------------------------
// UPDATE leads + UPDATE ligacoes (agregado) ANTES do pg_sleep; INSERT no
// outbox DEPOIS.
{
  const rpcTeste = `${RPC_CONSOLIDAR}_gatetest`;
  exigirIdentificadorHml(rpcTeste, 'rpcTeste consolidar (derivado)');
  specs.push({
    slug: 'consolidar',
    rotulo: 'consolidar',
    rpcReal: RPC_CONSOLIDAR,
    rpcTeste,
    ddl: `
create or replace function ${rpcTeste}(p_ligacao_id bigint, p_lead_ct text, p_sleep_ms int)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  update ${TABELA_LEADS} set score=1, atualizado_em=now() where clickup_task_id = p_lead_ct;
  update ${TABELA_LIGACOES}
     set status='fechada', resultado='atendida', atendeu=true, atualizado_em=now()
   where id = p_ligacao_id;
  if not found then raise exception '${rpcTeste}: ligacao % inexistente', p_ligacao_id; end if;
  if p_sleep_ms > 0 then perform pg_sleep(p_sleep_ms / 1000.0); end if;
  insert into ${TABELA_OUTBOX} (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values ('ligacao', p_ligacao_id, 'set_status', true,
          jsonb_build_object('resultado', 'atendida', 'atendeu', true),
          'ligacao:' || p_ligacao_id || ':consolidar-fechar',
          coalesce((select max(seq) from ${TABELA_OUTBOX} where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1)
  on conflict (dedup_key) do nothing;
end;$$;`,
    dropSql: `drop function if exists ${rpcTeste}(bigint, text, int);`,
    async semear(uid) {
      const leadCt = `GATELEAD-${runId}-consol-${uid}`;
      const canon = `GATETEST-${runId}-consol-${uid}`;
      await pgQuery(`insert into ${TABELA_LEADS} (clickup_task_id) values ('${leadCt}');`);
      const linhas = await pgQuery(`
        insert into ${TABELA_LIGACOES} (lead_id, lead_clickup_task_id, telefone_canonico, status, origem)
        values (null, '${leadCt}', '${canon}', 'aberta', 'lote')
        returning id;`);
      const ligId = linhas[0]?.id;
      if (!ligId) throw new Error(`[gate] consolidar.semear falhou (uid=${uid})`);
      return { ligId, leadCt, canon };
    },
    chamada(ctx, sleepMs) {
      return `${rpcTeste}(${ctx.ligId}, '${ctx.leadCt}', ${sleepMs})`;
    },
    async verificar(ctx) {
      const l = (await pgQuery(`select status, resultado from ${TABELA_LIGACOES} where id = ${ctx.ligId};`))[0] || {};
      const aplicado = l.status === 'fechada' && l.resultado === 'atendida';
      const outboxPresente = (await contarOutbox(`ligacao:${ctx.ligId}:consolidar-fechar`)) === 1;
      return { aplicado, outboxPresente };
    },
    async sanidade(ctx) {
      await comOutboxRpc(this.rpcReal, {
        p_ligacao_id: ctx.ligId,
        p_lead_id: null,
        p_lead_clickup_task_id: ctx.leadCt,
        p_leads_patch: { score: 1 },
        p_ligacao_patch: { resultado: 'atendida', atendeu: true },
      });
    },
    async limpar(ctx) {
      await pgQuery(`delete from ${TABELA_OUTBOX} where aggregate_id = ${ctx.ligId};`);
      await pgQuery(`delete from ${TABELA_OUTBOX} where dedup_key like 'lead:${ctx.leadCt}:%';`);
      await pgQuery(`delete from ${TABELA_LIGACOES} where id = ${ctx.ligId};`);
      await pgQuery(`delete from ${TABELA_LEADS} where clickup_task_id = '${ctx.leadCt}';`);
    },
  });
}

// ===== Classificação both-or-neither =====

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
    // agregado + outbox presentes apesar do kill == janela perdida (a tx
    // commitou antes do kill atingir): conta 'both', não é falha do invariante.
    r.both++;
    if (!killOk) r.janelaPerdida++;
  }
}

// ===== Runner genérico por classe =====

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
        classificarControleSan(r, await spec.verificar(ctx));
      } else {
        // kill-mid-tx
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

// ===== Sweep final por runId (defesa extra além do limpar por-iteração) =====

async function sweepFinal() {
  try {
    await pgQuery(`delete from ${TABELA_OUTBOX} where dedup_key like 'lead:GATELEAD-${runId}-%';`);
    await pgQuery(
      `delete from ${TABELA_OUTBOX} where aggregate_id in (select id from ${TABELA_LIGACOES} where telefone_canonico like 'GATETEST-${runId}-%');`,
    );
    await pgQuery(`delete from ${TABELA_VOTOS} where lead_task_id like 'GATELEAD-${runId}-%';`);
    await pgQuery(`delete from ${TABELA_LIGACOES} where telefone_canonico like 'GATETEST-${runId}-%';`);
    await pgQuery(`delete from ${TABELA_LEADS} where clickup_task_id like 'GATELEAD-${runId}-%';`);
  } catch (e) {
    console.error(`[gate] AVISO: falha no sweep final: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ===== Orquestração =====

async function main() {
  console.log(
    `[gate] kill-between-writes-fase-b — runId=${runId} — DB-only (nunca chama o ClickUp), ` +
      'rollback SERVER-SIDE via pg_terminate_backend (não kill de cliente)',
  );
  console.log(
    `[gate] tabelas: ${TABELA_LIGACOES} / ${TABELA_OUTBOX} / ${TABELA_LEADS} / ${TABELA_VOTOS}`,
  );
  console.log(`[gate] RPCs provadas: ${specs.map((s) => s.rotulo).join(', ')}`);

  // Cria todas as RPCs de teste (uma reload de schema no fim, como no molde).
  for (const spec of specs) {
    await pgQuery(spec.ddl);
  }
  await pgQuery(`notify pgrst, 'reload schema'`);

  const resultados = [];
  try {
    for (const spec of specs) {
      console.log(
        `[gate] --- ${spec.rotulo} (real=${spec.rpcReal}, teste=${spec.rpcTeste}) ---`,
      );
      const controle = await rodarClasse(spec, 'controle', GATE_CONTROLE_ITERS);
      const kill = await rodarClasse(spec, 'kill', GATE_KILL_ITERS);
      const sanidade = await rodarClasse(spec, 'sanidade', GATE_SANIDADE_ITERS);
      resultados.push({ spec, controle, kill, sanidade });
      console.log(
        `[gate] ${spec.rotulo}: controle both=${controle.both}/${controle.total}  ` +
          `kill neither=${kill.neither} both=${kill.both}(janela perdida=${kill.janelaPerdida}) ` +
          `orfao=${kill.orfao} perdido=${kill.perdido}  sanidade both=${sanidade.both}/${sanidade.total}`,
      );
    }
  } finally {
    await sweepFinal();
    for (const spec of specs) {
      try {
        await pgQuery(spec.dropSql);
      } catch (e) {
        console.error(`[gate] AVISO: falha ao dropar ${spec.rpcTeste}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // ===== Avaliação — cada RPC/caminho prova o invariante separadamente =====
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
    if (sanidade.both === 0) falhas.push(`${p}: sanidade.both === 0 — a RPC real não foi provada`);
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
  console.log('  (registrar_voto provado nos DOIS caminhos: voto[LIGACAO] e voto[LEAD], cada um com prova própria)');
  process.exit(0);
}

main().catch((e) => {
  console.error(`[gate] ERRO FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
