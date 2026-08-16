// Assets estaticos do PWA Discador (servidos por rotas no index.ts). Mantidos
// como strings pra nao depender de static-file middleware do Mastra/Hono.
// app.js e escrito SEM template literals / ${...} de proposito, pra poder viver
// dentro destas template strings sem escape.

export const DISCADOR_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#29c5f6"/><stop offset="1" stop-color="#007bff"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#g)"/><path d="M356 300c-14-3-25-8-35-13-8-4-17-2-23 4l-16 16c-40-22-73-55-95-95l16-16c6-6 8-15 4-23-5-10-10-21-13-35-2-11-12-19-23-19h-36c-13 0-24 11-22 25 7 55 31 106 70 145s90 63 145 70c14 2 25-9 25-22v-36c0-11-8-21-19-23z" fill="#fff"/></svg>`;

export const DISCADOR_MANIFEST = JSON.stringify({
  name: 'Discador USI',
  short_name: 'Discador',
  description: 'Discador da fila de ligações do dia — RomeroCall',
  start_url: '/discador',
  scope: '/discador',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#050a14',
  theme_color: '#007bff',
  icons: [
    { src: '/discador/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
  ],
});

// CACHE bump (discador-v23 -> discador-v24): deep-link de gestor agora volta pra
// FILA DELE no painel (retornoPainel = panelUrl + /fila), nao pra fila do
// discador — app.js mudou, precisa propagar. quick-260816-u7
export const DISCADOR_SW_JS = `const CACHE='discador-v24';
const SHELL=['/discador','/discador/app.js','/discador/manifest.webmanifest','/discador/icon.svg'];
self.addEventListener('install',function(e){e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(SHELL);}).then(function(){return self.skipWaiting();}));});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener('fetch',function(e){var u=new URL(e.request.url);if(u.pathname.indexOf('/api/')===0){return;}e.respondWith(caches.match(e.request).then(function(r){return r||fetch(e.request);}));});`;

export const DISCADOR_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#04122a">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Discador USI</title>
<link rel="manifest" href="/discador/manifest.webmanifest">
<link rel="apple-touch-icon" href="/discador/icon.svg">
<link rel="icon" href="/discador/icon.svg">
<style>
  :root{
    --bg:#04122a;--ink:#ffffff;--dim:#93aacb;--dim-2:#6e86a8;
    --romero:#3d8bff;--andreza:#f5c43d;--alert:#ff6b6b;
    --line:rgba(255,255,255,.1);--card:rgba(255,255,255,.055);--card-2:rgba(255,255,255,.085);
    --hair-top:rgba(255,255,255,.14);--hair-side:rgba(255,255,255,.06);
    --accent:linear-gradient(90deg,#3d8bff,#2bb6a0)
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{height:100%}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
  body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(1100px 700px at 12% -8%,#123a6b,transparent 58%),radial-gradient(900px 600px at 92% 4%,#0b2f5c,transparent 52%),linear-gradient(178deg,#04122a 0%,#0a2547 55%,#061b36 100%)}
  .wrap{max-width:640px;margin:0 auto;min-height:100dvh;display:flex;flex-direction:column}
  header{position:sticky;top:0;z-index:5;padding:calc(14px + env(safe-area-inset-top)) 16px 12px 16px;background:rgba(4,18,42,.55);-webkit-backdrop-filter:blur(14px) saturate(160%);backdrop-filter:blur(14px) saturate(160%);border-bottom:1px solid var(--line)}
  header .row{display:flex;align-items:center;gap:10px}
  header h1{font-size:18px;margin:0;flex:1;font-weight:800;letter-spacing:-.01em}
  .pill{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.12em;padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:var(--card)}
  input,button{font-size:16px;font-family:inherit}
  main{flex:1;padding:14px 16px calc(24px + env(safe-area-inset-bottom))}
  .muted{color:var(--dim);text-align:center;padding:16px;font-size:14px}
  .ghost{background:none;border:0;color:var(--dim);padding:8px;border-radius:10px}
  .ghost:active{background:var(--card)}
  /* card da proxima ligacao (uma-por-vez — D-P2-08) */
  .card-ligacao{position:relative;border-radius:18px;padding:18px;background:var(--card);-webkit-backdrop-filter:blur(16px) saturate(180%);backdrop-filter:blur(16px) saturate(180%);border-top:1px solid var(--hair-top);border-left:1px solid var(--hair-side);border-right:1px solid var(--hair-side);border-bottom:1px solid rgba(255,255,255,.05);box-shadow:0 8px 32px rgba(2,6,16,.5)}
  .lig-head{display:flex;align-items:center;gap:12px;margin-bottom:16px}
  .lig-avatar{width:54px;height:54px;border-radius:50%;background:linear-gradient(150deg,#3d8bff,#1b4fa0);display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;flex:0 0 auto;text-transform:uppercase;font-size:18px;box-shadow:0 6px 18px rgba(61,139,255,.35)}
  .lig-info{flex:1;min-width:0}
  .lig-nome{font-size:19px;font-weight:800;text-transform:capitalize;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em}
  .lig-tel{color:var(--dim);margin-top:2px}
  .lig-script-wrap{margin-bottom:16px}
  .lig-script-label{font-size:10px;color:var(--romero);text-transform:uppercase;letter-spacing:.16em;margin-bottom:8px}
  .lig-script{background:rgba(255,255,255,.03);border:1px solid var(--line);border-left:3px solid var(--romero);border-radius:11px;padding:12px 14px;font-size:14px;line-height:1.55;white-space:pre-wrap}
  .loadmore{width:100%;background:var(--card-2);color:var(--ink);border:1px solid var(--line);border-radius:11px;padding:13px;margin-top:10px;font-weight:600}
  .loadmore:active{background:rgba(255,255,255,.10)}
  .call-lg{margin-top:0;padding:16px;font-size:17px}
  /* fila ao vivo: lista de todas as ligacoes pendentes (LIVE-QUEUE) */
  .fila-item{position:relative;display:flex;align-items:center;gap:12px;border-radius:16px;padding:14px 16px;margin-bottom:12px;background:var(--card);-webkit-backdrop-filter:blur(16px) saturate(180%);backdrop-filter:blur(16px) saturate(180%);border-top:1px solid var(--hair-top);border-left:1px solid var(--hair-side);border-right:1px solid var(--hair-side);border-bottom:1px solid rgba(255,255,255,.05);box-shadow:0 6px 22px rgba(2,6,16,.4)}
  .fila-item:active{transform:translateY(1px)}
  .fila-item .lig-info{flex:1;min-width:0}
  .fila-item .fila-ligar{flex:0 0 auto;width:auto;padding:11px 20px;font-size:14px}
  /* login */
  #login-view{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;overflow:hidden;padding:calc(24px + env(safe-area-inset-top)) 20px calc(24px + env(safe-area-inset-bottom));width:100%}
  #login-view .patinhas-bg{position:absolute;inset:0;pointer-events:none}
  #login-view .patinhas-bg span{position:absolute;color:var(--romero);opacity:.06}
  #login-view .login-shell{width:100%;max-width:360px}
  #login-view .lblk{background:rgba(255,255,255,.055);border:1px solid var(--line);border-radius:22px;padding:26px 20px 22px;animation:reveal-up 520ms cubic-bezier(.2,.9,.3,1.2)}
  #login-view .lblk-marca{display:grid;place-items:center;text-align:center}
  #login-view .marca-58{width:58px;height:58px;border-radius:14px;background:linear-gradient(150deg,#3d8bff,#1b4fa0);display:grid;place-items:center;box-shadow:0 6px 22px -8px rgba(61,139,255,.45)}
  #login-view h1{margin-top:14px;font-size:22px;font-weight:800;letter-spacing:-.03em}
  #login-view .dim{margin-top:6px;font-size:12px;color:var(--dim)}
  #login-view .row{display:flex;align-items:center;gap:8px;margin-top:14px}
  #login-view .tag{font-size:11px;font-weight:700;border-radius:20px;padding:5px 10px;letter-spacing:.04em;text-transform:uppercase;background:rgba(255,255,255,.07);color:var(--dim)}
  #login-view .tag.pe{background:rgba(61,139,255,.16);color:#8fbeff}
  #login-view .tag.t3{background:rgba(245,196,61,.16);color:var(--andreza)}
  #login-view .login-form{margin-top:22px;display:grid;gap:12px}
  #login-view .flabel{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim-2);font-weight:700;margin-bottom:9px}
  #login-view .field{background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:12px;padding:14px 16px;color:var(--ink);width:100%;display:block;font-size:16px}
  #login-view .field::placeholder{color:var(--dim-2)}
  #login-view .field:focus{outline:none;border-color:var(--romero)}
  #login-view .pw-wrap{position:relative;display:block}
  #login-view .pw-wrap .field{padding-right:44px}
  #login-view .pw-eye{position:absolute;right:10px;top:50%;transform:translateY(-50%);color:var(--dim-2);display:inline-flex;background:none;border:0;padding:0}
  #login-view .autobox.warn{background:rgba(255,107,107,.09);border:1px solid rgba(255,107,107,.28);border-radius:14px;padding:12px 14px;display:flex;gap:8px;align-items:center;margin-top:2px}
  #login-view .autobox.warn svg{color:var(--alert);flex:none}
  #login-view .autobox .ab{font-size:13px;color:#edc5c5;line-height:1.5;margin-top:0}
  #login-view #login-err-box:has(#login-err:empty){display:none}
  #login-view .cta{width:100%;border-radius:15px;padding:16px;text-align:center;font-size:16px;font-weight:800;background:var(--accent);color:#04122a;border:0;margin-top:2px}
  #login-view .cta:active{transform:scale(.985)}
  #login-view .dim2{text-align:center;margin-top:14px;font-size:11px;color:var(--dim-2);animation:fade-in 700ms 500ms backwards}
  @keyframes reveal-up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  @keyframes fade-in{from{opacity:0}to{opacity:1}}
  .field{padding:14px 16px;border-radius:14px;border:1px solid var(--line);background:var(--card);color:var(--ink);width:100%;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
  .field::placeholder{color:var(--dim-2)}
  .field:focus{outline:none;border-color:rgba(61,139,255,.6);box-shadow:0 0 0 3px rgba(61,139,255,.18)}
  .primary{background:var(--accent);color:var(--bg);border:0;border-radius:14px;padding:14px;font-weight:800;width:100%;box-shadow:0 8px 22px rgba(61,139,255,.38);letter-spacing:.01em}
  .primary:active{transform:translateY(1px);box-shadow:0 4px 14px rgba(61,139,255,.32)}
  .err{color:#ff9b9b;text-align:center;font-size:14px;min-height:18px}
  /* call overlay — leve durante chamadas longas (avatar no meio, controles embaixo) */
  #call-overlay{position:fixed;inset:0;display:none;flex-direction:column;align-items:center;justify-content:space-between;z-index:20;padding:calc(52px + env(safe-area-inset-top)) 24px calc(40px + env(safe-area-inset-bottom));background:radial-gradient(600px 500px at 50% 12%,rgba(61,139,255,.22),transparent 60%),radial-gradient(520px 460px at 50% 108%,rgba(61,139,255,.12),transparent 60%),linear-gradient(180deg,#0a2547,#04122a)}
  .call-top{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
  #call-avatar{width:124px;height:124px;border-radius:50%;background:linear-gradient(150deg,#3d8bff,#1b4fa0);display:flex;align-items:center;justify-content:center;font-size:46px;font-weight:800;color:#fff;margin-bottom:22px;box-shadow:0 14px 40px rgba(61,139,255,.4);text-transform:uppercase}
  #call-nome{font-size:26px;font-weight:800;text-transform:capitalize;letter-spacing:-.01em}
  #call-tel{color:var(--dim);margin-top:2px}
  #call-status{margin-top:16px;font-size:14px;color:var(--romero);letter-spacing:.14em;text-transform:uppercase}
  #call-timer{font-size:20px;font-variant-numeric:tabular-nums;margin-top:6px;color:var(--dim)}
  /* script visivel durante a chamada (SCRIPT-IN-OVERLAY) — rolavel p/ chamadas de 30-90min */
  .call-script{width:100%;max-width:560px;max-height:38vh;overflow:auto;white-space:pre-wrap;background:rgba(255,255,255,.03);border:1px solid var(--line);border-left:3px solid var(--romero);border-radius:11px;padding:12px 14px;font-size:14px;line-height:1.55;margin:8px 0;flex:0 0 auto}
  .call-controls{display:flex;align-items:center;justify-content:center;gap:48px}
  .ctrl{display:flex;flex-direction:column;align-items:center;gap:8px;background:none;border:0;color:var(--dim);font-size:13px;font-weight:600}
  .ctrl .ic{width:68px;height:68px;border-radius:50%;background:var(--card-2);border:1px solid var(--line);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:center;font-size:26px;transition:background .15s,color .15s,transform .15s}
  .ctrl.hangup .ic{background:var(--alert);border-color:var(--alert);color:#fff;transform:rotate(135deg);box-shadow:0 10px 26px rgba(255,107,107,.45)}
  .ctrl.hangup:active .ic{transform:rotate(135deg) scale(.94)}
  /* preview do lead antes de ligar (CONTEXTO + SCRIPT) — estilo cartao de contato iOS, quick 260813-n46 */
  #preview-overlay{position:fixed;inset:0;display:none;z-index:20;overflow:auto;padding:calc(20px + env(safe-area-inset-top)) 20px calc(28px + env(safe-area-inset-bottom));background:radial-gradient(600px 500px at 50% 8%,rgba(61,139,255,.18),transparent 60%),linear-gradient(180deg,#0a2547,#04122a)}
  .preview-card{width:100%;max-width:560px;margin:0 auto}
  .preview-voltar{width:40px;height:40px;border-radius:50%;background:var(--card);display:flex;align-items:center;justify-content:center;font-size:18px;padding:0;margin-bottom:18px}
  .preview-voltar:active{background:var(--card-2)}
  #preview-overlay .lig-head{display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px;margin-bottom:20px}
  #preview-overlay .lig-info{flex:none;min-width:0;text-align:center}
  #preview-avatar{width:130px;height:130px;font-size:42px}
  #preview-nome{font-size:23px}
  #preview-tel{font-size:15px}
  #preview-ligar{display:block;width:fit-content;min-width:190px;min-height:52px;margin:0 auto 22px;padding:15px 30px;font-size:16px;border-radius:999px}
  .preview-info-card{border-radius:18px;background:var(--card);-webkit-backdrop-filter:blur(16px) saturate(180%);backdrop-filter:blur(16px) saturate(180%);border-top:1px solid var(--hair-top);border-left:1px solid var(--hair-side);border-right:1px solid var(--hair-side);border-bottom:1px solid rgba(255,255,255,.05);box-shadow:0 8px 32px rgba(2,6,16,.5);overflow:hidden}
  .preview-info-card .lig-script-wrap{margin-bottom:0;padding:16px}
  .preview-info-card .lig-script-wrap+.lig-script-wrap{border-top:1px solid var(--line)}
  #preview-contexto,#preview-script{max-height:31vh}
  /* pos-ligacao: confirmacao de voto (grava na Lista 01 LEADS) */
  #voto-overlay{position:fixed;inset:0;display:none;z-index:25;align-items:center;justify-content:center;padding:24px 20px calc(24px + env(safe-area-inset-bottom));background:radial-gradient(600px 500px at 50% 8%,rgba(61,139,255,.18),transparent 60%),linear-gradient(180deg,#0a2547,#04122a);overflow:auto}
  .voto-card{width:100%;max-width:460px;border-radius:22px;padding:22px;background:var(--card);-webkit-backdrop-filter:blur(16px) saturate(180%);backdrop-filter:blur(16px) saturate(180%);border-top:1px solid var(--hair-top);border-left:1px solid var(--hair-side);border-right:1px solid var(--hair-side);border-bottom:1px solid rgba(255,255,255,.05);box-shadow:0 8px 32px rgba(2,6,16,.5)}
  .voto-title{font-size:20px;font-weight:800;letter-spacing:-.01em}
  .voto-sub{color:var(--dim);margin:2px 0 18px;text-transform:capitalize}
  .voto-q{margin-bottom:18px}
  .voto-label{font-size:14px;margin-bottom:10px}
  .voto-label b{color:var(--romero);font-weight:800}
  #voto-q-romero .voto-label b{color:var(--romero)}
  #voto-q-andressa .voto-label b{color:var(--andreza)}
  .seg{display:flex;gap:8px}
  .seg-btn{flex:1;padding:12px 6px;border-radius:11px;border:1px solid var(--line);background:var(--card-2);color:var(--ink);font-weight:600;font-size:13px;transition:background .15s,border-color .15s,box-shadow .15s}
  .seg-btn.sel{background:#3d8bff;color:#04122a;border-color:transparent;font-weight:800;box-shadow:0 6px 16px rgba(61,139,255,.35)}
  #voto-salvar{margin-top:4px}
  #voto-pular{margin-top:10px;background:none}
</style>
</head>
<body>
<div class="wrap">
  <div id="login-view" style="display:none">
    <div class="patinhas-bg" aria-hidden="true">
      <span style="left:10%;top:12%;transform:rotate(-22deg)"><svg viewBox="0 0 48 48" fill="currentColor" width="118" height="118" aria-hidden="true"><ellipse cx="8.8" cy="17.4" rx="4.3" ry="5.4" transform="rotate(-24 8.8 17.4)"/><ellipse cx="39.2" cy="17.4" rx="4.3" ry="5.4" transform="rotate(24 39.2 17.4)"/><ellipse cx="18.6" cy="10.6" rx="4.6" ry="6" transform="rotate(-8 18.6 10.6)"/><ellipse cx="29.4" cy="10.6" rx="4.6" ry="6" transform="rotate(8 29.4 10.6)"/><path d="M24 24.6c7.1 0 12.9 5.3 12.9 11.2 0 4.2-3.4 6.8-7.6 6.8-2 0-3.5-.6-5.3-.6s-3.3.6-5.3.6c-4.2 0-7.6-2.6-7.6-6.8C11.1 29.9 16.9 24.6 24 24.6Z"/></svg></span>
      <span style="left:78%;top:8%;transform:rotate(16deg)"><svg viewBox="0 0 48 48" fill="currentColor" width="84" height="84" aria-hidden="true"><ellipse cx="8.8" cy="17.4" rx="4.3" ry="5.4" transform="rotate(-24 8.8 17.4)"/><ellipse cx="39.2" cy="17.4" rx="4.3" ry="5.4" transform="rotate(24 39.2 17.4)"/><ellipse cx="18.6" cy="10.6" rx="4.6" ry="6" transform="rotate(-8 18.6 10.6)"/><ellipse cx="29.4" cy="10.6" rx="4.6" ry="6" transform="rotate(8 29.4 10.6)"/><path d="M24 24.6c7.1 0 12.9 5.3 12.9 11.2 0 4.2-3.4 6.8-7.6 6.8-2 0-3.5-.6-5.3-.6s-3.3.6-5.3.6c-4.2 0-7.6-2.6-7.6-6.8C11.1 29.9 16.9 24.6 24 24.6Z"/></svg></span>
      <span style="left:82%;top:74%;transform:rotate(-8deg)"><svg viewBox="0 0 48 48" fill="currentColor" width="138" height="138" aria-hidden="true"><ellipse cx="8.8" cy="17.4" rx="4.3" ry="5.4" transform="rotate(-24 8.8 17.4)"/><ellipse cx="39.2" cy="17.4" rx="4.3" ry="5.4" transform="rotate(24 39.2 17.4)"/><ellipse cx="18.6" cy="10.6" rx="4.6" ry="6" transform="rotate(-8 18.6 10.6)"/><ellipse cx="29.4" cy="10.6" rx="4.6" ry="6" transform="rotate(8 29.4 10.6)"/><path d="M24 24.6c7.1 0 12.9 5.3 12.9 11.2 0 4.2-3.4 6.8-7.6 6.8-2 0-3.5-.6-5.3-.6s-3.3.6-5.3.6c-4.2 0-7.6-2.6-7.6-6.8C11.1 29.9 16.9 24.6 24 24.6Z"/></svg></span>
      <span style="left:6%;top:78%;transform:rotate(24deg)"><svg viewBox="0 0 48 48" fill="currentColor" width="94" height="94" aria-hidden="true"><ellipse cx="8.8" cy="17.4" rx="4.3" ry="5.4" transform="rotate(-24 8.8 17.4)"/><ellipse cx="39.2" cy="17.4" rx="4.3" ry="5.4" transform="rotate(24 39.2 17.4)"/><ellipse cx="18.6" cy="10.6" rx="4.6" ry="6" transform="rotate(-8 18.6 10.6)"/><ellipse cx="29.4" cy="10.6" rx="4.6" ry="6" transform="rotate(8 29.4 10.6)"/><path d="M24 24.6c7.1 0 12.9 5.3 12.9 11.2 0 4.2-3.4 6.8-7.6 6.8-2 0-3.5-.6-5.3-.6s-3.3.6-5.3.6c-4.2 0-7.6-2.6-7.6-6.8C11.1 29.9 16.9 24.6 24 24.6Z"/></svg></span>
    </div>
    <div class="login-shell">
      <div class="lblk">
        <div class="lblk-marca">
          <span class="marca-58"><svg viewBox="0 0 48 48" fill="#04122a" width="36" height="36" aria-hidden="true"><ellipse cx="8.8" cy="17.4" rx="4.3" ry="5.4" transform="rotate(-24 8.8 17.4)"/><ellipse cx="39.2" cy="17.4" rx="4.3" ry="5.4" transform="rotate(24 39.2 17.4)"/><ellipse cx="18.6" cy="10.6" rx="4.6" ry="6" transform="rotate(-8 18.6 10.6)"/><ellipse cx="29.4" cy="10.6" rx="4.6" ry="6" transform="rotate(8 29.4 10.6)"/><path d="M24 24.6c7.1 0 12.9 5.3 12.9 11.2 0 4.2-3.4 6.8-7.6 6.8-2 0-3.5-.6-5.3-.6s-3.3.6-5.3.6c-4.2 0-7.6-2.6-7.6-6.8C11.1 29.9 16.9 24.6 24 24.6Z"/></svg></span>
          <h1>Central Animal</h1>
          <p class="dim">Sistema de relacionamento direto</p>
          <div class="row">
            <span class="tag pe">Romero · 40000</span>
            <span class="tag t3">Andreza · 4020</span>
          </div>
        </div>
        <div class="login-form">
          <div>
            <div class="flabel">Usuário</div>
            <input id="u" class="field" placeholder="usuário" autocapitalize="none" autocomplete="username" autocorrect="off" spellcheck="false">
          </div>
          <div>
            <div class="flabel">Senha</div>
            <span class="pw-wrap">
              <input id="p" class="field" type="password" autocomplete="current-password">
              <button type="button" class="pw-eye" aria-label="Mostrar senha" onclick="var p=document.getElementById('p'),v=p.type==='password';p.type=v?'text':'password';this.setAttribute('aria-label',v?'Ocultar senha':'Mostrar senha');this.querySelector('.eye-on').style.display=v?'none':'inline-block';this.querySelector('.eye-off').style.display=v?'inline-block':'none';"><svg class="eye-on" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg><svg class="eye-off" style="display:none" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg></button>
            </span>
          </div>
          <div id="login-err-box" class="autobox warn" role="alert">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
            <span id="login-err" class="ab"></span>
          </div>
          <button id="login-btn" type="button" class="cta">Entrar</button>
        </div>
      </div>
      <p class="dim2">Acesso restrito à equipe do gabinete.</p>
    </div>
  </div>

  <div id="fila-view" style="display:none">
    <header>
      <div class="row">
        <h1>Fila de ligações</h1>
        <span id="fila-contador" class="pill"></span>
        <button id="reload-btn" class="ghost">↻</button>
        <button id="logout-btn" class="ghost">Sair</button>
      </div>
    </header>
    <main>
      <div id="fila-status" class="muted" style="display:none"></div>
      <div id="fila-lista"></div>
    </main>
  </div>

  <div id="preview-overlay">
    <div class="preview-card">
      <button id="preview-voltar" class="ghost preview-voltar" type="button">←</button>
      <div class="lig-head">
        <div id="preview-avatar" class="lig-avatar"></div>
        <div class="lig-info">
          <div id="preview-nome" class="lig-nome"></div>
          <div id="preview-tel" class="lig-tel"></div>
        </div>
      </div>
      <button id="preview-ligar" class="primary call-lg" type="button">\u{1F4DE} Ligar</button>
      <div class="preview-info-card">
        <div class="lig-script-wrap">
          <div class="lig-script-label">Contexto</div>
          <div id="preview-contexto" class="call-script"></div>
        </div>
        <div class="lig-script-wrap">
          <div class="lig-script-label">Script</div>
          <div id="preview-script" class="call-script"></div>
        </div>
      </div>
    </div>
  </div>

  <div id="call-overlay">
    <div class="call-top">
      <div id="call-avatar"></div>
      <div id="call-nome"></div>
      <div id="call-tel"></div>
      <div id="call-status"></div>
      <div id="call-timer"></div>
    </div>
    <div id="call-script" class="call-script"></div>
    <div class="call-controls">
      <button id="hangup-btn" class="ctrl hangup" aria-label="Desligar"><span class="ic">\u{1F4DE}</span></button>
    </div>
  </div>

  <div id="voto-overlay">
    <div class="voto-card">
      <div class="voto-title">Confirmação de voto</div>
      <div id="voto-nome" class="voto-sub"></div>
      <div class="voto-q" id="voto-q-romero">
        <div class="voto-label">Confirmou voto no <b>Romero</b>?</div>
        <div class="seg" data-cand="romero">
          <button type="button" class="seg-btn" data-v="sim">Sim</button>
          <button type="button" class="seg-btn" data-v="nao">Não</button>
          <button type="button" class="seg-btn" data-v="naoDeclarou">Não declarou</button>
        </div>
      </div>
      <div class="voto-q" id="voto-q-andressa">
        <div class="voto-label">Confirmou voto na <b>Andressa</b>?</div>
        <div class="seg" data-cand="andressa">
          <button type="button" class="seg-btn" data-v="sim">Sim</button>
          <button type="button" class="seg-btn" data-v="nao">Não</button>
          <button type="button" class="seg-btn" data-v="naoDeclarou">Não declarou</button>
        </div>
      </div>
      <div id="voto-err" class="err"></div>
      <button id="voto-salvar" class="primary">Salvar</button>
      <button id="voto-pular" class="loadmore">Pular</button>
    </div>
  </div>
</div>
<script src="/discador/app.js"></script>
</body>
</html>`;

export const DISCADOR_APP_JS = `(function(){
  var tokenKey='discador_token';
  var wavoip=null, currentCall=null, wavoipToken=null, wantHangup=false;
  var fila=null, filaPollInt=null;
  var timerInt=null, timerStart=0;
  var wakeLock=null, emChamada=false, retornoPainel=null;
  var foiAtendida=false, desfechoEnviado=false, chamadaTaskId=null, votoAtualTaskId=null, votoSel={romero:null,andressa:null};
  var previewAtualItem=null;
  // Multi-device pool (DEVICE-02): deviceModo aprendido uma vez via /config
  // ('dedicado'|'pool'|'global'); leaseDeviceId guarda o device alocado na
  // chamada corrente (so em modo pool) pra devolver ao fim. dedicadoDeviceId
  // (DEVICE-03) guarda o deviceId de /config quando modo='dedicado' — os
  // dois alimentam deviceIdCorrente() pro /ligando desambiguar a task ativa.
  var deviceModo=null, leaseDeviceId=null, dedicadoDeviceId=null;
  function initials(s){var n=(s||'').trim();if(!n){return '#';}var p=n.split(' ').filter(Boolean);var a=p[0]?p[0].charAt(0):'';var b=p.length>1?p[p.length-1].charAt(0):'';return (a+b).toUpperCase();}
  function $(id){return document.getElementById(id);}
  function getToken(){return localStorage.getItem(tokenKey)||'';}
  function setToken(t){if(t){localStorage.setItem(tokenKey,t);}else{localStorage.removeItem(tokenKey);}}
  // Handoff do app mobile (quick-260815-r3): o token e o taskId chegam no
  // FRAGMENTO (#token=...&task=...) — fragmento nao vai ao servidor (nao aparece
  // em log/Referer). Le so 'token' e 'task'; ignora o resto.
  function lerParamsDoHash(){var h=(location.hash||'').replace(/^#/,'');var out={};if(!h){return out;}var ps=h.split('&');for(var i=0;i<ps.length;i++){var kv=ps[i].split('=');var k=kv[0];var v=kv.length>1?decodeURIComponent(kv[1]):'';if(k==='token'){out.token=v;}else if(k==='task'){out.task=v;}}return out;}
  function show(v){$('login-view').style.display=(v==='login')?'flex':'none';$('fila-view').style.display=(v==='fila')?'block':'none';}
  function api(path){
    var opts={headers:{}};var t=getToken();if(t){opts.headers['Authorization']='Bearer '+t;}
    return fetch(path,opts).then(function(res){if(res.status===401){setToken('');show('login');throw new Error('401');}return res;});
  }
  // POST autenticado (D-P3-01) — mesmo tratamento de token/401 de api().
  function apiPost(path,body){
    var t=getToken();var opts={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})};
    if(t){opts.headers['Authorization']='Bearer '+t;}
    return fetch(path,opts).then(function(res){if(res.status===401){setToken('');show('login');throw new Error('401');}return res;});
  }
  function doLogin(){
    var u=$('u').value.trim(), p=$('p').value;$('login-err').textContent='';
    fetch('/api/discador/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuario:u,senha:p})})
    .then(function(res){return res.json().then(function(j){return {ok:res.ok,j:j};});})
    .then(function(r){if(!r.ok||!r.j.token){$('login-err').textContent='Usuário ou senha inválidos.';return;}setToken(r.j.token);$('p').value='';if(r.j.papel==='gestor'&&irParaPainel(r.j.token,r.j.panelUrl)){return;}startFila();})
    .catch(function(){$('login-err').textContent='Erro ao entrar.';});
  }
  function startFila(){show('fila');carregarFila();}
  // Porta unica (quick 260816-u5): o discador e a porta de todos. O GESTOR logado
  // e mandado pro painel dele, ja logado (token no FRAGMENTO — nao vai ao servidor
  // nem a log/Referer). panelUrl vazio (painel nao configurado) -> retorna false e
  // o front cai na fila (degrada, nao quebra). Regex sem backslash de proposito
  // (/[/]+$/) pra sobreviver identica dentro de DISCADOR_APP_JS (template literal).
  function irParaPainel(token,panelUrl){if(!panelUrl){return false;}window.location.href=panelUrl.replace(/[/]+$/,'')+'/login#token='+encodeURIComponent(token);return true;}
  // Fila do operador logado (Lista 02 ClickUp — LOTE-04). Substitui a antiga
  // lista rolável do GHL QUALIFICADO (D-P2-07): /api/discador/qualificados
  // NAO e mais chamada por esta tela.
  function mostrarStatus(msg){$('fila-lista').style.display='none';$('fila-status').textContent=msg;$('fila-status').style.display='block';}
  // Uma-por-vez (D-P2-08): renderiza SO o proximo lead (itens[0]). O backend
  // continua mandando a fila inteira, mas so exibimos o primeiro — ao desfechar,
  // o proximo poll refetcha e o de baixo sobe. Nome/telefone via textContent
  // (sem XSS, sem escaping) — nunca innerHTML/template literal.
  function renderFila(itens){
    if(!itens||!itens.length){
      $('fila-contador').textContent='';
      mostrarStatus('Sem ligações na sua fila hoje.');
      return;
    }
    $('fila-status').style.display='none';
    $('fila-contador').textContent='Próxima ligação';
    var lista=$('fila-lista');
    lista.textContent='';
    lista.style.display='block';
    lista.appendChild(criarItemFila(itens[0]));
  }
  function criarItemFila(item){
    var row=document.createElement('div');row.className='fila-item';
    var av=document.createElement('div');av.className='lig-avatar';av.textContent=initials(item.nome||item.telefone);
    var info=document.createElement('div');info.className='lig-info';
    var nome=document.createElement('div');nome.className='lig-nome';nome.textContent=item.nome||item.telefone;
    var tel=document.createElement('div');tel.className='lig-tel';tel.textContent=item.telefone;
    info.appendChild(nome);info.appendChild(tel);
    var btn=document.createElement('button');btn.className='primary fila-ligar';btn.textContent='Ligar';
    btn.onclick=function(){abrirPreview(item);};
    row.appendChild(av);row.appendChild(info);row.appendChild(btn);
    return row;
  }
  function carregarFila(){
    mostrarStatus('Carregando fila...');
    buscarFila(false);
  }
  // Poll silencioso (~15s + pos-fluxo): NAO troca pra "Carregando fila..." (pra
  // nao piscar) e, em erro, mantem a lista atual (nao sobrescreve com mensagem).
  function carregarFilaSilencioso(){buscarFila(true);}
  function buscarFila(silencioso){
    api('/api/discador/fila').then(function(res){
      return res.json().catch(function(){return {};}).then(function(data){return {status:res.status,data:data};});
    }).then(function(r){
      if(r.status!==200){
        // Erro de carregamento e DISTINTO de fila vazia (WR-03/T-02-03-D) —
        // nunca mostra "sem ligações" quando na verdade a chamada falhou.
        if(!silencioso){mostrarStatus('Erro ao carregar a fila. Toque em ↻ para tentar de novo.');}
        return;
      }
      if(r.data.semMapeamento){
        if(!silencioso){mostrarStatus('Seu usuário ainda não está vinculado a um operador do ClickUp. Configure DISCADOR_ASSIGNEES.');}
        return;
      }
      fila=r.data.fila||[];
      renderFila(fila);
    }).catch(function(e){
      if(e&&e.message==='401'){return;}
      if(!silencioso){mostrarStatus('Erro ao carregar a fila. Toque em ↻ para tentar de novo.');}
    });
  }
  // Poll ~15s: NUNCA dispara durante uma chamada ativa (LOCKED: nao interromper).
  function pollFila(){if(emChamada){return;}carregarFilaSilencioso();}
  // Volta pra fila apos os pontos terminais do fluxo (chamada/voto) e refetcha
  // silenciosamente — a task recem-desfechada some da lista (ou reaparece se
  // ficou na fila por nao-atendida/hangup antes de atender).
  // MESMO ENDERECO (u7): se veio do painel (deep-link de gestor), volta pra FILA
  // DELE no painel — nao pra fila do discador. retornoPainel so e setado no init
  // quando /me diz gestor + panelUrl.
  function voltarParaFila(){$('call-overlay').style.display='none';$('voto-overlay').style.display='none';if(retornoPainel){window.location.href=retornoPainel;return;}carregarFilaSilencioso();}
  // Preview do lead antes de ligar (T-m3v): abre ao tocar "Ligar" na fila,
  // mostra CONTEXTO (dossie nativo) + SCRIPT; a chamada so comeca ao tocar
  // "Ligar" DENTRO do preview (delega pra iniciarLigacao existente).
  function abrirPreview(item){
    previewAtualItem=item;
    var av=$('preview-avatar');if(av){av.textContent=initials(item.nome||item.telefone);}
    $('preview-nome').textContent=item.nome||item.telefone;
    $('preview-tel').textContent=item.telefone;
    $('preview-contexto').textContent='Carregando contexto...';
    $('preview-script').textContent='Carregando script...';
    $('preview-overlay').style.display='block';
    carregarContextoDoPreview(item.taskId);
    carregarScriptDoPreview(item.taskId);
  }
  function fecharPreview(){$('preview-overlay').style.display='none';previewAtualItem=null;}
  // Botao "Voltar" do preview (u7): gestor vindo do painel volta pra fila DELE.
  function voltarDoPreview(){if(retornoPainel){window.location.href=retornoPainel;return;}fecharPreview();}
  // Deep-link &task (quick-260815-r3): abre o preview da Ligacao exata pelo
  // taskId vindo do handoff. Ownership validado no backend (GET /ligacao/:taskId,
  // CR-01) — status !=200 (ex. 404 de outro operador) so nao abre, sem erro.
  function abrirLigacaoPorTask(taskId){api('/api/discador/ligacao/'+encodeURIComponent(taskId)).then(function(res){return res.json().catch(function(){return {};}).then(function(d){return {status:res.status,data:d};});}).then(function(r){if(r.status===200&&r.data.ligacao){abrirPreview({taskId:taskId,nome:r.data.ligacao.nome,telefone:r.data.ligacao.telefone});}}).catch(function(){});}
  function carregarContextoDoPreview(taskId){
    var el=$('preview-contexto');if(!el){return;}
    api('/api/discador/contexto/'+encodeURIComponent(taskId)).then(function(res){
      return res.json().catch(function(){return {};}).then(function(data){return {status:res.status,data:data};});
    }).then(function(r){
      if(!previewAtualItem||previewAtualItem.taskId!==taskId){return;} // preview trocou/fechou enquanto carregava
      if(r.status!==200){el.textContent='Não foi possível carregar o contexto.';return;}
      if(r.data.temLead&&r.data.contexto){el.textContent=r.data.contexto;}else{el.textContent='Sem contexto disponível para este lead.';}
    }).catch(function(e){
      if(e&&e.message==='401'){return;}
      if(!previewAtualItem||previewAtualItem.taskId!==taskId){return;}
      el.textContent='Não foi possível carregar o contexto.';
    });
  }
  function carregarScriptDoPreview(taskId){
    var el=$('preview-script');if(!el){return;}
    api('/api/discador/ligacao/'+encodeURIComponent(taskId)).then(function(res){
      return res.json().catch(function(){return {};}).then(function(data){return {status:res.status,data:data};});
    }).then(function(r){
      if(!previewAtualItem||previewAtualItem.taskId!==taskId){return;} // preview trocou/fechou enquanto carregava
      if(r.status!==200||!r.data.ligacao){el.textContent='Não foi possível carregar o script.';return;}
      el.textContent=r.data.ligacao.script||'(sem script)';
    }).catch(function(e){
      if(e&&e.message==='401'){return;}
      if(!previewAtualItem||previewAtualItem.taskId!==taskId){return;}
      el.textContent='Não foi possível carregar o script.';
    });
  }
  // Script no overlay da chamada (SCRIPT-IN-OVERLAY): fetch on-demand ao abrir a
  // chamada (nao mais por item da lista) — menos chamadas por poll.
  function carregarScriptDaChamada(taskId){
    var el=$('call-script');if(!el){return;}
    el.textContent='Carregando script...';
    api('/api/discador/ligacao/'+encodeURIComponent(taskId)).then(function(res){
      return res.json().catch(function(){return {};}).then(function(data){return {status:res.status,data:data};});
    }).then(function(r){
      if(chamadaTaskId!==taskId){return;} // outra chamada comecou enquanto carregava
      if(r.status!==200||!r.data.ligacao){el.textContent='Não foi possível carregar o script.';return;}
      el.textContent=r.data.ligacao.script||'(sem script)';
    }).catch(function(e){
      if(e&&e.message==='401'){return;}
      if(chamadaTaskId!==taskId){return;}
      el.textContent='Não foi possível carregar o script.';
    });
  }
  // Desfecho best-effort (RETENTION-BY-OUTCOME): idempotente por chamada
  // (desfechoEnviado, first-wins) — atendida so no peerAccept, recusou so no
  // peerReject. Nao-atendida/hangup (quick-260815-w6h) votam 'nao_atendida':
  // a task fica na fila mas e RE-ORDENADA (afunda pro fim) e o proximo lead
  // aparece; se 'atendida'/'recusou' ja venceu o guard, e no-op (nao sobrescreve).
  function enviarDesfecho(resultado){
    if(desfechoEnviado||!chamadaTaskId){return;}
    desfechoEnviado=true;
    apiPost('/api/discador/desfecho',{taskId:chamadaTaskId,resultado:resultado}).catch(function(){});
  }
  function instanciarWavoip(token){
    return import('https://esm.sh/@wavoip/wavoip-api@2.6.3').then(function(mod){
      var W=mod.Wavoip||(mod.default&&mod.default.Wavoip)||mod.default||mod;
      return new W({tokens:[token]});
    });
  }
  // Modo pool (DEVICE-02): lease de um device LIVRE no inicio da chamada —
  // cada chamada pode receber um device diferente, entao NAO reusa o
  // singleton 'wavoip' de dedicado/global. leaseDeviceId fica guardado pra
  // endCallUI devolver o device ao pool no fim (liberarDeviceDaChamada).
  function alocarDeviceELigar(){
    return apiPost('/api/discador/dispositivo/lease',{}).then(function(res){
      if(res.status===503){var e=new Error('sem device livre');e.semDeviceLivre=true;throw e;}
      return res.json();
    }).then(function(alocado){
      leaseDeviceId=alocado.deviceId;
      return instanciarWavoip(alocado.wavoipToken);
    });
  }
  // Devolve o device de pool alocado na chamada corrente (best-effort,
  // idempotente) — chamada de DENTRO de endCallUI, cobrindo TODOS os
  // caminhos de termino (ended/unanswered/peerReject/hangup/erro de discagem).
  function liberarDeviceDaChamada(){
    if(!leaseDeviceId){return;}
    var id=leaseDeviceId;leaseDeviceId=null;
    apiPost('/api/discador/dispositivo/release',{deviceId:id}).catch(function(){});
  }
  function garantirWavoip(){
    if((deviceModo==='dedicado'||deviceModo==='global')&&wavoip){return Promise.resolve(wavoip);}
    if(deviceModo===null){
      return api('/api/discador/config').then(function(res){return res.json();}).then(function(cfg){
        deviceModo=cfg.modo;
        if(deviceModo==='pool'){return alocarDeviceELigar();}
        if(deviceModo==='dedicado'){dedicadoDeviceId=cfg.deviceId||null;}
        wavoipToken=cfg.wavoipToken;if(!wavoipToken){throw new Error('sem token wavoip');}
        return instanciarWavoip(wavoipToken).then(function(w){wavoip=w;return wavoip;});
      });
    }
    return alocarDeviceELigar();
  }
  // DEVICE-03: deviceId corrente pro /ligando desambiguar a task ativa —
  // dedicado usa o deviceId aprendido de /config, pool usa o lease da
  // chamada corrente, global nao tem device individual (''; degrada
  // telefone-so, DD-07-13).
  function deviceIdCorrente(){
    if(deviceModo==='dedicado'){return dedicadoDeviceId||'';}
    if(deviceModo==='pool'){return leaseDeviceId||'';}
    return '';
  }
  function iniciarLigacao(lead){
    openCall(lead,'Pedindo microfone...');
    // iOS: o prompt de microfone SO aparece se getUserMedia rodar DENTRO do
    // gesto do toque, antes de qualquer await. Pedimos aqui pra conceder a
    // permissao; o SDK depois adquire o proprio stream (sem novo prompt).
    var mic;
    try { mic = navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { mic = Promise.reject(e); }
    mic.then(function(stream){
      try { stream.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
      setCallStatus('Conectando...');
      return garantirWavoip();
    }).then(function(w){
      // D-P3-01/DEVICE-03: reporta a task ativa ao backend (grava
      // INICIO+OPERADOR e move pra "em processamento" — D-P3-02/07) DEPOIS
      // de garantirWavoip resolver, pra incluir o deviceId corrente (dedicado
      // ou pool ja alocado nesta chamada) — sem isso o pool nunca teria
      // deviceId conhecido a tempo (lease so acontece dentro de
      // garantirWavoip). Best-effort (.catch) — nunca bloqueia a discagem.
      apiPost('/api/discador/ligando',{taskId:lead.taskId,deviceId:deviceIdCorrente()}).catch(function(){});
      return w.startCall({ to: lead.telefone });
    }).then(function(r){
      if(r && r.err){ setCallStatus('Erro: '+((r.err&&r.err.message)?r.err.message:'falha ao iniciar')); endCallUI(); return; }
      currentCall=(r&&r.call)?r.call:r;
      if(wantHangup){ hangup(); return; }
      setCallStatus('Chamando...');
      wireCallEvents(currentCall);
    }).catch(function(e){
      if(e&&e.semDeviceLivre){setCallStatus('Sem número livre, tente em instantes');endCallUI();return;}
      var neg=(e&&(e.name==='NotAllowedError'||e.name==='SecurityError'));
      setCallStatus(neg?'Permita o microfone pra ligar':('Falha: '+((e&&e.message)?e.message:'erro')));
      endCallUI();
    });
  }
  function on(call,ev,fn){try{if(call&&call.on){call.on(ev,fn);}}catch(e){}}
  function mapStatus(s){var m={CALLING:'Chamando...',RINGING:'Tocando...',ACTIVE:'Em ligação',ACCEPT:'Em ligação',ENDED:'Encerrada',NOT_ANSWERED:'Não atendida',UNANSWERED:'Não atendida',REJECTED:'Recusada'};return m[String(s).toUpperCase()]||String(s||'');}
  function wireCallEvents(call){
    // Eventos reais do @wavoip/wavoip-api (CallOutgoingEvents).
    on(call,'status',function(s){var t=mapStatus(s);if(t){setCallStatus(t);}});
    on(call,'peerAccept',function(active){if(active&&typeof active.end==='function'){currentCall=active;}foiAtendida=true;enviarDesfecho('atendida');setCallStatus('Em ligação');startTimer();});
    on(call,'peerReject',function(){enviarDesfecho('recusou');setCallStatus('Recusada');endCallUI();});
    on(call,'unanswered',function(){enviarDesfecho('nao_atendida');setCallStatus('Não atendida');endCallUI();});
    on(call,'ended',function(){enviarDesfecho('nao_atendida');setCallStatus('Encerrada');endCallUI();});
    on(call,'connectivityIssue',function(){setCallStatus('Problema de conexão');});
  }
  function hangup(){
    wantHangup=true; // se pressionado antes do startCall resolver, encerra ao resolver
    var c=currentCall;
    if(c&&typeof c.end==='function'){try{c.end();}catch(e){}}
    enviarDesfecho('nao_atendida');// se ja atendeu, 'atendida' ja venceu o guard (no-op aqui)
    setCallStatus('Encerrada');endCallUI();
  }
  // Chamadas de 30-90 min: manter a tela acordada (no celular, apagar a tela
  // suspende o WebRTC e derruba o audio). Wake Lock e best-effort e cai sozinho
  // quando a aba esconde — por isso re-adquirimos no visibilitychange.
  function pedirWakeLock(){
    try{
      if(!navigator.wakeLock||!navigator.wakeLock.request){return;}
      navigator.wakeLock.request('screen').then(function(w){
        wakeLock=w;try{w.addEventListener('release',function(){wakeLock=null;});}catch(e){}
      }).catch(function(){});
    }catch(e){}
  }
  function soltarWakeLock(){try{if(wakeLock&&wakeLock.release){wakeLock.release().catch(function(){});}}catch(e){}wakeLock=null;}
  function openCall(lead,status){wantHangup=false;emChamada=true;foiAtendida=false;desfechoEnviado=false;chamadaTaskId=(lead&&lead.taskId)||null;pedirWakeLock();var av=$('call-avatar');if(av){av.textContent=initials(lead.nome||lead.telefone);}$('call-nome').textContent=lead.nome||lead.telefone;$('call-tel').textContent=lead.telefone;setCallStatus(status);$('call-timer').textContent='';var sc=$('call-script');if(sc){sc.textContent='Carregando script...';}$('call-overlay').style.display='flex';if(chamadaTaskId){carregarScriptDaChamada(chamadaTaskId);}}
  function setCallStatus(s){$('call-status').textContent=s;}
  function startTimer(){timerStart=Date.now();if(timerInt){clearInterval(timerInt);}timerInt=setInterval(function(){var s=Math.floor((Date.now()-timerStart)/1000);var mm=Math.floor(s/60),ss=s%60;$('call-timer').textContent=(mm<10?'0':'')+mm+':'+(ss<10?'0':'')+ss;},500);}
  function endCallUI(){liberarDeviceDaChamada();emChamada=false;soltarWakeLock();if(timerInt){clearInterval(timerInt);timerInt=null;}currentCall=null;var atendida=foiAtendida,tid=chamadaTaskId;setTimeout(function(){if(atendida&&tid){mostrarVotoSeNecessario(tid);}else{voltarParaFila();}},1400);}
  // Pos-ligacao (SO quando ATENDIDA): pergunta a confirmacao de voto dos
  // candidatos ainda nao preenchidos no lead (Lista 01) e grava. Se o lead ja
  // tem os dois definidos, ou nao ha lead resolvido, so fecha a overlay da
  // chamada. Best-effort: qualquer erro so fecha a overlay (nunca trava o operador).
  function mostrarVotoSeNecessario(taskId){
    api('/api/discador/voto/'+encodeURIComponent(taskId)).then(function(res){return res.json().catch(function(){return {};});}).then(function(st){
      var pRom=!!(st&&st.temLead&&!st.romeroDefinido);
      var pAnd=!!(st&&st.temLead&&!st.andressaDefinido);
      if(!pRom&&!pAnd){voltarParaFila();return;}
      abrirVoto(taskId,pRom,pAnd);
    }).catch(function(e){if(e&&e.message==='401'){return;}voltarParaFila();});
  }
  function abrirVoto(taskId,pRom,pAnd){
    votoAtualTaskId=taskId;votoSel={romero:null,andressa:null};
    $('voto-nome').textContent=$('call-nome').textContent||'';
    $('voto-err').textContent='';
    $('voto-q-romero').style.display=pRom?'block':'none';
    $('voto-q-andressa').style.display=pAnd?'block':'none';
    var btns=document.querySelectorAll('#voto-overlay .seg-btn');
    for(var i=0;i<btns.length;i++){btns[i].classList.remove('sel');}
    $('call-overlay').style.display='none';
    $('voto-overlay').style.display='flex';
  }
  function salvarVoto(){
    var body={taskId:votoAtualTaskId};
    if(votoSel.romero){body.romero=votoSel.romero;}
    if(votoSel.andressa){body.andressa=votoSel.andressa;}
    if(!body.romero&&!body.andressa){voltarParaFila();return;}
    var btn=$('voto-salvar');$('voto-err').textContent='';btn.disabled=true;btn.textContent='Salvando...';
    apiPost('/api/discador/voto',body).then(function(res){return res.json().catch(function(){return {};}).then(function(d){return {status:res.status,d:d};});}).then(function(r){
      btn.disabled=false;btn.textContent='Salvar';
      if(r.status!==200){$('voto-err').textContent='Não foi possível salvar. Tente de novo ou toque em Pular.';return;}
      voltarParaFila();
    }).catch(function(e){btn.disabled=false;btn.textContent='Salvar';if(e&&e.message==='401'){return;}$('voto-err').textContent='Não foi possível salvar. Tente de novo ou toque em Pular.';});
  }
  window.addEventListener('DOMContentLoaded',function(){
    $('login-btn').onclick=doLogin;
    $('p').addEventListener('keydown',function(e){if(e.key==='Enter'){doLogin();}});
    $('logout-btn').onclick=function(){if(emChamada&&!confirm('Há uma ligação em andamento. Sair mesmo assim?')){return;}setToken('');show('login');};
    $('reload-btn').onclick=carregarFila;
    $('hangup-btn').onclick=hangup;
    $('preview-voltar').onclick=voltarDoPreview;
    $('preview-ligar').onclick=function(){var it=previewAtualItem;fecharPreview();if(it){iniciarLigacao(it);}};
    // Poll ~15s da fila ao vivo (LIVE-QUEUE) — pulado durante chamada ativa (pollFila).
    filaPollInt=setInterval(pollFila,15000);
    var vo=$('voto-overlay');
    if(vo){vo.addEventListener('click',function(e){var b=e.target&&e.target.closest?e.target.closest('.seg-btn'):null;if(!b){return;}var grp=b.parentNode;var cand=grp.getAttribute('data-cand');var all=grp.querySelectorAll('.seg-btn');for(var i=0;i<all.length;i++){all[i].classList.remove('sel');}b.classList.add('sel');votoSel[cand]=b.getAttribute('data-v');});}
    $('voto-salvar').onclick=salvarVoto;
    $('voto-pular').onclick=voltarParaFila;
    // Chamadas longas: evitar perder a ligacao por refresh/fechar/logout sem querer
    // e re-adquirir o Wake Lock quando a aba volta a ficar visivel.
    window.addEventListener('beforeunload',function(e){if(emChamada){e.preventDefault();e.returnValue='';return '';}});
    document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'&&emChamada&&!wakeLock){pedirWakeLock();}});
    window.addEventListener('offline',function(){if(emChamada){setCallStatus('Sem internet — a ligação pode cair');}});
    window.addEventListener('online',function(){if(emChamada){setCallStatus('Conexão restabelecida');}});
    // Handoff (quick-260815-r3): consome #token (auto-login) e &task (deep-link)
    // e LIMPA o fragmento do historico (o token nao pode vazar em back/forward).
    var hp=lerParamsDoHash();
    if(hp.token){setToken(hp.token);}
    try{history.replaceState(null,'',location.pathname+location.search);}catch(e){}
    // Porta unica (quick 260816-u5): com &task e o gestor indo LIGAR (handoff de
    // chamada) — NUNCA redireciona, abre a Ligacao aqui. Sem &task, checa o papel
    // via /me e manda o gestor pro painel; atendente (e qualquer falha) cai na fila.
    if(getToken()){if(hp.task){api('/api/discador/me').then(function(res){return res.json();}).then(function(me){if(me&&me.papel==='gestor'&&me.panelUrl){retornoPainel=me.panelUrl.replace(/[/]+$/,'')+'/fila';}}).catch(function(){});startFila();abrirLigacaoPorTask(hp.task);}else{api('/api/discador/me').then(function(res){return res.json();}).then(function(me){if(me&&me.papel==='gestor'&&irParaPainel(getToken(),me.panelUrl)){return;}startFila();}).catch(function(){startFila();});}}else{show('login');}
    if('serviceWorker' in navigator){navigator.serviceWorker.register('/discador/sw.js').catch(function(){});}
  });
})();`;
