# CONTEXT — sql/ (migrações)

DDL do Postgres/Supabase que dá suporte ao backend. Hoje concentra o milestone **v2.0
Escala** em [escala/](escala/).

## Convenção

- Numeração por pasta de milestone: `NN_nome.sql` (ex.: `escala/01_webhook_eventos.sql`).
- **Idempotente** sempre que possível (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`)
  — pode reaplicar sem quebrar.
- Uma migração = uma unidade coesa (uma tabela + seus índices, uma coluna nova, etc.).

## Arquivos

| Arquivo | O que cria |
|---|---|
| [escala/01_webhook_eventos.sql](escala/01_webhook_eventos.sql) | Tabela `webhook_eventos` (uuid pk, payload jsonb, status, índices) — durabilidade do evento cru do webhook Wavoip antes de processar (FILA-01). |
| [escala/03_mensagens_whatsapp.sql](escala/03_mensagens_whatsapp.sql) | Tabela `mensagens_whatsapp` (id text pk, lead_task_id, telefone_canonico, dois índices) — conversa WhatsApp por lead (Fase 13): read-model rápido da UI + durabilidade das mensagens do webhook Evolution. |
| [escala/05_votos_ligacao.sql](escala/05_votos_ligacao.sql) | Tabela `votos_ligacao` (pk ligacao_task_id+candidato, três índices) — atribui a declaração de voto ao operador que a colheu, com data. O ClickUp guarda o voto no LEAD, sem operador e sem data; por isso o ranking publicava "0 votos". Nada muda no ClickUp. `origem` separa o que foi medido na hora (`ligacao`) do que foi reconstruído por regra (`backfill`, via [scripts/backfill-votos-ligacao.mjs](../scripts/backfill-votos-ligacao.mjs)). |
| [escala/20_anotacoes_ligacao.sql](escala/20_anotacoes_ligacao.sql) | Tabela `anotacoes_ligacao` (sem FK p/ `ligacoes`, chaveada por `ligacao_task_id`) + `discador_leads_espelho.super_fa` — escrita dupla best-effort dos campos estruturados do retorno de ligação (classificação/demanda/observação/canal/após-whatsapp/super-fã/resultado), ao lado dos marcadores ClickUp (quick 260822-tdj). |

## Como aplicar

Preferido: `node --env-file=.env scripts/aplicar-sql.mjs sql/escala/NN_nome.sql` — aplica via
rota `/pg/query` do Kong (pg-meta, autentica com a SUPABASE_SERVICE_KEY) e **força o reload
do schema cache do PostgREST** derrubando as conexões do `authenticator` (neste deploy o
canal de NOTIFY está desabilitado — sem isso, POST/PATCH numa tabela nova responde `404 {}`
com GET funcionando, constatado 2026-08-19). Alternativas: SQL editor do Supabase ou
`psql "$DATABASE_URL" -f ...` (aí rode o kick do authenticator manualmente). O backend
degrada gracioso se a tabela não existir — mas em produção ela **deve** existir.

## Bom output

Migração idempotente · numerada na sequência · o código que a usa continua degradando
gracioso se ela ainda não foi aplicada.
