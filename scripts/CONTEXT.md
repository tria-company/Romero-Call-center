# CONTEXT — scripts/ (smokes + utilitários operacionais)

Scripts Node standalone (`.mjs`, sem transpile). Duas famílias, distinguidas pelo sufixo:

## `*.smoke.mjs` — testes determinísticos

Verificação rápida de um comportamento, feita pra rodar sem surpresa. Rodar:

```shell
node scripts/estado-webhook.smoke.mjs
```

Cada smoke imprime asserções e sai !=0 se algo falha. Cobrem, entre outros: `estado-webhook`
(camada Redis-ou-memória), `analise-*` (payload/script/status), `dossie`, `fila`, `gerar-lote`,
`lote-selecao`, `supabase*`, `deepgram-411-fallback`, `contexto`, `rotular-papeis`,
`llm-endpoint-azure`, `smoke-fundacao`.

## Sem sufixo `smoke` — utilitários operacionais

Rodados à mão pra operar/descobrir, **não** são teste. Ex.: `gerar-lote.mjs` (gera o lote do
dia), `ingerir-supabase.mjs`, `montar-dossies.mjs`, `descobrir-status-ligacoes.mjs`,
`descobrir-supabase-ghl.mjs`, `lote-selecao.mjs`. Podem bater em serviços reais (ClickUp/
Supabase/GHL) — usar com env configurado e consciência de LGPD (sem dumpar PII em log).

## Bom output

Smoke: determinístico, sem depender de rede quando dá, mensagem clara de PASS/FAIL.
Utilitário: idempotente quando possível, nunca imprime telefone/CPF em claro.
