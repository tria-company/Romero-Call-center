-- Projeto Roberth — tabela de erros do agente.
-- Idempotente: pode ser rodado mais de uma vez sem erro.
--
-- Usada pelo dashboard (/api/dashboard) pra mostrar:
--   - lista dos N erros mais recentes
--   - contagem por error_code (content_filter / timeout / rate_limit / outro)
--
-- Populada pelo catch em src/mastra/index.ts (salvarErro), idempotente
-- com o aviso ao grupo SUPORTE.

CREATE TABLE IF NOT EXISTS errors_roberth (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations_roberth(id) ON DELETE SET NULL,
  customer_id     uuid REFERENCES customers_roberth(id) ON DELETE SET NULL,
  telefone        text NOT NULL,
  nome            text,
  error_message   text NOT NULL,
  error_code      text,
  context         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_errors_roberth_created
  ON errors_roberth (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_errors_roberth_code_created
  ON errors_roberth (error_code, created_at DESC);
