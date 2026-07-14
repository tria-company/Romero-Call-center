# docs/sql/auton_sdr/ — schema canonico do banco dedicado do SDR AUTON

Este diretorio e o schema SQL **canonico** do banco dedicado do SDR AUTON Health
(Supabase proprio, separado do banco em producao do ex-bot Closer "Roberth" — decisao
do usuario, 2026-07-13, registrada em `.planning/STATE.md`).

## Reconciliacao de naming: `auton_sdr_` (prefixo) = "`_auton`" (requisito)

O requisito de migracao (CLEAN-02) foi escrito como "migrar tabelas de sufixo
`_roberth` pra sufixo `_auton`" (ex.: `customers_roberth` -> `customers_auton`).
A implementacao real (quick task `260713-sj8`, 2026-07-13) usou **PREFIXO**
`auton_sdr_` em vez de sufixo `_auton` (ex.: `auton_sdr_customers`, nao
`customers_auton`).

**`auton_sdr_` E a forma implementada do requisito `_auton`.** O espirito do
requisito — sair do naming `_roberth` (era do bot Closer compartilhado) para um
naming proprio do SDR AUTON, com o codigo lendo/escrevendo exclusivamente nas
tabelas novas — esta satisfeito. Nao existe, e nao havera, uma segunda rodada
de renomeacao para o sufixo literal `_auton`: isso seria puro churn de naming
(sem ganho funcional) e exigiria uma nova migracao DDL contra um banco que
atualmente esta **READ-ONLY** (ver secao abaixo) — custo/risco desproporcional
para uma diferenca cosmetica de prefixo vs. sufixo.

Prova executavel dessa migracao: `scripts/smoke-tabelas-auton.mjs` falha o
build se `src/mastra/supabase.ts` referenciar qualquer tabela sem o prefixo
`auton_sdr_`, ou qualquer residuo `_roberth`/`roberth_`.

## O que existe aqui (01 -> 11, ordem de aplicacao)

| Arquivo | O que cria/altera |
|---|---|
| `01_init.sql` | Schema inicial: enums (`auton_sdr_status_conversa`, `auton_sdr_agente_tipo`, `auton_sdr_categoria_objecao`) + tabelas `auton_sdr_customers`, `auton_sdr_conversations`, `auton_sdr_messages`, `auton_sdr_objecoes` + triggers de `updated_at`. |
| `02_follow_up.sql` | Colunas de tracking de follow-up em `auton_sdr_conversations` (`last_assistant_message_at`, `last_lead_message_at`, `fup_1/3/5_sent_at`, `handoff_silencio_em`). |
| `03_errors.sql` | Tabela `auton_sdr_errors` (log de erros do agente, consumida pelo dashboard). |
| `04_prod_hardening.sql` | Indice unico parcial anti-duplicata de conversa ativa por customer + suporte a dedup/buffer de webhook sob carga. |
| `05_kiwify_conversion.sql` | **NO-OP** — Kiwify foi removido do stack do SDR AUTON (quick task `260713-t0f`); o arquivo permanece so pra nao quebrar a numeracao espelhada do runbook de deploy (roda `apply-migration.mjs` em ordem 01->10). Executa apenas `SELECT 1;`, sem DDL. |
| `06_sdr_agente_enum.sql` | Adiciona os valores `'qualificador'`/`'camila'` ao enum `auton_sdr_agente_tipo` (Fase 1 — troca do agente Sofia/Closer pelo Qualificador+Camila do SDR). |
| `07_call_reminders.sql` | Tabela `auton_sdr_call_reminders` (lembretes de call D-1/H-1/5min). |
| `08_no_show.sql` | Estende `auton_sdr_call_reminders` com as colunas do loop de no-show/recuperacao. |
| `09_resgates.sql` | Tabela `auton_sdr_resgates` (resgate duravel 48h de leads com sinal de desistencia). |
| `10_agente_default.sql` | **[BLOCKING]/user_setup** — troca o `DEFAULT` da coluna `agente_atual` de `'vendedor'` (residuo Closer) pra `'atendimento_humano'`. Nao remove o valor `'vendedor'` do TYPE do enum (Postgres nao suporta DROP de valor de enum sem recriar o tipo) — so alinha o default de linhas futuras ao codigo, que ja nao produz mais o agente logico `'vendedor'` (CLEAN-01). |
| `11_llm_metrics.sql` | **[BLOCKING]/user_setup** (HARD-08, Fase 5 plano 05-06) — tabela `auton_sdr_llm_metrics` (observabilidade por interacao LLM: tokens/custo estimado/latencia/versao de prompt/cache_hit, por `camila_primaria`/`secundario_fallback`/`qualificador`). Persistencia FAIL-OPEN: enquanto pendente (banco read-only), `src/mastra/observabilidade.ts` continua emitindo o log JSON estruturado `[metrica-llm]` normalmente, sem quebrar o pipeline. |

`11_llm_metrics.sql` e a migracao mais recente.

## Como aplicar

Todas as migracoes sao idempotentes (usam `IF NOT EXISTS`/`CREATE OR REPLACE`/
`ADD VALUE IF NOT EXISTS`/`SET DEFAULT`, seguros para rodar mais de uma vez).
Aplicar em ordem numerica, contra o banco **dedicado** do SDR AUTON
(`SUPABASE_DB_URL` no `.env` apontando pro projeto Supabase proprio, nao o do
ex-bot Closer "Roberth"):

```bash
node scripts/apply-migration.mjs docs/sql/auton_sdr/01_init.sql
node scripts/apply-migration.mjs docs/sql/auton_sdr/02_follow_up.sql
node scripts/apply-migration.mjs docs/sql/auton_sdr/03_errors.sql
node scripts/apply-migration.mjs docs/sql/auton_sdr/04_prod_hardening.sql
node scripts/apply-migration.mjs docs/sql/auton_sdr/05_kiwify_conversion.sql
node scripts/apply-migration.mjs docs/sql/auton_sdr/06_sdr_agente_enum.sql
node scripts/apply-migration.mjs docs/sql/auton_sdr/07_call_reminders.sql
node scripts/apply-migration.mjs docs/sql/auton_sdr/08_no_show.sql
node scripts/apply-migration.mjs docs/sql/auton_sdr/09_resgates.sql
node scripts/apply-migration.mjs docs/sql/auton_sdr/10_agente_default.sql
node scripts/apply-migration.mjs docs/sql/auton_sdr/11_llm_metrics.sql
```

`scripts/apply-migration.mjs` recebe o caminho do SQL por argumento (sem
caminho fixo hard-coded) e le `SUPABASE_DB_URL` do `.env` — falha limpo (exit 1)
se a env var nao estiver presente.

## Status atual do banco dedicado: READ-ONLY (quota 402)

O projeto Supabase dedicado do SDR AUTON (`raajvnijvdyeqgybcfxq.supabase.co`)
esta atualmente em modo **READ-ONLY** — tentativas de DDL falham com
`"cannot execute CREATE TABLE in a read-only transaction"` (excedente de
quota, HTTP 402). As migracoes `01` a `09` ja foram aplicadas com sucesso
ANTES desse bloqueio (confirmado por sondagem REST: 7 tabelas presentes,
INSERT/DELETE de teste passou). As migracoes `10_agente_default.sql` e
`11_llm_metrics.sql` (Fase 5) ficam **pendentes** ate a quota ser resolvida
— roteadas como `user_setup` (aplicacao manual pos-quota), nao bloqueiam o
funcionamento do codigo (ver cabecalho de cada arquivo). No caso da `11`, a
persistencia da tabela `auton_sdr_llm_metrics` e explicitamente FAIL-OPEN:
sem ela, `src/mastra/observabilidade.ts` so emite o log JSON estruturado
`[metrica-llm]`, sem persistir e sem quebrar o pipeline.

## O que NAO fica mais aqui

Os arquivos legado de sufixo `_roberth` (`docs/sql/01_init.sql` ate
`docs/sql/06_sdr_agente_enum.sql`, na raiz de `docs/sql/`, fora desta pasta)
foram **removidos** neste plano (04-02). Eram o schema do banco COMPARTILHADO
do ex-bot Closer "Roberth" (tabelas `customers_roberth`,
`conversations_roberth`, etc.) — nunca foram aplicados no banco dedicado do
SDR AUTON e nao sao mais referenciados por nenhum script/runbook deste
repositorio (todo caminho vivo aponta pra `docs/sql/auton_sdr/`).
