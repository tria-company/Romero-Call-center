-- Projeto Roberth — schema inicial
-- Idempotente: pode ser rodado mais de uma vez sem erro.

-- ===== Enums =====

DO $$ BEGIN
  CREATE TYPE status_conversa_roberth AS ENUM (
    'em_atendimento',
    'aguardando_humano',
    'encerrada'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE agente_tipo_roberth AS ENUM (
    'vendedor',
    'atendimento_humano'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE categoria_objecao_roberth AS ENUM (
    'preco',
    'tempo',
    'duvida',
    'concorrente',
    'momento',
    'outro'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== customers_roberth =====

CREATE TABLE IF NOT EXISTS customers_roberth (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telefone    text UNIQUE NOT NULL,
  nome        text,
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_roberth_telefone ON customers_roberth (telefone);

-- ===== conversations_roberth =====

CREATE TABLE IF NOT EXISTS conversations_roberth (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           uuid NOT NULL REFERENCES customers_roberth(id) ON DELETE CASCADE,
  canal                 text NOT NULL DEFAULT 'whatsapp',
  status                status_conversa_roberth NOT NULL DEFAULT 'em_atendimento',
  agente_atual          agente_tipo_roberth NOT NULL DEFAULT 'vendedor',
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

CREATE INDEX IF NOT EXISTS idx_conversations_roberth_customer
  ON conversations_roberth (customer_id, data_ultima_mensagem DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_roberth_status
  ON conversations_roberth (status, data_ultima_mensagem DESC);

-- ===== messages_roberth =====

CREATE TABLE IF NOT EXISTS messages_roberth (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations_roberth(id) ON DELETE CASCADE,
  role            text NOT NULL,
  content         text NOT NULL,
  agent_table     text,
  tool_name       text,
  tool_input      jsonb,
  tool_output     jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_roberth_conversation
  ON messages_roberth (conversation_id, created_at);

-- ===== objecoes_roberth =====

CREATE TABLE IF NOT EXISTS objecoes_roberth (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid REFERENCES conversations_roberth(id) ON DELETE CASCADE,
  customer_id      uuid REFERENCES customers_roberth(id) ON DELETE CASCADE,
  telefone         text NOT NULL,
  categoria        categoria_objecao_roberth NOT NULL,
  texto_original   text NOT NULL,
  contornada       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_objecoes_roberth_categoria
  ON objecoes_roberth (categoria, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_objecoes_roberth_telefone
  ON objecoes_roberth (telefone, created_at DESC);

-- ===== Trigger para updated_at =====

CREATE OR REPLACE FUNCTION set_updated_at_roberth()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_customers_roberth_updated_at ON customers_roberth;
CREATE TRIGGER trg_customers_roberth_updated_at
  BEFORE UPDATE ON customers_roberth
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_roberth();

DROP TRIGGER IF EXISTS trg_conversations_roberth_updated_at ON conversations_roberth;
CREATE TRIGGER trg_conversations_roberth_updated_at
  BEFORE UPDATE ON conversations_roberth
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_roberth();
