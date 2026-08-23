-- escala/20_anotacoes_ligacao.sql — persiste os campos ESTRUTURADOS que o
-- retorno de ligação já coleta hoje (classificação/demanda/observação/canal/
-- após-whatsapp/super-fã/resultado), como escrita DUPLA best-effort ao lado
-- dos marcadores ClickUp (quick 260822-rr6).
--
-- (a) SEM FK para `ligacoes` DE PROPÓSITO: em produção só existem as
--     migrações escala/01-05 aplicadas — `ligacoes` (escala/06, Fase A) NÃO
--     existe ainda em prod. Esta tabela precisa funcionar HOJE, sem esperar
--     o flip da Fase B (Phase 19) e sem tocar a superfície dela.
-- (b) Chave = `ligacao_task_id` (o task_id do ClickUp da Ligação, Lista 02)
--     — NÃO um id numérico local, porque não há linha `ligacoes` pra
--     referenciar em prod ainda.
-- (c) PÓS-FLIP (Fase 19/Fase B): junta-se com `ligacoes` por
--     `ligacao_task_id = ligacoes.clickup_task_id` (join lógico, sem FK
--     declarada — os dois bancos evoluem em paralelo até a migração/
--     reconciliação de fases futuras).
-- (d) LGPD: esta tabela NÃO guarda telefone/CPF — só texto digitado pelo
--     atendente (observação/demanda) e rótulos fixos (classificação/canal/
--     resultado/super_fa). Nunca logar o conteúdo em claro (T-tdj-03).
-- (e) Como aplicar: `node --env-file=.env scripts/aplicar-sql.mjs
--     sql/escala/20_anotacoes_ligacao.sql` (mesmo mecanismo de
--     06_ligacoes.sql — aplica via /pg/query do Kong e força o reload do
--     schema cache do PostgREST derrubando o authenticator; NOTIFY
--     desabilitado neste deploy, sem o kick POST numa tabela nova responde
--     404 {} com GET funcionando).
--
-- Idempotente (IF NOT EXISTS) — pode reaplicar sem quebrar.

create table if not exists anotacoes_ligacao (
  id                bigserial primary key,
  ligacao_task_id   text not null,
  lead_task_id      text,
  operador          text,
  classificacao     text check (classificacao in ('receptiva', 'indecisa', 'negativa')),
  demanda           text,
  observacao        text,
  canal             text check (canal in ('whatsapp', 'telefone')),
  apos_whatsapp     boolean,
  super_fa          boolean,
  resultado         text,
  criado_em         timestamptz not null default now()
);

create index if not exists ix_anotacoes_ligacao_task on anotacoes_ligacao (ligacao_task_id);
create index if not exists ix_anotacoes_ligacao_criado on anotacoes_ligacao (criado_em);

-- Atributo PERMANENTE da pessoa (não da ligação) — a tabela "leads" do design
-- é `discador_leads_espelho` (escala/02, único espelho de leads que existe em
-- prod); NÃO existe tabela chamada `leads`.
alter table discador_leads_espelho add column if not exists super_fa boolean not null default false;

-- PostgREST self-hosted: grant só service_role (LGPD-01/R13) — nunca
-- anon/authenticated. + reload de cache (idempotente; mesmo molde de
-- 02_leads_espelho.sql / 06_ligacoes.sql).
grant all privileges on table anotacoes_ligacao to service_role;
notify pgrst, 'reload schema';
