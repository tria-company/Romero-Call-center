-- escala/29_leads_romero_ja_falou.sql — flag "Romero já falou com este lead"
-- (Fase 3 do roadmap). Coluna no ESPELHO (nosso Postgres, chave clickup_task_id
-- ESTÁVEL) — o histórico de relacionamento sobrevive à troca de chip/número do
-- lead (a identidade é o task-id, não o telefone).
--
-- Escrita: write-through no envio (áudio/texto) marca romero_ja_falou=true; e é
-- RE-DERIVÁVEL de mensagens_whatsapp via scripts/backfill-romero-ja-falou.mjs
-- (se o espelho for reconstruído). O re-sync do espelho a partir do ClickUp usa
-- upsert merge-duplicates SEM esta coluna → o valor é PRESERVADO.
--
-- Idempotente. Aplicar: node --env-file=.env scripts/aplicar-sql.mjs sql/escala/29_leads_romero_ja_falou.sql
-- REQUER discador_leads_espelho (escala/02) já aplicado. LGPD: flag booleana, sem PII.

alter table discador_leads_espelho add column if not exists romero_ja_falou boolean not null default false;

-- Índice PARCIAL: o recorte "Romero já falou" filtra só os true (barato e pequeno).
create index if not exists ix_leads_romero_ja_falou on discador_leads_espelho (romero_ja_falou) where romero_ja_falou;

-- grant + reload de cache (idempotente; mesmo molde das migrações vizinhas).
grant all privileges on table discador_leads_espelho to service_role;
notify pgrst, 'reload schema';
