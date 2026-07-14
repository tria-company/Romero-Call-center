-- SDR AUTON Health — [BLOCKING] colunas do loop de no-show (banco dedicado).
-- Idempotente: pode ser rodado mais de uma vez sem erro.
--
-- [BLOCKING] Aplicar no Supabase DEDICADO do SDR AUTON (env `SUPABASE_DB_URL`)
-- ANTES do deploy desta fase — estende auton_sdr_call_reminders (migration
-- 07_call_reminders.sql, plano 02-01). Sem esta migracao, o loop de no-show
-- (src/mastra/no-show.ts) fica mudo: os helpers em supabase.ts fazem
-- `if (!SUPABASE_URL) return` mas as COLUNAS precisam existir pro PATCH
-- funcionar de fato:
--   node scripts/apply-migration.mjs docs/sql/auton_sdr/08_no_show.sql
--
-- Comportamento desejado (FUN-03/FUN-04, implementado em
-- src/mastra/no-show.ts):
--   - 15min apos call_start_at sem mensagem do lead (proxy WhatsApp) → move
--     o card pra NO_SHOW + dispara recuperacao (Camila natural + task pro
--     SDR humano). no_show_tentativas vai de 0 -> 1, ultima_recuperacao_em
--     e no_show_detectado_em sao marcados.
--   - 2o no-show (nova falta sobre uma call reagendada, no_show_tentativas
--     ja >= 1) OU 48h de silencio desde ultima_recuperacao_em → move o card
--     pra PERDIDO e marca terminal=true + motivo_terminal ('2º no-show' ou
--     '48h sem resposta'). Loop encerrado: linhas terminal=true nunca sao
--     reabertas (decidirNoShow retorna 'nada' incondicionalmente).

ALTER TABLE auton_sdr_call_reminders
  ADD COLUMN IF NOT EXISTS no_show_tentativas    int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ultima_recuperacao_em timestamptz,
  ADD COLUMN IF NOT EXISTS no_show_detectado_em  timestamptz,
  ADD COLUMN IF NOT EXISTS terminal              boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS motivo_terminal       text;

-- Index parcial: o loop de no-show (no-show.ts) varre so calls 'agendada'
-- E ainda nao terminais — mesmo padrao de idx_call_reminders_pendentes
-- (07_call_reminders.sql). Mitiga T-02-09/DoS: nunca re-escaneia rows ja
-- encerradas pelo loop.
CREATE INDEX IF NOT EXISTS idx_call_reminders_no_show
  ON auton_sdr_call_reminders (call_start_at)
  WHERE status = 'agendada' AND terminal = false;
