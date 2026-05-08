# Projeto Roberth

Agente conversacional de WhatsApp que vende um curso/infoproduto para lista quente durante um lancamento. Um unico agente (Sofia) qualifica o lead, trata objecao curta e entrega o link de checkout. Stack: **Mastra + Evolution API + Supabase + OpenAI**.

## Como comecar

```shell
npm install
cp .env.example .env   # preencha as chaves
npm run dev            # Mastra Studio em http://localhost:4111
```

## Estrutura (resumo)

| Pasta | Para que serve |
|---|---|
| [docs/](docs/) | PRD dinamico em fases — briefing, PRD, UX-spec, arquitetura, checklist, historias, QA. |
| [src/mastra/](src/mastra/) | Codigo do agente. Veja [src/mastra/CONTEXT.md](src/mastra/CONTEXT.md). |
| [src/mastra/agents/](src/mastra/agents/) | `vendedor.ts` — agente unico. |
| [src/mastra/tools/](src/mastra/tools/) | `enviar-checkout`, `registrar-objecao`, `salvar-sessao`, `handoff-humano`. |

A organizacao segue o padrao **CLAUDE.md (mapa) + CONTEXT.md (workspace)**. Comece pelo [CLAUDE.md](CLAUDE.md) para entender o roteamento.

## Como o PRD funciona

PRD aqui e **dinamico**: cada fase (briefing → PRD → UX → arquitetura → historias → QA) vive em um arquivo de [docs/](docs/) com status `[draft|approved]`. Mudou a arquitetura, volta pro PRD. A metodologia esta documentada em [docs/CONTEXT.md](docs/CONTEXT.md).

## Endpoints

- `POST /api/webhook/evolution` — webhook do WhatsApp (Evolution API).
- `POST /api/desbloquear` — reativa a IA depois que humano termina o atendimento. Body: `{ "telefone": "5511..." }`.

## Migrations

Antes de subir, rode [docs/sql/01_init.sql](docs/sql/01_init.sql) no Supabase para criar as tabelas (`customers_roberth`, `conversations_roberth`, `messages_roberth`, `objecoes_roberth`).
