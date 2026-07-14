-- SDR AUTON Health — tabela de metricas de observabilidade por interacao LLM
-- (HARD-08, Fase 5 plano 05-06). Idempotente: pode ser rodado mais de uma
-- vez sem erro.
--
-- [BLOCKING]/user_setup: o banco dedicado do SDR AUTON esta atualmente
-- READ-ONLY (quota 402, ver secao "Status atual" no README.md desta pasta).
-- Aplicar assim que a quota for resolvida:
--   node scripts/apply-migration.mjs docs/sql/auton_sdr/11_llm_metrics.sql
--
-- A persistencia desta tabela e FAIL-OPEN (src/mastra/observabilidade.ts +
-- src/mastra/supabase.ts, salvarMetricaLLM): enquanto a tabela nao existir
-- (ou o banco estiver read-only), o codigo continua rodando normalmente —
-- cada interacao LLM so emite o log JSON estruturado `[metrica-llm]`
-- (consultavel via logs), sem persistir na tabela e sem quebrar o pipeline.
--
-- Populada por src/mastra/index.ts (via registrarMetricaLLM ->
-- salvarMetricaLLM) apos cada chamada LLM: Camila primaria, LLM secundario
-- da cascata de fallback (05-04) e Qualificador — alem de cache HIT
-- (tokens/custo=0, cache_hit=true, mensuravel a economia do cache
-- semantico HARD-04).

CREATE TABLE IF NOT EXISTS auton_sdr_llm_metrics (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid REFERENCES auton_sdr_conversations(id) ON DELETE SET NULL,
  customer_id       uuid REFERENCES auton_sdr_customers(id) ON DELETE SET NULL,
  telefone          text,
  modelo            text NOT NULL,
  tipo              text NOT NULL, -- camila_primaria | secundario_fallback | qualificador
  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer,
  custo_estimado    numeric,
  latencia_ms       integer,
  prompt_versao     text,
  cache_hit         boolean NOT NULL DEFAULT false,
  -- WR-05 (review Fase 5): distingue custo/tokens REAIS de incognitas.
  -- custo_conhecido=false => o modelo/deployment nao tinha preco na tabela
  -- de custo (custo_estimado=0 e uma INCOGNITA, nao um zero real de cache
  -- hit). tokens_estimados=true => usage indisponivel na resposta do
  -- provider (tokens sao estimativa, nao valor exato). NULL = linha gravada
  -- por versao anterior do codigo (antes destes campos).
  custo_conhecido   boolean,
  tokens_estimados  boolean,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Idempotente para bancos onde a tabela ja foi criada sem as colunas WR-05.
ALTER TABLE auton_sdr_llm_metrics ADD COLUMN IF NOT EXISTS custo_conhecido boolean;
ALTER TABLE auton_sdr_llm_metrics ADD COLUMN IF NOT EXISTS tokens_estimados boolean;

CREATE INDEX IF NOT EXISTS idx_auton_sdr_llm_metrics_created
  ON auton_sdr_llm_metrics (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auton_sdr_llm_metrics_modelo_created
  ON auton_sdr_llm_metrics (modelo, created_at DESC);
