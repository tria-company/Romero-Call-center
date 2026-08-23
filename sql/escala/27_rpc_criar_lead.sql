-- escala/27_rpc_criar_lead.sql — Fase C (Phase 20), Caminho B — quick task 260823-h1s.
--
-- NUMERAÇÃO: 26 é a última gaveta ocupada (26_rpc_gerar_lote.sql, plano 20-03)
-- — 27 é a próxima gaveta livre (confirmado via `ls sql/escala/` antes de
-- escrever este arquivo).
--
-- Molde EXATO de sql/escala/16_rpc_criar_ligacao_avulsa.sql — a RPC faz a
-- escrita do agregado (`discador_leads_espelho`) + o INSERT no
-- `clickup_outbox` no MESMO corpo plpgsql (both-or-neither, design §3.0/§3.1).
-- Gêmeo `hml_criar_lead` referencia hml_discador_leads_espelho/hml_clickup_outbox.
--
-- CRIAÇÃO DE LEAD NATIVO (Fase C — inversão Supabase-fonte-da-verdade): um
-- lead criado direto no Supabase ainda não tem task no ClickUp — diferente de
-- audios/notas/ligações (que sempre referenciam um lead_clickup_task_id JÁ
-- existente), aqui a task da Lista 01 nasce DEPOIS, via dreno. Como
-- `discador_leads_espelho.clickup_task_id` é a PRIMARY KEY (NOT NULL,
-- sql/escala/02_leads_espelho.sql), o INSERT usa um placeholder ÚNICO
-- prefixado `'novo:'` (`'novo:' || gen_random_uuid()::text`) — nunca um
-- literal fixo (colidiria já no 2º lead). O prefixo `novo:` é o sinal que o
-- futuro back-fill do dreno (débito pré-flip, ver rodapé) usa pra distinguir
-- "ainda não resolvido" de um clickup_task_id real.
--
-- `canonizar_telefone` (sql/escala/22_fundacao_fase_c.sql, fonte ÚNICA,
-- table-agnóstica, sem gêmeo hml_) é usado SÓ no payload do outbox (campo
-- TELEFONE do ClickUp, tipo phone) — a coluna `telefone` do espelho guarda o
-- valor cru (`p_telefone`), mesma disciplina das demais RPCs da Fase C.
--
-- SEM dedup por telefone (diferente de criar_ligacao_avulsa/MODELO-02): não
-- há índice UNIQUE por telefone em `discador_leads_espelho` e esta quick task
-- não pede dedup — `criar_lead` sempre INSERE um lead novo.
--
-- LGPD: nenhum RAISE cita telefone/CPF em claro — os parâmetros só aparecem
-- em coluna/payload (payload é scrubado pós-drain pelo worker de dreno,
-- LGPD-03, mesma disciplina das RPCs anteriores).
--
-- Idempotente (CREATE OR REPLACE FUNCTION) — pode reaplicar sem quebrar,
-- desde que a assinatura não mude.
--
-- NÃO APLICADO A NENHUM BANCO VIVO por esta quick task — a aplicação é passo
-- de operador (mesmo padrão do checkpoint 20-08/20-08-RUNBOOK-FLIP.md).
--
-- DÉBITO PRÉ-FLIP (BLOQUEANTE — ver 260823-h1s-SUMMARY.md/verification do
-- plano-fonte): o DRENO (src/mastra/drenar-outbox.ts +
-- src/mastra/outbox-repo.ts) HOJE exclui 'lead' de 'criar_task'
-- (AGREGADOS_COM_CRIAR_TASK = {'ligacao','audio'}) — a linha de outbox
-- aggregate='lead'/op='criar_task' que esta RPC enfileira NÃO será drenada
-- corretamente até o dreno ser estendido (montarBodyDoLead + back-fill ciente
-- do placeholder 'novo:' + TABELA_DO_AGREGADO['lead']). Isso é OBRIGATÓRIO
-- ANTES de qualquer flip FONTE_LEADS=supabase — risco de deferir é ZERO ao
-- vivo enquanto FONTE_LEADS='clickup' (default), porque nenhuma linha de
-- outbox 'lead' existe até esta migração ser aplicada E FONTE_LEADS ser
-- virado (ambos passos de operador).

-- ============================================================================
-- criar_lead — produção (discador_leads_espelho / clickup_outbox)
-- ============================================================================
create or replace function criar_lead(
  p_nome         text,
  p_telefone     text,
  p_cpf          text default null,
  p_bairro       text default null,
  p_cidade       text default null,
  p_dossie       text default null,
  p_tags         text[] default null,
  p_militante    boolean default false,
  p_super_fa     boolean default false,
  p_elegivel     boolean default null,
  p_score        int default null,
  p_id_supabase  text default null,
  p_origem       text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_id             bigint;
  v_outbox         int := 0;
  v_tel_canonico   text;
  v_clickup_task_id_placeholder text := 'novo:' || gen_random_uuid()::text;
begin
  v_tel_canonico := canonizar_telefone(p_telefone);

  insert into discador_leads_espelho (
    clickup_task_id, id_supabase, nome, nome_lower, telefone, cpf, bairro, cidade,
    dossie, tags, militante, super_fa, elegivel, score, sem_contato, atualizado_em
  )
  values (
    v_clickup_task_id_placeholder, p_id_supabase, p_nome, lower(p_nome), p_telefone, p_cpf, p_bairro, p_cidade,
    p_dossie, p_tags, coalesce(p_militante, false), coalesce(p_super_fa, false), p_elegivel, p_score, true, now()
  )
  returning id into v_id;

  insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'lead',
    v_id,
    'criar_task',
    true,
    jsonb_build_object(
      'nome', p_nome,
      'telefone_canonico', v_tel_canonico,
      'cpf', p_cpf,
      'bairro', p_bairro,
      'cidade', p_cidade,
      'dossie', p_dossie,
      'origem', p_origem,
      'score', p_score,
      'id_supabase', p_id_supabase,
      'tags', to_jsonb(p_tags),
      'militante', coalesce(p_militante, false)
    ),
    'lead:' || v_id || ':criar',
    1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_outbox = row_count;

  return jsonb_build_object(
    'lead_id', v_id,
    'id_supabase', p_id_supabase,
    'clickup_task_id_local', 'novo:' || v_id,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- hml_criar_lead — gêmeo de homolog (hml_discador_leads_espelho / hml_clickup_outbox)
-- Corpo IDÊNTICO ao acima — só mudam os nomes de tabela. `canonizar_telefone`
-- é table-agnóstica (sem gêmeo hml_, ver sql/escala/22_fundacao_fase_c.sql) —
-- a mesma definição serve prod e homolog.
-- ============================================================================
create or replace function hml_criar_lead(
  p_nome         text,
  p_telefone     text,
  p_cpf          text default null,
  p_bairro       text default null,
  p_cidade       text default null,
  p_dossie       text default null,
  p_tags         text[] default null,
  p_militante    boolean default false,
  p_super_fa     boolean default false,
  p_elegivel     boolean default null,
  p_score        int default null,
  p_id_supabase  text default null,
  p_origem       text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_id             bigint;
  v_outbox         int := 0;
  v_tel_canonico   text;
  v_clickup_task_id_placeholder text := 'novo:' || gen_random_uuid()::text;
begin
  v_tel_canonico := canonizar_telefone(p_telefone);

  insert into hml_discador_leads_espelho (
    clickup_task_id, id_supabase, nome, nome_lower, telefone, cpf, bairro, cidade,
    dossie, tags, militante, super_fa, elegivel, score, sem_contato, atualizado_em
  )
  values (
    v_clickup_task_id_placeholder, p_id_supabase, p_nome, lower(p_nome), p_telefone, p_cpf, p_bairro, p_cidade,
    p_dossie, p_tags, coalesce(p_militante, false), coalesce(p_super_fa, false), p_elegivel, p_score, true, now()
  )
  returning id into v_id;

  insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'lead',
    v_id,
    'criar_task',
    true,
    jsonb_build_object(
      'nome', p_nome,
      'telefone_canonico', v_tel_canonico,
      'cpf', p_cpf,
      'bairro', p_bairro,
      'cidade', p_cidade,
      'dossie', p_dossie,
      'origem', p_origem,
      'score', p_score,
      'id_supabase', p_id_supabase,
      'tags', to_jsonb(p_tags),
      'militante', coalesce(p_militante, false)
    ),
    'lead:' || v_id || ':criar',
    1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_outbox = row_count;

  return jsonb_build_object(
    'lead_id', v_id,
    'id_supabase', p_id_supabase,
    'clickup_task_id_local', 'novo:' || v_id,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- Segurança/exposição: SECURITY INVOKER + search_path fixado + EXECUTE
-- revogado de public e concedido SÓ a service_role, para AMBAS as funções.
-- ============================================================================
revoke all on function criar_lead(text, text, text, text, text, text, text[], boolean, boolean, boolean, int, text, text) from public;
grant execute on function criar_lead(text, text, text, text, text, text, text[], boolean, boolean, boolean, int, text, text) to service_role;

revoke all on function hml_criar_lead(text, text, text, text, text, text, text[], boolean, boolean, boolean, int, text, text) from public;
grant execute on function hml_criar_lead(text, text, text, text, text, text, text[], boolean, boolean, boolean, int, text, text) to service_role;

-- Reload do cache de schema do PostgREST. A aplicação em homolog é um passo
-- de operador (fora do escopo desta quick task).
notify pgrst, 'reload schema';
