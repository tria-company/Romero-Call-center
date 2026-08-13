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

// CACHE bump (discador-v15 -> discador-v16): fix de especificidade CSS do
// botao "Ligar" da fila (cobria nome/telefone) — index.html mudou de novo.
// Mantém em sincronia com web/sw.js.
export const DISCADOR_SW_JS = `const CACHE='discador-v16';
const SHELL=['/discador','/discador/app.js','/discador/manifest.webmanifest','/discador/icon.svg'];
self.addEventListener('install',function(e){e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(SHELL);}).then(function(){return self.skipWaiting();}));});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener('fetch',function(e){var u=new URL(e.request.url);if(u.pathname.indexOf('/api/')===0){return;}e.respondWith(caches.match(e.request).then(function(r){return r||fetch(e.request);}));});`;

export const DISCADOR_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#007bff">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Discador USI</title>
<link rel="manifest" href="/discador/manifest.webmanifest">
<link rel="apple-touch-icon" href="/discador/icon.svg">
<link rel="icon" href="/discador/icon.svg">
<style>
  :root{
    --bg:#050a14;--txt:#eaf2ff;--mut:#93a6c8;
    --blue:#007bff;--cyan:#29c5f6;--indigo:#3a4b9f;--red:#dc2626;
    --line:rgba(255,255,255,.08);--glass:rgba(255,255,255,.045);--glass2:rgba(255,255,255,.07);
    --hair-top:rgba(255,255,255,.14);--hair-side:rgba(255,255,255,.06);
    --accent:linear-gradient(135deg,var(--cyan),var(--blue))
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{height:100%}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:var(--txt);background:var(--bg);-webkit-font-smoothing:antialiased}
  body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(680px 460px at 12% -8%,rgba(0,123,255,.20),transparent 60%),radial-gradient(560px 460px at 108% 12%,rgba(41,197,246,.14),transparent 55%),radial-gradient(680px 560px at 40% 116%,rgba(58,75,159,.18),transparent 60%)}
  .wrap{max-width:640px;margin:0 auto;min-height:100dvh;display:flex;flex-direction:column}
  header{position:sticky;top:0;z-index:5;padding:calc(14px + env(safe-area-inset-top)) 16px 12px 16px;background:rgba(5,10,20,.55);-webkit-backdrop-filter:blur(14px) saturate(160%);backdrop-filter:blur(14px) saturate(160%);border-bottom:1px solid var(--line)}
  header .row{display:flex;align-items:center;gap:10px}
  header h1{font-size:18px;margin:0;flex:1;font-weight:700;letter-spacing:-.01em}
  .pill{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.12em;padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:var(--glass)}
  input,button{font-size:16px;font-family:inherit}
  main{flex:1;padding:14px 16px calc(24px + env(safe-area-inset-bottom))}
  .muted{color:var(--mut);text-align:center;padding:16px;font-size:14px}
  .ghost{background:none;border:0;color:var(--mut);padding:8px;border-radius:10px}
  .ghost:active{background:var(--glass)}
  /* card da proxima ligacao (uma-por-vez — D-P2-08) */
  .card-ligacao{position:relative;border-radius:18px;padding:18px;background:var(--glass);-webkit-backdrop-filter:blur(16px) saturate(180%);backdrop-filter:blur(16px) saturate(180%);border-top:1px solid var(--hair-top);border-left:1px solid var(--hair-side);border-right:1px solid var(--hair-side);border-bottom:1px solid rgba(255,255,255,.05);box-shadow:0 8px 32px rgba(2,6,16,.5)}
  .lig-head{display:flex;align-items:center;gap:12px;margin-bottom:16px}
  .lig-avatar{width:54px;height:54px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;flex:0 0 auto;text-transform:uppercase;font-size:18px;box-shadow:0 6px 18px rgba(0,123,255,.35)}
  .lig-info{flex:1;min-width:0}
  .lig-nome{font-size:19px;font-weight:700;text-transform:capitalize;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em}
  .lig-tel{color:var(--mut);margin-top:2px}
  .lig-script-wrap{margin-bottom:16px}
  .lig-script-label{font-size:10px;color:var(--cyan);text-transform:uppercase;letter-spacing:.16em;margin-bottom:8px}
  .lig-script{background:rgba(255,255,255,.03);border:1px solid var(--line);border-left:3px solid var(--cyan);border-radius:12px;padding:12px 14px;font-size:14px;line-height:1.55;white-space:pre-wrap}
  .loadmore{width:100%;background:var(--glass2);color:var(--txt);border:1px solid var(--line);border-radius:12px;padding:13px;margin-top:10px;font-weight:600}
  .loadmore:active{background:rgba(255,255,255,.10)}
  .call-lg{margin-top:0;padding:16px;font-size:17px}
  /* fila ao vivo: lista de todas as ligacoes pendentes (LIVE-QUEUE) */
  .fila-item{position:relative;display:flex;align-items:center;gap:12px;border-radius:16px;padding:14px 16px;margin-bottom:12px;background:var(--glass);-webkit-backdrop-filter:blur(16px) saturate(180%);backdrop-filter:blur(16px) saturate(180%);border-top:1px solid var(--hair-top);border-left:1px solid var(--hair-side);border-right:1px solid var(--hair-side);border-bottom:1px solid rgba(255,255,255,.05);box-shadow:0 6px 22px rgba(2,6,16,.4)}
  .fila-item:active{transform:translateY(1px)}
  .fila-item .lig-info{flex:1;min-width:0}
  .fila-item .fila-ligar{flex:0 0 auto;width:auto;padding:11px 20px;font-size:14px}
  /* login */
  #login-view{flex:1;display:flex;flex-direction:column;justify-content:center;padding:28px;gap:14px;max-width:420px;margin:0 auto;width:100%}
  #login-view .logo{width:66px;height:66px;margin:0 auto 8px;border-radius:20px;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:30px;box-shadow:0 10px 30px rgba(0,123,255,.4)}
  #login-view h2{text-align:center;margin:0 0 4px;font-weight:700;letter-spacing:-.02em}
  #login-view .sub{text-align:center;color:var(--mut);margin:0 0 12px;font-size:14px}
  .field{padding:14px 16px;border-radius:14px;border:1px solid var(--line);background:var(--glass);color:var(--txt);width:100%;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
  .field::placeholder{color:#6f83a6}
  .field:focus{outline:none;border-color:rgba(41,197,246,.6);box-shadow:0 0 0 3px rgba(41,197,246,.18)}
  .primary{background:var(--accent);color:#fff;border:0;border-radius:14px;padding:14px;font-weight:700;width:100%;box-shadow:0 8px 22px rgba(0,123,255,.38);letter-spacing:.01em}
  .primary:active{transform:translateY(1px);box-shadow:0 4px 14px rgba(0,123,255,.32)}
  .err{color:#fca5a5;text-align:center;font-size:14px;min-height:18px}
  /* call overlay — leve durante chamadas longas (avatar no meio, controles embaixo) */
  #call-overlay{position:fixed;inset:0;display:none;flex-direction:column;align-items:center;justify-content:space-between;z-index:20;padding:calc(52px + env(safe-area-inset-top)) 24px calc(40px + env(safe-area-inset-bottom));background:radial-gradient(600px 500px at 50% 12%,rgba(0,123,255,.22),transparent 60%),radial-gradient(520px 460px at 50% 108%,rgba(41,197,246,.12),transparent 60%),linear-gradient(180deg,#081426,#050a14)}
  .call-top{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
  #call-avatar{width:124px;height:124px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:46px;font-weight:700;color:#fff;margin-bottom:22px;box-shadow:0 14px 40px rgba(0,123,255,.4);text-transform:uppercase}
  #call-nome{font-size:26px;font-weight:700;text-transform:capitalize;letter-spacing:-.01em}
  #call-tel{color:var(--mut);margin-top:2px}
  #call-status{margin-top:16px;font-size:14px;color:var(--cyan);letter-spacing:.14em;text-transform:uppercase}
  #call-timer{font-size:20px;font-variant-numeric:tabular-nums;margin-top:6px;color:var(--mut)}
  /* script visivel durante a chamada (SCRIPT-IN-OVERLAY) — rolavel p/ chamadas de 30-90min */
  .call-script{width:100%;max-width:560px;max-height:38vh;overflow:auto;white-space:pre-wrap;background:rgba(255,255,255,.03);border:1px solid var(--line);border-left:3px solid var(--cyan);border-radius:12px;padding:12px 14px;font-size:14px;line-height:1.55;margin:8px 0;flex:0 0 auto}
  .call-controls{display:flex;align-items:center;justify-content:center;gap:48px}
  .ctrl{display:flex;flex-direction:column;align-items:center;gap:8px;background:none;border:0;color:var(--mut);font-size:13px;font-weight:600}
  .ctrl .ic{width:68px;height:68px;border-radius:50%;background:var(--glass2);border:1px solid var(--line);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:center;font-size:26px;transition:background .15s,color .15s,transform .15s}
  .ctrl.hangup .ic{background:var(--red);border-color:var(--red);color:#fff;transform:rotate(135deg);box-shadow:0 10px 26px rgba(220,38,38,.45)}
  .ctrl.hangup:active .ic{transform:rotate(135deg) scale(.94)}
  /* preview do lead antes de ligar (CONTEXTO + SCRIPT) */
  #preview-overlay{position:fixed;inset:0;display:none;z-index:20;overflow:auto;padding:calc(20px + env(safe-area-inset-top)) 20px calc(28px + env(safe-area-inset-bottom));background:radial-gradient(600px 500px at 50% 8%,rgba(0,123,255,.18),transparent 60%),linear-gradient(180deg,#081426,#050a14)}
  .preview-card{width:100%;max-width:560px;margin:0 auto}
  /* pos-ligacao: confirmacao de voto (grava na Lista 01 LEADS) */
  #voto-overlay{position:fixed;inset:0;display:none;z-index:25;align-items:center;justify-content:center;padding:24px 20px calc(24px + env(safe-area-inset-bottom));background:radial-gradient(600px 500px at 50% 8%,rgba(0,123,255,.18),transparent 60%),linear-gradient(180deg,#081426,#050a14);overflow:auto}
  .voto-card{width:100%;max-width:460px;border-radius:20px;padding:22px;background:var(--glass);-webkit-backdrop-filter:blur(16px) saturate(180%);backdrop-filter:blur(16px) saturate(180%);border-top:1px solid var(--hair-top);border-left:1px solid var(--hair-side);border-right:1px solid var(--hair-side);border-bottom:1px solid rgba(255,255,255,.05);box-shadow:0 8px 32px rgba(2,6,16,.5)}
  .voto-title{font-size:20px;font-weight:700;letter-spacing:-.01em}
  .voto-sub{color:var(--mut);margin:2px 0 18px;text-transform:capitalize}
  .voto-q{margin-bottom:18px}
  .voto-label{font-size:14px;margin-bottom:10px}
  .voto-label b{color:var(--cyan);font-weight:700}
  .seg{display:flex;gap:8px}
  .seg-btn{flex:1;padding:12px 6px;border-radius:12px;border:1px solid var(--line);background:var(--glass2);color:var(--txt);font-weight:600;font-size:13px;transition:background .15s,border-color .15s,box-shadow .15s}
  .seg-btn.sel{background:var(--accent);border-color:transparent;box-shadow:0 6px 16px rgba(0,123,255,.35)}
  #voto-salvar{margin-top:4px}
  #voto-pular{margin-top:10px;background:none}
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
      <button id="preview-voltar" class="ghost" type="button" style="margin-bottom:6px">← Voltar</button>
      <div class="lig-head">
        <div id="preview-avatar" class="lig-avatar"></div>
        <div class="lig-info">
          <div id="preview-nome" class="lig-nome"></div>
          <div id="preview-tel" class="lig-tel"></div>
        </div>
      </div>
      <div class="lig-script-wrap">
        <div class="lig-script-label">Contexto</div>
        <div id="preview-contexto" class="call-script"></div>
      </div>
      <div class="lig-script-wrap">
        <div class="lig-script-label">Script</div>
        <div id="preview-script" class="call-script"></div>
      </div>
      <button id="preview-ligar" class="primary call-lg" type="button">Ligar</button>
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
  var wakeLock=null, emChamada=false;
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
  function mostrarStatus(msg){$('fila-lista').style.display='none';$('fila-status').textContent=msg;$('fila-status').style.display='block';}
  // Lista AO VIVO (LIVE-QUEUE): reconstroi #fila-lista inteiro a cada render
  // (fila pequena, aceitavel). Nome/telefone via textContent (sem XSS, sem
  // escaping) — nunca innerHTML/template literal.
  function renderFila(itens){
    if(!itens||!itens.length){
      $('fila-contador').textContent='';
      mostrarStatus('Sem ligações na sua fila hoje.');
      return;
    }
    $('fila-status').style.display='none';
    $('fila-contador').textContent=itens.length+' ligações';
    var lista=$('fila-lista');
    lista.textContent='';
    lista.style.display='block';
    for(var i=0;i<itens.length;i++){
      lista.appendChild(criarItemFila(itens[i]));
    }
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
  function voltarParaFila(){$('call-overlay').style.display='none';$('voto-overlay').style.display='none';carregarFilaSilencioso();}
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
  // (desfechoEnviado) — atendida so no peerAccept, recusou so no peerReject;
  // nunca bloqueia a UI. Nao-atendida/hangup NAO chamam (task fica na fila).
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
    $('preview-voltar').onclick=fecharPreview;
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
    if(getToken()){startFila();}else{show('login');}
    if('serviceWorker' in navigator){navigator.serviceWorker.register('/discador/sw.js').catch(function(){});}
  });
})();`;
