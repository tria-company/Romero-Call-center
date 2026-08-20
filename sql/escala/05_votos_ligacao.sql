-- 05_votos_ligacao — quem colheu cada declaração de voto, e quando.
--
-- PROBLEMA QUE RESOLVE: o voto é gravado na task do LEAD (Lista 01, campos
-- CONFIRMOU_VOTO_*), que não tem operador nem data. No instante em que o closer marca a
-- intenção ao fim da ligação, a rota /api/discador/voto SABE quem marcou (sessão) e de
-- qual ligação veio (taskId) — e descartava as duas coisas depois de autorizar. Sem elas
-- o ranking publicava "0 votos" para todo mundo, e o gráfico de votos acumulados ficava
-- em branco por falta de data.
--
-- Esta tabela é o REGISTRO DO EVENTO: "esta ligação, deste operador, produziu esta
-- declaração, neste instante". A Lista 01 do ClickUp continua sendo a FONTE DA VERDADE do
-- voto ATUAL do lead (ele pode mudar de ideia; lá vale o último). São perguntas
-- diferentes: "em quem o lead vota hoje?" (ClickUp) e "quem colheu essa informação, e
-- quando?" (aqui).
--
-- NADA MUDA NO CLICKUP por causa desta tabela — nenhum campo novo, nenhuma automação.
--
-- escolha: 'sim' | 'nao' | 'naoDeclarou' — as três opções que a rota aceita. Guardamos as
--     TRÊS de propósito: 'sim' mede voto conquistado, o conjunto mede esforço de coleta, e
--     quem decide qual dos dois vira "Votos" na tela é a leitura, não a gravação.
--
-- origem: 'ligacao' (closer marcou ao fim da chamada) ou 'backfill' (linha reconstruída
--     pelo cruzamento histórico, scripts/backfill-votos-ligacao.mjs). Fica explícito na
--     tabela o que é medição e o que é atribuição por regra — sem isso os dois viram o
--     mesmo número e ninguém consegue mais separar.
--
-- UNIQUE (ligacao_task_id, candidato): idempotente. O closer corrigir a marcação na mesma
--     ligação ATUALIZA a linha em vez de criar uma segunda — senão um lead que teve o voto
--     corrigido contaria duas vezes no ranking.

create table if not exists votos_ligacao (
  ligacao_task_id text not null,
  lead_task_id text not null default '',
  operador text not null,
  candidato text not null,
  escolha text not null,
  origem text not null default 'ligacao',
  registrado_em timestamptz not null default now(),
  primary key (ligacao_task_id, candidato)
);

-- O painel agrupa por operador; o gráfico acumulado varre por data.
create index if not exists idx_votos_ligacao_operador on votos_ligacao (operador);
create index if not exists idx_votos_ligacao_registrado_em on votos_ligacao (registrado_em);
-- Contar PESSOAS distintas, não declarações: um lead trabalhado em duas ligações do mesmo
-- operador é um apoiador só.
create index if not exists idx_votos_ligacao_lead on votos_ligacao (lead_task_id);
