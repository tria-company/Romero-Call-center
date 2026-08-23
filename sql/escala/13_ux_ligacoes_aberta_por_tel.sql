-- escala/13_ux_ligacoes_aberta_por_tel.sql — dedup AUTORITATIVO de ligação
-- aberta por telefone canônico (MODELO-02, Fase B).
--
-- DÉBITO FECHADO: o índice UNIQUE parcial foi especificado no design (§2.1)
-- desde a Fase A (17-01), mas deliberadamente NÃO criado lá — ver
-- sql/escala/06_ligacoes.sql topo e 17-CONTEXT.md decisão 5. Seu
-- comportamento (colidir no banco em vez de criar duplicata) só se realiza
-- quando a ESCRITA de `ligacoes` inverte — é agora, na Fase B
-- (.planning/phases/19-fase-b-inverter-ligacoes-escrita-leitura-juntas/
-- 19-CONTEXT.md decisão 6, design §2.1/Riscos R3).
--
-- SUBSTITUI o backstop em memória (`criandoInbound`/`inboundAdiados`,
-- src/mastra/index.ts) por um invariante forçado pelo DB: duas redeliveries
-- do Evolution (ou 2 processos/réplicas) tentando criar a MESMA ligação
-- 'aberta' pro MESMO telefone_canonico colidem no índice — o segundo INSERT
-- (`INSERT ... ON CONFLICT (telefone_canonico) WHERE status='aberta' DO
-- NOTHING`, implementado nas RPCs/rotas dos planos 19-02/19-07) não cria
-- duplicata. A rota decide "criada vs. já existia" pela CONTAGEM DE LINHAS
-- (rowcount) do INSERT, não por guarda em memória de processo (que não
-- sobrevive restart nem é compartilhada entre réplicas).
--
-- DOIS índices gêmeos (débito de sincronia manual — mesmo padrão das RPCs da
-- Phase 18, ver sql/escala/12_rpc_registrar_desfecho.sql nota (c)): o de
-- homolog leva o prefixo `hml_` no NOME do índice (não colide na mesma
-- instância Postgres compartilhada — manager01, ver memória do projeto),
-- pois `hml_ligacoes` é uma tabela distinta de `ligacoes`.
--
-- NOTA — aplicação em homolog (débito documentado, ação do 19-10, não deste
-- arquivo): se já existir alguma linha 'aberta' com telefone_canonico
-- duplicado no homolog (dado herdado do espelho da Fase A, sincronizado
-- antes deste índice existir), a criação do UNIQUE parcial FALHA. A
-- limpeza/dedup dessas linhas pré-existentes é passo do apply em janela de
-- manutenção (19-10), não desta migração.
--
-- LGPD: o índice opera só sobre a coluna JÁ canônica (telefone_canonico) —
-- nenhum telefone em claro aparece neste SQL nem em log de aplicação.
--
-- Idempotente (IF NOT EXISTS) — pode reaplicar sem quebrar.

create unique index if not exists ux_ligacoes_aberta_por_tel
  on ligacoes (telefone_canonico)
  where status = 'aberta';

create unique index if not exists ux_hml_ligacoes_aberta_por_tel
  on hml_ligacoes (telefone_canonico)
  where status = 'aberta';

-- Reload do cache de schema do PostgREST — mesma disciplina das demais
-- migrações desta série (mudança de schema). O kick real do `authenticator`
-- (o NOTIFY sozinho não propaga de forma confiável neste deploy self-hosted)
-- vem de scripts/aplicar-sql.mjs, executado no plano de verificação (19-10).
notify pgrst, 'reload schema';
