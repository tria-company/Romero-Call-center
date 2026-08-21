-- escala/16_rpc_criar_ligacao_avulsa.sql — Fase B (Phase 19), Caminho B.
--
-- Molde EXATO de sql/escala/12_rpc_registrar_desfecho.sql — a RPC faz a
-- escrita do agregado + o INSERT no outbox no MESMO corpo plpgsql
-- (both-or-neither, design §3.0/§3.1, ESCRITA-01). Gêmeo
-- `hml_criar_ligacao_avulsa` referencia hml_ligacoes/hml_clickup_outbox.
--
-- DEDUP AUTORITATIVO (MODELO-02/R3, sql/escala/13_ux_ligacoes_aberta_por_tel.sql,
-- Phase 19): `INSERT ... ON CONFLICT (telefone_canonico) WHERE status='aberta'
-- DO NOTHING` mira o índice UNIQUE parcial criado no 19-01 — duas
-- redeliveries do Evolution (ou dois processos/réplicas) tentando criar a
-- MESMA ligação aberta pro MESMO telefone colidem no banco em vez de
-- duplicar. `GET DIAGNOSTICS ROW_COUNT` decide "criada vs. já existia": 1 =
-- criou (a RPC enfileira `criar_task` no outbox), 0 = já existia (resolve o
-- id existente, NÃO reenfileira criar_task — evitaria duplicar a task no
-- ClickUp). A rota decide por este rowcount, nunca por guarda em memória de
-- processo (src/mastra/clickup.ts::criarLigacaoAvulsa hoje faz isso via
-- criarTask direto — aqui vira INSERT + outbox).
--
-- LGPD: nunca loga telefone (o telefone_canonico já vem normalizado pela rota,
-- telefone-canonico.ts 19-01) — nenhum RAISE cita o telefone em claro.
--
-- Idempotente (CREATE OR REPLACE FUNCTION) — pode reaplicar sem quebrar,
-- desde que a assinatura não mude.

-- ============================================================================
-- criar_ligacao_avulsa — produção (ligacoes / clickup_outbox)
-- ============================================================================
create or replace function criar_ligacao_avulsa(
  p_telefone_canonico  text,
  p_telefone_variantes text[],
  p_operador           text,
  p_assignee_clickup_id bigint,
  p_lead_id             bigint default null,
  p_lead_clickup_task_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_id        bigint;
  v_rowcount  int;
  v_outbox    int := 0;
begin
  -- (1) INSERT protegido pelo UNIQUE parcial — colide (DO NOTHING) se já
  -- existir uma ligação 'aberta' com o mesmo telefone_canonico.
  insert into ligacoes (
    lead_id, lead_clickup_task_id, operador, assignee_clickup_id,
    telefone_canonico, telefone_variantes, status, origem, criado_em, atualizado_em
  )
  values (
    p_lead_id, p_lead_clickup_task_id, p_operador, p_assignee_clickup_id,
    p_telefone_canonico, p_telefone_variantes, 'aberta', 'avulsa', now(), now()
  )
  on conflict (telefone_canonico) where status='aberta' do nothing
  returning id into v_id;
  get diagnostics v_rowcount = row_count;

  -- (2) se já existia (rowcount=0), resolve o id existente — a rota decide
  -- criada-vs-existia por ESTE rowcount, não por guarda em memória.
  if v_rowcount = 0 then
    select id into v_id from ligacoes where telefone_canonico = p_telefone_canonico and status = 'aberta' limit 1;
  end if;

  -- (3) outbox — SÓ quando CRIOU: o worker (19-03) cria a task no ClickUp e
  -- faz back-fill de clickup_task_id. Se já existia, nada é enfileirado
  -- (evita duplicar a task).
  if v_rowcount = 1 then
    insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'ligacao',
      v_id,
      'criar_task',
      true,
      jsonb_build_object(
        'origem', 'avulsa',
        'telefone_canonico', p_telefone_canonico,
        'assignee_clickup_id', p_assignee_clickup_id,
        'lead_clickup_task_id', p_lead_clickup_task_id
      ),
      'ligacao:' || v_id || ':criar',
      1
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_outbox = row_count;
  end if;

  return jsonb_build_object(
    'ligacao_id', v_id,
    'criada', v_rowcount = 1,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- hml_criar_ligacao_avulsa — gêmeo de homolog (hml_ligacoes / hml_clickup_outbox)
-- Corpo IDÊNTICO ao acima — só mudam os nomes de tabela. O ON CONFLICT mira
-- o índice gêmeo ux_hml_ligacoes_aberta_por_tel (mesmo predicado/coluna).
-- ============================================================================
create or replace function hml_criar_ligacao_avulsa(
  p_telefone_canonico  text,
  p_telefone_variantes text[],
  p_operador           text,
  p_assignee_clickup_id bigint,
  p_lead_id             bigint default null,
  p_lead_clickup_task_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_id        bigint;
  v_rowcount  int;
  v_outbox    int := 0;
begin
  insert into hml_ligacoes (
    lead_id, lead_clickup_task_id, operador, assignee_clickup_id,
    telefone_canonico, telefone_variantes, status, origem, criado_em, atualizado_em
  )
  values (
    p_lead_id, p_lead_clickup_task_id, p_operador, p_assignee_clickup_id,
    p_telefone_canonico, p_telefone_variantes, 'aberta', 'avulsa', now(), now()
  )
  on conflict (telefone_canonico) where status='aberta' do nothing
  returning id into v_id;
  get diagnostics v_rowcount = row_count;

  if v_rowcount = 0 then
    select id into v_id from hml_ligacoes where telefone_canonico = p_telefone_canonico and status = 'aberta' limit 1;
  end if;

  if v_rowcount = 1 then
    insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'ligacao',
      v_id,
      'criar_task',
      true,
      jsonb_build_object(
        'origem', 'avulsa',
        'telefone_canonico', p_telefone_canonico,
        'assignee_clickup_id', p_assignee_clickup_id,
        'lead_clickup_task_id', p_lead_clickup_task_id
      ),
      'ligacao:' || v_id || ':criar',
      1
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_outbox = row_count;
  end if;

  return jsonb_build_object(
    'ligacao_id', v_id,
    'criada', v_rowcount = 1,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- Segurança/exposição: SECURITY INVOKER + search_path fixado + EXECUTE
-- revogado de public e concedido SÓ a service_role, para AMBAS as funções.
-- ============================================================================
revoke all on function criar_ligacao_avulsa(text, text[], text, bigint, bigint, text) from public;
grant execute on function criar_ligacao_avulsa(text, text[], text, bigint, bigint, text) to service_role;

revoke all on function hml_criar_ligacao_avulsa(text, text[], text, bigint, bigint, text) from public;
grant execute on function hml_criar_ligacao_avulsa(text, text[], text, bigint, bigint, text) to service_role;

-- Reload do cache de schema do PostgREST (kick do authenticator via
-- scripts/aplicar-sql.mjs). A aplicação em homolog é o plano 19-10.
notify pgrst, 'reload schema';
