-- Migracao 04: hardening pra producao sob carga
-- Data: 2026-05-09
-- Issues do review de prod:
--   #1 Race em criarSessao gerando conversations duplicadas
--   #4 Webhook GHL sem dedup (retry duplicado vira 2 respostas)
--   #2 Buffer em memoria perde mensagens em restart

-- =================================================================
-- Fix #1: unique partial index pra prevenir conversa duplicada por race
-- Garante que cada customer so tem 1 conversa em_atendimento ativa
-- (sem ended_at). PostgreSQL rejeita INSERT que violaria essa
-- restricao com erro 23505 (unique_violation), e o codigo trata
-- chamando buscarConversaAtiva pra recuperar a existente.
-- =================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uk_conv_ativa_por_customer
  ON conversations_roberth (customer_id)
  WHERE status = 'em_atendimento' AND ended_at IS NULL;

-- =================================================================
-- Fix #4: dedup de webhook GHL
-- O Workflow do GHL pode disparar webhook 2-3x por bug de rede /
-- retry automatico. Sem dedup, isso vira respostas duplicadas pro lead.
-- Hash inclui contact_id + body/attachment + bucket de tempo.
-- Cleanup periodico no scheduler (ver follow-up.ts).
-- =================================================================

CREATE TABLE IF NOT EXISTS webhook_dedup_roberth (
  hash         text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_dedup_processed_at
  ON webhook_dedup_roberth (processed_at);

-- =================================================================
-- Fix #2: buffer persistente de mensagens
-- Antes: buffer em memoria. Se o container reinicia nos 10s de
-- debounce, a mensagem do lead vira lixo silencioso (webhook ja
-- retornou 200 OK ao GHL). Agora cada msg tambem grava aqui;
-- worker recovery (no scheduler) re-processa orfas.
-- =================================================================

CREATE TABLE IF NOT EXISTS webhook_buffer_roberth (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telefone        text NOT NULL,
  texto           text NOT NULL,
  nome            text,
  processar_apos  timestamptz NOT NULL,
  processado      boolean NOT NULL DEFAULT false,
  processado_em   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_buffer_pendente
  ON webhook_buffer_roberth (telefone, processar_apos)
  WHERE processado = false;

CREATE INDEX IF NOT EXISTS idx_buffer_cleanup
  ON webhook_buffer_roberth (processado_em)
  WHERE processado = true;
