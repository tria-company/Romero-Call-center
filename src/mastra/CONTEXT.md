# CONTEXT — src/mastra (backend Mastra)

Servidor HTTP único (Mastra/Hono, porta 4111) que roda na VPS. Faz **API do discador**,
**webhook do Wavoip** e serve o **PWA legado** em `/discador/*` (rollback). A ligação em si
é 100% no navegador (WebRTC/Wavoip) — **não há telefonia no backend**.

## Mapa dos módulos

| Arquivo | Responsabilidade |
|---|---|
| [index.ts](index.ts) | Rotas: PWA legado (`/discador/*`), API (`/api/discador/*`), webhook (`/api/webhook/wavoip`). O handler do webhook usa `estado-webhook.ts` e persiste o evento cru antes de processar. |
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
| [operadores.ts](operadores.ts) | Mapa usuário logado → operador do ClickUp (`DISCADOR_ASSIGNEES`). |
| [http.ts](http.ts) | `fetchTimeout` (helper de fetch com timeout/method/body). |

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
