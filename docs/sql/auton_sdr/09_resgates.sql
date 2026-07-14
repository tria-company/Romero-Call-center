-- SDR AUTON Health — [BLOCKING] tabela de resgate durável de leads (banco dedicado).
-- Idempotente: pode ser rodado mais de uma vez sem erro.
--
-- [BLOCKING] Aplicar no Supabase DEDICADO do SDR AUTON (env `SUPABASE_DB_URL`)
-- ANTES do deploy desta fase — sem esta migracao, o mecanismo de resgate
-- (src/mastra/resgates.ts) fica mudo: os helpers em supabase.ts fazem
-- `if (!SUPABASE_URL) return` mas a TABELA precisa existir pro POST/PATCH
-- funcionar de fato:
--   node scripts/apply-migration.mjs docs/sql/auton_sdr/09_resgates.sql
--
-- Comportamento desejado (GRAV-03, implementado em src/mastra/resgates.ts +
-- src/mastra/extracao-sinais.ts):
--   - A extracao de sinais (extracao-sinais.ts) detecta sinal de desistencia
--     (sinais_desistencia.presente=true) numa transcricao anonimizada. Se o
--     lead ainda NAO fechou (nao-GANHO no pipeline COMERCIAL USI), agenda um
--     resgate via agendarResgate48h: upsert (on_conflict=telefone) com
--     resgatar_em = agora + 48h, status='pendente'.
--   - O scheduler existente (lembretes.ts, mesmo tick de
--     processarLembretes/processarNoShows) varre a cada 60s os resgates
--     pendentes e DEVIDOS (resgatar_em<=now). Pra cada um: pula se o lead
--     estiver em pausa duravel (humano/bloqueado); re-checa se o lead ja
--     esta GANHO (fechou nesse meio-tempo) — se sim, cancela
--     (status='cancelado'); senao cria uma task pro SDR humano e marca
--     status='feito' apos a criacao confirmada.
--   - Upsert por telefone: um novo sinal de desistencia pro MESMO lead
--     reabre status='pendente' e recalcula resgatar_em (o relogio de 48h
--     reinicia a partir do sinal mais recente) — nunca cria 2 resgates
--     pendentes pro mesmo lead (T-03-09, mitigacao de DoS/flood de task).

CREATE TABLE IF NOT EXISTS auton_sdr_resgates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid REFERENCES auton_sdr_customers(id) ON DELETE CASCADE,
  telefone      text NOT NULL,
  nome          text,
  motivo        text,
  resgatar_em   timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'pendente', -- pendente | feito | cancelado
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 1 resgate pendente por lead (telefone) — mesma licao do CR-01 da
-- 07_call_reminders.sql: o upsert do PostgREST (`?on_conflict=telefone` +
-- Prefer: resolution=merge-duplicates) vira `INSERT ... ON CONFLICT
-- (telefone) DO UPDATE`, e o Postgres so INFERE indexes unicos NAO-parciais
-- nessa clausula (um index parcial exigiria o predicado WHERE dentro do ON
-- CONFLICT, que o PostgREST nao emite). Por isso o index unico e CHEIO (nao
-- filtra por status) — um resgate 'feito'/'cancelado' antigo do mesmo
-- telefone e SOBRESCRITO (reaberto como 'pendente') se um novo sinal de
-- desistencia chegar depois; historico de resgates anteriores nao e mantido
-- (mesmo trade-off documentado em auton_sdr_call_reminders).
CREATE UNIQUE INDEX IF NOT EXISTS uq_resgates_telefone
  ON auton_sdr_resgates (telefone);

-- Index parcial: o scheduler (resgates.ts#processarResgates) varre so
-- resgates 'pendente' — mesmo padrao de idx_call_reminders_pendentes
-- (07_call_reminders.sql) / idx_call_reminders_no_show (08_no_show.sql).
-- Mitiga T-03-09 (DoS): a varredura nunca escaneia rows ja encerradas.
CREATE INDEX IF NOT EXISTS idx_resgates_pendentes
  ON auton_sdr_resgates (resgatar_em)
  WHERE status = 'pendente';

DROP TRIGGER IF EXISTS trg_auton_sdr_resgates_updated_at ON auton_sdr_resgates;
CREATE TRIGGER trg_auton_sdr_resgates_updated_at
  BEFORE UPDATE ON auton_sdr_resgates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_auton_sdr();
