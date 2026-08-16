/* ══════════════════════════════════════════════════════════════════════════
   SERVICE WORKER — escrito à mão.

   Sem next-pwa/workbox de propósito: a superfície é pequena e o comportamento
   fica explícito. Três estratégias:

   · navegação (HTML)  → network-first, cai para o cache e depois /offline
   · /_next/static/*   → cache-first (o nome do arquivo já carrega o hash)
   · demais GET        → stale-while-revalidate

   POST/PUT nunca são cacheados e /api/* sempre vai à rede — é por lá que passa
   o login, e servir sessão de cache seria pior do que ficar offline.

   ESTE APP FUNCIONA OFFLINE DE VERDADE: os dados vivem no localStorage, não
   num servidor. Por isso TODAS as abas entram no precache — sem elas, abrir
   uma aba ainda não visitada no avião cairia na tela de "sem conexão" mesmo
   com todos os dados na mão. Aba nova, linha nova em ROTAS.
   ══════════════════════════════════════════════════════════════════════════ */

/* Subir a versão invalida todos os caches antigos no `activate`. */
const VERSAO = "central-animal-v8";
const CACHE_SHELL = `${VERSAO}-shell`;
const CACHE_ESTATICO = `${VERSAO}-static`;
const CACHE_DINAMICO = `${VERSAO}-dyn`;

const OFFLINE = "/offline";
const ROTAS = ["/", "/fila", "/base", "/perfil"];
const PRECACHE = [OFFLINE, "/manifest.webmanifest", ...ROTAS];

/**
 * Resposta que pode entrar no cache.
 *
 * `redirected` é a parte que importa: quando a sessão expira, uma rota
 * protegida responde 307 para /login. Guardar isso quebraria a navegação de
 * duas formas — o navegador recusa servir resposta redirecionada para um
 * pedido de navegação, e o usuário ficaria preso no login mesmo depois de
 * entrar de novo.
 */
const cacheavel = (res) => res && res.ok && res.type === "basic" && !res.redirected;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_SHELL);
      // uma a uma: `addAll` aborta tudo se UM recurso falhar, e aqui as rotas
      // são protegidas por sessão — uma delas falhar é normal
      await Promise.all(
        PRECACHE.map(async (rota) => {
          try {
            const res = await fetch(rota, { credentials: "same-origin" });
            if (cacheavel(res)) await cache.put(rota, res);
          } catch {
            /* melhor-esforço: falhar aqui não pode travar a instalação */
          }
        }),
      );
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const nomes = await caches.keys();
      await Promise.all(nomes.filter((n) => !n.startsWith(VERSAO)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // login e afins sempre na rede
  // Discador/admin (proxied pro Mastra) tem SW proprio em `/discador/sw.js`: o
  // SW do painel nao pode interceptar a porta/assets/SW do discador.
  if (url.pathname === "/discador" || url.pathname.startsWith("/discador/") || url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return;

  /* 1) Navegação — network-first */
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (cacheavel(res)) {
            const cache = await caches.open(CACHE_DINAMICO);
            cache.put(req, res.clone());
          }
          return res;
        } catch {
          const dyn = await caches.open(CACHE_DINAMICO);
          const salvo = (await dyn.match(req)) ?? (await caches.match(url.pathname));
          if (salvo) return salvo;
          const shell = await caches.open(CACHE_SHELL);
          return (await shell.match(OFFLINE)) ?? Response.error();
        }
      })(),
    );
    return;
  }

  /* 2) Estáticos versionados — cache-first */
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icones/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_ESTATICO);
        const salvo = await cache.match(req);
        if (salvo) return salvo;
        const res = await fetch(req);
        if (cacheavel(res)) cache.put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  /* 3) Resto — stale-while-revalidate */
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_DINAMICO);
      const salvo = await cache.match(req);
      const rede = fetch(req)
        .then((res) => {
          if (cacheavel(res)) cache.put(req, res.clone());
          return res;
        })
        .catch(() => salvo ?? Response.error());
      return salvo ?? rede;
    })(),
  );
});
