-- escala/24_rpc_registrar_envio_audio.sql — Fase C (Phase 20), Caminho B.
--
-- NUMERAÇÃO: o plano-fonte (20-03-PLAN.md) previa `22_rpc_registrar_envio_audio.sql`,
-- mas `22`/`23` já foram consumidos por `22_fundacao_fase_c.sql`/`23_indices_fase_c.sql`
-- (plano 20-01, ver aviso explícito no topo daquele arquivo). Esta migração assume
-- `24` (a próxima gaveta livre); as irmãs deste plano (`registrar_anotacao`/
-- `gerar_lote`) viram `25`/`26` (ver 20-03-SUMMARY.md).
--
-- Molde EXATO de sql/escala/16_rpc_criar_ligacao_avulsa.sql — a RPC faz a
-- escrita do agregado (`audios_envios`) + o INSERT no outbox no MESMO corpo
-- plpgsql (both-or-neither, design §3.0/§3.1, ESCRITA-01/ESCRITA-05). Gêmeos
-- `hml_registrar_envio_audio`/`hml_registrar_mensagem_texto` referenciam
-- hml_audios_envios/hml_clickup_outbox.
--
-- Duas funções (o envio de áudio e o envio de mensagem de texto hoje vivem em
-- clickup.ts::registrarEnvioAudio/registrarMensagemTexto — src/mastra/clickup.ts
-- ~1628-1815): ambas gravam `audios_envios` + enfileiram `criar_task` (aggregate
-- 'audio', bloqueante=true) na Lista 03 via o dispatcher `montarBodyDoAudio`
-- (src/mastra/drenar-outbox.ts, Fase C Plano 02) — o payload aqui reproduz
-- BYTE-A-BYTE as chaves que esse dispatcher já lê (`origem`, `tipo`,
-- `lead_clickup_task_id`, `telefone_canonico`, `enviado_por`, `corpo`,
-- `data_do_envio`) e o CONTRATO de prefixo de título ("Áudio enviado —"/
-- "Mensagem enviada —") que `listarEnviosAudioDoLead` usa para distinguir tipo.
-- `registrar_envio_audio` enfileira TAMBÉM uma linha `anexar` (bloqueante=false,
-- R6) quando `p_midia_ref` vem preenchido — o binário já está no store canônico
-- (Supabase Storage) ANTES desta RPC rodar (upload é responsabilidade do
-- caller/rota, fora desta transação).
--
-- `lead_id` é ADITIVO/opcional aqui (`p_lead_id`): quando o caller já o
-- resolveu, é gravado direto; quando vem `null` e `p_lead_clickup_task_id` não,
-- o trigger `trg_resolver_lead_id`/`trg_resolver_lead_id_hml` (20-01,
-- sql/escala/22_fundacao_fase_c.sql) o preenche no INSERT.
--
-- LGPD: nenhum RAISE cita telefone/texto — `p_telefone_canonico`/`p_texto` só
-- aparecem em coluna/payload (payload é scrubado pós-drain, LGPD-03).
--
-- Idempotente (CREATE OR REPLACE FUNCTION) — pode reaplicar sem quebrar, desde
-- que a assinatura não mude.

-- ============================================================================
-- registrar_envio_audio — produção (audios_envios / clickup_outbox)
-- ============================================================================
create or replace function registrar_envio_audio(
  p_lead_clickup_task_id text,
  p_lead_id              bigint,
  p_telefone_canonico    text,
  p_enviado_por          text,
  p_midia_ref            text,
  p_transcricao          text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_id            bigint;
  v_outbox        int := 0;
  v_tmp           int;
  v_data_do_envio bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  insert into audios_envios (
    lead_clickup_task_id, lead_id, tipo, corpo, transcricao_audio, midia_ref, enviado_em
  )
  values (
    p_lead_clickup_task_id, p_lead_id, 'audio', null, p_transcricao, p_midia_ref, now()
  )
  returning id into v_id;

  insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'audio',
    v_id,
    'criar_task',
    true,
    jsonb_build_object(
      'origem', 'envio',
      'tipo', 'audio',
      'lead_clickup_task_id', p_lead_clickup_task_id,
      'telefone_canonico', p_telefone_canonico,
      'enviado_por', p_enviado_por,
      'data_do_envio', v_data_do_envio
    ),
    'audio:' || v_id || ':criar',
    1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_outbox + v_tmp;

  -- Linha `anexar` (não-bloqueante, R6) só quando há mídia a anexar — o dreno
  -- (op='anexar', Fase C Plano 02) baixa do store canônico e sobe pro ClickUp
  -- assim que `criar_task` resolver o taskId (backpressure de ordem).
  if p_midia_ref is not null then
    insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'audio',
      v_id,
      'anexar',
      false,
      jsonb_build_object('midia_ref', p_midia_ref),
      'audio:' || v_id || ':anexar',
      2
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_tmp = row_count;
    v_outbox := v_outbox + v_tmp;
  end if;

  return jsonb_build_object(
    'audio_id', v_id,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- registrar_mensagem_texto — produção (audios_envios / clickup_outbox)
-- ============================================================================
create or replace function registrar_mensagem_texto(
  p_lead_clickup_task_id text,
  p_lead_id              bigint,
  p_telefone_canonico    text,
  p_enviado_por          text,
  p_texto                text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_id            bigint;
  v_outbox        int := 0;
  v_tmp           int;
  v_data_do_envio bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  insert into audios_envios (
    lead_clickup_task_id, lead_id, tipo, corpo, transcricao_audio, midia_ref, enviado_em
  )
  values (
    p_lead_clickup_task_id, p_lead_id, 'texto', p_texto, null, null, now()
  )
  returning id into v_id;

  insert into clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'audio',
    v_id,
    'criar_task',
    true,
    jsonb_build_object(
      'origem', 'envio',
      'tipo', 'texto',
      'lead_clickup_task_id', p_lead_clickup_task_id,
      'telefone_canonico', p_telefone_canonico,
      'enviado_por', p_enviado_por,
      'corpo', p_texto,
      'data_do_envio', v_data_do_envio
    ),
    'audio:' || v_id || ':criar',
    1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_outbox + v_tmp;

  return jsonb_build_object(
    'audio_id', v_id,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- hml_registrar_envio_audio — gêmeo de homolog (hml_audios_envios / hml_clickup_outbox)
-- Corpo IDÊNTICO ao acima — só mudam os nomes de tabela.
-- ============================================================================
create or replace function hml_registrar_envio_audio(
  p_lead_clickup_task_id text,
  p_lead_id              bigint,
  p_telefone_canonico    text,
  p_enviado_por          text,
  p_midia_ref            text,
  p_transcricao          text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_id            bigint;
  v_outbox        int := 0;
  v_tmp           int;
  v_data_do_envio bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  insert into hml_audios_envios (
    lead_clickup_task_id, lead_id, tipo, corpo, transcricao_audio, midia_ref, enviado_em
  )
  values (
    p_lead_clickup_task_id, p_lead_id, 'audio', null, p_transcricao, p_midia_ref, now()
  )
  returning id into v_id;

  insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'audio',
    v_id,
    'criar_task',
    true,
    jsonb_build_object(
      'origem', 'envio',
      'tipo', 'audio',
      'lead_clickup_task_id', p_lead_clickup_task_id,
      'telefone_canonico', p_telefone_canonico,
      'enviado_por', p_enviado_por,
      'data_do_envio', v_data_do_envio
    ),
    'audio:' || v_id || ':criar',
    1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_outbox + v_tmp;

  if p_midia_ref is not null then
    insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
    values (
      'audio',
      v_id,
      'anexar',
      false,
      jsonb_build_object('midia_ref', p_midia_ref),
      'audio:' || v_id || ':anexar',
      2
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_tmp = row_count;
    v_outbox := v_outbox + v_tmp;
  end if;

  return jsonb_build_object(
    'audio_id', v_id,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- hml_registrar_mensagem_texto — gêmeo de homolog (hml_audios_envios / hml_clickup_outbox)
-- Corpo IDÊNTICO ao acima — só mudam os nomes de tabela.
-- ============================================================================
create or replace function hml_registrar_mensagem_texto(
  p_lead_clickup_task_id text,
  p_lead_id              bigint,
  p_telefone_canonico    text,
  p_enviado_por          text,
  p_texto                text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_id            bigint;
  v_outbox        int := 0;
  v_tmp           int;
  v_data_do_envio bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  insert into hml_audios_envios (
    lead_clickup_task_id, lead_id, tipo, corpo, transcricao_audio, midia_ref, enviado_em
  )
  values (
    p_lead_clickup_task_id, p_lead_id, 'texto', p_texto, null, null, now()
  )
  returning id into v_id;

  insert into hml_clickup_outbox (aggregate, aggregate_id, op, bloqueante, payload, dedup_key, seq)
  values (
    'audio',
    v_id,
    'criar_task',
    true,
    jsonb_build_object(
      'origem', 'envio',
      'tipo', 'texto',
      'lead_clickup_task_id', p_lead_clickup_task_id,
      'telefone_canonico', p_telefone_canonico,
      'enviado_por', p_enviado_por,
      'corpo', p_texto,
      'data_do_envio', v_data_do_envio
    ),
    'audio:' || v_id || ':criar',
    1
  )
  on conflict (dedup_key) do nothing;
  get diagnostics v_tmp = row_count;
  v_outbox := v_outbox + v_tmp;

  return jsonb_build_object(
    'audio_id', v_id,
    'outbox_inseridos', v_outbox
  );
end;
$$;

-- ============================================================================
-- Segurança/exposição: SECURITY INVOKER + search_path fixado + EXECUTE
-- revogado de public e concedido SÓ a service_role, para AS QUATRO funções.
-- ============================================================================
revoke all on function registrar_envio_audio(text, bigint, text, text, text, text) from public;
grant execute on function registrar_envio_audio(text, bigint, text, text, text, text) to service_role;

revoke all on function registrar_mensagem_texto(text, bigint, text, text, text) from public;
grant execute on function registrar_mensagem_texto(text, bigint, text, text, text) to service_role;

revoke all on function hml_registrar_envio_audio(text, bigint, text, text, text, text) from public;
grant execute on function hml_registrar_envio_audio(text, bigint, text, text, text, text) to service_role;

revoke all on function hml_registrar_mensagem_texto(text, bigint, text, text, text) from public;
grant execute on function hml_registrar_mensagem_texto(text, bigint, text, text, text) to service_role;

-- Reload do cache de schema do PostgREST. A aplicação em homolog é o 20-08.
notify pgrst, 'reload schema';
