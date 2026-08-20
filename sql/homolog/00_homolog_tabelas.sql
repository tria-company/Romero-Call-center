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

-- Escrita via PostgREST é feita como `service_role` (o backend). NUNCA conceder
-- a anon/authenticated: estas tabelas contêm telefone/CPF (mesma disciplina de
-- LGPD do espelho de produção).
grant all on table
  hml_discador_leads_espelho,
  hml_votos_ligacao,
  hml_mensagens_whatsapp,
  hml_webhook_eventos,
  hml_discador_usuarios
  to service_role;
