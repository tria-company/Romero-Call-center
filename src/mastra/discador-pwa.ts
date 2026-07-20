// Assets estaticos do PWA Discador (servidos por rotas no index.ts). Mantidos
// como strings pra nao depender de static-file middleware do Mastra/Hono.
// app.js e escrito SEM template literals / ${...} de proposito, pra poder viver
// dentro destas template strings sem escape.

export const DISCADOR_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0f766e"/><path d="M356 300c-14-3-25-8-35-13-8-4-17-2-23 4l-16 16c-40-22-73-55-95-95l16-16c6-6 8-15 4-23-5-10-10-21-13-35-2-11-12-19-23-19h-36c-13 0-24 11-22 25 7 55 31 106 70 145s90 63 145 70c14 2 25-9 25-22v-36c0-11-8-21-19-23z" fill="#fff"/></svg>`;

export const DISCADOR_MANIFEST = JSON.stringify({
  name: 'Discador USI',
  short_name: 'Discador',
  description: 'Discador de leads qualificados — AUTON Health',
  start_url: '/discador',
  scope: '/discador',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0b1220',
  theme_color: '#0f766e',
  icons: [
    { src: '/discador/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
  ],
});

export const DISCADOR_SW_JS = `const CACHE='discador-v1';
const SHELL=['/discador','/discador/app.js','/discador/manifest.webmanifest','/discador/icon.svg'];
self.addEventListener('install',function(e){e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(SHELL);}).then(function(){return self.skipWaiting();}));});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener('fetch',function(e){var u=new URL(e.request.url);if(u.pathname.indexOf('/api/')===0){return;}e.respondWith(caches.match(e.request).then(function(r){return r||fetch(e.request);}));});`;

export const DISCADOR_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f766e">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Discador USI</title>
<link rel="manifest" href="/discador/manifest.webmanifest">
<link rel="apple-touch-icon" href="/discador/icon.svg">
<link rel="icon" href="/discador/icon.svg">
<style>
  :root{--bg:#0b1220;--card:#131c2e;--card2:#1a2438;--txt:#e7ecf5;--mut:#8fa0bd;--teal:#0f766e;--teal2:#12a594;--red:#dc2626;--line:#233149}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--txt)}
  .wrap{max-width:640px;margin:0 auto;min-height:100dvh;display:flex;flex-direction:column}
  header{position:sticky;top:0;background:rgba(11,18,32,.92);backdrop-filter:blur(8px);padding:14px 16px calc(10px + env(safe-area-inset-top)) 16px;border-bottom:1px solid var(--line);z-index:5}
  header .row{display:flex;align-items:center;gap:10px}
  header h1{font-size:18px;margin:0;flex:1;font-weight:700}
  .pill{font-size:12px;color:var(--mut)}
  input,button{font-size:16px;font-family:inherit}
  .search{width:100%;margin-top:10px;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card2);color:var(--txt)}
  .search::placeholder{color:var(--mut)}
  main{flex:1;padding:12px 16px calc(24px + env(safe-area-inset-bottom))}
  .card{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:10px}
  .card .info{flex:1;min-width:0}
  .card .nome{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-transform:capitalize}
  .card .tel{color:var(--mut);font-size:14px;margin-top:2px}
  .call-btn{background:var(--teal);color:#fff;border:0;border-radius:12px;padding:12px 18px;font-weight:700;display:flex;align-items:center;gap:6px}
  .call-btn:active{background:var(--teal2)}
  .call-btn::before{content:'\\1F4DE'}
  .muted{color:var(--mut);text-align:center;padding:14px;font-size:14px}
  .loadmore{width:100%;background:var(--card2);color:var(--txt);border:1px solid var(--line);border-radius:12px;padding:12px;margin-top:4px}
  .ghost{background:none;border:0;color:var(--mut);padding:8px}
  /* login */
  #login-view{flex:1;display:flex;flex-direction:column;justify-content:center;padding:28px;gap:14px;max-width:420px;margin:0 auto;width:100%}
  #login-view .logo{width:64px;height:64px;margin:0 auto 6px;border-radius:18px;background:var(--teal);display:flex;align-items:center;justify-content:center;font-size:30px}
  #login-view h2{text-align:center;margin:0 0 4px}
  #login-view .sub{text-align:center;color:var(--mut);margin:0 0 12px;font-size:14px}
  .field{padding:14px 16px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--txt);width:100%}
  .primary{background:var(--teal);color:#fff;border:0;border-radius:12px;padding:14px;font-weight:700;width:100%}
  .err{color:#fca5a5;text-align:center;font-size:14px;min-height:18px}
  /* call overlay */
  #call-overlay{position:fixed;inset:0;background:rgba(5,10,20,.96);display:none;flex-direction:column;align-items:center;justify-content:center;gap:8px;z-index:20;padding:24px}
  #call-nome{font-size:24px;font-weight:700;text-transform:capitalize;text-align:center}
  #call-tel{color:var(--mut)}
  #call-status{margin-top:18px;font-size:15px;color:var(--teal2);letter-spacing:.5px}
  #call-timer{font-size:34px;font-variant-numeric:tabular-nums;margin-top:4px}
  #hangup-btn{margin-top:36px;width:72px;height:72px;border-radius:50%;background:var(--red);color:#fff;border:0;font-size:30px}
  #hangup-btn::before{content:'\\1F4DE'}
</style>
</head>
<body>
<div class="wrap">
  <div id="login-view" style="display:none">
    <div class="logo">\u{1F4DE}</div>
    <h2>Discador USI</h2>
    <p class="sub">Leads qualificados — AUTON Health</p>
    <input id="u" class="field" placeholder="Usuário" autocapitalize="none" autocomplete="username">
    <input id="p" class="field" type="password" placeholder="Senha" autocomplete="current-password">
    <div id="login-err" class="err"></div>
    <button id="login-btn" class="primary">Entrar</button>
  </div>

  <div id="list-view" style="display:none">
    <header>
      <div class="row">
        <h1>Qualificados</h1>
        <span id="total" class="pill"></span>
        <button id="reload-btn" class="ghost">↻</button>
        <button id="logout-btn" class="ghost">Sair</button>
      </div>
      <input id="search" class="search" placeholder="Buscar por nome..." autocapitalize="none">
    </header>
    <main>
      <div id="leads"></div>
      <div id="load-status" class="muted"></div>
      <button id="loadmore-btn" class="loadmore">Carregar mais</button>
    </main>
  </div>

  <div id="call-overlay">
    <div id="call-nome"></div>
    <div id="call-tel"></div>
    <div id="call-status"></div>
    <div id="call-timer"></div>
    <button id="hangup-btn" aria-label="Desligar"></button>
  </div>
</div>
<script src="/discador/app.js"></script>
</body>
</html>`;

export const DISCADOR_APP_JS = `(function(){
  var tokenKey='discador_token';
  var wavoip=null, currentCall=null, wavoipToken=null;
  var page={q:'',startAfter:null,startAfterId:null,done:false,loading:false};
  var timerInt=null, timerStart=0;
  function $(id){return document.getElementById(id);}
  function getToken(){return localStorage.getItem(tokenKey)||'';}
  function setToken(t){if(t){localStorage.setItem(tokenKey,t);}else{localStorage.removeItem(tokenKey);}}
  function show(v){$('login-view').style.display=(v==='login')?'flex':'none';$('list-view').style.display=(v==='list')?'block':'none';}
  function api(path){
    var opts={headers:{}};var t=getToken();if(t){opts.headers['Authorization']='Bearer '+t;}
    return fetch(path,opts).then(function(res){if(res.status===401){setToken('');show('login');throw new Error('401');}return res;});
  }
  function doLogin(){
    var u=$('u').value.trim(), p=$('p').value;$('login-err').textContent='';
    fetch('/api/discador/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuario:u,senha:p})})
    .then(function(res){return res.json().then(function(j){return {ok:res.ok,j:j};});})
    .then(function(r){if(!r.ok||!r.j.token){$('login-err').textContent='Usuário ou senha inválidos.';return;}setToken(r.j.token);$('p').value='';startList();})
    .catch(function(){$('login-err').textContent='Erro ao entrar.';});
  }
  function startList(){show('list');resetList();}
  function resetList(){page={q:$('search').value.trim(),startAfter:null,startAfterId:null,done:false,loading:false};$('leads').innerHTML='';loadMore();}
  function loadMore(){
    if(page.loading||page.done){return;}page.loading=true;$('load-status').textContent='Carregando...';
    var url='/api/discador/qualificados?limit=30';
    if(page.q){url+='&q='+encodeURIComponent(page.q);}
    if(page.startAfter){url+='&startAfter='+encodeURIComponent(page.startAfter)+'&startAfterId='+encodeURIComponent(page.startAfterId||'');}
    api(url).then(function(res){return res.json();}).then(function(data){
      renderLeads(data.leads||[]);
      if(data.startAfter&&(data.leads||[]).length){page.startAfter=data.startAfter;page.startAfterId=data.startAfterId;}else{page.done=true;}
      if(typeof data.total==='number'){$('total').textContent=data.total+' no total';}
      $('load-status').textContent=page.done?'Fim da lista.':'';
      $('loadmore-btn').style.display=page.done?'none':'block';
      page.loading=false;
    }).catch(function(){$('load-status').textContent='Erro ao carregar.';page.loading=false;});
  }
  function renderLeads(leads){
    var frag=document.createDocumentFragment();
    leads.forEach(function(l){
      var card=document.createElement('div');card.className='card';
      var info=document.createElement('div');info.className='info';
      var nome=document.createElement('div');nome.className='nome';nome.textContent=l.nome||'(sem nome)';
      var tel=document.createElement('div');tel.className='tel';tel.textContent=l.telefone;
      info.appendChild(nome);info.appendChild(tel);
      var btn=document.createElement('button');btn.className='call-btn';btn.textContent='Ligar';
      btn.onclick=function(){iniciarLigacao(l);};
      card.appendChild(info);card.appendChild(btn);frag.appendChild(card);
    });
    $('leads').appendChild(frag);
  }
  function garantirWavoip(){
    if(wavoip){return Promise.resolve(wavoip);}
    return api('/api/discador/config').then(function(res){return res.json();}).then(function(cfg){
      wavoipToken=cfg.wavoipToken;if(!wavoipToken){throw new Error('sem token wavoip');}
      return import('https://esm.sh/wavoip-api@3.1.24');
    }).then(function(mod){
      var W=mod.Wavoip||(mod.default&&mod.default.Wavoip)||mod.default||mod;
      wavoip=new W({tokens:[wavoipToken]});return wavoip;
    });
  }
  function iniciarLigacao(lead){
    openCall(lead,'Conectando...');
    garantirWavoip().then(function(w){return w.startCall({to:lead.telefone});}).then(function(r){
      var call=(r&&r.call)?r.call:r;currentCall=call;
      if(r&&r.err){setCallStatus('Erro ao iniciar');return;}
      setCallStatus('Chamando...');wireCallEvents(call);
    }).catch(function(e){setCallStatus('Falha: '+((e&&e.message)?e.message:'erro'));});
  }
  function on(call,ev,fn){try{if(call&&call.on){call.on(ev,fn);}}catch(e){}}
  function wireCallEvents(call){
    on(call,'peerAccept',function(){setCallStatus('Em ligação');startTimer();});
    on(call,'accept',function(){setCallStatus('Em ligação');startTimer();});
    on(call,'reject',function(){setCallStatus('Recusada');endCallUI();});
    on(call,'terminate',function(){setCallStatus('Encerrada');endCallUI();});
    on(call,'end',function(){setCallStatus('Encerrada');endCallUI();});
    on(call,'hangup',function(){setCallStatus('Encerrada');endCallUI();});
  }
  function hangup(){
    var c=currentCall;
    if(c){['hangup','endCall','end','close','terminate','reject'].forEach(function(m){try{if(typeof c[m]==='function'){c[m]();}}catch(e){}});}
    setCallStatus('Encerrada');endCallUI();
  }
  function openCall(lead,status){$('call-nome').textContent=lead.nome||lead.telefone;$('call-tel').textContent=lead.telefone;setCallStatus(status);$('call-timer').textContent='';$('call-overlay').style.display='flex';}
  function setCallStatus(s){$('call-status').textContent=s;}
  function startTimer(){timerStart=Date.now();if(timerInt){clearInterval(timerInt);}timerInt=setInterval(function(){var s=Math.floor((Date.now()-timerStart)/1000);var mm=Math.floor(s/60),ss=s%60;$('call-timer').textContent=(mm<10?'0':'')+mm+':'+(ss<10?'0':'')+ss;},500);}
  function endCallUI(){if(timerInt){clearInterval(timerInt);timerInt=null;}currentCall=null;setTimeout(function(){$('call-overlay').style.display='none';},1400);}
  window.addEventListener('DOMContentLoaded',function(){
    $('login-btn').onclick=doLogin;
    $('p').addEventListener('keydown',function(e){if(e.key==='Enter'){doLogin();}});
    $('logout-btn').onclick=function(){setToken('');show('login');};
    $('reload-btn').onclick=resetList;
    var st=null;$('search').addEventListener('input',function(){if(st){clearTimeout(st);}st=setTimeout(resetList,400);});
    $('loadmore-btn').onclick=loadMore;
    $('hangup-btn').onclick=hangup;
    if(getToken()){startList();}else{show('login');}
    if('serviceWorker' in navigator){navigator.serviceWorker.register('/discador/sw.js').catch(function(){});}
  });
})();`;
