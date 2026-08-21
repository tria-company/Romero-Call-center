-- escala/15_rpc_pular_ligacao.sql — Fase B (Phase 19), Caminho B.
--
-- Molde EXATO de sql/escala/12_rpc_registrar_desfecho.sql — a RPC faz a
-- escrita do agregado + o INSERT no outbox no MESMO corpo plpgsql
-- (both-or-neither, design §3.0/§3.1, ESCRITA-01). Gêmeo `hml_pular_ligacao`
-- referencia hml_ligacoes/hml_clickup_outbox. DÉBITO herdado (Phase 18, nota
-- (c) de 12): sincronia manual entre os dois corpos.
--
-- Semântica 'pulado' (src/mastra/index.ts /audios/pular): fecha a ligação
-- (status='fechada', resultado='pulado') como uma falha NÃO-atendida com
-- motivo fixo, e reusa a MESMA reconciliação de duplicatas de
-- registrar_desfecho (fecha as demais ligações ABERTAS e VIRGENS — sem
-- INICIO — do mesmo lead, dentro da MESMA transação). GUARD ANTI-IDOR: recusa
-- pular ligação de outro operador (mesma garantia de CR-01).
--
-- Idempotente (CREATE OR REPLACE FUNCTION) — pode reaplicar sem quebrar,
-- desde que a assinatura não mude.

-- ============================================================================
-- pular_ligacao — produção (ligacoes / clickup_outbox)
-- ============================================================================
create or replace function pular_ligacao(
  p_ligacao_id bigint,
  p_operador   text,
  p_motivo     text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_lead_id        bigint;
  v_operador_atual text;
  v_dups           bigint[];
  v_outbox         int := 0;
  v_tmp            int;
begin
  -- (1) resolve lead + operador atual — ligação inexistente aborta tudo.
  select lead_id, operador into v_lead_id, v_operador_atual from ligacoes where id = p_ligacao_id;
  if not found then
    raise exception 'pular_ligacao: ligacao % inexistente', p_ligacao_id;
  end if;

  -- guard anti-IDOR.
  if v_operador_atual is not null and v_operador_atual <> p_operador then
    raise exception 'pular_ligacao: ligacao % pertence a outro operador', p_ligacao_id;
  end if;

  -- (2) desfecho 'pulado' da ligação principal.
  update ligacoes
     set status='fechada',
         resultado='pulado',
         atendeu=false,
         motivo_falha='Pulado',
         atualizado_em=now()
   where id = p_ligacao_id;

  -- (3) fecha as demais ligações ABERTAS e VIRGENS (sem INICIO) do mesmo
  -- lead — mesma reconciliação de fecharLigacoesDuplicadas (clickup.ts:892),
  -- agora both-or-neither com o passo (2).
  with dups as (
    update ligacoes
       set status='fechada', atualizado_em=now()
     where lead_id = v_lead_id
       and status='aberta'
       and inicio is null
       and id <> p_ligacao_id
     returning id
  )
  select array_agg(id) into v_dups from dups;

  -- (4) outbox — 'fechar' bloqueante da ligação principal.
  insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'ligacao',
    p_ligacao_id,
    'fechar',
    true,
    jsonb_build_object('motivo', 'pulado'),
    'ligacao:' || p_ligacao_id || ':pular',
    coalesce((select max(seq) from clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_tmp;

  -- outbox — 'comentar' NÃO-bloqueante com o motivo do operador (o worker
  -- formata "⏭️ Contato pulado"). LGPD: p_motivo é frase livre do operador
  -- (sem telefone/CPF por contrato) — vai só pro payload, nunca pro log.
  insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'ligacao',
    p_ligacao_id,
    'comentar',
    false,
    jsonb_build_object('texto', p_motivo),
    'ligacao:' || p_ligacao_id || ':pular-comentario',
    coalesce((select max(seq) from clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_outbox + v_tmp;

  -- outbox — uma linha 'fechar' por duplicata fechada no passo (3).
  insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  select
    'ligacao',
    dup_id,
    'fechar',
    true,
    jsonb_build_object('motivo', 'duplicata_fechada_no_pular', 'ligacao_principal', p_ligacao_id),
    'ligacao:' || dup_id || ':fechar-dup',
    coalesce((select max(seq) from clickup_outbox where aggregate='ligacao' and aggregate_id=dup_id), 0) + 1
  from unnest(v_dups) as dup_id
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_outbox + v_tmp;

  return jsonb_build_object(
    'ligacao_id', p_ligacao_id,
    'duplicatas_fechadas', coalesce(array_length(v_dups, 1), 0),
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- hml_pular_ligacao — gêmeo de homolog (hml_ligacoes / hml_clickup_outbox)
-- Corpo IDÊNTICO ao acima — só mudam os nomes de tabela.
-- ============================================================================
create or replace function hml_pular_ligacao(
  p_ligacao_id bigint,
  p_operador   text,
  p_motivo     text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_lead_id        bigint;
  v_operador_atual text;
  v_dups           bigint[];
  v_outbox         int := 0;
  v_tmp            int;
begin
  select lead_id, operador into v_lead_id, v_operador_atual from hml_ligacoes where id = p_ligacao_id;
  if not found then
    raise exception 'hml_pular_ligacao: ligacao % inexistente', p_ligacao_id;
  end if;

  if v_operador_atual is not null and v_operador_atual <> p_operador then
    raise exception 'hml_pular_ligacao: ligacao % pertence a outro operador', p_ligacao_id;
  end if;

  update hml_ligacoes
     set status='fechada',
         resultado='pulado',
         atendeu=false,
         motivo_falha='Pulado',
         atualizado_em=now()
   where id = p_ligacao_id;

  with dups as (
    update hml_ligacoes
       set status='fechada', atualizado_em=now()
     where lead_id = v_lead_id
       and status='aberta'
       and inicio is null
       and id <> p_ligacao_id
     returning id
  )
  select array_agg(id) into v_dups from dups;

  insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'ligacao',
    p_ligacao_id,
    'fechar',
    true,
    jsonb_build_object('motivo', 'pulado'),
    'ligacao:' || p_ligacao_id || ':pular',
    coalesce((select max(seq) from hml_clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_tmp;

  insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'ligacao',
    p_ligacao_id,
    'comentar',
    false,
    jsonb_build_object('texto', p_motivo),
    'ligacao:' || p_ligacao_id || ':pular-comentario',
    coalesce((select max(seq) from hml_clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_outbox + v_tmp;

  insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  select
    'ligacao',
    dup_id,
    'fechar',
    true,
    jsonb_build_object('motivo', 'duplicata_fechada_no_pular', 'ligacao_principal', p_ligacao_id),
    'ligacao:' || dup_id || ':fechar-dup',
    coalesce((select max(seq) from hml_clickup_outbox where aggregate='ligacao' and aggregate_id=dup_id), 0) + 1
  from unnest(v_dups) as dup_id
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_outbox + v_tmp;

  return jsonb_build_object(
    'ligacao_id', p_ligacao_id,
    'duplicatas_fechadas', coalesce(array_length(v_dups, 1), 0),
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- Segurança/exposição: SECURITY INVOKER + search_path fixado + EXECUTE
-- revogado de public e concedido SÓ a service_role, para AMBAS as funções.
-- ============================================================================
revoke all on function pular_ligacao(bigint, text, text) from public;
grant execute on function pular_ligacao(bigint, text, text) to service_role;

revoke all on function hml_pular_ligacao(bigint, text, text) from public;
grant execute on function hml_pular_ligacao(bigint, text, text) to service_role;

-- Reload do cache de schema do PostgREST (kick do authenticator via
-- scripts/aplicar-sql.mjs). A aplicação em homolog é o plano 19-10.
notify pgrst, 'reload schema';
