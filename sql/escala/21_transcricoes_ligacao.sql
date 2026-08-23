-- escala/21_transcricoes_ligacao.sql — linha ESTRUTURADA/queryável de cada
-- ligação transcrita (transcrição + análise-IA + metadados), independente do
-- binário da gravação (que já vai pro Supabase Storage em prod, Fase 19.1).
--
-- (a) SEM FK para `ligacoes` DE PROPÓSITO: em produção só existem as
--     migrações escala/01-05 + 20 aplicadas — `ligacoes` (escala/06, Fase A)
--     NÃO existe ainda em prod. Esta tabela precisa funcionar HOJE, sem
--     esperar o flip da Fase B (Phase 19) e sem tocar a superfície dela.
--     Mesmo molde de escala/20_anotacoes_ligacao.sql.
-- (b) Chave = `call_id` (id da chamada Wavoip) — UNIQUE, alvo do upsert
--     `on_conflict=call_id` (retry do worker não duplica a linha).
--     `ligacao_task_id` (task_id do ClickUp da Ligação, Lista 02) é metadado,
--     não a chave de dedup.
-- (c) PÓS-FLIP (Fase 19/Fase B): junta-se com `ligacoes` por
--     `ligacao_task_id = ligacoes.clickup_task_id` (join lógico, sem FK
--     declarada — os dois bancos evoluem em paralelo até a migração/
--     reconciliação de fases futuras).
-- (d) LGPD: esta tabela NÃO guarda telefone/CPF. A transcrição/análise-IA são
--     conteúdo LEGÍTIMO da tabela (é o propósito dela) — mas NUNCA vão pra
--     log (T-ubk-02); grant só `service_role`, nunca anon/authenticated
--     (T-ubk-01).
-- (e) Como aplicar: `node --env-file=.env scripts/aplicar-sql.mjs
--     sql/escala/21_transcricoes_ligacao.sql` (mesmo mecanismo de
--     06_ligacoes.sql/20_anotacoes_ligacao.sql — aplica via /pg/query do Kong
--     e força o reload do schema cache do PostgREST derrubando o
--     authenticator; sem o kick, POST numa tabela nova responde 404 {} com
--     GET funcionando).
--
-- Idempotente (IF NOT EXISTS) — pode reaplicar sem quebrar.

create table if not exists transcricoes_ligacao (
  id                   bigserial primary key,
  call_id              text unique,                  -- id da chamada Wavoip; alvo do upsert on_conflict (idempotência de retry)
  ligacao_task_id      text,                          -- task ClickUp da Ligação (Lista 02); nullable (avulsa)
  lead_task_id         text,                          -- nullable
  storage_path         text,                          -- ponteiro da cópia canônica (bucket/path); nullable — só main/prod popula (homolog não tem guardarGravacao)
  url_gravacao_wavoip  text,                          -- ponteiro Wavoip (recordUrl); nullable
  transcricao          text,
  analise_ia           jsonb,                         -- aderência/alertas/retorno/voto-IA (mesma classe de 06_ligacoes.sql); nullable
  duracao_seg          int,                           -- nullable
  criado_em            timestamptz not null default now()
);

create index if not exists ix_transcricoes_ligacao_task on transcricoes_ligacao (ligacao_task_id);

-- PostgREST self-hosted: grant só service_role (LGPD-01/R13 — transcrição/
-- análise em repouso). Nunca anon/authenticated. + reload de cache
-- (idempotente; mesmo molde de 06_ligacoes.sql/20_anotacoes_ligacao.sql).
grant all privileges on table transcricoes_ligacao to service_role;
notify pgrst, 'reload schema';
