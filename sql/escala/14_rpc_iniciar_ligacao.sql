-- escala/14_rpc_iniciar_ligacao.sql — Fase B (Phase 19), Caminho B.
--
-- Molde EXATO de sql/escala/12_rpc_registrar_desfecho.sql (Phase 18, gate
-- kill-between-writes já provado): a RPC faz a escrita do agregado + o INSERT
-- no outbox no MESMO corpo plpgsql — both-or-neither garantido pelo banco
-- (design §3.0/§3.1, ESCRITA-01). Gêmeo `hml_iniciar_ligacao` referencia
-- hml_ligacoes/hml_clickup_outbox (isolamento homolog, mesma disciplina do
-- 12). DÉBITO herdado (Phase 18, nota (c) de 12): os dois corpos são
-- idênticos exceto pelo nome das tabelas — sincronia manual.
--
-- Comportamento a preservar de src/mastra/clickup.ts::iniciarLigacao: carimba
-- INICIO+OPERADOR (custom fields) sem mudar STATUS (telemetria pura,
-- quick-260813-lf7 — quem tira a Ligação da fila é o DESFECHO, não o
-- carimbo). GUARD ANTI-IDOR: se a ligação já tem operador diferente do que
-- está tentando carimbar, RAISE (rollback) — mesma garantia de CR-01
-- (validarLigacaoDoOperador) hoje feita via assignee do ClickUp; uma ligação
-- de lote ainda sem operador (recém-criada) aceita o carimbo do primeiro
-- operador que a puxar.
--
-- Idempotente (CREATE OR REPLACE FUNCTION) — pode reaplicar sem quebrar,
-- desde que a assinatura não mude.

-- ============================================================================
-- iniciar_ligacao — produção (ligacoes / clickup_outbox)
-- ============================================================================
create or replace function iniciar_ligacao(
  p_ligacao_id          bigint,
  p_operador            text,
  p_assignee_clickup_id bigint default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_operador_atual text;
  v_outbox         int := 0;
  v_tmp            int;
begin
  -- (1) resolve o operador atual da ligação — inexistente aborta tudo.
  select operador into v_operador_atual from ligacoes where id = p_ligacao_id;
  if not found then
    raise exception 'iniciar_ligacao: ligacao % inexistente', p_ligacao_id;
  end if;

  -- guard anti-IDOR: recusa carimbar ligação já vinculada a OUTRO operador.
  -- Ligação de lote ainda sem operador (v_operador_atual is null) aceita o
  -- primeiro carimbo.
  if v_operador_atual is not null and v_operador_atual <> p_operador then
    raise exception 'iniciar_ligacao: ligacao % pertence a outro operador', p_ligacao_id;
  end if;

  -- (2) carimbo — NÃO muda status (telemetria pura).
  update ligacoes
     set inicio=now(),
         operador=p_operador,
         assignee_clickup_id=coalesce(p_assignee_clickup_id, assignee_clickup_id),
         atualizado_em=now()
   where id = p_ligacao_id;

  -- (3) outbox — duas linhas set_campo (INICIO/OPERADOR); o worker (19-03)
  -- mapeia o 'campo' lógico -> field_id do ClickUp. ON CONFLICT (dedup_key)
  -- DO NOTHING: reprocessar o mesmo carimbo não duplica push.
  insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'ligacao',
    p_ligacao_id,
    'set_campo',
    true,
    jsonb_build_object('campo', 'INICIO', 'valor', extract(epoch from now()) * 1000),
    'ligacao:' || p_ligacao_id || ':inicio',
    coalesce((select max(seq) from clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_tmp;

  insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'ligacao',
    p_ligacao_id,
    'set_campo',
    true,
    jsonb_build_object('campo', 'OPERADOR', 'valor', p_operador),
    'ligacao:' || p_ligacao_id || ':operador',
    coalesce((select max(seq) from clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_outbox + v_tmp;

  return jsonb_build_object(
    'ligacao_id', p_ligacao_id,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- hml_iniciar_ligacao — gêmeo de homolog (hml_ligacoes / hml_clickup_outbox)
-- Corpo IDÊNTICO ao acima — só mudam os nomes de tabela.
-- ============================================================================
create or replace function hml_iniciar_ligacao(
  p_ligacao_id          bigint,
  p_operador            text,
  p_assignee_clickup_id bigint default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_operador_atual text;
  v_outbox         int := 0;
  v_tmp            int;
begin
  select operador into v_operador_atual from hml_ligacoes where id = p_ligacao_id;
  if not found then
    raise exception 'hml_iniciar_ligacao: ligacao % inexistente', p_ligacao_id;
  end if;

  if v_operador_atual is not null and v_operador_atual <> p_operador then
    raise exception 'hml_iniciar_ligacao: ligacao % pertence a outro operador', p_ligacao_id;
  end if;

  update hml_ligacoes
     set inicio=now(),
         operador=p_operador,
         assignee_clickup_id=coalesce(p_assignee_clickup_id, assignee_clickup_id),
         atualizado_em=now()
   where id = p_ligacao_id;

  insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'ligacao',
    p_ligacao_id,
    'set_campo',
    true,
    jsonb_build_object('campo', 'INICIO', 'valor', extract(epoch from now()) * 1000),
    'ligacao:' || p_ligacao_id || ':inicio',
    coalesce((select max(seq) from hml_clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_tmp;

  insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'ligacao',
    p_ligacao_id,
    'set_campo',
    true,
    jsonb_build_object('campo', 'OPERADOR', 'valor', p_operador),
    'ligacao:' || p_ligacao_id || ':operador',
    coalesce((select max(seq) from hml_clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_outbox + v_tmp;

  return jsonb_build_object(
    'ligacao_id', p_ligacao_id,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- Segurança/exposição (mesma disciplina de 12_rpc_registrar_desfecho.sql):
-- SECURITY INVOKER + search_path fixado + EXECUTE revogado de public e
-- concedido SÓ a service_role, para AMBAS as funções.
-- ============================================================================
revoke all on function iniciar_ligacao(bigint, text, bigint) from public;
grant execute on function iniciar_ligacao(bigint, text, bigint) to service_role;

revoke all on function hml_iniciar_ligacao(bigint, text, bigint) from public;
grant execute on function hml_iniciar_ligacao(bigint, text, bigint) to service_role;

-- Reload do cache de schema do PostgREST (kick do authenticator via
-- scripts/aplicar-sql.mjs — o NOTIFY sozinho não propaga de forma confiável
-- neste deploy self-hosted). A aplicação em homolog é o plano 19-10.
notify pgrst, 'reload schema';
