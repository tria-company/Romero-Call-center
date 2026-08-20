-- escala/07_audios_envios.sql — ESPELHO da Lista 03 AUDIOS (ClickUp) para LEITURA futura.
--
-- Fase A da inversão Supabase-fonte-da-verdade (.planning/arquitetura/
-- inversao-supabase-fonte-da-verdade.md §2.2). NADA lê esta tabela ainda —
-- listarEnviosAudioDoLead/mapaConversaPorLead/buscarLeadsNuncaLigados
-- continuam 100% ClickUp nesta fase. A generalização do sync
-- (sincronizarEspelhoAudios(), que POPULA esta tabela) é trabalho de um
-- plano posterior (17-02+); este arquivo só cria a estrutura.
--
-- Idempotente (IF NOT EXISTS) — pode reaplicar sem quebrar.

create table if not exists audios_envios (
  id                    bigint generated always as identity primary key,
  clickup_task_id       text unique,                 -- nullable, task da Lista 03
  lead_id               bigint,                       -- id local do lead (FK lógica)
  lead_clickup_task_id  text,                          -- CAMPOS_AUDIOS.LEAD
  tipo                  text,                          -- enum: audio·texto
  corpo                 text,                          -- description ("Mensagem enviada"/legenda)
  transcricao_audio     text,                          -- TRANSCRICAO_AUDIO
  midia_ref             text,                          -- ponteiro p/ Supabase Storage (§2.6)
  selo_conversa         text,                          -- enum: ligar·nao_ligar·sem_conversa (hoje derivado por mapaConversaPorLead)
  enviado_em            timestamptz
);

create index if not exists ix_audios_lead on audios_envios (lead_id, enviado_em desc);

-- PostgREST self-hosted: grant só service_role (LGPD-01/R13). Nunca
-- anon/authenticated. + reload de cache (idempotente).
grant all privileges on table audios_envios to service_role;
notify pgrst, 'reload schema';
