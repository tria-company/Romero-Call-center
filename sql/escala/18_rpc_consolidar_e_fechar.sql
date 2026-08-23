-- escala/18_rpc_consolidar_e_fechar.sql — Fase B (Phase 19), Caminho B.
--
-- Molde EXATO de sql/escala/12_rpc_registrar_desfecho.sql — a RPC faz a
-- escrita do agregado + o INSERT no outbox no MESMO corpo plpgsql
-- (both-or-neither, design §3.0/§3.1, ESCRITA-01). Gêmeo
-- `hml_consolidar_e_fechar_ligacao` referencia hml_discador_leads_espelho/
-- hml_ligacoes/hml_clickup_outbox.
--
-- ESCOPO: concentra a PARTE DE ESCRITA de processador.ts::consolidarEFecharLigacao
-- (UPDATE leads + UPDATE ligacoes fechada + outbox), numa transação única. O
-- TS que chama esta RPC continua responsável pela chamada de LLM/dossiê e por
-- CALCULAR os patches (p_leads_patch/p_ligacao_patch) — esta função só
-- APLICA, nunca decide o conteúdo.
--
-- WHITELIST ESTÁTICA (NUNCA SQL dinâmico sobre identificador — T-19-02-Ti):
-- as chaves de p_leads_patch são uma lista FIXA enumerada no código
-- (score/tentativas/proximo_contato/retorno_necessario/observacao_consolidada/
-- dossie/ultimo_contato/qtd_contatos) — testadas com o operador jsonb `?`
-- (existência de chave) e aplicadas via CASE por-coluna; a CHAVE em si NUNCA
-- vira identificador de coluna via EXECUTE/format.
--
-- SURROGATE NUMÉRICO do outbox 'lead' (mesmo débito de 17_rpc_registrar_voto.sql):
-- `clickup_outbox.aggregate_id` é bigint NOT NULL; `discador_leads_espelho`
-- ainda não tem PK numérica (Phase 20). Usa p_lead_id quando o caller já o
-- resolveu; senão hashtextextended(clickup_task_id, 0) como pseudo-id
-- determinístico — a identidade real do lead no outbox é o dedup_key
-- (texto), aggregate_id só agrupa/ordena o dreno.
--
-- Idempotente (CREATE OR REPLACE FUNCTION) — pode reaplicar sem quebrar,
-- desde que a assinatura não mude.

-- ============================================================================
-- consolidar_e_fechar_ligacao — produção (discador_leads_espelho / ligacoes / clickup_outbox)
-- ============================================================================
create or replace function consolidar_e_fechar_ligacao(
  p_ligacao_id           bigint,
  p_lead_id              bigint,
  p_lead_clickup_task_id text,
  p_leads_patch          jsonb,
  p_ligacao_patch        jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_chaves             text[] := array['score','tentativas','proximo_contato','retorno_necessario','observacao_consolidada','dossie','ultimo_contato','qtd_contatos'];
  v_chave              text;
  v_lead_aggregate_id  bigint;
  v_outbox             int := 0;
  v_tmp                int;
begin
  v_lead_aggregate_id := coalesce(p_lead_id, hashtextextended(p_lead_clickup_task_id, 0));

  -- (1) leads — whitelist estática enumerada; só sobrescreve a chave PRESENTE
  -- em p_leads_patch (chave ausente mantém o valor atual).
  update discador_leads_espelho
     set score=case when p_leads_patch ? 'score' then (p_leads_patch->>'score')::int else score end,
         tentativas=case when p_leads_patch ? 'tentativas' then (p_leads_patch->>'tentativas')::int else tentativas end,
         proximo_contato=case when p_leads_patch ? 'proximo_contato' then (p_leads_patch->>'proximo_contato')::date else proximo_contato end,
         retorno_necessario=case when p_leads_patch ? 'retorno_necessario' then (p_leads_patch->>'retorno_necessario')::boolean else retorno_necessario end,
         observacao_consolidada=case when p_leads_patch ? 'observacao_consolidada' then p_leads_patch->>'observacao_consolidada' else observacao_consolidada end,
         dossie=case when p_leads_patch ? 'dossie' then p_leads_patch->>'dossie' else dossie end,
         ultimo_contato=case when p_leads_patch ? 'ultimo_contato' then (p_leads_patch->>'ultimo_contato')::timestamptz else ultimo_contato end,
         qtd_contatos=case when p_leads_patch ? 'qtd_contatos' then (p_leads_patch->>'qtd_contatos')::int else qtd_contatos end,
         atualizado_em=now()
   where clickup_task_id = p_lead_clickup_task_id;

  -- (2) ligacoes — fecha a ligação com o desfecho já computado pelo TS.
  update ligacoes
     set status='fechada',
         resultado=coalesce(p_ligacao_patch->>'resultado', resultado),
         atendeu=(p_ligacao_patch->>'atendeu')::boolean,
         transcricao=coalesce(p_ligacao_patch->>'transcricao', transcricao),
         analise_ia=coalesce(p_ligacao_patch->'analise_ia', analise_ia),
         -- CR-02: só sobrescreve necessita_revisao quando há SINAL real (a chave
         -- PRESENTE em p_ligacao_patch — divergência de voto OU baixa aderência,
         -- ver processador.ts). Chave AUSENTE = consolidação sem sinal de revisão:
         -- PRESERVA o valor atual (COALESCE via CASE), nunca zera a coluna. Espelha
         -- o guard do outbox NECESSITA_REVISAO logo abaixo (`? 'necessita_revisao'`).
         necessita_revisao=case when p_ligacao_patch ? 'necessita_revisao'
                                then (p_ligacao_patch->>'necessita_revisao')::boolean
                                else necessita_revisao end,
         atualizado_em=now()
   where id = p_ligacao_id;

  -- (3) outbox — ligação: set_status (resultado+atendeu) sempre; set_campo
  -- por-chave presente (transcricao/analise_ia/necessita_revisao).
  insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'ligacao',
    p_ligacao_id,
    'set_status',
    true,
    jsonb_build_object('resultado', p_ligacao_patch->>'resultado', 'atendeu', (p_ligacao_patch->>'atendeu')::boolean),
    'ligacao:' || p_ligacao_id || ':consolidar-fechar',
    coalesce((select max(seq) from clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_outbox + v_tmp;

  if p_ligacao_patch ? 'transcricao' then
    insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'ligacao',
      p_ligacao_id,
      'set_campo',
      true,
      jsonb_build_object('campo', 'TRANSCRICAO', 'valor', p_ligacao_patch->>'transcricao'),
      'ligacao:' || p_ligacao_id || ':transcricao',
      coalesce((select max(seq) from clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_tmp = row_count;
    v_outbox := v_outbox + v_tmp;
  end if;

  if p_ligacao_patch ? 'analise_ia' then
    insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'ligacao',
      p_ligacao_id,
      'set_campo',
      true,
      jsonb_build_object('campo', 'ANALISE_IA', 'valor', p_ligacao_patch->'analise_ia'),
      'ligacao:' || p_ligacao_id || ':analise_ia',
      coalesce((select max(seq) from clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_tmp = row_count;
    v_outbox := v_outbox + v_tmp;
  end if;

  if p_ligacao_patch ? 'necessita_revisao' then
    insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'ligacao',
      p_ligacao_id,
      'set_campo',
      true,
      jsonb_build_object('campo', 'NECESSITA_REVISAO', 'valor', (p_ligacao_patch->>'necessita_revisao')::boolean),
      'ligacao:' || p_ligacao_id || ':necessita_revisao',
      coalesce((select max(seq) from clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_tmp = row_count;
    v_outbox := v_outbox + v_tmp;
  end if;

  -- (4) outbox — leads: uma linha set_campo por-chave PRESENTE em p_leads_patch
  -- (whitelist estática — o loop itera sobre a LISTA FIXA declarada acima,
  -- nunca sobre chaves arbitrárias do jsonb recebido).
  foreach v_chave in array v_chaves loop
    if p_leads_patch ? v_chave then
      insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
      values (
        'lead',
        v_lead_aggregate_id,
        'set_campo',
        true,
        jsonb_build_object('campo', upper(v_chave), 'valor', p_leads_patch -> v_chave),
        'lead:' || p_lead_clickup_task_id || ':' || v_chave || ':consolidar',
        coalesce((select max(seq) from clickup_outbox where aggregate='lead' and aggregate_id=v_lead_aggregate_id), 0) + 1
      )
      on conflict (dedup_key) do nothing;
      get diagnostics v_tmp = row_count;
      v_outbox := v_outbox + v_tmp;
    end if;
  end loop;

  return jsonb_build_object(
    'ligacao_id', p_ligacao_id,
    'lead_clickup_task_id', p_lead_clickup_task_id,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- hml_consolidar_e_fechar_ligacao — gêmeo de homolog (hml_discador_leads_espelho
-- / hml_ligacoes / hml_clickup_outbox). Corpo IDÊNTICO ao acima — só mudam os
-- nomes de tabela.
-- ============================================================================
create or replace function hml_consolidar_e_fechar_ligacao(
  p_ligacao_id           bigint,
  p_lead_id              bigint,
  p_lead_clickup_task_id text,
  p_leads_patch          jsonb,
  p_ligacao_patch        jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_chaves             text[] := array['score','tentativas','proximo_contato','retorno_necessario','observacao_consolidada','dossie','ultimo_contato','qtd_contatos'];
  v_chave              text;
  v_lead_aggregate_id  bigint;
  v_outbox             int := 0;
  v_tmp                int;
begin
  v_lead_aggregate_id := coalesce(p_lead_id, hashtextextended(p_lead_clickup_task_id, 0));

  update hml_discador_leads_espelho
     set score=case when p_leads_patch ? 'score' then (p_leads_patch->>'score')::int else score end,
         tentativas=case when p_leads_patch ? 'tentativas' then (p_leads_patch->>'tentativas')::int else tentativas end,
         proximo_contato=case when p_leads_patch ? 'proximo_contato' then (p_leads_patch->>'proximo_contato')::date else proximo_contato end,
         retorno_necessario=case when p_leads_patch ? 'retorno_necessario' then (p_leads_patch->>'retorno_necessario')::boolean else retorno_necessario end,
         observacao_consolidada=case when p_leads_patch ? 'observacao_consolidada' then p_leads_patch->>'observacao_consolidada' else observacao_consolidada end,
         dossie=case when p_leads_patch ? 'dossie' then p_leads_patch->>'dossie' else dossie end,
         ultimo_contato=case when p_leads_patch ? 'ultimo_contato' then (p_leads_patch->>'ultimo_contato')::timestamptz else ultimo_contato end,
         qtd_contatos=case when p_leads_patch ? 'qtd_contatos' then (p_leads_patch->>'qtd_contatos')::int else qtd_contatos end,
         atualizado_em=now()
   where clickup_task_id = p_lead_clickup_task_id;

  update hml_ligacoes
     set status='fechada',
         resultado=coalesce(p_ligacao_patch->>'resultado', resultado),
         atendeu=(p_ligacao_patch->>'atendeu')::boolean,
         transcricao=coalesce(p_ligacao_patch->>'transcricao', transcricao),
         analise_ia=coalesce(p_ligacao_patch->'analise_ia', analise_ia),
         -- CR-02 (gêmeo IDÊNTICO ao de produção): só sobrescreve necessita_revisao
         -- quando a chave está PRESENTE em p_ligacao_patch (sinal real); ausente
         -- PRESERVA o valor atual, nunca zera.
         necessita_revisao=case when p_ligacao_patch ? 'necessita_revisao'
                                then (p_ligacao_patch->>'necessita_revisao')::boolean
                                else necessita_revisao end,
         atualizado_em=now()
   where id = p_ligacao_id;

  insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'ligacao',
    p_ligacao_id,
    'set_status',
    true,
    jsonb_build_object('resultado', p_ligacao_patch->>'resultado', 'atendeu', (p_ligacao_patch->>'atendeu')::boolean),
    'ligacao:' || p_ligacao_id || ':consolidar-fechar',
    coalesce((select max(seq) from hml_clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_outbox + v_tmp;

  if p_ligacao_patch ? 'transcricao' then
    insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'ligacao',
      p_ligacao_id,
      'set_campo',
      true,
      jsonb_build_object('campo', 'TRANSCRICAO', 'valor', p_ligacao_patch->>'transcricao'),
      'ligacao:' || p_ligacao_id || ':transcricao',
      coalesce((select max(seq) from hml_clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_tmp = row_count;
    v_outbox := v_outbox + v_tmp;
  end if;

  if p_ligacao_patch ? 'analise_ia' then
    insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'ligacao',
      p_ligacao_id,
      'set_campo',
      true,
      jsonb_build_object('campo', 'ANALISE_IA', 'valor', p_ligacao_patch->'analise_ia'),
      'ligacao:' || p_ligacao_id || ':analise_ia',
      coalesce((select max(seq) from hml_clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_tmp = row_count;
    v_outbox := v_outbox + v_tmp;
  end if;

  if p_ligacao_patch ? 'necessita_revisao' then
    insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'ligacao',
      p_ligacao_id,
      'set_campo',
      true,
      jsonb_build_object('campo', 'NECESSITA_REVISAO', 'valor', (p_ligacao_patch->>'necessita_revisao')::boolean),
      'ligacao:' || p_ligacao_id || ':necessita_revisao',
      coalesce((select max(seq) from hml_clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_tmp = row_count;
    v_outbox := v_outbox + v_tmp;
  end if;

  foreach v_chave in array v_chaves loop
    if p_leads_patch ? v_chave then
      insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
      values (
        'lead',
        v_lead_aggregate_id,
        'set_campo',
        true,
        jsonb_build_object('campo', upper(v_chave), 'valor', p_leads_patch -> v_chave),
        'lead:' || p_lead_clickup_task_id || ':' || v_chave || ':consolidar',
        coalesce((select max(seq) from hml_clickup_outbox where aggregate='lead' and aggregate_id=v_lead_aggregate_id), 0) + 1
      )
      on conflict (dedup_key) do nothing;
      get diagnostics v_tmp = row_count;
      v_outbox := v_outbox + v_tmp;
    end if;
  end loop;

  return jsonb_build_object(
    'ligacao_id', p_ligacao_id,
    'lead_clickup_task_id', p_lead_clickup_task_id,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- Segurança/exposição: SECURITY INVOKER + search_path fixado + EXECUTE
-- revogado de public e concedido SÓ a service_role, para AMBAS as funções.
-- ============================================================================
revoke all on function consolidar_e_fechar_ligacao(bigint, bigint, text, jsonb, jsonb) from public;
grant execute on function consolidar_e_fechar_ligacao(bigint, bigint, text, jsonb, jsonb) to service_role;

revoke all on function hml_consolidar_e_fechar_ligacao(bigint, bigint, text, jsonb, jsonb) from public;
grant execute on function hml_consolidar_e_fechar_ligacao(bigint, bigint, text, jsonb, jsonb) to service_role;

-- Reload do cache de schema do PostgREST (kick do authenticator via
-- scripts/aplicar-sql.mjs). A aplicação em homolog é o plano 19-10.
notify pgrst, 'reload schema';
