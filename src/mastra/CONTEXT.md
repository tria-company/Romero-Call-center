# src/mastra/ — workspace do agente

Aqui vive o codigo do agente vendedor (Sofia) e toda a infra de WhatsApp/Supabase/memoria.

## Estrutura

| Arquivo | Para que serve |
|---|---|
| `index.ts` | Bootstrap do Mastra: registra o agente, configura logger, observability, webhook Evolution e endpoint de desbloqueio. |
| `agents/vendedor.ts` | Agente unico — persona, instrucoes, blacklist, tools. |
| `tools/salvar-sessao.ts` | Persiste nome/email/interesse do lead. |
| `tools/registrar-objecao.ts` | Loga objecao do lead em `auton_sdr_objecoes`. |
| `tools/enviar-checkout.ts` | Envia o link de checkout com UTM e marca `link_enviado=true` na conversa. |
| `tools/handoff-humano.ts` | Pausa a IA — humano assume. |
| `evolution.ts` | Cliente Evolution API: enviar texto, simular digitacao, transcrever audio (Whisper), detectar mensagem do bot. |
| `supabase.ts` | REST client puro (fetch) para customers/conversas/mensagens/objecoes. |
| `memoria.ts` | Instancia de `Memory` (pgStore + PgVector + embedder OpenAI). Working memory por telefone. |
| `sessao.ts` | Cache em memoria + Supabase: `getSessao`, `criarSessao`, `trocarAgente`, `atualizarSessao`. |
| `buffer.ts` | Debounce 10s para agrupar mensagens consecutivas do lead. |
| `bloqueio.ts` | Pausa a IA por 1 dia quando humano envia mensagem pelo WhatsApp. |
| `processors.ts` | Mastra processors: anti prompt-injection (input), PII (input), system prompt scrubber (output). |
| `config.ts` | Variaveis: chaves Evolution, OpenAI, URLs de checkout, nome da campanha. |

## Padroes

- Todas as tools usam `createTool` do `@mastra/core/tools` com `inputSchema`/`outputSchema` em zod.
- Tools que persistem dado **leem** sessao via `getSessao(telefone)` antes de gravar.
- Mensagens enviadas ao lead **sempre** vao por `enviarMensagem(telefone, texto)` do `evolution.ts` — nunca chame Evolution direto.
- Logs com prefixo de modulo: `[sessao]`, `[bloqueio]`, `[handoff-humano]`, `[enviar-checkout]`, `[objecao]`, `[WhatsApp]`.
- Texto do agente em portugues — sem acento nas strings de codigo (compatibilidade com terminais Windows). Os docs em `.md` podem ter acento normalmente.

## Quando criar nova tool

1. Crie em `tools/<nome>.ts` (kebab-case).
2. Importe e adicione ao bloco `tools: { ... }` em `agents/vendedor.ts`.
3. Documente quando chamar/argumentos no system prompt do agente (secao `<Ferramentas>`).
4. Atualize `docs/03_arquitetura.md`.

## Quando NAO criar uma tool

- Para "perguntar coisas para o lead" → e papel do agente, nao de tool.
- Para chamada externa one-off de teste → use `npx tsx scripts/...` fora do agente.

## Build / smoke test

```shell
npm run build    # tem que passar sem erro de TS
npm run dev      # Mastra Studio: localhost:4111 — testa o agente sem WhatsApp
```
