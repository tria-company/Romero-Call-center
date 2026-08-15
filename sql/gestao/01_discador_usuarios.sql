-- discador_usuarios — store persistente de operadores do discador (Fase 11, D-01/D-02)
--
-- Substitui os mapas env (DISCADOR_USERS/DISCADOR_ASSIGNEES/WAVOIP_USER_DEVICES) por uma
-- tabela: login+senha (hash), papel (gestor|atendente), e o vínculo opcional com o membro
-- ClickUp e o device Wavoip do operador. É lida pelo login (discador-auth.ts) e pela tela de
-- gestão de usuários do painel admin (Fase 11).
--
-- Contém PII (hash de senha, vínculo ClickUp) — instância self-hosted, acesso SOMENTE via
-- service key. NÃO expor por anon/PostgREST público.
--
-- Aplicar no Supabase self-hosted (não é aplicado automaticamente — decisão D3
-- "construir código primeiro, provisionar depois"):
--   psql "$SUPABASE_DB_URL" -f sql/gestao/01_discador_usuarios.sql
-- Nome da tabela é parametrizável por SUPABASE_TABLE_USUARIOS (default abaixo).

create extension if not exists "pgcrypto";  -- gen_random_uuid()

create table if not exists discador_usuarios (
  id uuid primary key default gen_random_uuid(),
  usuario text not null unique,               -- login, case-insensitive por convenção
  senha_hash text not null,
  senha_salt text,                            -- null para o legado sha256 importado
  senha_algo text not null default 'scrypt',  -- 'scrypt' | 'sha256-legado' (D-08)
  papel text not null default 'atendente',    -- 'gestor' | 'atendente' (D-05)
  clickup_member_id text,                     -- vínculo opcional (D-03)
  wavoip_device_id text,                      -- vínculo opcional (D-04)
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz
);

create index if not exists idx_discador_usuarios_usuario on discador_usuarios (usuario);
