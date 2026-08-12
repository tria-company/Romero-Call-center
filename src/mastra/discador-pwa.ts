// Assets estaticos do PWA Discador (servidos por rotas no index.ts). Mantidos
// como strings pra nao depender de static-file middleware do Mastra/Hono.
// app.js e escrito SEM template literals / ${...} de proposito, pra poder viver
// dentro destas template strings sem escape.

export const DISCADOR_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0f766e"/><path d="M356 300c-14-3-25-8-35-13-8-4-17-2-23 4l-16 16c-40-22-73-55-95-95l16-16c6-6 8-15 4-23-5-10-10-21-13-35-2-11-12-19-23-19h-36c-13 0-24 11-22 25 7 55 31 106 70 145s90 63 145 70c14 2 25-9 25-22v-36c0-11-8-21-19-23z" fill="#fff"/></svg>`;

export const DISCADOR_MANIFEST = JSON.stringify({
  name: 'Discador USI',
  short_name: 'Discador',
  description: 'Discador da fila de ligações do dia — RomeroCall',
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

// CACHE bump (discador-v7 -> discador-v8): invalida o app.js antigo (sem o
// report de "task ativa" ao Ligar) nos dispositivos já instalados como PWA
// (Fase 03 Plano 01, D-P3-01).
export const DISCADOR_SW_JS = `const CACHE='discador-v8';
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
  header{position:sticky;top:0;background:rgba(11,18,32,.92);backdrop-filter:blur(8px);padding:calc(14px + env(safe-area-inset-top)) 16px 10px 16px;border-bottom:1px solid var(--line);z-index:5}
  header .row{display:flex;align-items:center;gap:10px}
  header h1{font-size:18px;margin:0;flex:1;font-weight:700}
  .pill{font-size:12px;color:var(--mut)}
  input,button{font-size:16px;font-family:inherit}
  main{flex:1;padding:12px 16px calc(24px + env(safe-area-inset-bottom))}
  .muted{color:var(--mut);text-align:center;padding:14px;font-size:14px}
  .ghost{background:none;border:0;color:var(--mut);padding:8px}
  /* card da proxima ligacao (uma-por-vez — D-P2-08) */
  .card-ligacao{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
  .lig-head{display:flex;align-items:center;gap:12px;margin-bottom:14px}
  .lig-avatar{width:52px;height:52px;border-radius:50%;background:var(--card2);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--teal2);flex:0 0 auto;text-transform:uppercase;font-size:18px}
  .lig-info{flex:1;min-width:0}
  .lig-nome{font-size:19px;font-weight:700;text-transform:capitalize;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .lig-tel{color:var(--mut);margin-top:2px}
  .lig-script-wrap{margin-bottom:16px}
  .lig-script-label{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px}
  .lig-script{background:var(--card2);border:1px solid var(--line);border-left:3px solid var(--teal2);border-radius:10px;padding:12px 14px;font-size:14px;line-height:1.5;white-space:pre-wrap}
  .loadmore{width:100%;background:var(--card2);color:var(--txt);border:1px solid var(--line);border-radius:12px;padding:12px;margin-top:10px}
  .call-lg{margin-top:0;padding:16px;font-size:17px}
  /* login */
  #login-view{flex:1;display:flex;flex-direction:column;justify-content:center;padding:28px;gap:14px;max-width:420px;margin:0 auto;width:100%}
  #login-view .logo{width:64px;height:64px;margin:0 auto 6px;border-radius:18px;background:var(--teal);display:flex;align-items:center;justify-content:center;font-size:30px}
  #login-view h2{text-align:center;margin:0 0 4px}
  #login-view .sub{text-align:center;color:var(--mut);margin:0 0 12px;font-size:14px}
  .field{padding:14px 16px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--txt);width:100%}
  .primary{background:var(--teal);color:#fff;border:0;border-radius:12px;padding:14px;font-weight:700;width:100%}
  .err{color:#fca5a5;text-align:center;font-size:14px;min-height:18px}
  /* call overlay — estilo WhatsApp: avatar no meio, controles ancorados embaixo */
  #call-overlay{position:fixed;inset:0;background:linear-gradient(180deg,#102437,#0b1220);display:none;flex-direction:column;align-items:center;justify-content:space-between;z-index:20;padding:calc(52px + env(safe-area-inset-top)) 24px calc(40px + env(safe-area-inset-bottom))}
  .call-top{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
  #call-avatar{width:120px;height:120px;border-radius:50%;background:var(--teal);display:flex;align-items:center;justify-content:center;font-size:46px;font-weight:700;color:#fff;margin-bottom:20px;box-shadow:0 10px 34px rgba(0,0,0,.4);text-transform:uppercase}
  #call-nome{font-size:26px;font-weight:700;text-transform:capitalize}
  #call-tel{color:var(--mut);margin-top:2px}
  #call-status{margin-top:16px;font-size:15px;color:var(--teal2);letter-spacing:.5px}
  #call-timer{font-size:20px;font-variant-numeric:tabular-nums;margin-top:4px;color:var(--mut)}
  .call-controls{display:flex;align-items:center;justify-content:center;gap:48px}
  .ctrl{display:flex;flex-direction:column;align-items:center;gap:8px;background:none;border:0;color:var(--mut);font-size:13px;font-weight:600}
  .ctrl .ic{width:66px;height:66px;border-radius:50%;background:var(--card2);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:26px;transition:background .15s,color .15s}
  .ctrl.hangup .ic{background:var(--red);border-color:var(--red);color:#fff;transform:rotate(135deg)}
</style>
</head>
<body>
<div class="wrap">
  <div id="login-view" style="display:none">
    <div class="logo">\u{1F4DE}</div>
    <h2>Discador USI</h2>
    <p class="sub">Fila de ligações do dia — RomeroCall</p>
    <input id="u" class="field" placeholder="Usuário" autocapitalize="none" autocomplete="username">
    <input id="p" class="field" type="password" placeholder="Senha" autocomplete="current-password">
    <div id="login-err" class="err"></div>
    <button id="login-btn" class="primary">Entrar</button>
  </div>

  <div id="fila-view" style="display:none">
    <header>
      <div class="row">
        <h1>Próxima ligação</h1>
        <span id="fila-contador" class="pill"></span>
        <button id="reload-btn" class="ghost">↻</button>
        <button id="logout-btn" class="ghost">Sair</button>
      </div>
    </header>
    <main>
      <div id="fila-status" class="muted" style="display:none"></div>
      <div id="fila-card" class="card-ligacao" style="display:none">
        <div class="lig-head">
          <div id="lig-avatar" class="lig-avatar"></div>
          <div class="lig-info">
            <div id="lig-nome" class="lig-nome"></div>
            <div id="lig-tel" class="lig-tel"></div>
          </div>
        </div>
        <div class="lig-script-wrap">
          <div class="lig-script-label">Script</div>
          <div id="lig-script" class="lig-script"></div>
        </div>
        <button id="lig-ligar" class="primary call-lg">\u{1F4DE} Ligar</button>
        <button id="lig-proxima" class="loadmore">Concluir / Próxima</button>
      </div>
    </main>
  </div>

  <div id="call-overlay">
    <div class="call-top">
      <div id="call-avatar"></div>
      <div id="call-nome"></div>
      <div id="call-tel"></div>
      <div id="call-status"></div>
      <div id="call-timer"></div>
    </div>
    <div class="call-controls">
      <button id="hangup-btn" class="ctrl hangup" aria-label="Desligar"><span class="ic">\u{1F4DE}</span></button>
    </div>
  </div>
</div>
<script src="/discador/app.js"></script>
</body>
</html>`;

export const DISCADOR_APP_JS = `(function(){
  var tokenKey='discador_token';
  var wavoip=null, currentCall=null, wavoipToken=null, wantHangup=false;
  var fila=null, filaIdx=0;
  var timerInt=null, timerStart=0;
  var wakeLock=null, emChamada=false;
  function initials(s){var n=(s||'').trim();if(!n){return '#';}var p=n.split(' ').filter(Boolean);var a=p[0]?p[0].charAt(0):'';var b=p.length>1?p[p.length-1].charAt(0):'';return (a+b).toUpperCase();}
  function $(id){return document.getElementById(id);}
  function getToken(){return localStorage.getItem(tokenKey)||'';}
  function setToken(t){if(t){localStorage.setItem(tokenKey,t);}else{localStorage.removeItem(tokenKey);}}
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
    .then(function(r){if(!r.ok||!r.j.token){$('login-err').textContent='Usuário ou senha inválidos.';return;}setToken(r.j.token);$('p').value='';startFila();})
    .catch(function(){$('login-err').textContent='Erro ao entrar.';});
  }
  function startFila(){show('fila');carregarFila();}
  // Fila do operador logado (Lista 02 ClickUp — LOTE-04). Substitui a antiga
  // lista rolável do GHL QUALIFICADO (D-P2-07): /api/discador/qualificados
  // NAO e mais chamada por esta tela.
  function mostrarStatus(msg){$('fila-card').style.display='none';$('fila-status').textContent=msg;$('fila-status').style.display='block';}
  function carregarFila(){
    mostrarStatus('Carregando fila...');
    api('/api/discador/fila').then(function(res){
      return res.json().catch(function(){return {};}).then(function(data){return {status:res.status,data:data};});
    }).then(function(r){
      if(r.status!==200){
        // Erro de carregamento e DISTINTO de fila vazia (WR-03/T-02-03-D) —
        // nunca mostra "sem ligações" quando na verdade a chamada falhou.
        mostrarStatus('Erro ao carregar a fila. Toque em ↻ para tentar de novo.');
        return;
      }
      if(r.data.semMapeamento){
        mostrarStatus('Seu usuário ainda não está vinculado a um operador do ClickUp. Configure DISCADOR_ASSIGNEES.');
        return;
      }
      fila=r.data.fila||[];filaIdx=0;
      mostrarItemAtual();
    }).catch(function(e){
      if(e&&e.message==='401'){return;}
      mostrarStatus('Erro ao carregar a fila. Toque em ↻ para tentar de novo.');
    });
  }
  function mostrarItemAtual(){
    if(!fila||!fila.length){
      $('fila-contador').textContent='';
      mostrarStatus('Sem ligações na sua fila hoje.');
      return;
    }
    if(filaIdx>=fila.length){
      $('fila-contador').textContent=fila.length+' de '+fila.length;
      mostrarStatus('Fila concluída — toque em ↻ para recarregar.');
      return;
    }
    $('fila-status').style.display='none';
    var item=fila[filaIdx];
    $('fila-contador').textContent=(filaIdx+1)+' de '+fila.length;
    $('lig-avatar').textContent=initials(item.nome||item.telefone);
    $('lig-nome').textContent=item.nome||item.telefone;
    $('lig-tel').textContent=item.telefone;
    $('lig-script').textContent='Carregando script...';
    $('fila-card').style.display='block';
    $('lig-ligar').onclick=function(){iniciarLigacao(item);};
    carregarScriptDoItem(item);
  }
  function carregarScriptDoItem(item){
    api('/api/discador/ligacao/'+encodeURIComponent(item.taskId)).then(function(res){
      return res.json().catch(function(){return {};}).then(function(data){return {status:res.status,data:data};});
    }).then(function(r){
      if(!fila||fila[filaIdx]!==item){return;} // fila avancou enquanto o script carregava
      if(r.status!==200||!r.data.ligacao){$('lig-script').textContent='Não foi possível carregar o script.';return;}
      $('lig-script').textContent=r.data.ligacao.script||'(sem script)';
    }).catch(function(e){
      if(e&&e.message==='401'){return;}
      if(!fila||fila[filaIdx]!==item){return;}
      $('lig-script').textContent='Não foi possível carregar o script.';
    });
  }
  function avancarFila(){filaIdx+=1;mostrarItemAtual();}
  function garantirWavoip(){
    if(wavoip){return Promise.resolve(wavoip);}
    return api('/api/discador/config').then(function(res){return res.json();}).then(function(cfg){
      wavoipToken=cfg.wavoipToken;if(!wavoipToken){throw new Error('sem token wavoip');}
      return import('https://esm.sh/@wavoip/wavoip-api@2.6.3');
    }).then(function(mod){
      var W=mod.Wavoip||(mod.default&&mod.default.Wavoip)||mod.default||mod;
      wavoip=new W({tokens:[wavoipToken]});return wavoip;
    });
  }
  function iniciarLigacao(lead){
    openCall(lead,'Pedindo microfone...');
    // D-P3-01: reporta a task ativa ao backend (grava INICIO+OPERADOR e move
    // pra "em processamento" — D-P3-02/07) best-effort — nunca bloqueia a
    // discagem se o backend falhar (mesmo tom de degradacao graciosa do
    // resto do app).
    apiPost('/api/discador/ligando',{taskId:lead.taskId}).catch(function(){});
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
      return w.startCall({ to: lead.telefone });
    }).then(function(r){
      if(r && r.err){ setCallStatus('Erro: '+((r.err&&r.err.message)?r.err.message:'falha ao iniciar')); endCallUI(); return; }
      currentCall=(r&&r.call)?r.call:r;
      if(wantHangup){ hangup(); return; }
      setCallStatus('Chamando...');
      wireCallEvents(currentCall);
    }).catch(function(e){
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
    on(call,'peerAccept',function(active){if(active&&typeof active.end==='function'){currentCall=active;}setCallStatus('Em ligação');startTimer();});
    on(call,'peerReject',function(){setCallStatus('Recusada');endCallUI();});
    on(call,'unanswered',function(){setCallStatus('Não atendida');endCallUI();});
    on(call,'ended',function(){setCallStatus('Encerrada');endCallUI();});
    on(call,'connectivityIssue',function(){setCallStatus('Problema de conexão');});
  }
  function hangup(){
    wantHangup=true; // se pressionado antes do startCall resolver, encerra ao resolver
    var c=currentCall;
    if(c&&typeof c.end==='function'){try{c.end();}catch(e){}}
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
  function openCall(lead,status){wantHangup=false;emChamada=true;pedirWakeLock();var av=$('call-avatar');if(av){av.textContent=initials(lead.nome||lead.telefone);}$('call-nome').textContent=lead.nome||lead.telefone;$('call-tel').textContent=lead.telefone;setCallStatus(status);$('call-timer').textContent='';$('call-overlay').style.display='flex';}
  function setCallStatus(s){$('call-status').textContent=s;}
  function startTimer(){timerStart=Date.now();if(timerInt){clearInterval(timerInt);}timerInt=setInterval(function(){var s=Math.floor((Date.now()-timerStart)/1000);var mm=Math.floor(s/60),ss=s%60;$('call-timer').textContent=(mm<10?'0':'')+mm+':'+(ss<10?'0':'')+ss;},500);}
  function endCallUI(){emChamada=false;soltarWakeLock();if(timerInt){clearInterval(timerInt);timerInt=null;}currentCall=null;setTimeout(function(){$('call-overlay').style.display='none';},1400);}
  window.addEventListener('DOMContentLoaded',function(){
    $('login-btn').onclick=doLogin;
    $('p').addEventListener('keydown',function(e){if(e.key==='Enter'){doLogin();}});
    $('logout-btn').onclick=function(){if(emChamada&&!confirm('Há uma ligação em andamento. Sair mesmo assim?')){return;}setToken('');show('login');};
    $('reload-btn').onclick=carregarFila;
    $('lig-proxima').onclick=avancarFila;
    $('hangup-btn').onclick=hangup;
    // Chamadas longas: evitar perder a ligacao por refresh/fechar/logout sem querer
    // e re-adquirir o Wake Lock quando a aba volta a ficar visivel.
    window.addEventListener('beforeunload',function(e){if(emChamada){e.preventDefault();e.returnValue='';return '';}});
    document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'&&emChamada&&!wakeLock){pedirWakeLock();}});
    window.addEventListener('offline',function(){if(emChamada){setCallStatus('Sem internet — a ligação pode cair');}});
    window.addEventListener('online',function(){if(emChamada){setCallStatus('Conexão restabelecida');}});
    if(getToken()){startFila();}else{show('login');}
    if('serviceWorker' in navigator){navigator.serviceWorker.register('/discador/sw.js').catch(function(){});}
  });
})();`;
