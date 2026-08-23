-- escala/27_conteudos.sql — biblioteca de CONTEÚDOS recorrentes (mensagens/links
-- prontos) que o Romero envia aos leads na conversa (Fase 2 do roadmap; o Felipe
-- deixa pronto a pedido do Romero).
--
-- (a) MVP: só `tipo` in ('texto','link'). Imagem/vídeo/áudio ficam para uma fase
--     posterior (exigem wrapper de mídia na Evolution + storage) — o CHECK abaixo
--     será estendido nessa fase.
-- (b) Chave = `id` uuid (gen_random_uuid): a gestão (criar/editar/excluir) é feita
--     via PostgREST DIRETO como `service_role` — uuid evita depender de grant de
--     sequence a service_role (o insert de bigserial falharia sem `usage` na
--     sequence, já que a tabela é criada por outro role).
-- (c) `ativo` habilita SOFT-DELETE (excluir = ativo=false): preserva histórico e
--     evita quebrar referências; a listagem do operador filtra ativo=true.
-- (d) LGPD: NÃO guarda telefone/CPF — só título/categoria/texto/url que o gestor
--     digita. Sem dado pessoal.
-- (e) Como aplicar: `node --env-file=.env scripts/aplicar-sql.mjs
--     sql/escala/27_conteudos.sql` (mesmo mecanismo das migrações vizinhas —
--     aplica via /pg/query do Kong e força o reload do schema cache do PostgREST;
--     NOTIFY desabilitado neste deploy, sem o kick uma tabela nova responde 404
--     {} com GET funcionando).
--
-- Idempotente (IF NOT EXISTS) — pode reaplicar sem quebrar.

create table if not exists conteudos (
  id            uuid primary key default gen_random_uuid(),
  categoria     text,
  titulo        text not null,
  tipo          text not null check (tipo in ('texto', 'link')),
  texto         text,
  url           text,
  ordem         int not null default 0,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Índice da listagem do operador (ativo=true, agrupado por categoria, na ordem).
create index if not exists ix_conteudos_ativo_cat_ordem on conteudos (ativo, categoria, ordem);

-- PostgREST self-hosted: grant só service_role (LGPD-01/R13) — nunca
-- anon/authenticated. + reload de cache (idempotente; mesmo molde das migrações
-- vizinhas, ex.: 20_anotacoes_ligacao.sql).
grant all privileges on table conteudos to service_role;
notify pgrst, 'reload schema';
