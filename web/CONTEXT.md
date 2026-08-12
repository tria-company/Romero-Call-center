# CONTEXT — web/ (frontend estático, Vercel)

PWA vanilla (HTML/JS, **sem build step**) hospedado no Vercel. É a **fonte real de produção**
do frontend do discador. Ver também [README.md](README.md) (setup do Vercel) — este arquivo
é o modelo mental + as regras que não podem ser esquecidas.

## Regra de ouro: sincronia com o backend

`web/` é **extraído 1:1** de [../src/mastra/discador-pwa.ts](../src/mastra/discador-pwa.ts),
que o backend serve em `/discador/*` como rollback. **Os dois precisam ser mantidos em
sincronia manual** até as rotas antigas serem removidas. Ao mudar a UI:

1. Edite `discador-pwa.ts` **e** os arquivos de `web/` (`index.html`, `app.js`, `sw.js`).
2. A diferença de paths é intencional: em `web/` o shell vive na raiz (`/`), no backend em `/discador/*`.
3. **Bump do cache do Service Worker** (`CACHE=discador-vN` em `sw.js` **dos dois lados**) sempre
   que o shell muda — senão PWAs instalados servem o app antigo.

## Como a API funciona sem CORS

`vercel.json` faz *rewrite* de `/api/*` pro backend na VPS → o navegador vê tudo como mesma
origem. O `app.js` chama caminhos relativos (`/api/discador/fila` etc.). Auth por **Bearer
token** (header `Authorization`, nunca cookie) — por isso cross-origin não exige mudança.

## Restrições PWA / offline

- **Self-contained:** nada de libs/fontes externas no shell (a única exceção é o SDK Wavoip,
  importado via `esm.sh` **em runtime**, dentro da ligação — não no shell cacheado).
- `sw.js` cacheia o `SHELL` e faz cache-first; requests `/api/*` **passam direto** (nunca cacheadas).
- `app.js` é escrito **sem template literals `${...}`** de propósito (vive dentro de template
  strings no backend sem escape).

## Bom output

UI usável no celular (touch, sem cursor custom) · shell offline-safe · `web/` e
`discador-pwa.ts` idênticos em comportamento · cache do SW bumpado quando o shell muda.
