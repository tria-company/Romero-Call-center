# Skill: gerar-lote-diario

Gera o **lote priorizado do dia** de leads (Lista 01 LEADS do ClickUp) e cria uma
**task de Ligação por lead** na Lista 02 (LIGACOES), com um **roteiro estruturado**
(script) na descrição, vínculo ao lead e assignee do operador — pronto para o
discador (PWA Wavoip) consumir. É a materialização de LOTE-02/03 (Fase 2 do
RomeroCall) e da decisão **D-P2-01**: a GERAÇÃO do lote é uma skill do Claude
operada **sob demanda**, fora do backend Mastra (que só roda o discador).

## Quando usar

Rode esta skill **uma vez por dia** (ou sempre que o gestor da campanha quiser
repor a fila), tipicamente pela manhã, antes do time de closers começar a ligar.
Não há cron/scheduler nesta fase (D-P2-03) — é sempre acionada por um humano.

## Como rodar

```bash
node --env-file=.env --experimental-strip-types scripts/gerar-lote.mjs [--tamanho N] [--dry-run]
```

- `--tamanho N` — tamanho do lote do dia (default: `LOTE_TAMANHO_DEFAULT`, ~30).
- `--dry-run` — gera os scripts (chamada real ao LLM) e imprime o preview, mas
  **não escreve nada no ClickUp**. Use para conferir o lote antes de subir de
  verdade.

Sem `--dry-run`, o comando lê a Lista 01, prioriza, gera um roteiro por lead via
LLM e cria as tasks correspondentes na Lista 02, já atribuídas ao operador.

## Pré-requisitos (env)

| Variável | Para quê |
|---|---|
| `CLICKUP_API_TOKEN` | ler a Lista 01 / criar tasks e setar campos na Lista 02 (REST v2) |
| `OPENAI_API_KEY` (ou `AZURE_OPENAI_*` se `LLM_PROVIDER=azure`) | gerar o roteiro (Agente Script) |
| `DISCADOR_ASSIGNEES` | mapa `usuario_do_discador:memberId_ClickUp` (ex: `admin:88123456`) — o memberId vem de ClickUp → Settings → Members (ou `GET /team`) |
| `LOTE_OPERADOR_DEFAULT` | usuário do discador (de `DISCADOR_USERS`) que recebe as tasks — v1 é single-operator, sem round-robin |
| `LOTE_LIMITE_TENTATIVAS` / `LOTE_TAMANHO_DEFAULT` | opcionais, ajustam a priorização (ver Fase 2 Plano 01) |

Se `DISCADOR_ASSIGNEES`/`LOTE_OPERADOR_DEFAULT` não resolverem um assignee: em
`--dry-run` a skill segue com um assignee de exemplo (só preview); numa
execução real ela **para antes de escrever** e pede para configurar o `.env`.

## O que a skill faz (passo a passo)

1. Lê **toda** a Lista 01 LEADS (paginado) e prioriza com a lógica de
   `src/mastra/lote.ts` (`selecionarLoteElegivel` — elegibilidade por
   `proximo_contato`/tentativas, ordenação retorno→score→tentativas; ver Fase 2
   Plano 01 / `02-01-PLAN.md`).
2. Lê as **Ligações ABERTAS** da Lista 02 (`includeClosed: false`) para o dedupe.
3. Para cada lead do lote priorizado que **ainda não tem** Ligação aberta
   (`deveCriar`): gera o roteiro via `chamarLLM` (`montarPromptScript` — 5 seções
   fixas, PT-BR, tom cordial/consultivo da campanha), monta o payload da task
   (`montarTaskLigacao`) e cria a Ligação (`criarTask`), tentando em seguida
   vincular o relationship `LEAD_REL`.
4. Cada Ligação criada tem: `name` identificando o lead, `description` = script
   completo, `assignees` = memberId do operador, custom fields `ID_LEAD` e
   `TELEFONE` (e `LEAD_REL` quando o vínculo é aceito pela API).

## Idempotência (D-P2-03)

Rodar a skill **2x no mesmo dia não duplica tasks**: o critério de dedupe é
"o lead já tem alguma Ligação **ABERTA** (status não-fechado) na Lista 02" — se
sim, ele é pulado nesta execução. Isso cobre reruns do mesmo dia sem empilhar
Ligações abertas para o mesmo lead. Uma vez que a Ligação seja fechada
(operação concluída/fechada), o lead volta a ficar elegível para um novo lote.

## Backend "subir lote": REST agora, MCP depois (D-P2-02)

O caminho de escrita no ClickUp usado por esta skill é **REST direto**
(`src/mastra/clickup.ts`, autenticado por `CLICKUP_API_TOKEN`) — já provado
escrevendo na workspace `9014971829` (Listas 01/02), sem depender de nenhum
conector adicional. Esse é o caminho **recomendado e o único implementado**
nesta fase.

O ponto de extensão é a interface `BackendLote` (`src/mastra/lote.ts`):
`ligacoesAbertasDoLead(idLead)` + `criarLigacao(payload)`. Uma implementação
alternativa via **MCP do ClickUp** só faz sentido se o usuário conectar a
workspace `9014971829` ao conector MCP do claude.ai (hoje o conector desta
sessão **não enxerga** essa workspace — só `9011731314`/`90132819023`). Essa
troca não está implementada — é um caminho futuro documentado aqui para quando
o MCP passar a enxergar a workspace certa.

## LGPD

Os logs do runner imprimem só contagens e identificadores não-sensíveis (nome,
id da task); o **telefone é sempre mascarado** (só os últimos 4 dígitos), o
**CPF nunca é lido/logado** por esta skill, e o token do ClickUp **nunca**
aparece em mensagem de log/erro.

## Arquivos relacionados

- `scripts/gerar-lote.mjs` — runner (este comando).
- `scripts/gerar-lote.smoke.mjs` — smoke determinístico (sem rede) dos helpers puros.
- `src/mastra/lote.ts` — lógica pura (priorização, prompt, payload, dedupe).
- `src/mastra/clickup.ts` — client REST (`listarTasks`/`criarTask`/`setCustomField`).
- `src/mastra/llm.ts` — `chamarLLM` (Agente Script).
- `src/mastra/operadores.ts` — mapa operador do discador ↔ assignee ClickUp.
