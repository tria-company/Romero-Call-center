-- SDR AUTON Health — correlacao CALL<->RECORD do webhook Wavoip.
-- Idempotente: pode ser rodado mais de uma vez sem erro.
--
-- [BLOCKING] Aplicar no Supabase DEDICADO do SDR AUTON (env `SUPABASE_DB_URL`)
-- ANTES do deploy do webhook /api/webhook/wavoip:
--   node scripts/apply-migration.mjs docs/sql/auton_sdr/12_wavoip_calls.sql
--
-- Por que existe: o evento RECORD do webhook Wavoip (que traz record_url pra
-- transcricao) NAO inclui telefone — so `whatsapp_call_id`. O evento CALL (que
-- traz caller/receiver) chega antes. Guardamos aqui o par
-- whatsapp_call_id -> telefone pra que o handler do RECORD resolva o contato do
-- GHL e persista a transcricao no lead certo. Sem esta tabela, os helpers
-- salvarWavoipCall / buscarTelefonePorWavoipCall (src/mastra/supabase.ts) fazem
-- `if (!SUPABASE_URL) return`, mas a TABELA precisa existir pro POST/GET
-- (PostgREST) funcionar de fato.

CREATE TABLE IF NOT EXISTS auton_sdr_wavoip_calls (
  whatsapp_call_id  text PRIMARY KEY,
  telefone          text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Busca por telefone e/ou limpeza por idade sao O(n) sem indice; created_at
-- ajuda o cleanup periodico (retencao curta — a correlacao so importa nos
-- segundos/minutos entre CALL e RECORD).
CREATE INDEX IF NOT EXISTS idx_wavoip_calls_created_at
  ON auton_sdr_wavoip_calls (created_at);
