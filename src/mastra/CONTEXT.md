# src/mastra/ — workspace do agente

Aqui vive o codigo do SDR AUTON: qualifica alunos da base USI e agenda calls
comerciais com um closer humano, sobre a infra Mastra do WhatsApp/Supabase/
memoria ja em producao.

## Estrutura

| Arquivo | Para que serve |
|---|---|
| `index.ts` | Bootstrap do Mastra: registra os agentes (qualificador/camila), configura logger, observability, webhooks (formulario/gravacao/evolution) e endpoint de desbloqueio. |
| `agents/qualificador.ts` | Agente batch — processa o form 14q, grava BANT/ancora/spin_stage e move o card no pipeline. |
| `agents/camila.ts` | Agente conversacional — conduz o SPIN, saida em JSON estrito. |
| `tools/escalate-to-human.ts` | Pausa a IA e escala pro humano (bandeiras vermelhas do playbook AUTON). |
| `ghl.ts` | Cliente GoHighLevel (canal WhatsApp via API oficial): enviar texto, transcrever audio, extrair payload do webhook. |
| `supabase.ts` | REST client puro (fetch) para customers/conversas/mensagens/objecoes/lembretes/resgates. |
| `memoria.ts` | Instancia de `Memory` (pgStore + PgVector + embedder Azure). Working memory por telefone. |
| `sessao.ts` | Cache em memoria + Supabase: `getSessao`, `criarSessao`, `trocarAgente`, `atualizarSessao`. 3 estados logicos vivos: `qualificador` (batch)/`camila` (SPIN)/`humano` (pausa da IA). |
| `buffer.ts` | Debounce 10s para agrupar mensagens consecutivas do lead. |
| `bloqueio.ts` | Pausa a IA por 1 dia quando humano envia mensagem pelo WhatsApp. |
| `processors.ts` | Mastra processors: anti prompt-injection (input), PII (input), system prompt scrubber (output). |
| `config.ts` | Variaveis: chaves GHL/Azure, IDs de pipeline/calendario, tokens de webhook fail-closed. |

## Padroes

- Todas as tools usam `createTool` do `@mastra/core/tools` com `inputSchema`/`outputSchema` em zod.
- Tools que persistem dado **leem** sessao via `getSessao(telefone)` antes de gravar.
- Mensagens enviadas ao lead **sempre** vao por `enviarMensagem(telefone, texto)` do `ghl.ts` — nunca chame a API do GHL direto.
- Logs com prefixo de modulo: `[sessao]`, `[bloqueio]`, `[escalate-to-human]`, `[WhatsApp]`.
- Texto do agente em portugues — sem acento nas strings de codigo (compatibilidade com terminais Windows). Os docs em `.md` podem ter acento normalmente.

## Quando criar nova tool

1. Crie em `tools/<nome>.ts` (kebab-case).
2. Importe e adicione ao bloco `tools: { ... }` do agente que a usa (`agents/qualificador.ts` ou `agents/camila.ts` — a Camila so declara em `tools_a_executar[]`, o dispatcher em `index.ts` e o executor real).
3. Documente quando chamar/argumentos no system prompt do agente.

## Quando NAO criar uma tool

- Para "perguntar coisas para o lead" → e papel do agente, nao de tool.
- Para chamada externa one-off de teste → use `npx tsx scripts/...` fora do agente.

## Build / smoke test

```shell
npm run build    # tem que passar sem erro de TS
npm run dev      # Mastra Studio: localhost:4111 — testa o agente sem WhatsApp
```
