# CONTEXT — src/mastra (backend Mastra)

Servidor HTTP único (Mastra/Hono, porta 4111) que roda na VPS. Faz **API do discador**,
**webhook do Wavoip** e serve o **PWA legado** em `/discador/*` (rollback). A ligação em si
é 100% no navegador (WebRTC/Wavoip) — **não há telefonia no backend**.

## Mapa dos módulos

| Arquivo | Responsabilidade |
|---|---|
| [index.ts](index.ts) | Rotas: PWA legado (`/discador/*`), API (`/api/discador/*`), webhook (`/api/webhook/wavoip`) e **painel do gestor** (`/admin`, `/api/admin/*`: métricas, operação ao vivo, chamadas por número, usuários). O handler do webhook usa `estado-webhook.ts` e persiste o evento cru antes de processar. |
| [config.ts](config.ts) | Env vars + IDs de listas/campos ClickUp, `REDIS_URL`, Supabase, tabelas `romero_db_*`. Avisa (não quebra) quando algo opcional falta. |
| [clickup.ts](clickup.ts) | Store operacional — **fonte da verdade**. Listas 01 LEADS / 02 LIGACOES, `CAMPOS_LEADS`/`CAMPOS_LIGACOES` (field_ids), CRUD de tasks. |
| [supabase.ts](supabase.ts) | Durabilidade do evento cru do webhook (`registrarEventoWebhook`/`marcarEventoWebhook`) + leitura das tabelas de serviço `romero_db_*` (seção 5 do dossiê). |
| [estado-webhook.ts](estado-webhook.ts) | Camada **Redis-ou-memória**: correlação call→telefone, telefone→task, dedup de records/falhas. Alternável por env; degrada gracioso pra Maps em memória. |
| [analise.ts](analise.ts) | Análise IA da transcrição (aderência ao script) + gate de falha terminal (`ehStatusFalhaTerminal`). |
| [deepgram.ts](deepgram.ts) | Transcrição da gravação (timeout 600s p/ áudio longo) + fallback binário. |
| [llm.ts](llm.ts) | Provider LLM (Azure OpenAI / Azure AI Foundry). |
| [contexto.ts](contexto.ts) | Agente Contexto — monta contexto do lead pro Agente Script. |
| [lote.ts](lote.ts) | Geração do **lote diário priorizado** (LOTE-*) — o coração do loop diário. |
| [dossie.ts](dossie.ts) | Dossiê 360° do lead (multi-tabela `romero_db_*`). |
| [discador-auth.ts](discador-auth.ts) | Login do closer + token de sessão HMAC stateless (Bearer, nunca cookie). |
| [discador-pwa.ts](discador-pwa.ts) | Assets do PWA (HTML/`app.js`/`sw.js`) como template strings. **Espelhado em [../../web/](../../web/) — manter em sincronia manual.** |
| [painel-dados.ts](painel-dados.ts) | Números do dashboard lidos **ao vivo** da fonte certa: cadastros no Postgres (`users_romero`), votos e ligações no ClickUp. Cache stale-while-revalidate por processo. **Só leitura** — não grava em lugar nenhum. |
| [operadores.ts](operadores.ts) | Mapa usuário logado → operador do ClickUp (`DISCADOR_ASSIGNEES`). |
| [usuarios.ts](usuarios.ts) | Snapshot de `discador_usuarios` (papel, `clickup_member_id`, `wavoip_device_id`). Lookups rápidos: `papelDoUsuario`, `deviceIdDoUsuario`, `donoDoDevice`/`donosDevices` (exclusividade número↔operador), `snapshotUsuarios`. |
| [dispositivos.ts](dispositivos.ts) | `resolverConfigDoUsuario` — resolve o device do operador na ordem **dedicado** (`wavoip_device_id`→token) → **pool** (lease) → **global** (`WAVOIP_DEVICE_TOKEN`). |
| [wavoip-api.ts](wavoip-api.ts) | API de **gerência** Wavoip (login de conta→JWT): inventário vivo `deviceId→{token,número,status,calls_made}` (cache TTL 60s), `snapshotDevicesWavoip` (SEM token, p/ painel), auto-webhook por device. |
| [metricas.ts](metricas.ts) | **Redis-ou-memória**: presença/online (heartbeat), **em-chamada por operador**, **chamadas por número** (dia BRT), erros por etapa, 429s. Degrada p/ 0/`[]`/`{}`, **NUNCA lança**. |
| [fila.ts](fila.ts) | Fila de LIGACOES por assignee (`buscarFilaLigacoes`) + `profundidadeFila` (KPI). |
| [admin-painel.ts](admin-painel.ts) | Painel do **gestor** (`/admin`) — HTML/CSS/JS em template string: KPIs, **Operação ao vivo**, **Chamadas por número**, Filas/erros, gestão de operadores. Poll de 8s. |
| [http.ts](http.ts) | `fetchTimeout` (helper de fetch com timeout/method/body). |

## Métricas & painel do gestor (o que não é óbvio)

- **Presença / "Atendentes online":** o discador manda um **heartbeat** (`POST /api/discador/presenca`)
  a cada 60s enquanto aberto — inclusive durante a chamada. A presença dura 120s (`METRICAS_PRESENCA_TTL_MS`),
  então "online" reflete quem está com o discador aberto, não só quem ligou nos últimos minutos.
  Também é marcada em login/ligando/desfecho.
- **"Operação ao vivo"** (`/api/admin/operacao`): junta presença (online) + **em-chamada por operador**
  (`met:chamada:<usuario>`, marcado no `/ligando`, limpo no `/desfecho`, TTL de teto que auto-limpa se
  o desfecho falhar) + o número de cada um (via `wavoip_device_id`→inventário). LGPD: só usuário+número.
- **"Chamadas por número"** (`/api/admin/chamadas-por-numero`): a chamada é contada **1× no DESFECHO**,
  atribuída ao **número do operador** (`deviceIdDoUsuario`). O total de "hoje" é **derivado = atendidas + não**
  (nunca diverge). Dia **operacional em Brasília** (`diaOperacionalStr`, não UTC). Contagens sem número
  associado viram a linha **"Sem número associado"** (nada some). O **acumulado** vem do `calls_made` da Wavoip.
- **⚠️ Cuidado modo memória:** sem `REDIS_URL`, presença/em-chamada/chamadas-por-número vivem na **memória
  do processo** → **zeram a cada restart/hot-reload** (inclusive o watch do `npm run dev`). Em prod (Redis)
  persistem. Para testar local sem "zerar", não reinicie entre ligar e conferir — ou aponte um Redis local.

## Padrões (não-negociáveis)

- **Degradação graciosa:** tudo funciona sem Redis/Supabase — volta ao comportamento de 1
  instância (Maps/Sets em memória). "Construir código antes de provisionar" nunca pode
  quebrar produção.
- **kebab-case.ts** nos nomes de arquivo.
- **PT-BR no domínio** (`telefone`, `qualificado`, `lote`, `operador`); **EN em framework** (`server`, `handler`).
- **LGPD:** nunca logar telefone/CPF em claro (mascarar tipo `+5511****4321`).
- Token do device Wavoip é exposto client-side **por design** (o SDK do navegador precisa dele).

## Como é um bom output aqui

Compila (`npm run build` verde) · degrada gracioso sem infra opcional · sem PII em log ·
se mexeu no PWA (`discador-pwa.ts`), **espelhou em `web/`** e deu bump no cache do SW.
