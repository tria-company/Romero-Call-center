# docs/ — workspace do projeto SDR AUTON

Este projeto (SDR AUTON Health) reaproveita a infraestrutura Mastra ja em producao do
ex-bot Closer "Roberth" (agente de WhatsApp vendedor de curso/infoproduto). Os docs de
PRD/UX/arquitetura/historias/QA daquela era (`00_briefing.md` ate `06_qa-checklist.md`,
`persona-sofia.md`, `test-cases-sofia.md`, etc.) foram **arquivados** em
[_arquivo-roberth/](_arquivo-roberth/) — preservados como referencia historica, nao
refletem o SDR AUTON atual e nao devem ser editados.

## Docs vivos

| Doc | Para que serve |
|---|---|
| Este arquivo (`CONTEXT.md`) | Ponto de entrada do workspace de docs. |
| [sql/auton_sdr/README.md](sql/auton_sdr/README.md) | Schema canonico do banco dedicado do SDR AUTON (tabelas `auton_sdr_*`). |
| [persona-camila.md](persona-camila.md) | Persona/system prompt (md fonte) da Camila — versao humana, editar aqui primeiro. |
| [_arquivo-roberth/](_arquivo-roberth/) | Docs historicos do bot Closer original — nao editar. |

## Ponteiros para o codigo

- **Persona da Camila (markdown editavel)**: [persona-camila.md](persona-camila.md) — versao humana do system prompt.
- **Persona em runtime**: [../src/mastra/agents/camila.ts](../src/mastra/agents/camila.ts) — string `instructions` do agente. Espelha o `.md` (escapando backticks).
- **Qualificador (avaliacao BANT via formulario)**: [../src/mastra/agents/qualificador.ts](../src/mastra/agents/qualificador.ts) + [../src/mastra/bant.ts](../src/mastra/bant.ts).
- **Tools que materializam o fluxo**: [../src/mastra/tools/](../src/mastra/tools/).
- **Schema das tabelas**: [sql/auton_sdr/](sql/auton_sdr/).

> Quando editar a persona: mudar primeiro em `persona-camila.md`, depois espelhar em `camila.ts` (cuidando de escapar crases dentro da template literal). NAO editar o texto de seguranca da persona v2 (Safety Envelope/Behavioral Gradient/Hallucination Defense) sem revisao — ver `.planning/01-CONTEXT.md`.
