-- escala/25_rpc_registrar_anotacao.sql — Fase C (Phase 20), Caminho B.
--
-- NUMERAÇÃO: o plano-fonte (20-03-PLAN.md) previa `23_rpc_registrar_anotacao.sql`,
-- mas `22`/`23` já foram consumidos por `22_fundacao_fase_c.sql`/`23_indices_fase_c.sql`
-- (plano 20-01). Esta migração assume `25` (a próxima gaveta livre depois de
-- `24_rpc_registrar_envio_audio.sql`, deste mesmo plano) — ver 20-03-SUMMARY.md.
--
-- Molde EXATO de sql/escala/16_rpc_criar_ligacao_avulsa.sql — a RPC faz a
-- escrita do agregado (`notas`) + o INSERT no outbox no MESMO corpo plpgsql
-- (both-or-neither, design §3.0/§3.1, ESCRITA-05). Gêmeo `hml_registrar_anotacao`
-- referencia hml_notas/hml_clickup_outbox.
--
-- HOJE (src/mastra/index.ts, rota `/lead/:leadTaskId/anotacao` ~2220-2250):
-- `comentarTask(leadTaskId, texto)` direto e SÍNCRONO — a task-alvo é o
-- `leadTaskId` da Lista 01 (`p_aggregate='lead'`, o único caminho que a rota
-- atual usa; `'ligacao'` fica reservado pra uma anotação futura na Lista 02,
-- mesma função/assinatura).
--
-- ALVO POR PAYLOAD (design §3.2, drenar-outbox.ts::resolverAlvoLinha, Fase C
-- Plano 02): a op `comentar` de agregado `'nota'` NUNCA tem `criar_task` — a
-- lead/ligação já EXISTE no ClickUp. Por isso `p_clickup_task_id` (a task-alvo
-- já conhecida) vai DIRETO no `payload.clickup_task_id` da linha do outbox —
-- o dreno lê dali, sem depender de back-fill nem de `aggregate_id` apontar
-- para uma tabela com `clickup_task_id`. `bloqueante=false` (R6): uma
-- anotação atrasada nunca trava outras ops do mesmo agregado/aggregate_id.
--
-- LGPD: `p_corpo` (texto livre — pode conter PII) só aparece em coluna/payload
-- (payload é scrubado pós-drain, LGPD-03) — nenhum RAISE cita o corpo.
--
-- Idempotente (CREATE OR REPLACE FUNCTION) — pode reaplicar sem quebrar, desde
-- que a assinatura não mude.

-- ============================================================================
-- registrar_anotacao — produção (notas / clickup_outbox)
-- ============================================================================
create or replace function registrar_anotacao(
  p_aggregate       text,
  p_lead_id         bigint,
  p_clickup_task_id text,
  p_autor           text,
  p_corpo           text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_id     bigint;
  v_outbox int := 0;
begin
  insert into notas (aggregate, aggregate_id, autor, corpo, criado_em)
  values (p_aggregate, p_lead_id, p_autor, p_corpo, now())
  returning id into v_id;

  insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'nota',
    v_id,
    'comentar',
    false,
    jsonb_build_object('clickup_task_id', p_clickup_task_id, 'texto', p_corpo),
    'nota:' || v_id || ':comentar',
    1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_outbox = row_count;

  return jsonb_build_object(
    'nota_id', v_id,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- hml_registrar_anotacao — gêmeo de homolog (hml_notas / hml_clickup_outbox)
-- Corpo IDÊNTICO ao acima — só mudam os nomes de tabela.
-- ============================================================================
create or replace function hml_registrar_anotacao(
  p_aggregate       text,
  p_lead_id         bigint,
  p_clickup_task_id text,
  p_autor           text,
  p_corpo           text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_id     bigint;
  v_outbox int := 0;
begin
  insert into hml_notas (aggregate, aggregate_id, autor, corpo, criado_em)
  values (p_aggregate, p_lead_id, p_autor, p_corpo, now())
  returning id into v_id;

  insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'nota',
    v_id,
    'comentar',
    false,
    jsonb_build_object('clickup_task_id', p_clickup_task_id, 'texto', p_corpo),
    'nota:' || v_id || ':comentar',
    1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_outbox = row_count;

  return jsonb_build_object(
    'nota_id', v_id,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- Segurança/exposição: SECURITY INVOKER + search_path fixado + EXECUTE
-- revogado de public e concedido SÓ a service_role, para AMBAS as funções.
-- ============================================================================
revoke all on function registrar_anotacao(text, bigint, text, text, text) from public;
grant execute on function registrar_anotacao(text, bigint, text, text, text) to service_role;

revoke all on function hml_registrar_anotacao(text, bigint, text, text, text) from public;
grant execute on function hml_registrar_anotacao(text, bigint, text, text, text) to service_role;

-- Reload do cache de schema do PostgREST. A aplicação em homolog é o 20-08.
notify pgrst, 'reload schema';
