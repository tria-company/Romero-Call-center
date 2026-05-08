# Projeto Roberth — mapa

Agente unico de WhatsApp (Sofia) que vende um curso/infoproduto para lista quente durante um lancamento. Stack: **Mastra + Evolution API + Supabase + OpenAI**. Em portugues do Brasil.

## Estado do PRD

PRD e **incremental e dinamico** (briefing → PRD → UX → arquitetura → historias → QA). Cada fase vive em um arquivo de [docs/](docs/) com cabecalho `Status: [draft|approved]` + data. Comece sempre olhando [docs/CONTEXT.md](docs/CONTEXT.md).

## Routing table

| Tarefa | Vai para | Le primeiro |
|---|---|---|
| Editar briefing / PRD / UX / arquitetura / historias | [docs/](docs/) | [docs/CONTEXT.md](docs/CONTEXT.md) |
| Editar a persona/system prompt da Sofia | [docs/persona-sofia.md](docs/persona-sofia.md) (md fonte) → [src/mastra/agents/vendedor.ts](src/mastra/agents/vendedor.ts) (runtime) | [src/mastra/CONTEXT.md](src/mastra/CONTEXT.md) + [docs/02_ux-spec.md](docs/02_ux-spec.md) |
| Mexer em uma tool (checkout, objecao, sessao, handoff) | [src/mastra/tools/](src/mastra/tools/) | [src/mastra/CONTEXT.md](src/mastra/CONTEXT.md) + [docs/03_arquitetura.md](docs/03_arquitetura.md) |
| Integracao WhatsApp / persistencia / memoria | [src/mastra/](src/mastra/) (`evolution.ts`, `supabase.ts`, `memoria.ts`, `buffer.ts`, `bloqueio.ts`, `processors.ts`, `sessao.ts`) | [src/mastra/CONTEXT.md](src/mastra/CONTEXT.md) |
| Schema do banco / migrations | [docs/sql/](docs/sql/) | [docs/03_arquitetura.md](docs/03_arquitetura.md) |
| Variaveis de ambiente | [.env.example](.env.example) | — |

## Convencoes de nome

- Arquivos: `kebab-case.ts` / `kebab-case.md`.
- Docs do PRD: prefixo numerico de fase — `00_briefing.md`, `01_prd.md`, `02_ux-spec.md`, `03_arquitetura.md`, `04_po-checklist.md`, `05_historias.md`, `06_qa-checklist.md`.
- Tabelas Supabase do projeto: sufixo `_roberth` (ex: `customers_roberth`).
- Variaveis em codigo: portugues quando refletem dominio (`telefone`, `vendedor`, `objecao`); ingles para padroes de framework (`agent`, `tools`, `memory`).

## Boundaries

- **Nunca** enviar link de checkout colado no texto — sempre via tool `enviar-checkout` (faz UTM + log).
- **Nunca** inventar preco, prazo, bonus, desconto — se nao esta no `01_prd.md`/`02_ux-spec.md`, nao existe.
- **Nunca** registrar agentes/tools fora do `src/mastra/index.ts`.
- **Sempre** rodar `npm run build` antes de commitar para verificar compilacao.

## Comandos

```shell
npm run dev      # Mastra Studio em localhost:4111
npm run build    # build de producao
npm run start    # roda o servidor de producao
```
