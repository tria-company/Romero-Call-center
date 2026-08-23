-- escala/11_notas.sql — materializa os COMENTÁRIOS de task (Lista 01/02) do
-- ClickUp (design §2.6, MODELO-07, Riscos R7).
--
-- Anotações futuras viram `INSERT nota local + outbox comentar` (Phase 19).
-- O BACKFILL de comentários históricos (via get_task_comments/
-- get_threaded_comments, por-ID) é trabalho do plano 17-05 (MODELO-07) —
-- este arquivo só cria a estrutura.
--
-- Idempotente (IF NOT EXISTS) — pode reaplicar sem quebrar.

create table if not exists notas (
  id                 bigint generated always as identity primary key,
  aggregate          text,        -- 'lead' | 'ligacao'
  aggregate_id       bigint,
  autor              text,
  corpo              text,
  criado_em          timestamptz not null default now(),
  clickup_comment_id text                -- id do comentário no ClickUp (backfill/idempotência)
);

-- PostgREST self-hosted: grant só service_role (LGPD-01/R13 — corpo do
-- comentário pode conter PII). Nunca anon/authenticated. + reload de cache.
grant all privileges on table notas to service_role;
notify pgrst, 'reload schema';
