# Discador Wavoip — mapa

PWA de discagem para closers: lista os leads **QUALIFICADOS** do pipeline COMERCIAL USI
(GoHighLevel) e liga via **SDK Wavoip** (WebRTC) no navegador. A ligação acontece 100% no
cliente — não há telefonia no backend. Stack: **Mastra** (servidor HTTP/rotas, na VPS) +
**web/** (frontend estático, deploy separado no Vercel) + **GHL** (lista de leads) +
**Wavoip**. Em português do Brasil.

**Arquitetura (desde a separação front/back):** o frontend (`web/`) é hospedado no Vercel;
o backend (Mastra) fica na VPS só com API + webhook. `web/vercel.json` faz *rewrite* de
`/api/*` pro backend — sem CORS, autenticação por Bearer token inalterada. O backend
continua servindo a mesma UI em `/discador/*` (rotas antigas) como rollback, a partir do
mesmo código-fonte em `discador-pwa.ts` — **os dois precisam ser mantidos em sincronia
manualmente** até as rotas antigas serem removidas.

## Routing table

| Tarefa | Vai para |
|---|---|
| Frontend do PWA — deploy Vercel (fonte real, produção) | [web/](web/) (`index.html`, `app.js`, `sw.js`, `manifest.webmanifest`) |
| Frontend do PWA — servido pela VPS (rollback, mesma UI) | [src/mastra/discador-pwa.ts](src/mastra/discador-pwa.ts) |
| Rewrite `/api/*` → backend (evita CORS) | [web/vercel.json](web/vercel.json) |
| Rotas do servidor (PWA estático legado + API do discador) | [src/mastra/index.ts](src/mastra/index.ts) |
| Login do closer / token de sessão | [src/mastra/discador-auth.ts](src/mastra/discador-auth.ts) |
| Lista de leads qualificados (leitura no GHL) | [src/mastra/ghl.ts](src/mastra/ghl.ts) (`buscarQualificados`) |
| Config (GHL + token Wavoip) | [src/mastra/config.ts](src/mastra/config.ts) |
| Variáveis de ambiente | `.env` |

## Convenções

- Arquivos: `kebab-case.ts`.
- Variáveis em código: português quando refletem domínio (`telefone`, `qualificado`); inglês para padrões de framework (`server`, `handler`).
- O token do device Wavoip (`WAVOIP_DEVICE_TOKEN`) é exposto client-side por design — o SDK do navegador precisa dele.

## Boundaries

- **Sempre** rodar `npm run build` antes de commitar para verificar compilação.
- O login seed é `admin/admin` — trocar via `DISCADOR_USERS`/`DISCADOR_SESSION_SECRET` em produção.

## Comandos

```shell
npm run dev      # servidor em localhost:4111 (/discador)
npm run build    # build de produção
npm run start    # roda o servidor de produção
```
