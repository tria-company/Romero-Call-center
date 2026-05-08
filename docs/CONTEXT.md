# docs/ — workspace do PRD dinamico

Aqui vivem todos os artefatos de planejamento do projeto Roberth. **PRD e incremental:** cada fase produz um documento; quando algo muda numa fase posterior (ex: arquitetura descobriu uma restricao), volta-se a fase anterior e atualiza-se o documento marcando `Status: draft` ate revalidar.

## Pipeline (ordem das fases)

```
00_briefing.md   → analista (entender problema, publico, oferta, lancamento, riscos)
01_prd.md        → PM (objetivo, persona, funcionalidades, metricas)         ← INCREMENTAL
02_ux-spec.md    → UX (fluxo conversacional, copy, tom, gatilhos)
03_arquitetura.md→ arquiteto (codigo, banco, integracoes, env)
04_po-checklist.md→ PO (cheque consistencia: PRD ↔ UX ↔ arquitetura)
05_historias.md  → Scrum Master (user stories quebradas para implementar uma a uma)
06_qa-checklist.md→ criterios de aceite por historia
```

Os "papeis" (analista, PM, UX, arquiteto, PO, SM) sao **chapeus** — quem assume e o time (Roberth + assistente). Nao sao agentes Mastra. O agente Mastra do projeto e UM SO: o vendedor (`src/mastra/agents/vendedor.ts`).

## Como editar

1. Cada doc tem cabecalho:
   ```markdown
   ---
   status: draft | approved
   ultima_revisao: YYYY-MM-DD
   responsavel: <quem revisou>
   ---
   ```
2. Mudou algo? marque `status: draft`, atualize, e quando estiver alinhado volte para `approved`.
3. Mudancas em `03_arquitetura.md` que impactam funcionalidade **devem** voltar pro `01_prd.md`.
4. Apos `04_po-checklist.md` validar, gere ou atualize `05_historias.md` em pedacos pequenos (idealmente 1 historia = 1 PR).

## Output esperado

- Briefing curto (1-2 paginas).
- PRD com persona, escopo, fora-de-escopo, metricas e restricoes.
- UX-spec com fluxo turn-by-turn e copy real.
- Arquitetura com arvore de arquivos, schema e contratos.
- Historias com criterio de aceite — sem essas, nao se programa.

## Ponteiros para o codigo

- **Persona da Sofia (markdown editavel)**: [persona-sofia.md](persona-sofia.md) — versao humana do system prompt. Edite aqui primeiro.
- **Persona em runtime**: [../src/mastra/agents/vendedor.ts](../src/mastra/agents/vendedor.ts) — string `instructions` do agente. Espelha o `.md` (escapando backticks).
- **Tools que materializam o fluxo**: [../src/mastra/tools/](../src/mastra/tools/).
- **Schema das tabelas**: [sql/01_init.sql](sql/01_init.sql).

> Quando editar a persona: mudar primeiro em `persona-sofia.md`, depois copiar para `vendedor.ts` (cuidando de escapar `\\\`` nos crases dentro da template literal).
