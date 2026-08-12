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

## Como aplicar

Via SQL editor do Supabase, ou `psql "$DATABASE_URL" -f sql/escala/NN_nome.sql`. O backend
degrada gracioso se a tabela não existir (o evento cru só não é persistido) — mas em produção
ela **deve** existir pra não perder ligação sob rajada.

## Bom output

Migração idempotente · numerada na sequência · o código que a usa continua degradando
gracioso se ela ainda não foi aplicada.
