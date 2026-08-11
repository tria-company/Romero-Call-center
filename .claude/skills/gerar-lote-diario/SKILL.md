# Skill: gerar-lote-diario

Roda a **rotina diária completa** do RomeroCall (Fase 2 + Fase 4 — Dossiê 360°):
ingere/deduplica a base Supabase self-hosted na Lista 01, gera o **lote
priorizado do dia** de leads (Lista 01 LEADS do ClickUp), monta o **Dossiê 360°**
de cada lead selecionado (6 seções, gravadas na descrição do lead) e cria uma
**task de Ligação por lead** na Lista 02 (LIGACOES) com um **roteiro
estruturado** (script) que nasce do Gancho do dossiê — pronto para o discador
(PWA Wavoip) consumir. É a materialização de LOTE-02/03 (Fase 2, D-P2-01: a
GERAÇÃO do lote é uma skill do Claude operada **sob demanda**, fora do backend
Mastra) e de DOSS-01/DOSS-02 (Fase 4).

## Quando usar

Rode esta skill **uma vez por dia** (ou sempre que o gestor da campanha quiser
repor a fila), tipicamente pela manhã, antes do time de closers começar a ligar.
Não há cron/scheduler nesta fase (D-P2-03/D-P4-07) — é sempre acionada por um
humano, em dois comandos (PASSO 0 abaixo, depois `gerar-lote.mjs`).

## Como rodar

**PASSO 0 — ingestão/dedupe Supabase → Lista 01 (D-P4-07, roda ANTES do lote):**

```bash
node --env-file=.env --experimental-strip-types scripts/ingerir-supabase.mjs [--dry-run]
```

Lê a base Supabase self-hosted (paginada), deduplica em cascata
(ID_SUPABASE → CPF → telefone, D-P4-08) contra a Lista 01 e materializa no
ClickUp: cria lead novo elegível ao lote de hoje, ou só complementa campos
**vazios** de um lead já existente (nunca sobrescreve — D-P4-09). Use
`--dry-run` primeiro para conferir o preview do dedupe sem escrever nada.

**PASSO 1 — lote do dia (seleção → dossiê → script → Ligação):**

```bash
node --env-file=.env --experimental-strip-types scripts/gerar-lote.mjs [--tamanho N] [--dry-run]
```

- `--tamanho N` — tamanho do lote do dia (default: `LOTE_TAMANHO_DEFAULT`, ~30).
- `--dry-run` — monta o dossiê e o script (chamadas reais ao LLM) e imprime o
  preview (tamanho do dossiê + seções degradadas), mas **não escreve nada no
  ClickUp** (nem descrição do lead, nem Ligação). Use para conferir o lote
  antes de subir de verdade.

Sem `--dry-run`, o comando lê a Lista 01, prioriza, monta e grava o dossiê de
cada lead selecionado, gera um roteiro por lead via LLM (já nascendo do Gancho
do dossiê) e cria as tasks correspondentes na Lista 02, já atribuídas ao
operador.

## Pré-requisitos (env)

| Variável | Para quê |
|---|---|
| `CLICKUP_API_TOKEN` | ler a Lista 01 / criar tasks, atualizar descrição e setar campos na Lista 02 (REST v2) |
| `OPENAI_API_KEY` (ou `AZURE_OPENAI_*` se `LLM_PROVIDER=azure`) | gerar o dossiê (Agente Contexto) e o roteiro (Agente Script) |
| `DISCADOR_ASSIGNEES` | mapa `usuario_do_discador:memberId_ClickUp` (ex: `admin:88123456`) — o memberId vem de ClickUp → Settings → Members (ou `GET /team`) |
| `LOTE_OPERADOR_DEFAULT` | usuário do discador (de `DISCADOR_USERS`) que recebe as tasks — v1 é single-operator, sem round-robin |
| `LOTE_LIMITE_TENTATIVAS` / `LOTE_TAMANHO_DEFAULT` | opcionais, ajustam a priorização (ver Fase 2 Plano 01) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | acesso REST à instância self-hosted (server-side only — D-P4-11; **nunca** em log/doc/git) — ingestão (PASSO 0) e seções 1/5 do dossiê (militante/follow-ups) |
| `SUPABASE_TABLE_MILITANTES` / `SUPABASE_TABLE_FOLLOWUPS` | nomes reais das tabelas — descobertos via `scripts/descobrir-supabase-ghl.mjs`, colados no `.env` |
| `SUPABASE_COL_ID` / `SUPABASE_COL_CPF` / `SUPABASE_COL_TELEFONE` / `SUPABASE_COL_NOME` | nomes reais das colunas de identidade (defaults razoáveis: `id`/`cpf`/`telefone`/`nome` — confirmar contra o esquema real) |

Se `DISCADOR_ASSIGNEES`/`LOTE_OPERADOR_DEFAULT` não resolverem um assignee: em
`--dry-run` a skill segue com um assignee de exemplo (só preview); numa
execução real ela **para antes de escrever** e pede para configurar o `.env`.
Sem `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`, o PASSO 0 falha claro e determinístico
(WR-03); o PASSO 1 segue funcionando (seções do dossiê que dependem do Supabase
ficam degradadas — D-P4-06).

## O que a skill faz (passo a passo)

0. **(Ingestão, D-P4-07)** `ingerir-supabase.mjs` lê a base Supabase paginada,
   deduplica em cascata contra a Lista 01 (`resolverDedupe`/`mesclarCamposVazios`,
   `src/mastra/dossie.ts`) e cria/complementa leads antes de qualquer seleção
   de lote.
1. `gerar-lote.mjs` lê **toda** a Lista 01 LEADS (paginado) e prioriza com a
   lógica de `src/mastra/lote.ts` (`selecionarLoteElegivel` — elegibilidade por
   `proximo_contato`/tentativas, ordenação retorno→score→tentativas; ver Fase 2
   Plano 01 / `02-01-PLAN.md`).
2. Lê as **Ligações ABERTAS** da Lista 02 (`includeClosed: false`) para o dedupe.
3. **(Dossiê, DOSS-01, D-P4-01/04/05/06)** Para cada lead do lote priorizado
   que ainda não tem Ligação aberta: reúne as fontes (GHL — conversas
   WhatsApp/oportunidades; Supabase — militante/follow-ups; histórico
   RomeroCall — observação consolidada/último resultado), monta o Dossiê 360°
   de 6 seções via Agente Contexto (`montarPromptDossie` + `chamarLLM`) e
   **grava na descrição da task do lead na Lista 01** — sempre remontado do
   zero (sobrescreve), nunca faz merge parcial. Fonte indisponível ou lead sem
   dados numa fonte → a seção correspondente entra com marcação explícita de
   degradação, a IA nunca inventa; falha na montagem/gravação do dossiê de um
   lead **não aborta o lote** (`console.warn`, segue sem dossiê).
4. **(Script, D-P2-05/D-P4-02)** Gera o roteiro via `chamarLLM`
   (`montarPromptScript` — 5 seções fixas, PT-BR, tom cordial/consultivo da
   campanha); quando o dossiê foi montado com sucesso, o roteiro **nasce do
   Gancho** (seção 6 do dossiê) para a Abertura/Objetivo.
5. Monta o payload da task (`montarTaskLigacao`) e cria a Ligação (`criarTask`),
   tentando em seguida vincular o relationship `LEAD_REL`.
6. Cada Ligação criada tem: `name` identificando o lead, `description` = script
   completo, `assignees` = memberId do operador, custom fields `ID_LEAD` e
   `TELEFONE` (e `LEAD_REL` quando o vínculo é aceito pela API).

## Dossiê avulso (fora do lote)

Fora da rotina diária, para (re)montar o Dossiê 360° de leads da Lista 01 sem
mexer no lote (sem seleção/priorização, sem criar Ligação na Lista 02), use o
runner:

```bash
node --env-file=.env --experimental-strip-types scripts/montar-dossies.mjs [--dry-run] [--tamanho N] [--lead <taskId>] [--forcar]
```

O que faz: reúne as mesmas fontes do lote (GHL conversas/oportunidades,
Supabase militante/follow-ups, histórico RomeroCall) e monta o Dossiê 360°
(6 seções, `montarPromptDossie`), gravando na **descrição** da task do lead
(Lista 01) — mesma coleta/degradação de `gerar-lote.mjs`.

O que NÃO faz: NÃO cria Ligação, NÃO toca a Lista 02, NÃO aplica
elegibilidade/priorização de lote.

- `--dry-run` — monta com o LLM real e imprime o preview (tamanho + seções
  degradadas), sem escrever no ClickUp.
- `--tamanho N` — limita quantos leads processar; sem a flag, processa todos
  os que passarem no filtro (sem priorização — corte por ordem da lista).
- `--lead <taskId>` — processa só aquela task, ignorando `--tamanho`.
- `--forcar` — remonta mesmo quem já tem dossiê.
- **Default (sem `--forcar`):** só processa leads cuja descrição ainda não
  contém o marcador do dossiê (título da seção 1, "Perfil e classificação") —
  `--forcar` remonta mesmo assim.

## Idempotência (D-P2-03)

Rodar a skill **2x no mesmo dia não duplica tasks**: o critério de dedupe é
"o lead já tem alguma Ligação **ABERTA** (status não-fechado) na Lista 02" — se
sim, ele é pulado nesta execução. Isso cobre reruns do mesmo dia sem empilhar
Ligações abertas para o mesmo lead. Uma vez que a Ligação seja fechada
(operação concluída/fechada), o lead volta a ficar elegível para um novo lote.
O **dossiê** não segue essa idempotência — ele é **remontado sempre** que o
lead volta a ser selecionado num lote (D-P4-05, sem cache/detecção de mudança).

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
id da task); o **telefone é sempre mascarado** (só os últimos 4 dígitos). O
**dossiê passa a manipular CPF** como chave de identidade cruzada com o
Supabase (D-P4-08) — **CPF NUNCA aparece em log, nem mascarado** (mais estrito
que o telefone: nem os últimos dígitos). O token do ClickUp e a
`SUPABASE_SERVICE_KEY` **nunca** aparecem em mensagem de log/erro. O conteúdo
do dossiê (que pode conter CPF) é gravado **só** na descrição da task do lead
no ClickUp — o store operacional já autorizado (T-04-04-I2) — nunca em
arquivo/log.

## Arquivos relacionados

- `scripts/gerar-lote.mjs` — runner do lote (seleção → dossiê → script → Ligação).
- `scripts/montar-dossies.mjs` — runner do dossiê avulso (Fase 1 Contexto): monta/regrava o Dossiê 360° de leads da Lista 01 sob demanda, sem seleção de lote nem Ligação.
- `scripts/gerar-lote.smoke.mjs` / `scripts/lote-selecao.smoke.mjs` / `scripts/script-dossie.smoke.mjs` — smokes determinísticos (sem rede) dos helpers puros e do script nascendo do Gancho.
- `scripts/ingerir-supabase.mjs` — runner de ingestão/dedupe Supabase → Lista 01 (PASSO 0, DOSS-02).
- `scripts/descobrir-supabase-ghl.mjs` — runner de descoberta read-only (esquema Supabase real + probe de escopo GHL) — rodar antes de fixar `SUPABASE_TABLE_*`/`SUPABASE_COL_*` no `.env`.
- `src/mastra/lote.ts` — lógica pura (priorização, prompt do script com dossiê opcional, payload, dedupe de Ligação).
- `src/mastra/dossie.ts` — lógica pura do dossiê (dedupe em cascata, merge-only-empty, `montarPromptDossie` 6 seções).
- `src/mastra/supabase.ts` — client REST da base self-hosted (`buscarMilitante`/`listarFollowUps`, sempre LANÇAM em erro de infra — WR-03).
- `src/mastra/clickup.ts` — client REST (`listarTasks`/`criarTask`/`atualizarTask`/`setCustomField`).
- `src/mastra/ghl.ts` — leituras de enriquecimento (`buscarConversasWhatsApp`/`buscarOportunidades`, degradam sem lançar).
- `src/mastra/llm.ts` — `chamarLLM` (Agente Contexto do dossiê + Agente Script).
- `src/mastra/operadores.ts` — mapa operador do discador ↔ assignee ClickUp.
