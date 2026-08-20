-- ============================================================================
-- Tabelas hml_* do ambiente de HOMOLOGAÇÃO (mesma instância Supabase de prod).
--
-- Isolam a ESCRITA do homolog das tabelas de produção. A estrutura é copiada
-- 1:1 da tabela de produção com `LIKE ... INCLUDING ALL` (colunas, defaults,
-- constraints e índices) — sem duplicar DDL à mão, e sempre em dia com prod.
-- Idempotente (IF NOT EXISTS): pode reaplicar sem quebrar.
--
-- Só as tabelas que o homolog ESCREVE ganham cópia. militantes/follow-ups NÃO
-- entram aqui de propósito: o homolog lê os de produção (referência somente-
-- leitura), então o env NÃO sobrescreve SUPABASE_TABLE_MILITANTES/FOLLOWUPS.
--
-- Aplicar (na VPS, dentro de /opt/discador-homolog, com o env do homolog):
--   node --env-file=deploy/homolog.env scripts/aplicar-sql.mjs sql/homolog/00_homolog_tabelas.sql
-- (aplicar-sql.mjs roda o DDL via /pg/query do Kong e recarrega o cache do
--  PostgREST forçando a reconexão do authenticator.)
-- ============================================================================

create table if not exists hml_discador_leads_espelho (like discador_leads_espelho including all);
create table if not exists hml_votos_ligacao          (like votos_ligacao          including all);
create table if not exists hml_mensagens_whatsapp      (like mensagens_whatsapp      including all);
create table if not exists hml_webhook_eventos         (like webhook_eventos         including all);
create table if not exists hml_discador_usuarios       (like discador_usuarios       including all);

-- ============================================================================
-- Fase 17-A — inversão Supabase-fonte-da-verdade: cópias hml_ das tabelas de
-- sql/escala/06..11 (design §2). Mesmo padrão LIKE ... INCLUDING ALL.
-- ============================================================================
create table if not exists hml_ligacoes            (like ligacoes            including all);
create table if not exists hml_audios_envios        (like audios_envios        including all);
create table if not exists hml_clickup_outbox        (like clickup_outbox        including all);
create table if not exists hml_clickup_campo_mapa    (like clickup_campo_mapa    including all);
create table if not exists hml_notas                 (like notas                 including all);

-- ATENÇÃO (débito de LIKE ser snapshot único): hml_discador_leads_espelho foi
-- criada ANTES do ALTER aditivo de sql/escala/08_leads_full.sql — o LIKE
-- acima não herda ALTERs feitos depois. Repetir aqui, explicitamente, o MESMO
-- ADD COLUMN IF NOT EXISTS do 08 (idempotente — sql/escala/08_leads_full.sql).
alter table hml_discador_leads_espelho
  add column if not exists score int,
  add column if not exists tentativas int,
  add column if not exists proximo_contato date,
  add column if not exists retorno_necessario boolean,
  add column if not exists observacao_consolidada text,
  add column if not exists dossie text,
  add column if not exists ultimo_contato timestamptz,
  add column if not exists qtd_contatos int,
  add column if not exists id_lead text,
  add column if not exists tags text[],
  add column if not exists elegivel boolean;

-- Escrita via PostgREST é feita como `service_role` (o backend). NUNCA conceder
-- a anon/authenticated: estas tabelas contêm telefone/CPF (mesma disciplina de
-- LGPD do espelho de produção).
grant all on table
  hml_discador_leads_espelho,
  hml_votos_ligacao,
  hml_mensagens_whatsapp,
  hml_webhook_eventos,
  hml_discador_usuarios,
  hml_ligacoes,
  hml_audios_envios,
  hml_clickup_outbox,
  hml_clickup_campo_mapa,
  hml_notas
  to service_role;
notify pgrst, 'reload schema';
