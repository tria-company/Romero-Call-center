-- escala/19_rpc_painel_agregados.sql — RPCs READ-ONLY de agregado para o painel
-- (Campanha + painel-números), Phase 19 (Fase B), plano 19-04, LEITURA-02.
--
-- Design: .planning/arquitetura/inversao-supabase-fonte-da-verdade.md §4. Hoje
-- resumoCampanhaAoVivo/resumoLigacoesAoVivo (src/mastra/painel-dados.ts) pagam o
-- número varrendo a Lista 02 LIGACOES inteira no ClickUp (~3,8s, teto de páginas) —
-- exatamente o caminho que caiu no incidente de listagem de 2026-08-20. Estas duas
-- funções computam os MESMOS agregados em UM único SELECT sobre `ligacoes` (+
-- `votos_ligacao` para o ranking por operador), sem paginação nenhuma: um
-- incidente de listagem do ClickUp deixa de afetar esses números (SC1).
--
-- SÓ LEITURA — nenhum INSERT/UPDATE/DELETE em lugar nenhum deste arquivo. Por
-- isso `language sql` (não plpgsql: não há passo a passo, é um único SELECT com
-- CTEs) + `security invoker` (menor superfície — service_role já tem grant nas
-- tabelas via 06_ligacoes.sql/05_votos_ligacao.sql) + `search_path` fixado
-- (anti-hijack, mesmo molde de sql/escala/12_rpc_registrar_desfecho.sql).
--
-- Shape do jsonb devolvido NÃO é o shape final da UI (isso é
-- `resumoLigacoesSupabase`/`resumoCampanhaSupabase` em src/mastra/painel-dados.ts,
-- que montam o objeto final com as MESMAS chaves de resumoLigacoesAoVivo/
-- resumoCampanhaAoVivo) — é um agregado intermediário pensado para reusar, do
-- lado TS, a lógica pura que já existe e não devia ser duplicada em SQL:
--   • `agruparMotivos` (sinônimos de motivo_falha, PT-BR texto livre) — a RPC só
--     devolve `motivosBrutos` (array de strings cruas); quem agrupa é o TS.
--   • `nomeDeOperador` (grafia de e-mail → nome legível) — a RPC devolve a
--     grafia mais frequente (`mode()`) de cada login; quem formata é o TS.
--   • votos ATRIBUÍDOS por operador (não confundir com contarVotosEspelho, que
--     é outro card — romero/andressa/apoiadores/cidade, Lista 01) já são lidos
--     aqui de `votos_ligacao` (Supabase, dedup por lead), porque é uma tabela
--     local — sem round-trip extra nem reimplementação.
--
-- DÉBITO EXPLÍCITO (aderência ao script): `TelefonistaCampanha.ader`/`aderAmostra`
-- (nota 0–10 do Agente de Análise) vêm hoje de `analise_ia jsonb`, mas o espelho
-- (src/mastra/espelho.ts::paraAnaliseIa) grava só `{ texto: <bruto> }` — não uma
-- nota estruturada extraível por SQL. Sem coluna dedicada, estas duas RPCs
-- devolvem só os brutos necessários para o TS montar `ader:0, aderAmostra:0`
-- (mesma semântica de "nunca avaliada" que a UI já trata) até uma fase futura
-- estruturar a nota na escrita do espelho/análise. Documentado no
-- 19-04-SUMMARY.md — não é uma lacuna silenciosa.
--
-- `lote_data` (a coluna pensada para a série da Campanha) ainda é sempre NULL
-- nesta fase (o espelho não a popula — sql/escala/06_ligacoes.sql / espelho.ts
-- deixam "novo — hoje implícito"): agrupar só por `lote_data` produziria um
-- único balde com dia=null. A série usa `coalesce(inicio::date BRT, lote_data)`
-- — funciona hoje (via `inicio`) e já fica pronta para quando `lote_data` for
-- populado (passa a valer para ligações sem `inicio`, ex. avulsas futuras).
--
-- LGPD: zero PII no agregado — nenhuma coluna de telefone/CPF/nome de lead
-- entra em nenhum SELECT deste arquivo; só contagens, medianas e rankings por
-- LOGIN de operador (infraestrutura da campanha, não dado do lead).
--
-- Idempotente (CREATE OR REPLACE FUNCTION) — pode reaplicar sem quebrar.

-- ============================================================================
-- painel_ligacoes_agregado — produção (ligacoes)
-- Espelha resumoLigacoesAoVivo (painel-dados.ts:370): total/hoje/atendidas
-- hoje/não atendidas hoje/sem desfecho hoje/atendidas total/com gravação/com
-- transcrição/com análise IA/última ligação — tudo num scan só.
-- ============================================================================
create or replace function painel_ligacoes_agregado()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with base as (
    select
      *,
      -- Mesma definição de "discada" que ligacaoDiscada (painel-dados.ts:337):
      -- a task foi de fato chamada (INICIO/ATENDEU/DURACAO preenchidos), não só
      -- atribuída pelo lote do dia.
      (inicio is not null or atendeu is not null or duracao_seg is not null) as discada,
      coalesce((inicio at time zone 'America/Sao_Paulo')::date, lote_data) as dia_ligacao
    from ligacoes
  )
  select jsonb_build_object(
    'total', (select count(*) from base where discada),
    'hoje', (select count(*) from base
              where discada and dia_ligacao = (now() at time zone 'America/Sao_Paulo')::date),
    'atendidasHoje', (select count(*) from base
                        where discada and atendeu and dia_ligacao = (now() at time zone 'America/Sao_Paulo')::date),
    'naoAtendidasHoje', (select count(*) from base
                          where discada and atendeu is not distinct from false
                            and dia_ligacao = (now() at time zone 'America/Sao_Paulo')::date),
    'semDesfechoHoje', (select count(*) from base
                          where discada and atendeu is null
                            and dia_ligacao = (now() at time zone 'America/Sao_Paulo')::date),
    'atendidasTotal', (select count(*) from base where discada and atendeu),
    'comGravacao', (select count(*) from base where url_gravacao is not null),
    'comTranscricao', (select count(*) from base where transcricao is not null),
    'comAnaliseIa', (select count(*) from base where analise_ia is not null),
    'ultimaEm', (select max(coalesce(inicio, criado_em)) from base where discada),
    -- Sem paginação nenhuma neste SELECT (o teto PAINEL_MAX_PAGINAS deixa de
    -- existir) — o número nunca é um piso; `parcial` fica travado em false.
    'parcial', false
  );
$$;

-- ============================================================================
-- painel_campanha_agregado — produção (ligacoes + votos_ligacao)
-- Espelha os blocos de resumoCampanhaAoVivo (painel-dados.ts:702) que dependem
-- só de agregado SQL: série diária, ranking bruto por operador (+ votos
-- atribuídos via votos_ligacao), motivos brutos de não-contato, totais,
-- sem-operador, desfecho-de-app e tempo médio. `agruparMotivos`/`nomeDeOperador`
-- ficam no TS (ver nota de topo do arquivo).
-- ============================================================================
create or replace function painel_campanha_agregado()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with base as (
    select
      *,
      (inicio is not null or atendeu is not null or duracao_seg is not null) as discada,
      coalesce((inicio at time zone 'America/Sao_Paulo')::date, lote_data) as dia_ligacao,
      nullif(lower(trim(coalesce(operador, ''))), '') as op_chave
    from ligacoes
  ),
  op_stats as (
    -- Um grupo por login (chave em minúsculas — mesma correção de 19/08 que
    -- unia "kalinebrito288" e "Kalinebrito288"). `mode()` devolve a grafia MAIS
    -- FREQUENTE do próprio grupo (equivalente ao `variantes` de painel-dados.ts),
    -- para o TS aplicar `nomeDeOperador` na grafia real usada pela operação.
    select
      op_chave,
      mode() within group (order by operador) as grafia,
      count(*) filter (where discada) as lig,
      count(*) filter (where not discada) as fila,
      count(*) filter (where discada and atendeu) as cont,
      -- MEDIANA da duração (segundos) — já é coluna numérica em `ligacoes`
      -- (duracao_seg int); ao contrário do ClickUp (texto "5min 32s"), não há
      -- parsing nenhum a refazer aqui.
      percentile_cont(0.5) within group (order by duracao_seg) as tsec,
      min(inicio) filter (where discada) as ini,
      max(inicio) filter (where discada) as fim
    from base
    group by op_chave
  ),
  ranking as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'operador', grafia,
          'opChave', op_chave,
          'lig', lig,
          'fila', fila,
          'cont', cont,
          'tsec', coalesce(round(tsec), 0),
          'ini', ini,
          'fim', fim
        ) order by lig desc
      ) filter (where op_chave is not null),
      '[]'::jsonb
    ) as arr
    from op_stats
  ),
  sem_operador as (
    select
      coalesce((select lig from op_stats where op_chave is null), 0) as lig,
      coalesce((select cont from op_stats where op_chave is null), 0) as cont
  ),
  votos_op as (
    -- Mesma regra de dedup de contarVotosPorOperador (supabase.ts:1237): a
    -- declaração 'sim' MAIS RECENTE de cada lead (`registrado_em desc`) — um
    -- lead trabalhado em duas ligações do mesmo operador conta uma vez só.
    select distinct on (lead_task_id)
      lead_task_id,
      nullif(lower(trim(operador)), '') as op_chave
    from votos_ligacao
    where escolha = 'sim'
    order by lead_task_id, registrado_em desc
  ),
  votos_por_op as (
    select coalesce(jsonb_object_agg(op_chave, n), '{}'::jsonb) as obj
    from (
      select op_chave, count(*) as n
      from votos_op
      where op_chave is not null
      group by op_chave
    ) v
  ),
  serie as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object('dia', dia_ligacao, 'ligacoes', ligacoes, 'contatos', contatos)
        order by dia_ligacao
      ),
      '[]'::jsonb
    ) as arr
    from (
      select
        dia_ligacao,
        count(*) filter (where discada) as ligacoes,
        count(*) filter (where discada and atendeu) as contatos
      from base
      where discada and dia_ligacao is not null
      group by dia_ligacao
    ) s
  ),
  motivos_brutos as (
    -- Sobre as NÃO-atendidas (atendeu is distinct from true) — sem filtrar por
    -- discada, mesmo universo de resumoCampanhaAoVivo:836 (`todas.map(...)`,
    -- que `agruparMotivos` já descarta string vazia). O agrupamento por
    -- sinônimo (SINONIMOS_MOTIVO) fica no TS — reusar `agruparMotivos`.
    select coalesce(jsonb_agg(motivo_falha), '[]'::jsonb) as arr
    from base
    where motivo_falha is not null and trim(motivo_falha) <> '' and atendeu is distinct from true
  ),
  totals as (
    select
      count(*) filter (where discada) as total_ligacoes,
      count(*) filter (where not discada) as total_na_fila,
      count(*) filter (where discada and atendeu) as total_contatos,
      count(*) filter (where discada and atendeu is null) as sem_desfecho,
      count(*) filter (where op_chave is not null) as com_operador,
      count(*) filter (where op_chave is not null and atendeu) as atendidas_com_operador,
      count(*) filter (where op_chave is not null and atendeu is null) as sem_desfecho_com_operador,
      min(duracao_seg) as t_min,
      max(duracao_seg) as t_max,
      percentile_cont(0.5) within group (order by duracao_seg) as t_mediana,
      count(duracao_seg) as t_amostra
    from base
  )
  select jsonb_build_object(
    'serie', (select arr from serie),
    'ranking', (select arr from ranking),
    'motivosBrutos', (select arr from motivos_brutos),
    'votosPorOperador', (select obj from votos_por_op),
    'totalLigacoes', (select total_ligacoes from totals),
    'totalNaFila', (select total_na_fila from totals),
    'totalContatos', (select total_contatos from totals),
    'semDesfecho', (select sem_desfecho from totals),
    'semOperador', jsonb_build_object(
      'lig', (select lig from sem_operador),
      'cont', (select cont from sem_operador)
    ),
    'desfechoDeApp', jsonb_build_object(
      'comOperador', (select com_operador from totals),
      'atendidas', (select atendidas_com_operador from totals),
      'semDesfecho', (select sem_desfecho_com_operador from totals)
    ),
    'tempoMedio', jsonb_build_object(
      'min', coalesce((select t_min from totals), 0),
      'mediana', coalesce(round((select t_mediana from totals)), 0),
      'max', coalesce((select t_max from totals), 0),
      'amostra', (select t_amostra from totals)
    )
  );
$$;

-- ============================================================================
-- hml_painel_ligacoes_agregado — gêmeo de homolog (hml_ligacoes)
-- Corpo IDÊNTICO ao de painel_ligacoes_agregado — só muda a tabela. Ver nota
-- (c) de sql/escala/12_rpc_registrar_desfecho.sql (sincronia manual, débito
-- já documentado; generalização fica para quando o Caminho B ganhar um
-- gerador de migração).
-- ============================================================================
create or replace function hml_painel_ligacoes_agregado()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with base as (
    select
      *,
      (inicio is not null or atendeu is not null or duracao_seg is not null) as discada,
      coalesce((inicio at time zone 'America/Sao_Paulo')::date, lote_data) as dia_ligacao
    from hml_ligacoes
  )
  select jsonb_build_object(
    'total', (select count(*) from base where discada),
    'hoje', (select count(*) from base
              where discada and dia_ligacao = (now() at time zone 'America/Sao_Paulo')::date),
    'atendidasHoje', (select count(*) from base
                        where discada and atendeu and dia_ligacao = (now() at time zone 'America/Sao_Paulo')::date),
    'naoAtendidasHoje', (select count(*) from base
                          where discada and atendeu is not distinct from false
                            and dia_ligacao = (now() at time zone 'America/Sao_Paulo')::date),
    'semDesfechoHoje', (select count(*) from base
                          where discada and atendeu is null
                            and dia_ligacao = (now() at time zone 'America/Sao_Paulo')::date),
    'atendidasTotal', (select count(*) from base where discada and atendeu),
    'comGravacao', (select count(*) from base where url_gravacao is not null),
    'comTranscricao', (select count(*) from base where transcricao is not null),
    'comAnaliseIa', (select count(*) from base where analise_ia is not null),
    'ultimaEm', (select max(coalesce(inicio, criado_em)) from base where discada),
    'parcial', false
  );
$$;

-- ============================================================================
-- hml_painel_campanha_agregado — gêmeo de homolog (hml_ligacoes / hml_votos_ligacao)
-- Corpo IDÊNTICO ao de painel_campanha_agregado — só mudam as tabelas.
-- ============================================================================
create or replace function hml_painel_campanha_agregado()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with base as (
    select
      *,
      (inicio is not null or atendeu is not null or duracao_seg is not null) as discada,
      coalesce((inicio at time zone 'America/Sao_Paulo')::date, lote_data) as dia_ligacao,
      nullif(lower(trim(coalesce(operador, ''))), '') as op_chave
    from hml_ligacoes
  ),
  op_stats as (
    select
      op_chave,
      mode() within group (order by operador) as grafia,
      count(*) filter (where discada) as lig,
      count(*) filter (where not discada) as fila,
      count(*) filter (where discada and atendeu) as cont,
      percentile_cont(0.5) within group (order by duracao_seg) as tsec,
      min(inicio) filter (where discada) as ini,
      max(inicio) filter (where discada) as fim
    from base
    group by op_chave
  ),
  ranking as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'operador', grafia,
          'opChave', op_chave,
          'lig', lig,
          'fila', fila,
          'cont', cont,
          'tsec', coalesce(round(tsec), 0),
          'ini', ini,
          'fim', fim
        ) order by lig desc
      ) filter (where op_chave is not null),
      '[]'::jsonb
    ) as arr
    from op_stats
  ),
  sem_operador as (
    select
      coalesce((select lig from op_stats where op_chave is null), 0) as lig,
      coalesce((select cont from op_stats where op_chave is null), 0) as cont
  ),
  votos_op as (
    select distinct on (lead_task_id)
      lead_task_id,
      nullif(lower(trim(operador)), '') as op_chave
    from hml_votos_ligacao
    where escolha = 'sim'
    order by lead_task_id, registrado_em desc
  ),
  votos_por_op as (
    select coalesce(jsonb_object_agg(op_chave, n), '{}'::jsonb) as obj
    from (
      select op_chave, count(*) as n
      from votos_op
      where op_chave is not null
      group by op_chave
    ) v
  ),
  serie as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object('dia', dia_ligacao, 'ligacoes', ligacoes, 'contatos', contatos)
        order by dia_ligacao
      ),
      '[]'::jsonb
    ) as arr
    from (
      select
        dia_ligacao,
        count(*) filter (where discada) as ligacoes,
        count(*) filter (where discada and atendeu) as contatos
      from base
      where discada and dia_ligacao is not null
      group by dia_ligacao
    ) s
  ),
  motivos_brutos as (
    select coalesce(jsonb_agg(motivo_falha), '[]'::jsonb) as arr
    from base
    where motivo_falha is not null and trim(motivo_falha) <> '' and atendeu is distinct from true
  ),
  totals as (
    select
      count(*) filter (where discada) as total_ligacoes,
      count(*) filter (where not discada) as total_na_fila,
      count(*) filter (where discada and atendeu) as total_contatos,
      count(*) filter (where discada and atendeu is null) as sem_desfecho,
      count(*) filter (where op_chave is not null) as com_operador,
      count(*) filter (where op_chave is not null and atendeu) as atendidas_com_operador,
      count(*) filter (where op_chave is not null and atendeu is null) as sem_desfecho_com_operador,
      min(duracao_seg) as t_min,
      max(duracao_seg) as t_max,
      percentile_cont(0.5) within group (order by duracao_seg) as t_mediana,
      count(duracao_seg) as t_amostra
    from base
  )
  select jsonb_build_object(
    'serie', (select arr from serie),
    'ranking', (select arr from ranking),
    'motivosBrutos', (select arr from motivos_brutos),
    'votosPorOperador', (select obj from votos_por_op),
    'totalLigacoes', (select total_ligacoes from totals),
    'totalNaFila', (select total_na_fila from totals),
    'totalContatos', (select total_contatos from totals),
    'semDesfecho', (select sem_desfecho from totals),
    'semOperador', jsonb_build_object(
      'lig', (select lig from sem_operador),
      'cont', (select cont from sem_operador)
    ),
    'desfechoDeApp', jsonb_build_object(
      'comOperador', (select com_operador from totals),
      'atendidas', (select atendidas_com_operador from totals),
      'semDesfecho', (select sem_desfecho_com_operador from totals)
    ),
    'tempoMedio', jsonb_build_object(
      'min', coalesce((select t_min from totals), 0),
      'mediana', coalesce(round((select t_mediana from totals)), 0),
      'max', coalesce((select t_max from totals), 0),
      'amostra', (select t_amostra from totals)
    )
  );
$$;

-- ============================================================================
-- Segurança/exposição (mesmo molde de 12_rpc_registrar_desfecho.sql):
-- SECURITY INVOKER + search_path fixado (já no CREATE acima) + EXECUTE
-- revogado de public e concedido SÓ a service_role, para as 4 funções.
-- ============================================================================
revoke all on function painel_ligacoes_agregado() from public;
grant execute on function painel_ligacoes_agregado() to service_role;

revoke all on function painel_campanha_agregado() from public;
grant execute on function painel_campanha_agregado() to service_role;

revoke all on function hml_painel_ligacoes_agregado() from public;
grant execute on function hml_painel_ligacoes_agregado() to service_role;

revoke all on function hml_painel_campanha_agregado() from public;
grant execute on function hml_painel_campanha_agregado() to service_role;

-- Função nova precisa do reload de schema-cache para ser exposta em /rpc/ —
-- o kick do authenticator (o NOTIFY sozinho não propaga de forma confiável
-- neste deploy self-hosted) vem do aplicar-sql.mjs, quando esta migração for
-- aplicada (fora do escopo de 19-04 — só a migração é criada aqui).
notify pgrst, 'reload schema';
