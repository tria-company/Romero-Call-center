-- escala/26_rpc_gerar_lote.sql — Fase C (Phase 20), Caminho B (LEITURA-06).
--
-- NUMERAÇÃO: o plano-fonte (20-03-PLAN.md) previa `24_rpc_gerar_lote.sql`, mas
-- `22`-`25` já foram consumidos por `22_fundacao_fase_c.sql`/`23_indices_fase_c.sql`
-- (plano 20-01) e `24_rpc_registrar_envio_audio.sql`/`25_rpc_registrar_anotacao.sql`
-- (Tasks 1/2 deste mesmo plano). Esta migração assume `26` (a próxima gaveta
-- livre) — ver 20-03-SUMMARY.md.
--
-- Molde EXATO de sql/escala/16_rpc_criar_ligacao_avulsa.sql — a RPC faz a
-- SELEÇÃO por SQL (LEITURA-06) + o INSERT do agregado (`ligacoes`) + o INSERT
-- no outbox por-linha inserida, tudo na MESMA transação (both-or-neither,
-- design §5(1)/ESCRITA-01). Gêmeo `hml_gerar_lote` referencia
-- hml_discador_leads_espelho/hml_ligacoes/hml_clickup_outbox — chamando as
-- MESMAS funções puras `canonizar_telefone`/`variantes_telefone` (20-01,
-- table-agnósticas, sem gêmeo hml_).
--
-- ORDEM DE ELEGIBILIDADE (design §5(1), ix_leads_lote — sql/escala/08_leads_full.sql):
-- `WHERE elegivel AND NOT EXISTS (ligação aberta do lead) ORDER BY
-- retorno_necessario DESC, score DESC, tentativas ASC LIMIT $tamanho` — a MESMA
-- ordem de `lote.ts::selecionarLoteElegivel`, agora em SQL puro sobre
-- `discador_leads_espelho` (não mais `listarTasks` da Lista 01).
--
-- PINADO (MEDIUM-1, hazard do dedup MODELO-02): `telefone_canonico`/
-- `telefone_variantes` são derivados POR-LINHA chamando `canonizar_telefone`/
-- `variantes_telefone` (20-01) — as funções ÚNICAS byte-idênticas a
-- `telefone-canonico.ts`. NUNCA reimplementar a normalização inline aqui: uma
-- segunda forma canônica faria o `ON CONFLICT (telefone_canonico)` (o UNIQUE
-- parcial `ux_ligacoes_aberta_por_tel`, sql/escala/13) dedupar contra uma
-- chave diferente da que a camada TS grava, quebrando o dedup autoritativo.
--
-- DECISÃO — `script` (roteiro do Agente Script): a geração do roteiro é uma
-- chamada de LLM (fora do banco, feita pelo runner/wiring, 20-06) — e o runner
-- só sabe QUAIS leads foram selecionados DEPOIS que esta RPC roda (a seleção
-- também é feita aqui, por SQL). Preencher `script`/description no MOMENTO do
-- INSERT exigiria ou (a) mover a seleção para fora do banco (perderia
-- LEITURA-06) ou (b) uma segunda chamada round-trip ANTES do INSERT só para
-- prever quem seria selecionado (frágil — corrida entre a previsão e o INSERT
-- real). Opção escolhida (a mais simples, plano permite explicitamente):
-- `gerar_lote` insere `script=null`; o runner (20-06), de posse do retorno
-- (`ligacoes_criadas`, com `id`/`lead_clickup_task_id`), gera o roteiro por
-- lead e materializa via um caminho separado (UPDATE ligacoes.script + outbox
-- set_campo/descrição da task) — fora do escopo desta RPC (SQL-only, este
-- plano não toca TS). O outbox `criar_task` desta RPC NÃO carrega `script` no
-- payload por esse motivo (débito documentado, ver 20-03-SUMMARY.md).
--
-- LGPD: nenhum RAISE cita telefone.
--
-- Idempotente (CREATE OR REPLACE FUNCTION) — pode reaplicar sem quebrar, desde
-- que a assinatura não mude.

-- ============================================================================
-- gerar_lote — produção (discador_leads_espelho / ligacoes / clickup_outbox)
-- ============================================================================
create or replace function gerar_lote(
  p_operador             text,
  p_assignee_clickup_id  bigint,
  p_tamanho              int,
  p_lote_data            date default current_date
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_criadas int := 0;
  v_outbox  int := 0;
  v_tmp     int;
  rec       record;
begin
  for rec in
    with candidatos as (
      select l.id as lead_id, l.clickup_task_id as lead_clickup_task_id, l.telefone
        from discador_leads_espelho l
       where l.elegivel
         and not exists (
           select 1 from ligacoes g where g.lead_id = l.id and g.status = 'aberta'
         )
       order by l.retorno_necessario desc, l.score desc, l.tentativas asc
       limit p_tamanho
    )
    insert into ligacoes (
      lead_id, lead_clickup_task_id, operador, assignee_clickup_id,
      telefone_canonico, telefone_variantes, script, status, origem, lote_data,
      criado_em, atualizado_em
    )
    select
      c.lead_id,
      c.lead_clickup_task_id,
      p_operador,
      p_assignee_clickup_id,
      canonizar_telefone(c.telefone),
      variantes_telefone(c.telefone),
      null,
      'aberta',
      'lote',
      p_lote_data,
      now(),
      now()
    from candidatos c
    on conflict (telefone_canonico) where status = 'aberta' do nothing
    returning id, lead_clickup_task_id, telefone_canonico, assignee_clickup_id
  loop
    v_criadas := v_criadas + 1;

    insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'ligacao',
      rec.id,
      'criar_task',
      true,
      jsonb_build_object(
        'origem', 'lote',
        'telefone_canonico', rec.telefone_canonico,
        'assignee_clickup_id', rec.assignee_clickup_id,
        'lead_clickup_task_id', rec.lead_clickup_task_id
      ),
      'ligacao:' || rec.id || ':criar',
      1
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_tmp = row_count;
    v_outbox := v_outbox + v_tmp;
  end loop;

  return jsonb_build_object(
    'criadas', v_criadas,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- hml_gerar_lote — gêmeo de homolog (hml_discador_leads_espelho / hml_ligacoes /
-- hml_clickup_outbox). Corpo IDÊNTICO ao acima — só mudam os nomes de tabela;
-- chama as MESMAS funções puras canonizar_telefone/variantes_telefone (20-01,
-- table-agnósticas, sem gêmeo hml_).
-- ============================================================================
create or replace function hml_gerar_lote(
  p_operador             text,
  p_assignee_clickup_id  bigint,
  p_tamanho              int,
  p_lote_data            date default current_date
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_criadas int := 0;
  v_outbox  int := 0;
  v_tmp     int;
  rec       record;
begin
  for rec in
    with candidatos as (
      select l.id as lead_id, l.clickup_task_id as lead_clickup_task_id, l.telefone
        from hml_discador_leads_espelho l
       where l.elegivel
         and not exists (
           select 1 from hml_ligacoes g where g.lead_id = l.id and g.status = 'aberta'
         )
       order by l.retorno_necessario desc, l.score desc, l.tentativas asc
       limit p_tamanho
    )
    insert into hml_ligacoes (
      lead_id, lead_clickup_task_id, operador, assignee_clickup_id,
      telefone_canonico, telefone_variantes, script, status, origem, lote_data,
      criado_em, atualizado_em
    )
    select
      c.lead_id,
      c.lead_clickup_task_id,
      p_operador,
      p_assignee_clickup_id,
      canonizar_telefone(c.telefone),
      variantes_telefone(c.telefone),
      null,
      'aberta',
      'lote',
      p_lote_data,
      now(),
      now()
    from candidatos c
    on conflict (telefone_canonico) where status = 'aberta' do nothing
    returning id, lead_clickup_task_id, telefone_canonico, assignee_clickup_id
  loop
    v_criadas := v_criadas + 1;

    insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'ligacao',
      rec.id,
      'criar_task',
      true,
      jsonb_build_object(
        'origem', 'lote',
        'telefone_canonico', rec.telefone_canonico,
        'assignee_clickup_id', rec.assignee_clickup_id,
        'lead_clickup_task_id', rec.lead_clickup_task_id
      ),
      'ligacao:' || rec.id || ':criar',
      1
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_tmp = row_count;
    v_outbox := v_outbox + v_tmp;
  end loop;

  return jsonb_build_object(
    'criadas', v_criadas,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- Segurança/exposição: SECURITY INVOKER + search_path fixado + EXECUTE
-- revogado de public e concedido SÓ a service_role, para AMBAS as funções.
-- ============================================================================
revoke all on function gerar_lote(text, bigint, int, date) from public;
grant execute on function gerar_lote(text, bigint, int, date) to service_role;

revoke all on function hml_gerar_lote(text, bigint, int, date) from public;
grant execute on function hml_gerar_lote(text, bigint, int, date) to service_role;

-- Reload do cache de schema do PostgREST. A aplicação em homolog é o 20-08.
notify pgrst, 'reload schema';
