-- escala/17_rpc_registrar_voto.sql — Fase B (Phase 19), Caminho B.
--
-- Molde EXATO de sql/escala/12_rpc_registrar_desfecho.sql — a RPC faz a
-- escrita do agregado + o INSERT no outbox no MESMO corpo plpgsql
-- (both-or-neither, design §3.0/§3.1, ESCRITA-01/R12). Gêmeo
-- `hml_registrar_voto` referencia hml_discador_leads_espelho/hml_votos_ligacao/
-- hml_clickup_outbox.
--
-- DEVIO DE ASSINATURA (deviation Rule 1 — fix de bug bloqueante): o plano
-- 19-02 especifica `registrar_voto(p_ligacao_id bigint default null,
-- p_operador text, ...)` — o Postgres EXIGE que todo parâmetro posicional sem
-- DEFAULT venha ANTES de qualquer parâmetro com DEFAULT (CREATE FUNCTION não
-- compila com um obrigatório depois de um opcional). `p_operador` (sem
-- default) foi movido para o primeiro lugar; os quatro parâmetros com
-- default (`p_ligacao_id`, `p_romero`, `p_andressa`, `p_lead_clickup_task_id`)
-- seguem depois. PostgREST chama RPCs por nome de parâmetro (JSON body), não
-- por posição — a reordenação não muda o contrato de chamada dos planos
-- 19-07/08 (que passam args nomeados).
--
-- VOTO — TRÊS REPRESENTAÇÕES, UMA SoT (R12, design §3.3): leads.confirmou_* é
-- a ÚNICA fonte do voto corrente (SoT); votos_ligacao é o ledger append-only
-- de atribuição (quem colheu, quando); ambos escritos na MESMA transação
-- desta RPC, com o outbox set_campo espelhando pro ClickUp.
--
-- DOIS CAMINHOS DETERMINÍSTICOS (nunca condicional a "se houver ligação"):
--   (a) LIGAÇÃO — p_ligacao_id não-nulo: resolve lead/operador pela linha de
--       `ligacoes`; ledger key = coalesce(clickup_task_id, 'local:'||id).
--       Guard anti-IDOR: recusa registrar voto de ligação de outro operador.
--   (b) LEAD — p_ligacao_id NULO + p_lead_clickup_task_id: resolve o lead
--       direto em discador_leads_espelho; ledger key DETERMINÍSTICA
--       'lead:'||lead_clickup_task_id (não há ligação em curso). Guard de
--       gestor é da ROTA (19-08), não desta RPC — esta ação é sobre o LEAD.
-- Isso permite que /voto e /lead/:id/voto (19-08) consumam esta MESMA RPC sem
-- ramo condicional na rota.
--
-- SURROGATE NUMÉRICO do outbox 'lead' (débito documentado): `clickup_outbox.
-- aggregate_id` é `bigint NOT NULL`, mas `discador_leads_espelho` ainda não
-- tem PK numérica (só `clickup_task_id text` — a inversão de `leads` com PK
-- bigint é Phase 20). Usa `ligacoes.lead_id` quando já resolvido (caminho
-- ligação); senão `hashtextextended(clickup_task_id, 0)` como pseudo-id
-- determinístico. A IDENTIDADE REAL do lead no outbox é o `dedup_key` (texto,
-- carrega o clickup_task_id) — `aggregate_id` só agrupa/ordena o dreno
-- (ix_outbox_ordem), nunca é usado como FK/join.
--
-- Idempotente (CREATE OR REPLACE FUNCTION) — pode reaplicar sem quebrar,
-- desde que a assinatura não mude.

-- ============================================================================
-- registrar_voto — produção (discador_leads_espelho / votos_ligacao / clickup_outbox)
-- ============================================================================
create or replace function registrar_voto(
  p_operador             text,
  p_ligacao_id           bigint default null,
  p_romero               text default null,
  p_andressa             text default null,
  p_lead_clickup_task_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_lead_ct            text;
  v_lead_id_ligacao    bigint;
  v_operador_atual     text;
  v_lig_key            text;
  v_lead_aggregate_id  bigint;
  v_outbox             int := 0;
  v_tmp                int;
begin
  if p_ligacao_id is not null then
    -- Caminho LIGAÇÃO: resolve lead/operador/chave do ledger pela linha.
    select lead_id, lead_clickup_task_id, operador, coalesce(clickup_task_id, 'local:'||id)
      into v_lead_id_ligacao, v_lead_ct, v_operador_atual, v_lig_key
      from ligacoes where id = p_ligacao_id;
    if not found then
      raise exception 'registrar_voto: ligacao % inexistente', p_ligacao_id;
    end if;

    if v_operador_atual is not null and v_operador_atual <> p_operador then
      raise exception 'registrar_voto: ligacao % pertence a outro operador', p_ligacao_id;
    end if;
  else
    -- Caminho LEAD: exige p_lead_clickup_task_id; ledger key DETERMINÍSTICA
    -- 'lead:'||lead_clickup_task_id (sem ligação em curso).
    if p_lead_clickup_task_id is null then
      raise exception 'registrar_voto: p_lead_clickup_task_id obrigatorio quando p_ligacao_id e nulo';
    end if;

    select clickup_task_id into v_lead_ct
      from discador_leads_espelho where clickup_task_id = p_lead_clickup_task_id;
    if not found then
      raise exception 'registrar_voto: lead % inexistente', p_lead_clickup_task_id;
    end if;

    v_lig_key := 'lead:' || v_lead_ct;
  end if;

  -- SoT: leads.confirmou_* — sobrescreve SÓ o candidato passado, para AMBOS
  -- os caminhos.
  update discador_leads_espelho
     set confirmou_romero=coalesce(p_romero, confirmou_romero),
         confirmou_andressa=coalesce(p_andressa, confirmou_andressa),
         atualizado_em=now()
   where clickup_task_id = v_lead_ct;

  v_lead_aggregate_id := coalesce(v_lead_id_ligacao, hashtextextended(v_lead_ct, 0));

  if p_romero is not null then
    -- Ledger: append-only por (ligacao_task_id, candidato) — corrigir a
    -- marcação na MESMA referência atualiza a linha, não duplica.
    insert into votos_ligacao (ligacao_task_id, lead_task_id, operador, candidato, escolha, origem)
    values (v_lig_key, coalesce(v_lead_ct, ''), p_operador, 'romero', p_romero, 'ligacao')
    on conflict (ligacao_task_id, candidato) do update set escolha=excluded.escolha, operador=excluded.operador;

    -- outbox set_campo — dedup_key inclui lead + candidato + lig_key: não
    -- colide entre voto-de-ligação e voto-de-lead do MESMO lead/candidato.
    insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'lead',
      v_lead_aggregate_id,
      'set_campo',
      true,
      jsonb_build_object('campo', 'CONFIRMOU_VOTO_ROMERO', 'valor', p_romero),
      'lead:' || v_lead_ct || ':voto:romero:' || v_lig_key,
      coalesce((select max(seq) from clickup_outbox where aggregate='lead' and aggregate_id=v_lead_aggregate_id), 0) + 1
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_tmp = row_count;
    v_outbox := v_outbox + v_tmp;
  end if;

  if p_andressa is not null then
    insert into votos_ligacao (ligacao_task_id, lead_task_id, operador, candidato, escolha, origem)
    values (v_lig_key, coalesce(v_lead_ct, ''), p_operador, 'andressa', p_andressa, 'ligacao')
    on conflict (ligacao_task_id, candidato) do update set escolha=excluded.escolha, operador=excluded.operador;

    insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'lead',
      v_lead_aggregate_id,
      'set_campo',
      true,
      jsonb_build_object('campo', 'CONFIRMOU_VOTO_ANDRESSA', 'valor', p_andressa),
      'lead:' || v_lead_ct || ':voto:andressa:' || v_lig_key,
      coalesce((select max(seq) from clickup_outbox where aggregate='lead' and aggregate_id=v_lead_aggregate_id), 0) + 1
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_tmp = row_count;
    v_outbox := v_outbox + v_tmp;
  end if;

  return jsonb_build_object(
    'lead_clickup_task_id', v_lead_ct,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- hml_registrar_voto — gêmeo de homolog (hml_ligacoes / hml_discador_leads_espelho
-- / hml_votos_ligacao / hml_clickup_outbox). Corpo IDÊNTICO ao acima — só
-- mudam os nomes de tabela.
-- ============================================================================
create or replace function hml_registrar_voto(
  p_operador             text,
  p_ligacao_id           bigint default null,
  p_romero               text default null,
  p_andressa             text default null,
  p_lead_clickup_task_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_lead_ct            text;
  v_lead_id_ligacao    bigint;
  v_operador_atual     text;
  v_lig_key            text;
  v_lead_aggregate_id  bigint;
  v_outbox             int := 0;
  v_tmp                int;
begin
  if p_ligacao_id is not null then
    select lead_id, lead_clickup_task_id, operador, coalesce(clickup_task_id, 'local:'||id)
      into v_lead_id_ligacao, v_lead_ct, v_operador_atual, v_lig_key
      from hml_ligacoes where id = p_ligacao_id;
    if not found then
      raise exception 'hml_registrar_voto: ligacao % inexistente', p_ligacao_id;
    end if;

    if v_operador_atual is not null and v_operador_atual <> p_operador then
      raise exception 'hml_registrar_voto: ligacao % pertence a outro operador', p_ligacao_id;
    end if;
  else
    if p_lead_clickup_task_id is null then
      raise exception 'hml_registrar_voto: p_lead_clickup_task_id obrigatorio quando p_ligacao_id e nulo';
    end if;

    select clickup_task_id into v_lead_ct
      from hml_discador_leads_espelho where clickup_task_id = p_lead_clickup_task_id;
    if not found then
      raise exception 'hml_registrar_voto: lead % inexistente', p_lead_clickup_task_id;
    end if;

    v_lig_key := 'lead:' || v_lead_ct;
  end if;

  update hml_discador_leads_espelho
     set confirmou_romero=coalesce(p_romero, confirmou_romero),
         confirmou_andressa=coalesce(p_andressa, confirmou_andressa),
         atualizado_em=now()
   where clickup_task_id = v_lead_ct;

  v_lead_aggregate_id := coalesce(v_lead_id_ligacao, hashtextextended(v_lead_ct, 0));

  if p_romero is not null then
    insert into hml_votos_ligacao (ligacao_task_id, lead_task_id, operador, candidato, escolha, origem)
    values (v_lig_key, coalesce(v_lead_ct, ''), p_operador, 'romero', p_romero, 'ligacao')
    on conflict (ligacao_task_id, candidato) do update set escolha=excluded.escolha, operador=excluded.operador;

    insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'lead',
      v_lead_aggregate_id,
      'set_campo',
      true,
      jsonb_build_object('campo', 'CONFIRMOU_VOTO_ROMERO', 'valor', p_romero),
      'lead:' || v_lead_ct || ':voto:romero:' || v_lig_key,
      coalesce((select max(seq) from hml_clickup_outbox where aggregate='lead' and aggregate_id=v_lead_aggregate_id), 0) + 1
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_tmp = row_count;
    v_outbox := v_outbox + v_tmp;
  end if;

  if p_andressa is not null then
    insert into hml_votos_ligacao (ligacao_task_id, lead_task_id, operador, candidato, escolha, origem)
    values (v_lig_key, coalesce(v_lead_ct, ''), p_operador, 'andressa', p_andressa, 'ligacao')
    on conflict (ligacao_task_id, candidato) do update set escolha=excluded.escolha, operador=excluded.operador;

    insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'lead',
      v_lead_aggregate_id,
      'set_campo',
      true,
      jsonb_build_object('campo', 'CONFIRMOU_VOTO_ANDRESSA', 'valor', p_andressa),
      'lead:' || v_lead_ct || ':voto:andressa:' || v_lig_key,
      coalesce((select max(seq) from hml_clickup_outbox where aggregate='lead' and aggregate_id=v_lead_aggregate_id), 0) + 1
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_tmp = row_count;
    v_outbox := v_outbox + v_tmp;
  end if;

  return jsonb_build_object(
    'lead_clickup_task_id', v_lead_ct,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- Segurança/exposição: SECURITY INVOKER + search_path fixado + EXECUTE
-- revogado de public e concedido SÓ a service_role, para AMBAS as funções.
-- ============================================================================
revoke all on function registrar_voto(text, bigint, text, text, text) from public;
grant execute on function registrar_voto(text, bigint, text, text, text) to service_role;

revoke all on function hml_registrar_voto(text, bigint, text, text, text) from public;
grant execute on function hml_registrar_voto(text, bigint, text, text, text) to service_role;

-- Reload do cache de schema do PostgREST (kick do authenticator via
-- scripts/aplicar-sql.mjs). A aplicação em homolog é o plano 19-10.
notify pgrst, 'reload schema';
