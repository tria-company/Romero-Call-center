# Discador Wavoip — AUTON Health

PWA de discagem para closers: lista os leads **QUALIFICADOS** do pipeline COMERCIAL USI
(GoHighLevel) e liga para eles direto do navegador via **SDK Wavoip** (WebRTC). Não há
telefonia no backend — a ligação acontece 100% no cliente.

Stack: **Mastra** (só o servidor HTTP/rotas) + **GoHighLevel** (lista de leads) + **Wavoip** (ligação no navegador).

## Como rodar

```shell
npm install
# configure as variáveis no .env (ver abaixo)
npm run dev     # servidor em http://localhost:4111
```

Acesse o discador em **http://localhost:4111/discador** (login inicial: `admin` / `admin` — trocar em produção).

## Variáveis de ambiente

| Var | Para que serve |
|---|---|
| `GHL_PIT_TOKEN` | Private Integration Token do GHL (scope `opportunities.readonly`) — usado para listar os qualificados. |
| `GHL_LOCATION_ID` / `GHL_PIPELINE_ID` | Location e pipeline COMERCIAL USI (têm default no `config.ts`). |
| `WAVOIP_DEVICE_TOKEN` | Token do device Wavoip — o SDK do navegador precisa dele para abrir a ligação. |
| `DISCADOR_USERS` | Login dos closers: `user:sha256hex,...` (default seed `admin/admin`). |
| `DISCADOR_SESSION_SECRET` | Segredo HMAC do token de sessão (trocar em produção). |

## Estrutura

| Arquivo | Para que serve |
|---|---|
| [src/mastra/index.ts](src/mastra/index.ts) | Servidor Mastra + rotas do discador (PWA estático + API). |
| [src/mastra/discador-pwa.ts](src/mastra/discador-pwa.ts) | Frontend do PWA (HTML/JS/manifest/service worker/ícone) como strings. |
| [src/mastra/discador-auth.ts](src/mastra/discador-auth.ts) | Login por closer + token de sessão HMAC. |
| [src/mastra/ghl.ts](src/mastra/ghl.ts) | `buscarQualificados` — leitura da lista de leads no GHL. |
| [src/mastra/config.ts](src/mastra/config.ts) | Config central (GHL + token Wavoip). |
| [src/mastra/http.ts](src/mastra/http.ts) | `fetchTimeout` (fetch com AbortController). |

## Endpoints

- `GET /discador` — o PWA (frontend).
- `POST /api/discador/login` — login do closer. Body: `{ "usuario", "senha" }` → `{ token }`.
- `GET /api/discador/qualificados` — lista paginada de leads qualificados (Bearer token).
- `GET /api/discador/config` — devolve o `wavoipToken` para o SDK do navegador (Bearer token).
