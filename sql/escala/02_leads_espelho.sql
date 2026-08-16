-- escala/02_leads_espelho.sql — ESPELHO rápido dos leads da Lista 01 (ClickUp).
--
-- Read-model para a tela Base do painel: busca / filtro (recorte) / paginação /
-- contagem em MILISSEGUNDOS no Postgres, em vez de ~2,7s por página no ClickUp
-- (inviável para ~100 mil leads). O ClickUp CONTINUA a fonte da verdade:
--   • sincronizarEspelhoLeads() copia os leads do ClickUp pra cá em 2º plano;
--   • ao gravar um voto, o backend atualiza ClickUp E este espelho (write-through),
--     então o voto aparece na hora na lista.
--
-- Idempotente (IF NOT EXISTS) — pode reaplicar sem quebrar. O backend degrada
-- gracioso: se a tabela não existir/estiver vazia, a Base cai no caminho antigo
-- (ClickUp ao vivo) — só mais lento, nunca quebra.
--
-- Como aplicar: SQL editor do Supabase (self-hosted) OU psql "$DATABASE_URL" -f este_arquivo.

create extension if not exists pg_trgm;

create table if not exists discador_leads_espelho (
  clickup_task_id     text primary key,          -- id do card no ClickUp (chave; link do detalhe + write-through)
  id_supabase         text,                        -- ID Supabase do lead (users_romero.id), quando houver
  nome                text,
  nome_lower          text,                        -- nome em minúsculas para busca case-insensitive (índice trigram)
  telefone            text,
  cpf                 text,
  bairro              text,
  cidade              text,
  confirmou_romero    text,                        -- 'sim' | 'nao' | 'naoDeclarou' | null
  confirmou_andressa  text,
  militante           boolean not null default false,
  sem_contato         boolean not null default true,
  atualizado_em       timestamptz not null default now()
);

-- Busca por nome (substring, case-insensitive) rápida em 100k+ linhas.
create index if not exists idx_leads_espelho_nome_trgm on discador_leads_espelho using gin (nome_lower gin_trgm_ops);
-- Recortes (filtro server-side) e ordenação/incremental.
create index if not exists idx_leads_espelho_romero      on discador_leads_espelho (confirmou_romero);
create index if not exists idx_leads_espelho_andressa    on discador_leads_espelho (confirmou_andressa);
create index if not exists idx_leads_espelho_militante   on discador_leads_espelho (militante);
create index if not exists idx_leads_espelho_semcontato  on discador_leads_espelho (sem_contato);
create index if not exists idx_leads_espelho_atualizado  on discador_leads_espelho (atualizado_em);

-- PostgREST self-hosted: o backend escreve como `service_role`. Após um CREATE
-- TABLE, o cache de schema do PostgREST fica leitura-só até recarregar — a tabela
-- aceita SELECT mas devolve 404 no INSERT/UPSERT. As duas linhas abaixo garantem o
-- acesso de escrita e forçam o reload do cache (idempotentes; rode sempre que
-- reaplicar). Só `service_role` (o backend) — nunca anon/authenticated, pra não
-- expor a base com telefone/CPF pela API pública.
grant all privileges on table discador_leads_espelho to service_role;
notify pgrst, 'reload schema';
