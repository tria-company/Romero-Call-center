-- escala/10_clickup_campos.sql — clickup_campo_mapa: cache VERSIONADO dos
-- field-ids do ClickUp (design §2.5, D-07, MODELO-06, uma única autoridade).
--
-- Hoje os field_ids são hardcoded em CAMPOS_LIGACOES/CAMPOS_LEADS/OPCOES_*
-- (src/mastra/clickup.ts) — essas constantes continuam sendo a fonte de
-- ESCRITA. Esta tabela é o cache versionado da busca em
-- clickup_get_custom_fields/get_custom_fields, usado para VALIDAR as
-- constantes no boot e servir o caminho REVERSO (UUID de opção -> valor
-- lógico). O carregamento/validação no boot é trabalho do plano 17-03
-- (MODELO-06) — este arquivo só cria a estrutura.
--
-- Idempotente (IF NOT EXISTS) — pode reaplicar sem quebrar.

create table if not exists clickup_campo_mapa (
  lista         text,        -- 'LEADS'|'LIGACOES'|'AUDIOS'
  campo_logico  text,        -- 'INICIO','ATENDEU','CONFIRMOU_VOTO_ROMERO'...
  field_id      text,        -- UUID D-07
  tipo          text,        -- drop_down|date|text|number|bool|relationship
  opcoes        jsonb,       -- OPCOES_* (valor lógico <-> UUID de opção, BIDIRECIONAL)
  origem        text,        -- 'clickup_get_custom_fields@<timestamp>' (auditável)
  primary key (lista, campo_logico)
);

-- Grant só service_role (LGPD-01) — mapa não tem PII, mas segue a mesma
-- disciplina das demais tabelas novas por consistência.
grant all privileges on table clickup_campo_mapa to service_role;
notify pgrst, 'reload schema';
