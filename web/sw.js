const CACHE='discador-v32';
const SHELL=['/','/app.js','/manifest.webmanifest','/icon.svg'];
self.addEventListener('install',function(e){e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(SHELL);}).then(function(){return self.skipWaiting();}));});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
// NETWORK-FIRST: online sempre pega a última versão do shell (atualiza o cache);
// offline cai no cache. Evita servir app.js velho a cada mudança. /api/ passa direto.
self.addEventListener('fetch',function(e){var u=new URL(e.request.url);if(u.pathname.indexOf('/api/')===0){return;}e.respondWith(fetch(e.request).then(function(r){if(r&&r.ok&&e.request.method==='GET'){var cp=r.clone();caches.open(CACHE).then(function(c){c.put(e.request,cp);});}return r;}).catch(function(){return caches.match(e.request);}));});
