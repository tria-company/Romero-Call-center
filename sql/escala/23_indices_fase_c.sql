-- escala/23_indices_fase_c.sql — Índices de leitura da Fase C (Phase 20).
--
-- NUMERAÇÃO: renumerado de `21_indices_fase_c.sql` (previsto no plano-fonte
-- 20-01-PLAN.md) para `23` — mesma colisão de gaveta documentada no topo de
-- `22_fundacao_fase_c.sql` (20/21 já consumidos pelas quick tasks
-- 260822-tdj/ubk antes deste plano rodar).
--
-- O QUE JÁ SERVE (não duplicar):
--   • Anti-join "nunca-ligados" (LEITURA-04, `SELECT l.* FROM leads l WHERE
--     NOT EXISTS (SELECT 1 FROM ligacoes g WHERE g.lead_id=l.id)`, design §4)
--     — coberto por `ix_ligacoes_lead (lead_id, inicio desc)`
--     (sql/escala/06_ligacoes.sql): `lead_id` é a coluna líder, então o
--     planner usa o índice pro NOT EXISTS sem scan completo.
--   • INSERT do lote por SQL (LEITURA-06, `... FROM leads l WHERE l.elegivel
--     AND NOT EXISTS (SELECT 1 FROM ligacoes g WHERE g.lead_id=l.id AND
--     g.status='aberta') ORDER BY l.retorno_necessario DESC, l.score DESC,
--     l.tentativas ASC`, design §5(1)) — coberto por `ix_leads_lote
--     (retorno_necessario desc, score desc, tentativas asc) WHERE elegivel =
--     true` (sql/escala/08_leads_full.sql) para a ordenação/filtro, e pelo
--     MESMO `ix_ligacoes_lead` para o NOT EXISTS por lead_id.
--   • A chave numérica `discador_leads_espelho.id` já ganhou UNIQUE
--     (`ux_leads_espelho_id`/`ux_hml_leads_espelho_id`) em
--     `22_fundacao_fase_c.sql` — não duplicar aqui.
--
-- O QUE FALTA (este arquivo cria só isto):
--   • Timeline/detalhe do lead por notas (LEITURA-04/detalhe, `notas WHERE
--     aggregate=... AND aggregate_id=... ORDER BY criado_em`) — `notas`
--     (sql/escala/11_notas.sql) não tinha índice de leitura ainda.
--
-- Idempotente (IF NOT EXISTS) — pode reaplicar sem quebrar. A APLICAÇÃO real
-- ao homolog é o plano de prova 20-08 (como no 19-01/19-02) — este arquivo
-- só ESCREVE.

create index if not exists ix_notas_aggregate on notas (aggregate, aggregate_id, criado_em);
create index if not exists ix_hml_notas_aggregate on hml_notas (aggregate, aggregate_id, criado_em);

grant all privileges on table notas to service_role;
grant all privileges on table hml_notas to service_role;
notify pgrst, 'reload schema';
