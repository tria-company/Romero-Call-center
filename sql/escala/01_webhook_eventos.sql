-- webhook_eventos — durabilidade do webhook Wavoip (Fase 2, escala-150-atendentes)
--
-- CADA evento do webhook Wavoip é gravado aqui CRU e ANTES de processar. É a
-- rede de segurança do "não perder nenhuma ligação": se transcrição/LLM/escrita
-- falharem ou o processo cair no meio, o evento fica aqui e é reprocessável.
--
-- Contém PII (telefone no payload) — instância self-hosted, acesso SOMENTE via
-- service key (bypassa RLS). NÃO expor por anon/PostgREST público.
--
-- Aplicar no Supabase self-hosted (não é aplicado automaticamente — decisão D3
-- "construir código primeiro, provisionar depois"):
--   psql "$SUPABASE_DB_URL" -f sql/escala/01_webhook_eventos.sql
-- Nome da tabela é parametrizável por SUPABASE_TABLE_WEBHOOK_EVENTOS (default abaixo).

create extension if not exists "pgcrypto";  -- gen_random_uuid()

create table if not exists webhook_eventos (
  id                uuid primary key default gen_random_uuid(),
  tipo              text not null,                     -- CALL | RECORD | ...
  whatsapp_call_id  text,                              -- correlação Wavoip (indexado)
  status            text not null default 'recebido',  -- recebido | processado | erro
  payload           jsonb not null,                    -- evento cru (reprocessável)
  detalhe           text,                              -- msg do desfecho de erro (truncada)
  recebido_em       timestamptz not null default now(),
  atualizado_em     timestamptz
);

-- Reprocesso: achar rápido por call_id e varrer o que ficou 'recebido'/'erro'.
create index if not exists idx_webhook_eventos_call   on webhook_eventos (whatsapp_call_id);
create index if not exists idx_webhook_eventos_status on webhook_eventos (status, recebido_em);
