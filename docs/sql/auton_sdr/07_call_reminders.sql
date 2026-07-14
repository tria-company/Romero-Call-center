-- SDR AUTON Health — [BLOCKING] tabela de lembretes de call (banco dedicado).
-- Idempotente: pode ser rodado mais de uma vez sem erro.
--
-- [BLOCKING] Aplicar no Supabase DEDICADO do SDR AUTON (env `SUPABASE_DB_URL`)
-- ANTES do deploy desta fase — sem esta migracao, schedule_reminder (TOOL-08)
-- e o scheduler de lembretes (src/mastra/lembretes.ts) ficam mudos: os
-- helpers em supabase.ts fazem `if (!SUPABASE_URL) return` mas a TABELA
-- precisa existir pro POST/PATCH funcionar de fato:
--   node scripts/apply-migration.mjs docs/sql/auton_sdr/07_call_reminders.sql
--
-- Comportamento desejado (implementado em src/mastra/tools/schedule-reminder.ts
-- e src/mastra/lembretes.ts):
--   - Ao agendar a call com sucesso (create-calendar-event.ts), faz upsert
--     (on_conflict=telefone) de uma row com call_start_at e envia a
--     CONFIRMACAO IMEDIATA (FUN-02 toque 1), marcando confirmacao_sent_at.
--   - O scheduler varre a cada 60s (status='agendada') e dispara D-1 (24h
--     antes), H-1 (1h antes) e 5min antes — cada toque exatamente 1x, gate
--     via as colunas *_sent_at (idempotencia, sem reenvio em loop).
--   - Reschedule (nova call pro mesmo telefone) faz upsert por telefone:
--     atualiza call_start_at, volta status='agendada' e ZERA d1/h1/m5_sent_at
--     (e o estado terminal do loop de no-show) — o relogio dos 3 toques
--     temporizados comeca do zero pra nova data.
--   - status permanece 'agendada' apos o toque de 5min; o loop de no-show
--     (plano 02-02, src/mastra/no-show.ts) e quem transiciona: 'realizada'
--     (lead respondeu depois da call) ou 'no_show' (terminal=true, junto de
--     08_no_show.sql). Rows fora de 'agendada' saem das varreduras — a janela
--     de scan (limit=200) nunca fica presa em historico antigo (CR-06).

CREATE TABLE IF NOT EXISTS auton_sdr_call_reminders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           uuid REFERENCES auton_sdr_customers(id) ON DELETE CASCADE,
  conversation_id       uuid REFERENCES auton_sdr_conversations(id) ON DELETE CASCADE,
  telefone              text NOT NULL,
  nome                  text,
  closer                text,
  call_start_at         timestamptz NOT NULL,
  confirmacao_sent_at   timestamptz,
  d1_sent_at            timestamptz,
  h1_sent_at            timestamptz,
  m5_sent_at            timestamptz,
  status                text NOT NULL DEFAULT 'agendada',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- 1 row por lead (telefone) — reschedule vira upsert on_conflict=telefone em
-- vez de criar row duplicada/orfa.
--
-- CR-01: o index unico precisa ser CHEIO (nao-parcial). O upsert do PostgREST
-- (`?on_conflict=telefone` + Prefer: resolution=merge-duplicates) vira
-- `INSERT ... ON CONFLICT (telefone) DO UPDATE`, e o Postgres so INFERE
-- indexes unicos NAO-parciais nessa clausula — um index parcial exigiria o
-- predicado WHERE dentro do ON CONFLICT, que o PostgREST nao emite. Com o
-- index parcial anterior (WHERE status='agendada'), TODO insert falhava com
-- 42P10 e a fase inteira ficava inerte. Semantica resultante: 1 row por
-- telefone; historico de calls encerradas nao e mantido (um design de
-- arquivamento exigiria outra chave — PostgREST nao consegue mirar index
-- parcial). O DROP abaixo cobre bancos onde a versao antiga chegou a rodar.
DROP INDEX IF EXISTS uq_call_reminders_ativo;
CREATE UNIQUE INDEX IF NOT EXISTS uq_call_reminders_telefone
  ON auton_sdr_call_reminders (telefone);

-- Index parcial: o scheduler (lembretes.ts) varre so calls 'agendada' — mesmo
-- padrao de idx_auton_sdr_conversations_fup_pendentes (02_follow_up.sql).
-- Mitiga T-02-04 (DoS): a varredura nunca escaneia rows encerradas/antigas.
CREATE INDEX IF NOT EXISTS idx_call_reminders_pendentes
  ON auton_sdr_call_reminders (call_start_at)
  WHERE status = 'agendada';

DROP TRIGGER IF EXISTS trg_auton_sdr_call_reminders_updated_at ON auton_sdr_call_reminders;
CREATE TRIGGER trg_auton_sdr_call_reminders_updated_at
  BEFORE UPDATE ON auton_sdr_call_reminders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_auton_sdr();
