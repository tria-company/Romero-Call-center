-- SDR AUTON Health — schema inicial (banco dedicado)
-- Idempotente: pode ser rodado mais de uma vez sem erro.
--
-- Aplicar no Supabase DEDICADO do SDR AUTON (env `SUPABASE_DB_URL`):
--   node scripts/apply-migration.mjs docs/sql/auton_sdr/01_init.sql

-- ===== Enums =====

DO $$ BEGIN
  CREATE TYPE auton_sdr_status_conversa AS ENUM (
    'em_atendimento',
    'aguardando_humano',
    'encerrada'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE auton_sdr_agente_tipo AS ENUM (
    'vendedor',
    'atendimento_humano'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE auton_sdr_categoria_objecao AS ENUM (
    'preco',
    'tempo',
    'duvida',
    'concorrente',
    'momento',
    'outro'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== auton_sdr_customers =====

CREATE TABLE IF NOT EXISTS auton_sdr_customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telefone    text UNIQUE NOT NULL,
  nome        text,
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auton_sdr_customers_telefone ON auton_sdr_customers (telefone);

-- ===== auton_sdr_conversations =====

CREATE TABLE IF NOT EXISTS auton_sdr_conversations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           uuid NOT NULL REFERENCES auton_sdr_customers(id) ON DELETE CASCADE,
  canal                 text NOT NULL DEFAULT 'whatsapp',
  status                auton_sdr_status_conversa NOT NULL DEFAULT 'em_atendimento',
  agente_atual          auton_sdr_agente_tipo NOT NULL DEFAULT 'vendedor',
  started_at            timestamptz NOT NULL DEFAULT now(),
  ended_at              timestamptz,
  data_ultima_mensagem  timestamptz NOT NULL DEFAULT now(),
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  link_enviado          boolean NOT NULL DEFAULT false,
  link_enviado_em       timestamptz,
  oferta_enviada        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auton_sdr_conversations_customer
  ON auton_sdr_conversations (customer_id, data_ultima_mensagem DESC);

CREATE INDEX IF NOT EXISTS idx_auton_sdr_conversations_status
  ON auton_sdr_conversations (status, data_ultima_mensagem DESC);

-- ===== auton_sdr_messages =====

CREATE TABLE IF NOT EXISTS auton_sdr_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES auton_sdr_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL,
  content         text NOT NULL,
  agent_table     text,
  tool_name       text,
  tool_input      jsonb,
  tool_output     jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auton_sdr_messages_conversation
  ON auton_sdr_messages (conversation_id, created_at);

-- ===== auton_sdr_objecoes =====

CREATE TABLE IF NOT EXISTS auton_sdr_objecoes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid REFERENCES auton_sdr_conversations(id) ON DELETE CASCADE,
  customer_id      uuid REFERENCES auton_sdr_customers(id) ON DELETE CASCADE,
  telefone         text NOT NULL,
  categoria        auton_sdr_categoria_objecao NOT NULL,
  texto_original   text NOT NULL,
  contornada       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auton_sdr_objecoes_categoria
  ON auton_sdr_objecoes (categoria, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auton_sdr_objecoes_telefone
  ON auton_sdr_objecoes (telefone, created_at DESC);

-- ===== Trigger para updated_at =====

CREATE OR REPLACE FUNCTION set_updated_at_auton_sdr()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auton_sdr_customers_updated_at ON auton_sdr_customers;
CREATE TRIGGER trg_auton_sdr_customers_updated_at
  BEFORE UPDATE ON auton_sdr_customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_auton_sdr();

DROP TRIGGER IF EXISTS trg_auton_sdr_conversations_updated_at ON auton_sdr_conversations;
CREATE TRIGGER trg_auton_sdr_conversations_updated_at
  BEFORE UPDATE ON auton_sdr_conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_auton_sdr();
