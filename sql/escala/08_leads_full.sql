-- escala/08_leads_full.sql — ESTENDE discador_leads_espelho pro registro COMPLETO
-- da Lista 01 LEADS (ClickUp), aditivo (design §2.3).
--
-- Decisão explícita da Fase A (17-CONTEXT.md decisão 4 / débito documentado):
-- o design §2.3 fala em "leads vira a tabela autoritativa" e renomear
-- conceitualmente "espelho" -> "leads". Essa renomeação (+ view alias) é
-- DEFERIDA para quando as LEITURAS invertem (Phase 19/20) — a Fase A é
-- aditiva-e-reversível por definição (17-CONTEXT.md: "nada lê essas tabelas
-- ainda"). Este arquivo SÓ adiciona colunas (ADD COLUMN IF NOT EXISTS,
-- nullable) na tabela EXISTENTE `discador_leads_espelho`; não renomeia, não
-- dropa, não cria view. O SELECT explícito de listarLeadsEspelho
-- (src/mastra/supabase.ts) não muda — colunas novas simplesmente não são
-- lidas ainda.
--
-- As colunas confirmou_romero/confirmou_andressa (o voto — SoT futura,
-- Riscos R12) JÁ EXISTEM (sql/escala/02_leads_espelho.sql) — não
-- re-adicionadas aqui.
--
-- Idempotente (IF NOT EXISTS em tudo) — pode reaplicar sem quebrar.

alter table discador_leads_espelho
  add column if not exists score int,
  add column if not exists tentativas int,
  add column if not exists proximo_contato date,
  add column if not exists retorno_necessario boolean,
  add column if not exists observacao_consolidada text,
  add column if not exists dossie text,                 -- materializa a description usada pelo dossiê
  add column if not exists ultimo_contato timestamptz,
  add column if not exists qtd_contatos int,
  add column if not exists id_lead text,
  add column if not exists tags text[],
  add column if not exists elegivel boolean;

-- Índice de priorização do lote (ordem exata de selecionarLoteElegivel, lote.ts — §2.3).
create index if not exists ix_leads_lote on discador_leads_espelho
  (retorno_necessario desc, score desc, tentativas asc)
  where elegivel = true;

-- Reafirma o grant/reload (mesma disciplina de 02_leads_espelho.sql — service_role só).
grant all privileges on table discador_leads_espelho to service_role;
notify pgrst, 'reload schema';
