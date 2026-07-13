-- SDR AUTON Health — colunas de tracking pro follow-up automatico (banco dedicado).
-- Idempotente: pode ser rodado mais de uma vez sem erro.
--
-- Aplicar no Supabase DEDICADO do SDR AUTON (env `SUPABASE_DB_URL`):
--   node scripts/apply-migration.mjs docs/sql/auton_sdr/02_follow_up.sql
--
-- Comportamento desejado (implementado em src/mastra/follow-up.ts):
--   - Camila/vendedor mandou ultima mensagem e lead silenciou >= 1h  → FUP1
--   - silencio >= 3h e sem FUP3 ainda                        → FUP2 (col fup_3_sent_at)
--   - silencio >= 5h e sem FUP5 ainda                        → FUP3 (col fup_5_sent_at)
--   - silencio >= 24h                                        → handoff humano automatico
-- Quando o lead responde, marcarMsgLead() zera os fup_*_sent_at.

ALTER TABLE auton_sdr_conversations
  ADD COLUMN IF NOT EXISTS last_assistant_message_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_lead_message_at      timestamptz,
  ADD COLUMN IF NOT EXISTS fup_1_sent_at             timestamptz,
  ADD COLUMN IF NOT EXISTS fup_3_sent_at             timestamptz,
  ADD COLUMN IF NOT EXISTS fup_5_sent_at             timestamptz,
  ADD COLUMN IF NOT EXISTS handoff_silencio_em       timestamptz;

-- Index parcial: o cron varre so conversas elegiveis (em atendimento, ainda
-- nao escalonadas por silencio, com timestamp da ultima mensagem do agente).
CREATE INDEX IF NOT EXISTS idx_auton_sdr_conversations_fup_pendentes
  ON auton_sdr_conversations (last_assistant_message_at)
  WHERE status = 'em_atendimento'
    AND ended_at IS NULL
    AND handoff_silencio_em IS NULL
    AND last_assistant_message_at IS NOT NULL;
