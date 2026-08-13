// Painel operacional (Fase 10, OBS-01, D-01..D-04). Servido pelo backend na
// VPS (mesmo padrao de discador-pwa.ts): HTML + JS como template strings,
// sem middleware de arquivo estatico, sem framework de UI.
// ADMIN_APP_JS e escrito SEM template literals / ${...} de proposito, pra
// poder viver dentro de ADMIN_HTML sem escape — mesma convencao documentada
// no topo de discador-pwa.ts.
//
// Reusa a MESMA sessao do discador (D-02, discador-auth.ts): o gate de login
// e client-side (checa o token 'discador_token' ja usado por /discador),
// sem novo nivel de acesso.

export const ADMIN_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#007bff">
<title>Painel operacional — RomeroCall</title>
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
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:var(--txt);background:var(--bg);-webkit-font-smoothing:antialiased;font-size:14px;line-height:1.5}
  body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(680px 460px at 12% -8%,rgba(0,123,255,.20),transparent 60%),radial-gradient(560px 460px at 108% 12%,rgba(41,197,246,.14),transparent 55%),radial-gradient(680px 560px at 40% 116%,rgba(58,75,159,.18),transparent 60%)}
  .wrap{max-width:960px;margin:0 auto;min-height:100dvh;display:flex;flex-direction:column}
  header{position:sticky;top:0;z-index:5;padding:calc(14px + env(safe-area-inset-top)) 16px 12px 16px;background:rgba(5,10,20,.55);-webkit-backdrop-filter:blur(14px) saturate(160%);backdrop-filter:blur(14px) saturate(160%);border-bottom:1px solid var(--line)}
  header .row{display:flex;align-items:center;gap:10px}
  header h1{font-size:18px;margin:0;flex:1;font-weight:700;letter-spacing:-.01em}
  .pill{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.12em;padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:var(--glass)}
  .ghost{background:none;border:0;color:var(--mut);padding:8px;border-radius:10px;font-size:14px;font-family:inherit}
  .ghost:active{background:var(--glass)}
  input,button{font-size:16px;font-family:inherit}
  main{flex:1;padding:24px 16px calc(48px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:32px}
  .muted{color:var(--mut)}
  /* cartao glass — mesmo padrao visual de .card-ligacao (discador-pwa.ts) */
  .card{position:relative;border-radius:18px;padding:16px;background:var(--glass);-webkit-backdrop-filter:blur(16px) saturate(180%);backdrop-filter:blur(16px) saturate(180%);border-top:1px solid var(--hair-top);border-left:1px solid var(--hair-side);border-right:1px solid var(--hair-side);border-bottom:1px solid rgba(255,255,255,.05);box-shadow:0 8px 32px rgba(2,6,16,.5)}
  /* grid de 4 KPIs — 1 coluna mobile / 2-4 colunas em telas largas */
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}
  .kpi-label{font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700;color:var(--cyan);display:flex;align-items:center;gap:6px}
  .kpi-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);flex:0 0 auto}
  .kpi-display{font-size:28px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums;margin-top:8px}
  .kpi-display.ok{background:var(--accent);-webkit-background-clip:text;background-clip:text;color:transparent}
  .kpi-display.bad{color:var(--red)}
  .kpi-empty{margin-top:8px;font-size:12px;color:var(--mut)}
  .kpi-empty b{display:block;color:var(--txt);font-weight:700;margin-bottom:2px}
  section.bloco{display:flex;flex-direction:column;gap:12px}
  .bloco-title{font-size:18px;font-weight:700;line-height:1.2;letter-spacing:-.01em}
  .linha-etapa{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-top:1px solid var(--line)}
  .linha-etapa:first-of-type{border-top:0}
  .linha-etapa .nome{color:var(--mut)}
  .linha-etapa .val{font-weight:700;font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:8px}
  .linha-etapa .dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}
  .linha-etapa .dot.bad{background:var(--red)}
  .linha-etapa .val.bad{color:var(--red)}
  .placeholder{color:var(--mut);font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}
  .placeholder-sub{color:var(--mut);font-size:12px;margin-top:4px}
  .erro-bloco{color:var(--mut);font-size:14px;padding:8px 0}
  /* login (reusa a mesma sessao do discador, D-02) */
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
</style>
</head>
<body>
<div class="wrap">
  <div id="login-view" style="display:none">
    <div class="logo">\u{1F4CA}</div>
    <h2>Painel operacional</h2>
    <p class="sub">RomeroCall — visão da operação do dia</p>
    <input id="u" class="field" placeholder="Usuário" autocapitalize="none" autocomplete="username">
    <input id="p" class="field" type="password" placeholder="Senha" autocomplete="current-password">
    <div id="login-err" class="err"></div>
    <button id="login-btn" class="primary">Entrar</button>
  </div>

  <div id="painel-view" style="display:none">
    <header>
      <div class="row">
        <h1>Painel operacional</h1>
        <span id="upd-pill" class="pill">—</span>
        <button id="logout-btn" class="ghost">Sair</button>
      </div>
    </header>
    <main>
      <section id="kpis-bloco" class="bloco">
        <div id="kpis-erro" class="erro-bloco" style="display:none"></div>
        <div id="kpis-grid" class="kpi-grid">
          <div class="card">
            <div class="kpi-label"><span class="kpi-dot"></span>Atendentes online</div>
            <div id="kpi-atendentes" class="kpi-display ok">—</div>
          </div>
          <div class="card">
            <div class="kpi-label">Chamadas ativas</div>
            <div id="kpi-chamadas" class="kpi-display ok">—</div>
            <div id="kpi-chamadas-vazio" class="kpi-empty" style="display:none"><b>Nenhuma chamada ativa agora</b>Volte a checar quando o lote do dia começar a rodar.</div>
          </div>
          <div class="card">
            <div class="kpi-label">Gravações na fila</div>
            <div id="kpi-fila" class="kpi-display ok">—</div>
            <div id="kpi-fila-vazio" class="kpi-empty" style="display:none"><b>Fila de gravações vazia</b>Volte a checar quando o lote do dia começar a rodar.</div>
          </div>
          <div class="card">
            <div class="kpi-label">Erros do dia</div>
            <div id="kpi-erros" class="kpi-display ok">—</div>
          </div>
        </div>
      </section>

      <section id="filas-bloco" class="bloco">
        <div class="bloco-title">Filas e erros</div>
        <div id="filas-erro" class="erro-bloco" style="display:none"></div>
        <div id="filas-card" class="card">
          <div class="linha-etapa">
            <span class="nome">Profundidade da fila</span>
            <span id="linha-fila-val" class="val"><span class="dot"></span>—</span>
          </div>
          <div class="linha-etapa">
            <span class="nome">Webhook</span>
            <span id="linha-webhook-val" class="val"><span class="dot"></span>—</span>
          </div>
          <div class="linha-etapa">
            <span class="nome">Transcrição (Deepgram)</span>
            <span id="linha-transcricao-val" class="val"><span class="dot"></span>—</span>
          </div>
          <div class="linha-etapa">
            <span class="nome">Análise (Azure OpenAI)</span>
            <span id="linha-analise-val" class="val"><span class="dot"></span>—</span>
          </div>
          <div class="linha-etapa">
            <span class="nome">Sync ClickUp</span>
            <span id="linha-sync-val" class="val"><span class="dot"></span>—</span>
          </div>
          <div class="linha-etapa">
            <span class="nome">429s do ClickUp</span>
            <span id="linha-429-val" class="val"><span class="dot"></span>—</span>
          </div>
        </div>
      </section>

      <section id="saude-bloco" class="bloco">
        <div class="bloco-title">Saúde</div>
        <div class="card">
          <div class="placeholder">—</div>
          <div class="placeholder-sub">Status de réplica/deploy não é acompanhado ao vivo nesta fase. O alerta de saúde de réplica sai direto pelo Slack (ver runbook de deploy).</div>
        </div>
      </section>
    </main>
  </div>
</div>
<script src="/admin/app.js"></script>
</body>
</html>`;

export const ADMIN_APP_JS = `(function(){
  var tokenKey='discador_token';
  var pollMs=8000;
  var pollTimer=null, tickTimer=null, lastUpdateTs=0;
  function $(id){return document.getElementById(id);}
  function getToken(){return localStorage.getItem(tokenKey)||'';}
  function setToken(t){if(t){localStorage.setItem(tokenKey,t);}else{localStorage.removeItem(tokenKey);}}
  function show(v){$('login-view').style.display=(v==='login')?'flex':'none';$('painel-view').style.display=(v==='painel')?'block':'none';}
  function api(path){
    var opts={headers:{}};var t=getToken();if(t){opts.headers['Authorization']='Bearer '+t;}
    return fetch(path,opts).then(function(res){if(res.status===401){setToken('');pararPolling();show('login');throw new Error('401');}return res;});
  }
  function doLogin(){
    var u=$('u').value.trim(), p=$('p').value;$('login-err').textContent='';
    fetch('/api/discador/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuario:u,senha:p})})
    .then(function(res){return res.json().then(function(j){return {ok:res.ok,j:j};});})
    .then(function(r){if(!r.ok||!r.j.token){$('login-err').textContent='Usuário ou senha inválidos.';return;}setToken(r.j.token);$('p').value='';iniciarPainel();})
    .catch(function(){$('login-err').textContent='Erro ao entrar.';});
  }
  function classe(valor,limite){return (limite>0&&valor>limite)?'bad':'ok';}
  function setLinha(prefixo,texto,ruim){
    var el=$(prefixo+'-val');if(!el){return;}
    el.className='val'+(ruim?' bad':'');
    el.innerHTML='';
    var d=document.createElement('span');d.className='dot'+(ruim?' bad':'');el.appendChild(d);
    el.appendChild(document.createTextNode(texto));
  }
  function pct(taxa){return Math.round((taxa||0)*100)+'%';}
  function atualizarPainel(m){
    var t=m.thresholds||{};
    // KPIs
    $('kpi-atendentes').textContent=String(m.atendentesOnline||0);
    $('kpi-atendentes').className='kpi-display ok';
    $('kpi-chamadas').textContent=String(m.chamadasAtivas||0);
    $('kpi-chamadas').className='kpi-display ok';
    $('kpi-chamadas-vazio').style.display=(m.chamadasAtivas===0)?'block':'none';
    var filaRuim=t.fila>0&&m.profundidadeFila>t.fila;
    $('kpi-fila').textContent=String(m.profundidadeFila||0);
    $('kpi-fila').className='kpi-display '+(filaRuim?'bad':'ok');
    $('kpi-fila-vazio').style.display=(m.profundidadeFila===0)?'block':'none';
    $('kpi-erros').textContent=String(m.errosDia||0);
    $('kpi-erros').className='kpi-display ok';
    // Filas e erros
    setLinha('linha-fila',String(m.profundidadeFila||0),filaRuim);
    var etapas=m.taxaErroPorEtapa||{};
    var nomes={webhook:'linha-webhook',transcricao:'linha-transcricao',analise:'linha-analise',sync:'linha-sync'};
    for(var k in nomes){
      var e=etapas[k]||{erros:0,total:0,taxa:0};
      var ruim=t.erroTaxa>0&&e.total>0&&e.taxa>t.erroTaxa;
      setLinha(nomes[k],pct(e.taxa)+' ('+e.erros+'/'+e.total+')',ruim);
    }
    var contagem429Ruim=t.contagem429>0&&m.contagem429>t.contagem429;
    setLinha('linha-429',String(m.contagem429||0),contagem429Ruim);
    $('kpis-erro').style.display='none';
    $('kpis-grid').style.display='grid';
    $('filas-erro').style.display='none';
    $('filas-card').style.display='block';
    lastUpdateTs=Date.now();
  }
  function mostrarErroBlocos(){
    var msg='Não foi possível carregar as métricas agora. Atualizando de novo em '+(pollMs/1000)+'s.';
    $('kpis-erro').textContent=msg;$('kpis-erro').style.display='block';$('kpis-grid').style.display='none';
    $('filas-erro').textContent=msg;$('filas-erro').style.display='block';$('filas-card').style.display='none';
  }
  function buscarMetricas(){
    api('/api/admin/metricas').then(function(res){
      if(!res.ok){mostrarErroBlocos();return;}
      return res.json().then(function(m){atualizarPainel(m);});
    }).catch(function(e){
      if(e&&e.message==='401'){return;}
      mostrarErroBlocos();
    });
  }
  function tickPill(){
    if(!lastUpdateTs){$('upd-pill').textContent='—';return;}
    var s=Math.floor((Date.now()-lastUpdateTs)/1000);
    $('upd-pill').textContent='atualizado há '+s+'s';
  }
  function iniciarPolling(){
    if(pollTimer){return;}
    buscarMetricas();
    pollTimer=setInterval(buscarMetricas,pollMs);
    if(!tickTimer){tickTimer=setInterval(tickPill,1000);}
  }
  function pararPolling(){
    if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
    if(tickTimer){clearInterval(tickTimer);tickTimer=null;}
  }
  function iniciarPainel(){
    show('painel');
    iniciarPolling();
  }
  document.addEventListener('visibilitychange',function(){
    if(document.visibilityState==='visible'){if(getToken()){iniciarPolling();}}
    else{pararPolling();}
  });
  window.addEventListener('DOMContentLoaded',function(){
    $('login-btn').onclick=doLogin;
    $('p').addEventListener('keydown',function(e){if(e.key==='Enter'){doLogin();}});
    $('logout-btn').onclick=function(){pararPolling();setToken('');show('login');};
    if(getToken()){iniciarPainel();}else{show('login');}
  });
})();`;
