-- Migration 05: confirmação de pagamento via webhook Kiwify
-- Data: 2026-05-09
--
-- Adiciona colunas em conversations_roberth pra rastrear quando o pagamento
-- foi efetivamente aprovado pelo Kiwify (separado de "link_enviado pela Sofia").
--
-- Comportamento esperado:
--   - Webhook Kiwify aprovado -> confirmarPagamento() em supabase.ts:
--     * Busca customer pelo telefone. Se nao existe, IGNORA (criterio:
--       so contamos como conversao quando a Sofia atendeu antes).
--     * Marca conversa: pagamento_confirmado=true, valor_pago, kiwify_order_id,
--       status='encerrada', ended_at=NOW().
--   - Scheduler de FUP filtra pagamento_confirmado=false -> nao spamma quem ja comprou.
--   - Dashboard tem section nova somando rows com pagamento_confirmado=true.

ALTER TABLE conversations_roberth
  ADD COLUMN IF NOT EXISTS pagamento_confirmado     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pagamento_confirmado_em  timestamptz,
  ADD COLUMN IF NOT EXISTS kiwify_order_id          text,
  ADD COLUMN IF NOT EXISTS valor_pago               numeric(10,2);

-- Idempotencia: cada order_id do Kiwify so conta uma vez.
-- Webhook de retry do Kiwify (mesmo order_id) bate na unique violation
-- e o codigo trata respondendo 200 OK pra parar de retentar.
CREATE UNIQUE INDEX IF NOT EXISTS uk_conv_kiwify_order
  ON conversations_roberth (kiwify_order_id)
  WHERE kiwify_order_id IS NOT NULL;

-- Index parcial pra dashboard contar rapido por janela temporal
-- (hoje / semana / mes / total).
CREATE INDEX IF NOT EXISTS idx_conv_pagamento_confirmado_em
  ON conversations_roberth (pagamento_confirmado_em DESC)
  WHERE pagamento_confirmado = true;
