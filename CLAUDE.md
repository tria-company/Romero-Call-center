# SDR Auton — mapa

Agente de WhatsApp (Camila + Qualificador) que qualifica alunos da base USI via BANT×SPIN e
agenda calls comerciais com um closer humano, para a AUTON Health. Stack: **Mastra + GoHighLevel
(GHL) + Supabase + Azure OpenAI**. Em portugues do Brasil.

## Estado do PRD

PRD e **incremental e dinamico** (briefing → PRD → UX → arquitetura → historias → QA). Cada fase vive em um arquivo de [docs/](docs/) com cabecalho `Status: [draft|approved]` + data. Comece sempre olhando [docs/CONTEXT.md](docs/CONTEXT.md).

## Routing table

| Tarefa | Vai para | Le primeiro |
|---|---|---|
| Editar briefing / PRD / UX / arquitetura / historias | [docs/](docs/) | [docs/CONTEXT.md](docs/CONTEXT.md) |
| Editar a persona/system prompt da Camila | [docs/persona-camila.md](docs/persona-camila.md) (md fonte) → [src/mastra/agents/camila.ts](src/mastra/agents/camila.ts) (runtime) | [src/mastra/CONTEXT.md](src/mastra/CONTEXT.md) |
| Editar a avaliacao BANT do Qualificador | [src/mastra/agents/qualificador.ts](src/mastra/agents/qualificador.ts) + [src/mastra/bant.ts](src/mastra/bant.ts) | [src/mastra/CONTEXT.md](src/mastra/CONTEXT.md) |
| Mexer em uma tool GHL (ficha, campo, pipeline, calendario, task, nota, historico, mensagem, escalacao) | [src/mastra/tools/](src/mastra/tools/) | [src/mastra/CONTEXT.md](src/mastra/CONTEXT.md) |
| Integracao WhatsApp (GHL) / persistencia / memoria | [src/mastra/](src/mastra/) (`ghl.ts`, `supabase.ts`, `memoria.ts`, `buffer.ts`, `bloqueio.ts`, `processors.ts`, `sessao.ts`) | [src/mastra/CONTEXT.md](src/mastra/CONTEXT.md) |
| Schema do banco / migrations | [docs/sql/auton_sdr/](docs/sql/auton_sdr/) | [docs/03_arquitetura.md](docs/03_arquitetura.md) |
| Variaveis de ambiente | [.env.example](.env.example) | — |

## Convencoes de nome

- Arquivos: `kebab-case.ts` / `kebab-case.md`.
- Docs do PRD: prefixo numerico de fase — `00_briefing.md`, `01_prd.md`, `02_ux-spec.md`, `03_arquitetura.md`, `04_po-checklist.md`, `05_historias.md`, `06_qa-checklist.md`.
- Tabelas Supabase do projeto: prefixo `auton_sdr_` (ex: `auton_sdr_customers`).
- Variaveis em codigo: portugues quando refletem dominio (`telefone`, `qualificador`, `bant`); ingles para padroes de framework (`agent`, `tools`, `memory`).

## Boundaries

- **Nunca** inventar preco, prazo, bonus, desconto, cura ou opiniao clinica.
- **Nunca** registrar agentes/tools fora do `src/mastra/index.ts`.
- **Sempre** rodar `npm run build` antes de commitar para verificar compilacao.

## Comandos

```shell
npm run dev      # Mastra Studio em localhost:4111
npm run build    # build de producao
npm run start    # roda o servidor de producao
```
