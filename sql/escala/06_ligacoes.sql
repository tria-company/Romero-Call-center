-- escala/06_ligacoes.sql — ESPELHO da Lista 02 LIGACOES (ClickUp) para LEITURA futura.
--
-- Fase A da inversão Supabase-fonte-da-verdade (.planning/arquitetura/
-- inversao-supabase-fonte-da-verdade.md §2.1). NADA lê esta tabela ainda — o
-- caminho crítico (fila/painel/timeline) continua 100% ClickUp nesta fase.
-- A generalização de sincronizarEspelhoLeads (espelho.ts) para
-- sincronizarEspelhoLigacoes() (que POPULA esta tabela) é trabalho de um
-- plano posterior (17-02+); este arquivo só cria a estrutura.
--
-- Origem das colunas (D-07, field_id do ClickUp — src/mastra/clickup.ts,
-- CAMPOS_LIGACOES): LEAD_REL, OPERADOR, INICIO, FIM, DURACAO, MOTIVO_FALHA,
-- URL_GRAVACAO, TRANSCRICAO, ANALISE_IA, NECESSITA_REVISAO. Nunca resolver
-- por nome em runtime (D-07) — o mapa de field-ids segue vivendo em
-- clickup.ts / clickup_campo_mapa (sql/escala/10, plano 17-03).
--
-- DÉBITO EXPLÍCITO (MODELO-02, Phase 19): o design (§2.1) especifica também
-- um UNIQUE parcial `ux_ligacoes_aberta_por_tel` (no máximo uma ligação
-- 'aberta' por telefone_canonico) como dedup AUTORITATIVO. Esse índice NÃO é
-- criado aqui de propósito — seu comportamento (colidir no banco em vez de
-- criar duplicata) só faz sentido quando a ESCRITA de `ligacoes` inverte
-- (Phase 19); criá-lo agora, com a tabela ainda vazia/não escrita por
-- ninguém, não mitiga nada e antecipa uma constraint que pode conflitar com
-- o formato real de dedup ainda a definir. Ver 17-CONTEXT.md decisão 5.
--
-- Idempotente (IF NOT EXISTS) — pode reaplicar sem quebrar.

create table if not exists ligacoes (
  id                    bigint generated always as identity primary key,
  clickup_task_id       text unique,                 -- nullable até o push (outbox, Phase 19)
  lead_id               bigint,                       -- id local do lead (FK lógica; leads ainda é discador_leads_espelho)
  lead_clickup_task_id  text,                          -- LEAD_REL (relationship) — chave de junção nesta fase
  operador              text,                          -- login do operador (discador_usuarios)
  assignee_clickup_id   bigint,                        -- clickup_member_id do operador
  telefone_canonico     text,                          -- forma canônica determinística (E.164 pós 9º dígito) — NUNCA em log
  telefone_variantes    text[],                        -- candidatos ±9º dígito, correlação multi-candidato (§5.3)
  script                text,                          -- description/markdown da task (roteiro pronto)
  status                text,                          -- enum: aberta·em_processamento·fechada (OPER_STATUS_*)
  resultado             text,                          -- enum: atendida·recusou·nao_atendida·pulado·sem_whatsapp
  inicio                timestamptz,                   -- CAMPOS_LIGACOES.INICIO
  fim                   timestamptz,                   -- CAMPOS_LIGACOES.FIM
  duracao_seg           int,                           -- CAMPOS_LIGACOES.DURACAO
  atendeu               boolean,                       -- CAMPOS_LIGACOES.ATENDEU
  motivo_falha          text,                          -- CAMPOS_LIGACOES.MOTIVO_FALHA
  url_gravacao          text,                          -- ponteiro (§2.6 — binário canônico vive no Supabase Storage)
  transcricao           text,                          -- CAMPOS_LIGACOES.TRANSCRICAO
  analise_ia            jsonb,                         -- aderência/alertas/retorno/voto-IA (ANALISE_IA)
  necessita_revisao     boolean,                       -- NECESSITA_REVISAO
  lote_data             date,                          -- dia do lote (novo — hoje implícito)
  origem                text,                          -- enum: lote·avulsa·inbound_whatsapp
  criado_em             timestamptz not null default now(),
  atualizado_em         timestamptz not null default now()
);

-- Índices de fila/lead/lote (substituem as varreduras filtradas do ClickUp — §2.1).
create index if not exists ix_ligacoes_fila on ligacoes (operador, status, inicio)
  where status <> 'em_processamento';           -- buscarFilaLigacoes
create index if not exists ix_ligacoes_lead on ligacoes (lead_id, inicio desc);   -- timeline
create index if not exists ix_ligacoes_lote on ligacoes (lote_data, status);      -- campanha/painel

-- NOTA: ux_ligacoes_aberta_por_tel (UNIQUE parcial de dedup) NÃO criado aqui —
-- ver comentário de topo / débito MODELO-02, Phase 19.

-- PostgREST self-hosted: grant só service_role (LGPD-01/R13 — telefone/
-- transcrição em repouso). Nunca anon/authenticated. + reload de cache
-- (idempotente; rode sempre que reaplicar — mesmo molde de 02_leads_espelho.sql).
grant all privileges on table ligacoes to service_role;
notify pgrst, 'reload schema';
