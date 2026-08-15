# Skill: gerar-lote-diario

Roda a rotina diária do lote de ligações do RomeroCall, **ClickUp-only**
(Quick 260815-hea, decisões travadas D1-D6): a Lista 01 (LEADS) já vem
preenchida à mão pelo gestor (ingestão/dedupe de outras fontes fica fora
desta skill); o runner faz **seleção explícita → distribui em round-robin
entre os operadores da rodada → cria uma Ligação por lead** na Lista 02
(LIGACOES) com o roteiro que o gestor escreveu num arquivo `.md`. Não há
banco externo, não há chamada de IA em nenhum passo — o dossiê do lead é
**read-only** (o gestor digita à mão na descrição do lead; a skill nunca
gera nem sobrescreve).

## Quando usar

Rode esta skill sempre que o gestor da campanha quiser repor a fila de
Ligações do dia (ou de uma rodada específica), tipicamente pela manhã, antes
do time de closers começar a ligar. Não há cron/scheduler — é sempre
acionada por um humano.

## Como rodar

```bash
node --env-file=.env --experimental-strip-types scripts/gerar-lote.mjs \
  (--telefones "<lista>" | --tag [nome] | --tamanho N) \
  --script <caminho.md> \
  [--operadores nome1,nome2,...] \
  [--dry-run]
```

### Modos de seleção (D4 — exatamente UM é obrigatório)

| Flag | O que faz |
|---|---|
| `--telefones "<lista>"` | Casa cada telefone colado (separado por vírgula, espaço ou quebra de linha) contra `TELEFONE` da Lista 01. Telefone sem match é ignorado. Tolerante a prefixo DDI `55` com/sem, em qualquer um dos dois lados. |
| `--tag [nome]` | Puxa só os leads da Lista 01 marcados com essa tag nativa do ClickUp (case-insensitive). Sem nome explícito, usa o default `lote-hoje` (ou `LOTE_TAG_DEFAULT`, se configurada). |
| `--tamanho N` | Pega os primeiros N leads **em ordem de lista** (sem scoring, sem `proximo_contato` — a priorização automática saiu do fluxo), pulando quem já tem Ligação aberta. Sem N, usa `LOTE_TAMANHO_DEFAULT`. |

Não há priorização automática nesta skill: a seleção é sempre uma decisão
explícita do gestor, num dos 3 modos acima.

### Script (D3 — obrigatório)

`--script <caminho.md>` aponta para o arquivo com o roteiro que o gestor
escreveu. O texto inteiro do arquivo vira a `description` de **todas** as
Ligações criadas nesta execução (script único do dia/rodada, igual para
todos os leads selecionados). Arquivo ausente ou vazio falha claro, antes de
tocar o ClickUp.

### Operadores e round-robin (D6)

`--operadores nome1,nome2,...` distribui as Ligações **ciclicamente** entre
os operadores listados: o 1º lead selecionado vai para o 1º operador, o 2º
para o 2º, e assim por diante, voltando ao início da lista quando ela acaba
(`distribuirRoundRobin`, determinístico na ordem de seleção). Sem a flag,
cai no fallback single-operator `LOTE_OPERADOR_DEFAULT`.

Cada nome resolve para um `memberId` do ClickUp via `DISCADOR_ASSIGNEES`.
**Guard:** se QUALQUER operador de `--operadores` não resolver, numa
execução real o runner **para antes de escrever** (mensagem lista os nomes
não resolvidos + instrução de configurar `DISCADOR_ASSIGNEES`); em
`--dry-run` segue com um assignee de exemplo `'0'` só para o preview.

### `--dry-run`

Imprime o que seria criado (lead selecionado, operador atribuído) sem
escrever nada no ClickUp. Use para conferir a seleção e a distribuição antes
de rodar de verdade.

## Pré-requisitos (env)

| Variável | Para quê | Obrigatória? |
|---|---|---|
| `CLICKUP_API_TOKEN` | ler a Lista 01 / criar tasks e setar campos na Lista 02 (REST v2) | Sim |
| `DISCADOR_ASSIGNEES` | mapa `usuario_do_discador:memberId_ClickUp` (ex: `admin:88123456`) — o memberId vem de ClickUp → Settings → Members (ou `GET /team`) | Sim |
| `LOTE_OPERADOR_DEFAULT` | usuário do discador que recebe as Ligações quando `--operadores` não é passado (fallback single-operator) | Sim |
| `LOTE_TAMANHO_DEFAULT` | tamanho default do modo `--tamanho` (default 30 se ausente) | Opcional |
| `LOTE_TAG_DEFAULT` | tag default do modo `--tag` (default `lote-hoje` se ausente) | Opcional |
| `CLICKUP_LIST_LEADS` / `CLICKUP_LIST_LIGACOES` | ids das listas (já têm default fixo — só sobrescrever se as listas mudarem) | Opcional |

**Removido do requisito da skill** (D1): não há mais envs de banco externo
nem de IA no caminho desta skill — o runner nunca as lê.

Se algum operador de `--operadores` (ou o `LOTE_OPERADOR_DEFAULT`) não
resolver via `DISCADOR_ASSIGNEES`: em `--dry-run` a skill segue com um
assignee de exemplo (só preview); numa execução real ela **para antes de
escrever** e pede para configurar o `.env`.

## O que a skill faz (passo a passo)

1. Resolve o modo de seleção (`--telefones` / `--tag` / `--tamanho`), lê o
   arquivo `--script` e resolve a lista de operadores da rodada — tudo isso
   **antes** de tocar o ClickUp (falha-claro barato).
2. Lê **toda** a Lista 01 LEADS (paginado).
3. Lê as **Ligações ABERTAS** da Lista 02 (`includeClosed: false`) para o dedupe.
4. Aplica o modo de seleção escolhido sobre a Lista 01 (`filtrarLeadsPorTelefones`
   / `filtrarTasksPorTag` / `selecionarPorQuantidade` — `src/mastra/lote.ts`).
5. Filtra o resultado por `deveCriar` (dedupe de Ligação aberta, universal aos
   3 modos — D5).
6. Distribui os leads elegíveis em round-robin entre os operadores resolvidos
   (`distribuirRoundRobin`).
7. Para cada par lead/operador: monta o payload (`montarTaskLigacao`) — nome
   identificando o lead, `description` = o texto do arquivo `--script`,
   `assignees` = o memberId do operador atribuído, custom fields `ID_LEAD`/
   `TELEFONE` — cria a Ligação (`criarTask`) e tenta em seguida vincular o
   relationship `LEAD_REL` (best-effort: se falhar, segue — `ID_LEAD` já
   gravado garante o vínculo textual).

**Dossiê read-only (D2):** esta skill nunca lê nem grava a descrição da task
do lead na Lista 01. Quem quiser ler o histórico do lead antes de ligar
navega até a task pelo vínculo `LEAD_REL`/`ID_LEAD` da Ligação e lê o que o
gestor escreveu à mão lá. Nenhuma chamada de IA acontece em nenhum passo
desta skill.

## Idempotência (D-P2-03)

Rodar a skill 2x no mesmo dia/rodada **não duplica tasks**: o critério de
dedupe é "o lead já tem alguma Ligação **ABERTA** (status não-fechado) na
Lista 02" — se sim, ele é pulado nesta execução (`deveCriar`). Isso cobre
reruns do mesmo dia sem empilhar Ligações abertas para o mesmo lead. Uma vez
que a Ligação seja fechada, o lead volta a ficar elegível para uma nova
seleção.

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
sessão **não enxerga** essa workspace). Essa troca não está implementada — é
um caminho futuro documentado aqui para quando o MCP passar a enxergar a
workspace certa.

## LGPD

Os logs do runner imprimem só contagens, o nome do lead e o **telefone
sempre mascarado** (só os últimos 4 dígitos, `mascararTelefone`). O nome do
operador atribuído a cada Ligação **pode aparecer em log por design** (D6 —
não é PII sensível). O CPF do lead **nunca** é lido nem logado por esta
skill (dossiê read-only — a skill não toca em campos de identidade além de
`TELEFONE`/`ID_LEAD`). O token do ClickUp **nunca** aparece em mensagem de
log/erro (choke point `clickup.ts`).

## Arquivos relacionados

- `scripts/gerar-lote.mjs` — runner do lote (seleção explícita → round-robin
  de operadores → Ligação, ClickUp-only).
- `scripts/lote-selecao.smoke.mjs` / `scripts/gerar-lote.smoke.mjs` /
  `scripts/script-dossie.smoke.mjs` — smokes determinísticos (sem rede) dos
  helpers puros de seleção/round-robin e dos helpers legados ainda cobertos
  por outros smokes (`montarTaskLigacao`/`deveCriar`).
- `src/mastra/lote.ts` — lógica pura: seleção explícita
  (`filtrarLeadsPorTelefones`/`filtrarTasksPorTag`/`selecionarPorQuantidade`),
  distribuição (`distribuirRoundRobin`), payload da Ligação e dedupe
  (`deveCriar`).
- `src/mastra/clickup.ts` — client REST (`listarTasks`/`criarTask`/`setCustomField`).
- `src/mastra/operadores.ts` — mapa operador do discador ↔ assignee ClickUp
  (`DISCADOR_ASSIGNEES`).
- `src/mastra/mascarar.ts` — `mascararTelefone` (LGPD).

Os módulos `src/mastra/dossie.ts`, `src/mastra/supabase.ts`, `src/mastra/ghl.ts`
e `src/mastra/llm.ts` continuam existindo no repo (usados por outros fluxos),
mas não fazem mais parte da rotina desta skill.
