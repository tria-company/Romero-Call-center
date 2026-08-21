-- escala/12_rpc_registrar_desfecho.sql — Portão 1 (substrato transacional), Caminho B.
--
-- (a) DESIGN: cada mutação multi-passo vira UMA função plpgsql = UMA chamada
-- PostgREST (`POST /rest/v1/rpc/{nome}`) = UMA transação de banco. É o
-- caminho travado pelo operador em 2026-08-21 (18-CONTEXT.md decisão 1) para
-- resolver o dual-write de PostgREST puro (design
-- .planning/arquitetura/inversao-supabase-fonte-da-verdade.md §0.1/§3.0/§3.1,
-- Riscos R1): sobre REST puro, "UPDATE ligacoes" + "INSERT clickup_outbox"
-- como duas chamadas são dois commits independentes — um crash entre eles
-- perde o push ou enfileira push de mutação que deu rollback. Aqui as duas
-- escritas (+ o fechamento de duplicatas, hoje best-effort em
-- src/mastra/clickup.ts:892 `fecharLigacoesDuplicadas`) vivem no MESMO corpo
-- plpgsql: ou tudo commita, ou nada — both-or-neither garantido pelo banco.
--
-- (b) ISOLAMENTO HOMOLOG: `hml_registrar_desfecho` é o gêmeo que referencia
-- hml_ligacoes/hml_clickup_outbox. O helper (src/mastra/outbox-rpc.ts)
-- escolhe QUAL RPC chamar via SUPABASE_RPC_REGISTRAR_DESFECHO (env) — sem
-- esse isolamento, chamar a RPC de produção a partir do homolog escreveria em
-- tabelas de PRODUÇÃO (o incidente do 17-02, mesma lição do isolamento
-- SUPABASE_TABLE_*=hml_ já usado no resto do projeto).
--
-- (c) DÉBITO EXPLÍCITO: os dois corpos abaixo são idênticos exceto pelo nome
-- das tabelas — `LIKE` não funciona para funções (só para tabelas), então a
-- sincronia entre `registrar_desfecho` e `hml_registrar_desfecho` é MANUAL.
-- Isso se generaliza (ex.: um gerador de migração, ou um único corpo
-- parametrizado por schema) na Phase 19, quando as demais RPCs do Caminho B
-- forem criadas (uma por mutação, ao inverter cada rota).
--
-- Escopo desta migração (18-CONTEXT.md Scope Fence): SÓ cria o substrato —
-- não é aplicada em nenhum banco nesta tarefa (18-01), nem consumida por
-- rota nenhuma (isso é a Phase 19). A aplicação em homolog + o teste
-- kill-between-writes são o plano 18-02.
--
-- Idempotente (CREATE OR REPLACE FUNCTION) — pode reaplicar sem quebrar,
-- desde que a assinatura (lista de parâmetros) não mude.

-- ============================================================================
-- registrar_desfecho — produção (ligacoes / clickup_outbox)
-- ============================================================================
create or replace function registrar_desfecho(
  p_ligacao_id   bigint,
  p_resultado    text,
  p_atendeu      boolean default null,
  p_motivo_falha text default null,
  p_fim          timestamptz default now(),
  p_duracao_seg  int default null,
  -- SÓ-TESTE (default 0 = no-op em produção): alarga a janela da transação
  -- entre as escritas para o teste kill-between-writes (18-02) posicionar o
  -- pg_terminate_backend. O gate 18-02 NÃO depende disto — ele cria/dropa sua
  -- própria FUNÇÃO DE TESTE espelho, com o pg_sleep posicionado ENTRE o
  -- UPDATE e o INSERT; este parâmetro fica aqui só como afordamento genérico
  -- da RPC de produção, sem uso obrigatório pelo gate.
  p_sleep_ms     int default 0
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_lead_id bigint;
  v_dups    bigint[];
  v_outbox  int := 0;
  v_tmp     int;
begin
  -- (1) resolve o lead da ligação principal — ligação inexistente aborta tudo
  -- (RAISE EXCEPTION = ROLLBACK implícito, nada persistido).
  select lead_id into v_lead_id from ligacoes where id = p_ligacao_id;
  if not found then
    raise exception 'registrar_desfecho: ligacao % inexistente', p_ligacao_id;
  end if;

  -- (2) desfecho da ligação principal.
  update ligacoes
     set status='fechada',
         resultado=p_resultado,
         atendeu=p_atendeu,
         motivo_falha=p_motivo_falha,
         fim=p_fim,
         duracao_seg=p_duracao_seg,
         atualizado_em=now()
   where id = p_ligacao_id;

  -- (3) fecha as demais ligações ABERTAS e VIRGENS (sem INICIO) do mesmo
  -- lead — a lógica hoje best-effort de fecharLigacoesDuplicadas
  -- (src/mastra/clickup.ts:892) vira SQL DENTRO desta transação: deixa de
  -- "degradar silenciosamente" e passa a ser both-or-neither com o passo (2).
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

  -- (4) outbox — linha do desfecho principal. ON CONFLICT (dedup_key) DO
  -- NOTHING: reprocessar o mesmo desfecho não duplica push (idempotência).
  insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'ligacao',
    p_ligacao_id,
    'set_status',
    true,
    jsonb_build_object('resultado', p_resultado, 'atendeu', p_atendeu, 'motivo_falha', p_motivo_falha),
    'ligacao:' || p_ligacao_id || ':desfecho',
    coalesce((select max(seq) from clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_tmp;

  -- outbox — uma linha 'fechar' por duplicata fechada no passo (3).
  insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  select
    'ligacao',
    dup_id,
    'fechar',
    true,
    jsonb_build_object('motivo', 'duplicata_fechada_no_desfecho', 'ligacao_principal', p_ligacao_id),
    'ligacao:' || dup_id || ':fechar-dup',
    coalesce((select max(seq) from clickup_outbox where aggregate='ligacao' and aggregate_id=dup_id), 0) + 1
  from unnest(v_dups) as dup_id
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_outbox + v_tmp;

  -- (5) janela de teste — SEMPRE por último, depois de todas as escritas e
  -- antes do RETURN: uma queda do cliente durante o sleep rola TUDO de volta
  -- (both-or-neither também sob crash simulado).
  if p_sleep_ms > 0 then
    perform pg_sleep(p_sleep_ms / 1000.0);
  end if;

  -- (6) outbox_inseridos agora é CALCULADO (passo 4, GET DIAGNOSTICS
  -- ROW_COUNT) — nunca um campo fantasma/não-inicializado. Reflete as linhas
  -- EFETIVAMENTE enfileiradas (ON CONFLICT DO NOTHING pode inserir menos por
  -- idempotência num reprocesso).
  return jsonb_build_object(
    'ligacao_id', p_ligacao_id,
    'duplicatas_fechadas', coalesce(array_length(v_dups, 1), 0),
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- hml_registrar_desfecho — gêmeo de homolog (hml_ligacoes / hml_clickup_outbox)
-- Corpo IDÊNTICO ao acima — só mudam os nomes de tabela. Ver nota (c) no topo
-- do arquivo (débito de sincronia manual).
-- ============================================================================
create or replace function hml_registrar_desfecho(
  p_ligacao_id   bigint,
  p_resultado    text,
  p_atendeu      boolean default null,
  p_motivo_falha text default null,
  p_fim          timestamptz default now(),
  p_duracao_seg  int default null,
  p_sleep_ms     int default 0
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_lead_id bigint;
  v_dups    bigint[];
  v_outbox  int := 0;
  v_tmp     int;
begin
  select lead_id into v_lead_id from hml_ligacoes where id = p_ligacao_id;
  if not found then
    raise exception 'hml_registrar_desfecho: ligacao % inexistente', p_ligacao_id;
  end if;

  update hml_ligacoes
     set status='fechada',
         resultado=p_resultado,
         atendeu=p_atendeu,
         motivo_falha=p_motivo_falha,
         fim=p_fim,
         duracao_seg=p_duracao_seg,
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
    'set_status',
    true,
    jsonb_build_object('resultado', p_resultado, 'atendeu', p_atendeu, 'motivo_falha', p_motivo_falha),
    'ligacao:' || p_ligacao_id || ':desfecho',
    coalesce((select max(seq) from hml_clickup_outbox where aggregate='ligacao' and aggregate_id=p_ligacao_id), 0) + 1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_tmp;

  insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  select
    'ligacao',
    dup_id,
    'fechar',
    true,
    jsonb_build_object('motivo', 'duplicata_fechada_no_desfecho', 'ligacao_principal', p_ligacao_id),
    'ligacao:' || dup_id || ':fechar-dup',
    coalesce((select max(seq) from hml_clickup_outbox where aggregate='ligacao' and aggregate_id=dup_id), 0) + 1
  from unnest(v_dups) as dup_id
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_outbox + v_tmp;

  if p_sleep_ms > 0 then
    perform pg_sleep(p_sleep_ms / 1000.0);
  end if;

  return jsonb_build_object(
    'ligacao_id', p_ligacao_id,
    'duplicatas_fechadas', coalesce(array_length(v_dups, 1), 0),
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- Segurança/exposição (18-CONTEXT.md decisão 4): SECURITY INVOKER (menor
-- superfície que DEFINER — service_role já tem grant nas tabelas via
-- 06_ligacoes.sql/09_clickup_outbox.sql) + search_path fixado (anti-hijack,
-- já no CREATE acima) + EXECUTE revogado de public e concedido SÓ a
-- service_role, para AMBAS as funções.
-- ============================================================================
revoke all on function registrar_desfecho(bigint, text, boolean, text, timestamptz, int, int) from public;
grant execute on function registrar_desfecho(bigint, text, boolean, text, timestamptz, int, int) to service_role;

revoke all on function hml_registrar_desfecho(bigint, text, boolean, text, timestamptz, int, int) from public;
grant execute on function hml_registrar_desfecho(bigint, text, boolean, text, timestamptz, int, int) to service_role;

-- Função nova precisa do reload de schema-cache para ser exposta em /rpc/ —
-- o kick do authenticator (o NOTIFY sozinho não propaga de forma confiável
-- neste deploy self-hosted) vem do aplicar-sql.mjs, que roda no 18-02.
notify pgrst, 'reload schema';
