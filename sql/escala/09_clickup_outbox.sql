-- escala/09_clickup_outbox.sql — transactional outbox p/ escrita assíncrona ao ClickUp
-- (design §2.4, MODELO-05).
--
-- CRIADA aqui (Fase A) mas só CONSUMIDA na Phase 19 (worker de dreno,
-- src/mastra/drenar-outbox.ts) — nenhum código escreve/lê esta tabela nesta
-- fase. O `payload` guarda field_id+valor ou o body da task; é NULADO após o
-- envio (scrub de PII, Riscos R13) pelo worker de dreno — não nesta migração.
--
-- Idempotente (IF NOT EXISTS) — pode reaplicar sem quebrar.

create table if not exists clickup_outbox (
  id            bigint generated always as identity primary key,
  aggregate     text not null,                    -- 'ligacao' | 'lead' | 'audio' | 'nota'
  aggregate_id  bigint not null,                   -- id local (ligacoes.id / leads.id / ...)
  op            text not null,                     -- 'criar_task' | 'set_campo' | 'set_status' | 'comentar' | 'anexar' | 'fechar'
  bloqueante    boolean not null default true,     -- criar_task/set_status = true; comentar/anexar = false
  payload       jsonb,                             -- field_id + valor, ou body da task; NULADO após envio (worker de dreno)
  dedup_key     text unique not null,               -- idempotência: ex 'ligacao:42:campo:INICIO'
  seq           bigint not null,                    -- ordem por aggregate (preserva ordem)
  status        text not null default 'pendente',   -- pendente|enviando|enviado|erro|dlq|orphan
  tentativas    int not null default 0,
  proxima_em    timestamptz not null default now(),  -- backoff
  ultimo_erro   text,                                -- truncado, sem PII
  criado_em     timestamptz not null default now(),
  enviado_em    timestamptz
);

create index if not exists ix_outbox_drain on clickup_outbox (status, proxima_em)
  where status in ('pendente','erro');
create index if not exists ix_outbox_ordem on clickup_outbox (aggregate, aggregate_id, seq);
-- monitoramento de head-of-line blocking (§3.2 / Riscos R6) — consumido na Phase 19.
create index if not exists ix_outbox_head_age on clickup_outbox (aggregate, aggregate_id, criado_em)
  where status in ('pendente','erro');

-- NOTA LGPD (LGPD-01/R13): payload pode conter transcrição/telefone em
-- repouso até o dreno nulá-lo — grant só service_role, nunca
-- anon/authenticated.
grant all privileges on table clickup_outbox to service_role;
notify pgrst, 'reload schema';
