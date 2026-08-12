# Discador PWA — frontend estático (Vercel)

PWA vanilla JS/HTML (sem build step) extraído de `src/mastra/discador-pwa.ts` —
o backend (Mastra na VPS) continua servindo a mesma UI em `/discador/*` por
enquanto (rollback fácil); esta pasta é o novo deploy separado no Vercel.

## Configurar no Vercel

1. Importar o repo `tria-company/Romero-Call-center`.
2. **Root Directory**: `web`.
3. Framework preset: **Other** (sem build step — é HTML/JS estático puro).
4. Deploy.

## Como a API funciona sem CORS

`vercel.json` faz *rewrite* de `/api/*` para o backend na VPS — o navegador
enxerga tudo como mesma origem, então o `app.js` continua chamando caminhos
relativos (`/api/discador/fila` etc.) sem nenhuma mudança de autenticação
(o token Bearer já era enviado por header, nunca por cookie).

**Pendência:** `vercel.json` aponta pro IP:porta HTTP direto da VPS
(`http://85.155.178.244:4111`) — interino, enquanto não há domínio/TLS na
VPS (decisão "pular TLS por enquanto"). Trocar para `https://` quando o
domínio/Traefik forem configurados.

## Arquivos

- `index.html` / `app.js` / `sw.js` / `manifest.webmanifest` / `icon.svg` —
  extraídos 1:1 de `discador-pwa.ts`, só com os paths `/discador/*` trocados
  para raiz (`/`), já que aqui esta pasta É a raiz do site.
- Cache do service worker: `discador-v9` (bump por causa da troca de paths —
  evita PWAs já instalados servirem o shell antigo com paths `/discador/*`).
