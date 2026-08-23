-- escala/22_fundacao_fase_c.sql — Fundação da Fase C (Phase 20), Caminho B.
--
-- NUMERAÇÃO: o plano-fonte (20-01-PLAN.md) previa `20_fundacao_fase_c.sql` /
-- `21_indices_fase_c.sql`, mas os números 20/21 já tinham sido consumidos
-- pelas quick tasks 260822-tdj (`20_anotacoes_ligacao.sql`) e 260822-ubk
-- (`21_transcricoes_ligacao.sql`), aplicadas ANTES deste plano rodar. Esta
-- migração assume 22 (a próxima gaveta livre); a irmã de índices vira `23`
-- (deviation Rule 3 — colisão bloqueante, resolvida por renumeração; ver
-- 20-01-SUMMARY.md). O plano 20-03 (`sql/escala/24_rpc_gerar_lote.sql` no
-- key_link do frontmatter) precisa ser renumerado pelo executor daquele
-- plano na mesma lógica (a próxima gaveta livre no momento).
--
-- Três blocos, cada um ADITIVO e idempotente (IF NOT EXISTS / CREATE OR
-- REPLACE), no molde das migrações 12-21:
--
-- (1) CHAVE NUMÉRICA DE LEAD — `discador_leads_espelho.id bigint identity`
-- (UNIQUE) ADITIVA. A PK segue `clickup_task_id` (NÃO trocada) — `id` é uma
-- chave-substituta que `ligacoes.lead_id`/`audios_envios.lead_id` passam a
-- poder referenciar de verdade, destravando o anti-join "nunca-ligados"
-- (LEITURA-04) e o INSERT do lote por SQL (LEITURA-06, 20-03). Também quita
-- o débito do 19-09: `ligacoes.lead_id`/`audios_envios.lead_id` ficavam
-- sempre `null` (timeline supabase degradada para `[]`) porque não havia
-- chave numérica pra apontar.
--
-- (2) TRIGGER + BACKFILL de `lead_id` — `resolver_lead_id(clickup_task_id)`
-- resolve o `id` pelo texto já gravado em `lead_clickup_task_id`; um trigger
-- BEFORE INSERT/UPDATE em `ligacoes`/`audios_envios` (+ gêmeos hml_) resolve
-- automaticamente quando `lead_id` vem nulo e `lead_clickup_task_id` não.
-- Backfill único cobre as linhas já existentes.
--
-- (3) FONTE ÚNICA DE CANONICALIZAÇÃO DE TELEFONE — `canonizar_telefone` e
-- `variantes_telefone`, IMMUTABLE, portando 1:1 a lógica de
-- `src/mastra/telefone-canonico.ts::canonizarTelefone`/`variantesTelefone`
-- (semNonoDigito + normalizarTelefoneE164 + apenasDigitos). Esta é a fonte
-- ÚNICA que `INSERT ... SELECT` do lote (20-03, `gerar_lote`) usa por-linha
-- pra popular `telefone_canonico` — o dedup autoritativo (`ON CONFLICT
-- (telefone_canonico) WHERE status='aberta'`, MODELO-02) só é correto se
-- esta forma bater BYTE-A-BYTE com a camada TS. Por isso o self-check
-- inline (bloco `DO $$ ... ASSERT ... $$`) logo abaixo da definição: se a
-- lógica SQL divergir do golden fixo (mesmos valores que
-- `telefone-canonico.ts` produz — 12/13 dígitos, com/sem 9º dígito, com/sem
-- prefixo 55, com caracteres de formatação), a APLICAÇÃO desta migração
-- FALHA — a paridade é forçada pelo próprio deploy, não por convenção
-- (T-20-01-Dedup). O golden usa números SINTÉTICOS — nenhum RAISE/ASSERT
-- cita telefone real (LGPD, T-20-01-I).
--
-- `canonizar_telefone`/`variantes_telefone` são TABLE-AGNÓSTICAS (puras —
-- só manipulação de string, sem SELECT) — por isso NÃO ganham gêmeo `hml_`:
-- uma única definição serve prod e homolog igualmente (diferente do padrão
-- `hml_<nome>` das RPCs que tocam tabela). `resolver_lead_id`, que SIM
-- consulta tabela, ganha a variante mínima `resolver_lead_id_hml` (consulta
-- `hml_discador_leads_espelho`) em vez de parametrização por nome de tabela
-- (plpgsql não permite tabela dinâmica sem EXECUTE dinâmico — a forma mínima
-- aqui é a função gêmea, mesmo padrão de `hml_criar_ligacao_avulsa` etc.).
--
-- SEGURANÇA (T-20-01-E): todas as funções novas são `security invoker` +
-- `search_path` fixado; EXECUTE é revogado de `public` e concedido só a
-- `service_role` — nenhuma vira RPC pública acidental via PostgREST.
--
-- Idempotente (IF NOT EXISTS / CREATE OR REPLACE / DROP+CREATE TRIGGER) —
-- pode reaplicar sem quebrar. A APLICAÇÃO real ao homolog é o plano de prova
-- 20-08 (como no 19-01/19-02) — este arquivo só ESCREVE.

-- ============================================================================
-- (1) Chave numérica de lead (aditiva; PK continua clickup_task_id)
-- ============================================================================
alter table discador_leads_espelho
  add column if not exists id bigint generated always as identity;
create unique index if not exists ux_leads_espelho_id on discador_leads_espelho (id);

-- Gêmeo hml_: `hml_discador_leads_espelho` foi criada via `LIKE ...
-- INCLUDING ALL` (sql/homolog/00_homolog_tabelas.sql) ANTES desta coluna
-- existir em prod — o mesmo débito de LIKE-snapshot-único já documentado lá
-- para as colunas do 08_leads_full.sql. Repetir aqui, explicitamente, o
-- mesmo ADD COLUMN (idempotente).
alter table hml_discador_leads_espelho
  add column if not exists id bigint generated always as identity;
create unique index if not exists ux_hml_leads_espelho_id on hml_discador_leads_espelho (id);

-- ============================================================================
-- (2) resolver_lead_id + trigger de manutenção de lead_id + backfill
-- ============================================================================
create or replace function resolver_lead_id(p_lead_ct text)
returns bigint
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select id from discador_leads_espelho where clickup_task_id = p_lead_ct;
$$;

create or replace function resolver_lead_id_hml(p_lead_ct text)
returns bigint
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select id from hml_discador_leads_espelho where clickup_task_id = p_lead_ct;
$$;

create or replace function trg_resolver_lead_id()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if NEW.lead_id is null and NEW.lead_clickup_task_id is not null then
    NEW.lead_id := resolver_lead_id(NEW.lead_clickup_task_id);
  end if;
  return NEW;
end;
$$;

create or replace function trg_resolver_lead_id_hml()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if NEW.lead_id is null and NEW.lead_clickup_task_id is not null then
    NEW.lead_id := resolver_lead_id_hml(NEW.lead_clickup_task_id);
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_ligacoes_lead_id on ligacoes;
create trigger trg_ligacoes_lead_id
  before insert or update on ligacoes
  for each row execute function trg_resolver_lead_id();

drop trigger if exists trg_audios_envios_lead_id on audios_envios;
create trigger trg_audios_envios_lead_id
  before insert or update on audios_envios
  for each row execute function trg_resolver_lead_id();

drop trigger if exists trg_hml_ligacoes_lead_id on hml_ligacoes;
create trigger trg_hml_ligacoes_lead_id
  before insert or update on hml_ligacoes
  for each row execute function trg_resolver_lead_id_hml();

drop trigger if exists trg_hml_audios_envios_lead_id on hml_audios_envios;
create trigger trg_hml_audios_envios_lead_id
  before insert or update on hml_audios_envios
  for each row execute function trg_resolver_lead_id_hml();

-- Backfill único (linhas já existentes, gravadas antes do trigger existir).
update ligacoes g
   set lead_id = l.id
  from discador_leads_espelho l
 where g.lead_clickup_task_id = l.clickup_task_id
   and g.lead_id is null;

update audios_envios g
   set lead_id = l.id
  from discador_leads_espelho l
 where g.lead_clickup_task_id = l.clickup_task_id
   and g.lead_id is null;

update hml_ligacoes g
   set lead_id = l.id
  from hml_discador_leads_espelho l
 where g.lead_clickup_task_id = l.clickup_task_id
   and g.lead_id is null;

update hml_audios_envios g
   set lead_id = l.id
  from hml_discador_leads_espelho l
 where g.lead_clickup_task_id = l.clickup_task_id
   and g.lead_id is null;

-- ============================================================================
-- (3) Fonte única de canonicalização de telefone (IMMUTABLE, table-agnóstica)
-- Porta 1:1 src/mastra/telefone-canonico.ts::canonizarTelefone/variantesTelefone.
-- ============================================================================
create or replace function canonizar_telefone(p_raw text)
returns text
language plpgsql
immutable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_digitos  text;
  v_com_ddi  text;
begin
  -- apenasDigitos: corta no primeiro '@' (sufixo Wavoip) e mantém só dígitos.
  v_digitos := regexp_replace(split_part(coalesce(p_raw, ''), '@', 1), '\D', '', 'g');

  -- semNonoDigito: unifica 12↔13 e 10↔11 dígitos ANTES do E.164.
  if length(v_digitos) = 13 and left(v_digitos, 2) = '55' and substr(v_digitos, 5, 1) = '9' then
    v_digitos := left(v_digitos, 4) || substr(v_digitos, 6);
  elsif length(v_digitos) = 11 and substr(v_digitos, 3, 1) = '9' then
    v_digitos := left(v_digitos, 2) || substr(v_digitos, 4);
  end if;

  -- normalizarTelefoneE164: BR local (10/11 díg) ganha prefixo 55; fora da
  -- faixa 12-15 dígitos não é E.164 plausível -> null (nunca lança).
  if v_digitos = '' then
    return null;
  end if;
  if length(v_digitos) in (10, 11) then
    v_com_ddi := '55' || v_digitos;
  else
    v_com_ddi := v_digitos;
  end if;
  if length(v_com_ddi) < 12 or length(v_com_ddi) > 15 then
    return null;
  end if;
  return '+' || v_com_ddi;
end;
$$;

create or replace function variantes_telefone(p_raw text)
returns text[]
language plpgsql
immutable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_digitos   text;
  v_com_pais  text;
  v_result    text[];
begin
  v_digitos := regexp_replace(split_part(coalesce(p_raw, ''), '@', 1), '\D', '', 'g');
  if v_digitos = '' then
    return array[]::text[];
  end if;

  if length(v_digitos) >= 12 then
    v_com_pais := v_digitos;
  else
    v_com_pais := '55' || v_digitos;
  end if;

  v_result := array['+' || v_com_pais];
  if length(v_com_pais) = 12 then
    v_result := array_append(v_result, '+' || left(v_com_pais, 4) || '9' || substr(v_com_pais, 5));
  end if;
  if length(v_com_pais) = 13 and substr(v_com_pais, 5, 1) = '9' then
    v_result := array_append(v_result, '+' || left(v_com_pais, 4) || substr(v_com_pais, 6));
  end if;

  -- dedup (equivalente ao `new Set(...)` do TS) sem exigir ordem estável.
  select array_agg(distinct x) into v_result from unnest(v_result) as x;
  return v_result;
end;
$$;

-- Self-check golden (T-20-01-Dedup) — números SINTÉTICOS, nunca reais
-- (LGPD/T-20-01-I). Cobre: 13 dígitos com 9º dígito e prefixo 55; 12 dígitos
-- sem 9º dígito; 11 dígitos locais (sem 55) com 9º dígito; formatação
-- (+55, parênteses, hífen); e um segundo número (DDD diferente) pra não
-- validar só um caso acidental. Os quatro primeiros DEVEM colapsar no MESMO
-- canônico (prova de unificação 10/11/12/13 dígitos, mesma exigida em
-- telefone-canonico.ts pelo comentário de canonizarTelefone). Se a lógica
-- SQL divergir de telefone-canonico.ts, esta migração FALHA a aplicação.
do $$
begin
  assert canonizar_telefone('5581987654321') = '+558187654321',
    'canonizar_telefone: golden 13-dig/com-9/com-55 divergiu';
  assert canonizar_telefone('558187654321') = '+558187654321',
    'canonizar_telefone: golden 12-dig/sem-9/com-55 divergiu';
  assert canonizar_telefone('81987654321') = '+558187654321',
    'canonizar_telefone: golden 11-dig-local/com-9/sem-55 divergiu';
  assert canonizar_telefone('+55 (81) 98765-4321') = '+558187654321',
    'canonizar_telefone: golden com-formatacao divergiu';
  assert canonizar_telefone('11912345678') = '+551112345678',
    'canonizar_telefone: golden segundo-numero (DDD 11) divergiu';
  assert canonizar_telefone(null) is null,
    'canonizar_telefone: golden null deveria devolver null';
  assert canonizar_telefone('') is null,
    'canonizar_telefone: golden vazio deveria devolver null';

  assert (select array(select unnest(variantes_telefone('558187654321')) order by 1))
       = (select array(select unnest(array['+558187654321', '+5581987654321']) order by 1)),
    'variantes_telefone: golden 12-dig divergiu (esperava par ±9o digito)';
  assert variantes_telefone(null) = array[]::text[],
    'variantes_telefone: golden null deveria devolver array vazio';
end $$;

-- Exposição via PostgREST (T-20-01-E): revoga de `public`, concede só a
-- `service_role` — mesma disciplina de sql/escala/16_rpc_criar_ligacao_avulsa.sql.
revoke all on function canonizar_telefone(text) from public;
grant execute on function canonizar_telefone(text) to service_role;
revoke all on function variantes_telefone(text) from public;
grant execute on function variantes_telefone(text) to service_role;
revoke all on function resolver_lead_id(text) from public;
grant execute on function resolver_lead_id(text) to service_role;
revoke all on function resolver_lead_id_hml(text) from public;
grant execute on function resolver_lead_id_hml(text) to service_role;

-- Reafirma grant/reload (mesma disciplina das migrações 02/06/07/08 acima).
grant all privileges on table discador_leads_espelho to service_role;
grant all privileges on table hml_discador_leads_espelho to service_role;
grant all privileges on table ligacoes to service_role;
grant all privileges on table hml_ligacoes to service_role;
grant all privileges on table audios_envios to service_role;
grant all privileges on table hml_audios_envios to service_role;
notify pgrst, 'reload schema';
