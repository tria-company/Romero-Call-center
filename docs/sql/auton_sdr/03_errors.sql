-- SDR AUTON Health — tabela de erros do agente (banco dedicado).
-- Idempotente: pode ser rodado mais de uma vez sem erro.
--
-- Aplicar no Supabase DEDICADO do SDR AUTON (env `SUPABASE_DB_URL`):
--   node scripts/apply-migration.mjs docs/sql/auton_sdr/03_errors.sql
--
-- Usada pelo dashboard (/api/dashboard) pra mostrar:
--   - lista dos N erros mais recentes
--   - contagem por error_code (content_filter / timeout / rate_limit / outro)
--
-- Populada pelo catch em src/mastra/index.ts (salvarErro), idempotente
-- com o aviso ao grupo SUPORTE.

CREATE TABLE IF NOT EXISTS auton_sdr_errors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES auton_sdr_conversations(id) ON DELETE SET NULL,
  customer_id     uuid REFERENCES auton_sdr_customers(id) ON DELETE SET NULL,
  telefone        text NOT NULL,
  nome            text,
  error_message   text NOT NULL,
  error_code      text,
  context         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auton_sdr_errors_created
  ON auton_sdr_errors (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auton_sdr_errors_code_created
  ON auton_sdr_errors (error_code, created_at DESC);
