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
<meta name="theme-color" content="#04122a">
<title>Painel operacional — RomeroCall</title>
<style>
  :root{
    --bg-0:#04122a;--bg-1:#0a2547;--bg-2:#0e3260;
    --card:rgba(255,255,255,.055);--card-2:rgba(255,255,255,.085);
    --line:rgba(255,255,255,.1);--line-2:rgba(255,255,255,.16);
    --ink:#fff;--dim:#93aacb;--dim-2:#6e86a8;
    --romero:#3d8bff;--go:#34d07f;--alert:#ff6b6b;--andreza:#f5c43d;
    --r-sm:11px;--r:14px;--r-md:16px;--r-lg:18px;--r-xl:22px;
    --shadow:0 18px 44px -18px rgba(2,10,26,.8);
    --ease:cubic-bezier(.2,.8,.3,1);--ease-out-soft:cubic-bezier(.2,.9,.3,1.2)
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{height:100%}
  html{background:radial-gradient(1100px 700px at 12% -8%,#123a6b 0%,transparent 58%),radial-gradient(900px 600px at 92% 4%,#0b2f5c 0%,transparent 52%),linear-gradient(178deg,var(--bg-0) 0%,var(--bg-1) 55%,#061b36 100%);background-attachment:fixed}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:var(--ink);background:transparent;-webkit-font-smoothing:antialiased;font-size:14px;line-height:1.5}
  .wrap{max-width:960px;margin:0 auto;min-height:100dvh;display:flex;flex-direction:column}
  header{position:sticky;top:0;z-index:5;padding:calc(14px + env(safe-area-inset-top)) 16px 12px 16px;background:rgba(4,18,42,.72);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid var(--line)}
  header .row{display:flex;align-items:center;gap:10px}
  header h1{font-size:18px;margin:0;flex:1;font-weight:700;letter-spacing:-.01em}
  .pill{font-size:11px;color:var(--dim-2);text-transform:uppercase;letter-spacing:.12em;padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:var(--card-2)}
  .ghost{background:none;border:0;color:var(--dim-2);padding:8px;border-radius:10px;font-size:14px;font-family:inherit}
  .ghost:active{background:var(--card)}
  input,button{font-size:16px;font-family:inherit}
  main{flex:1;padding:24px 16px calc(48px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:32px}
  .muted{color:var(--dim)}
  /* cartao glass — mesmo padrao visual de .m/.lblk (romero-mobile/app/globals.css) */
  .card{position:relative;border-radius:var(--r-md);padding:16px;background:var(--card);-webkit-backdrop-filter:blur(16px) saturate(180%);backdrop-filter:blur(16px) saturate(180%);border:1px solid var(--line);box-shadow:var(--shadow)}
  /* grid de 4 KPIs — 1 coluna mobile / 2-4 colunas em telas largas */
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}
  .kpi-label{font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700;color:var(--dim-2);display:flex;align-items:center;gap:6px}
  .kpi-dot{width:6px;height:6px;border-radius:50%;background:var(--go);flex:0 0 auto}
  .kpi-display{font-size:28px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums;letter-spacing:-.035em;margin-top:8px;color:var(--ink)}
  .kpi-display.ok{color:var(--ink)}
  .kpi-display.bad{color:var(--alert)}
  .kpi-empty{margin-top:8px;font-size:12px;color:var(--dim-2)}
  .kpi-empty b{display:block;color:var(--ink);font-weight:700;margin-bottom:2px}
  section.bloco{display:flex;flex-direction:column;gap:12px}
  .bloco-title{font-size:18px;font-weight:800;line-height:1.2;letter-spacing:-.02em}
  .linha-etapa{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-top:1px solid rgba(255,255,255,.05)}
  .linha-etapa:first-of-type{border-top:0}
  .linha-etapa .nome{color:var(--dim)}
  .linha-etapa .val{font-weight:700;font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:8px}
  .linha-etapa .dot{width:8px;height:8px;border-radius:50%;background:var(--go)}
  .linha-etapa .dot.bad{background:var(--alert)}
  .linha-etapa .val.bad{color:var(--alert)}
  .placeholder{color:var(--dim);font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}
  .placeholder-sub{color:var(--dim-2);font-size:12px;margin-top:4px}
  .erro-bloco{color:var(--dim);font-size:14px;padding:8px 0}
  /* login (reusa a mesma sessao do discador, D-02) */
  #login-view{flex:1;display:flex;flex-direction:column;justify-content:center;padding:28px;gap:14px;max-width:420px;margin:0 auto;width:100%}
  #login-view .logo{width:66px;height:66px;margin:0 auto 8px;border-radius:var(--r-lg);background:linear-gradient(150deg,#3d8bff,#1b4fa0);display:flex;align-items:center;justify-content:center;font-size:30px;box-shadow:var(--shadow)}
  #login-view h2{text-align:center;margin:0 0 4px;font-weight:800;letter-spacing:-.02em}
  #login-view .sub{text-align:center;color:var(--dim-2);margin:0 0 12px;font-size:14px}
  .field{padding:14px 16px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--ink);width:100%;font-size:clamp(16px,4vw,18px);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
  .field::placeholder{color:var(--dim-2)}
  .field:focus{outline:none;border-color:var(--romero)}
  .primary{background:linear-gradient(90deg,#3d8bff,#2bb6a0);color:#04122a;border:0;border-radius:15px;padding:14px;font-weight:800;width:100%;letter-spacing:.01em}
  .primary:active{transform:scale(.985)}
  .err{color:var(--alert);text-align:center;font-size:14px;min-height:18px}
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
        <button id="nav-painel-btn" class="ghost">Painel</button>
        <button id="nav-usuarios-btn" class="ghost" style="display:none">Usuários</button>
        <button id="logout-btn" class="ghost">Sair</button>
      </div>
    </header>
    <main>
      <div id="painel-tab">
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
      </div>

      <section id="usuarios-bloco" class="bloco" style="display:none">
        <div class="bloco-title">Usuários</div>
        <p class="muted" style="margin:0">Operadores do discador — usuário, papel, vínculo ao membro do ClickUp e ao device Wavoip (opcional).</p>
        <div id="usuarios-erro" class="erro-bloco" style="display:none"></div>
        <div id="usuarios-lista"></div>
        <form id="usuario-form" class="card" style="display:flex;flex-direction:column;gap:10px">
          <div class="bloco-title" style="font-size:15px">Novo operador</div>
          <input id="f-usuario" class="field" placeholder="Usuário" autocapitalize="none" autocomplete="off">
          <input id="f-senha" class="field" type="password" placeholder="Senha inicial" autocomplete="new-password">
          <select id="f-papel" class="field">
            <option value="atendente">Atendente</option>
            <option value="gestor">Gestor</option>
          </select>
          <select id="sel-membro" class="field">
            <option value="">— carregando membros do ClickUp —</option>
          </select>
          <select id="sel-device" class="field">
            <option value="">— pool/global —</option>
          </select>
          <button type="submit" class="primary">Criar operador</button>
        </form>
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
    carregarMembros();
    carregarDevices();
    carregarUsuarios();
  }
  document.addEventListener('visibilitychange',function(){
    if(document.visibilityState==='visible'){if(getToken()){iniciarPolling();}}
    else{pararPolling();}
  });

  // ============ Usuários (gestão de operadores — Fase 11) ============
  // Aba visível só para gestor: a autoridade real é o gate server-side em
  // /api/admin/usuarios* (403 pra atendente) — o hide aqui é so conveniencia de UI.
  var MEMBROS=[], DEVICES=[];
  function esc(s){
    return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function mostrarTab(tab){
    $('painel-tab').style.display=(tab==='painel')?'block':'none';
    $('usuarios-bloco').style.display=(tab==='usuarios')?'flex':'none';
  }
  function apiEnvio(path,method,body){
    var t=getToken();
    var opts={method:method,headers:{'Content-Type':'application/json'}};
    if(t){opts.headers['Authorization']='Bearer '+t;}
    if(body!==undefined){opts.body=JSON.stringify(body);}
    return fetch(path,opts).then(function(res){
      if(res.status===401){setToken('');pararPolling();show('login');throw new Error('401');}
      return res.json().catch(function(){return {};}).then(function(j){return {ok:res.ok,status:res.status,j:j};});
    });
  }
  function nomeMembro(id){
    if(!id){return '— sem vínculo —';}
    for(var i=0;i<MEMBROS.length;i++){if(String(MEMBROS[i].id)===String(id)){return MEMBROS[i].nome||MEMBROS[i].email||id;}}
    return id;
  }
  function nomeDevice(id){
    if(!id){return '— pool/global —';}
    for(var i=0;i<DEVICES.length;i++){if(String(DEVICES[i].deviceId)===String(id)){return DEVICES[i].numero||id;}}
    return id;
  }
  function preencherSelectMembros(valorAtual){
    var sel=$('sel-membro');sel.innerHTML='';
    var op0=document.createElement('option');op0.value='';op0.textContent='— selecione o membro ClickUp —';sel.appendChild(op0);
    for(var i=0;i<MEMBROS.length;i++){
      var m=MEMBROS[i];var op=document.createElement('option');op.value=m.id;op.textContent=(m.nome||m.email||m.id);
      if(valorAtual!=null&&String(valorAtual)===String(m.id)){op.selected=true;}
      sel.appendChild(op);
    }
  }
  function preencherSelectDevices(valorAtual){
    var sel=$('sel-device');sel.innerHTML='';
    var op0=document.createElement('option');op0.value='';op0.textContent='— pool/global —';sel.appendChild(op0);
    for(var i=0;i<DEVICES.length;i++){
      var d=DEVICES[i];var op=document.createElement('option');op.value=d.deviceId;op.textContent=(d.numero||d.deviceId);
      if(valorAtual!=null&&String(valorAtual)===String(d.deviceId)){op.selected=true;}
      sel.appendChild(op);
    }
  }
  function carregarMembros(){
    api('/api/admin/clickup-membros').then(function(res){
      if(!res.ok){return;}
      return res.json().then(function(j){MEMBROS=j.membros||[];preencherSelectMembros();renderUsuarios(ULTIMA_LISTA);});
    }).catch(function(){});
  }
  function carregarDevices(){
    api('/api/admin/devices').then(function(res){
      if(!res.ok){return;}
      return res.json().then(function(j){DEVICES=j.devices||[];preencherSelectDevices();renderUsuarios(ULTIMA_LISTA);});
    }).catch(function(){});
  }
  var ULTIMA_LISTA=[];
  function renderUsuarios(usuarios){
    ULTIMA_LISTA=usuarios||[];
    var lista=$('usuarios-lista');lista.innerHTML='';
    if(!ULTIMA_LISTA.length){
      var vazio=document.createElement('div');vazio.className='muted';vazio.textContent='Nenhum operador cadastrado ainda.';lista.appendChild(vazio);
      return;
    }
    for(var i=0;i<ULTIMA_LISTA.length;i++){
      (function(u){
        var card=document.createElement('div');card.className='card';card.style.marginBottom='10px';
        card.innerHTML=
          '<div style="display:flex;align-items:center;gap:8px;justify-content:space-between">'
          +'<div><b>'+esc(u.usuario)+'</b> <span class="pill">'+(u.papel==='gestor'?'Gestor':'Atendente')+'</span></div>'
          +'</div>'
          +'<div class="muted" style="margin-top:6px">Membro ClickUp: '+esc(nomeMembro(u.clickup_member_id))+'</div>'
          +'<div class="muted">Device: '+esc(nomeDevice(u.wavoip_device_id))+'</div>'
          +'<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">'
          +'<button type="button" class="ghost btn-editar">Editar</button>'
          +'<button type="button" class="ghost btn-reset">Resetar senha</button>'
          +'<button type="button" class="ghost btn-remover">Remover</button>'
          +'</div>';
        var btnEditar=card.querySelector('.btn-editar');
        var btnReset=card.querySelector('.btn-reset');
        var btnRemover=card.querySelector('.btn-remover');
        btnEditar.onclick=function(){ativarEdicao(card,u);};
        btnReset.onclick=function(){resetarSenha(u.id);};
        btnRemover.onclick=function(){removerUsuario(u.id,u.usuario);};
        lista.appendChild(card);
      })(ULTIMA_LISTA[i]);
    }
  }
  function ativarEdicao(card,u){
    card.innerHTML='';
    var titulo=document.createElement('div');titulo.innerHTML='<b>'+esc(u.usuario)+'</b>';card.appendChild(titulo);
    var selPapel=document.createElement('select');selPapel.className='field';selPapel.style.marginTop='8px';
    ['atendente','gestor'].forEach(function(p){var op=document.createElement('option');op.value=p;op.textContent=(p==='gestor'?'Gestor':'Atendente');if(p===u.papel){op.selected=true;}selPapel.appendChild(op);});
    card.appendChild(selPapel);
    var selMembro=document.createElement('select');selMembro.className='field';selMembro.style.marginTop='8px';
    var opM0=document.createElement('option');opM0.value='';opM0.textContent='— sem vínculo —';selMembro.appendChild(opM0);
    MEMBROS.forEach(function(m){var op=document.createElement('option');op.value=m.id;op.textContent=(m.nome||m.email||m.id);if(String(u.clickup_member_id)===String(m.id)){op.selected=true;}selMembro.appendChild(op);});
    card.appendChild(selMembro);
    var selDevice=document.createElement('select');selDevice.className='field';selDevice.style.marginTop='8px';
    var opD0=document.createElement('option');opD0.value='';opD0.textContent='— pool/global —';selDevice.appendChild(opD0);
    DEVICES.forEach(function(d){var op=document.createElement('option');op.value=d.deviceId;op.textContent=(d.numero||d.deviceId);if(String(u.wavoip_device_id)===String(d.deviceId)){op.selected=true;}selDevice.appendChild(op);});
    card.appendChild(selDevice);
    var linhaBtns=document.createElement('div');linhaBtns.style.cssText='display:flex;gap:8px;margin-top:10px';
    var btnSalvar=document.createElement('button');btnSalvar.type='button';btnSalvar.className='ghost';btnSalvar.textContent='Salvar';
    var btnCancelar=document.createElement('button');btnCancelar.type='button';btnCancelar.className='ghost';btnCancelar.textContent='Cancelar';
    linhaBtns.appendChild(btnSalvar);linhaBtns.appendChild(btnCancelar);card.appendChild(linhaBtns);
    btnCancelar.onclick=function(){renderUsuarios(ULTIMA_LISTA);};
    btnSalvar.onclick=function(){
      editarUsuario(u.id,{papel:selPapel.value,clickup_member_id:selMembro.value||null,wavoip_device_id:selDevice.value||null});
    };
  }
  function mostrarErroUsuarios(msg){
    var el=$('usuarios-erro');el.textContent=msg;el.style.display='block';
  }
  function carregarUsuarios(){
    api('/api/admin/usuarios').then(function(res){
      if(res.status===403){
        $('nav-usuarios-btn').style.display='none';
        if($('usuarios-bloco').style.display!=='none'){mostrarTab('painel');}
        return;
      }
      $('nav-usuarios-btn').style.display='inline-block';
      if(!res.ok){mostrarErroUsuarios('Não foi possível carregar os usuários agora.');return;}
      return res.json().then(function(j){$('usuarios-erro').style.display='none';renderUsuarios(j.usuarios||[]);});
    }).catch(function(e){if(e&&e.message==='401'){return;}mostrarErroUsuarios('Não foi possível carregar os usuários agora.');});
  }
  function criarUsuario(ev){
    if(ev&&ev.preventDefault){ev.preventDefault();}
    var usuario=$('f-usuario').value.trim();
    var senha=$('f-senha').value;
    var papel=$('f-papel').value;
    var membro=$('sel-membro').value;
    var device=$('sel-device').value;
    $('usuarios-erro').style.display='none';
    if(!usuario||!senha){mostrarErroUsuarios('Usuário e senha são obrigatórios.');return;}
    apiEnvio('/api/admin/usuarios','POST',{usuario:usuario,senha:senha,papel:papel,clickup_member_id:membro||null,wavoip_device_id:device||null})
    .then(function(r){
      if(!r.ok){mostrarErroUsuarios((r.j&&r.j.erro)||'Erro ao criar operador.');return;}
      $('f-usuario').value='';$('f-senha').value='';$('f-papel').value='atendente';preencherSelectMembros();preencherSelectDevices();
      carregarUsuarios();
    }).catch(function(e){if(e&&e.message==='401'){return;}mostrarErroUsuarios('Erro ao criar operador.');});
  }
  function resetarSenha(id){
    var nova=window.prompt('Nova senha para este operador:');
    if(!nova){return;}
    apiEnvio('/api/admin/usuarios/'+encodeURIComponent(id),'PATCH',{senha:nova})
    .then(function(r){if(!r.ok){mostrarErroUsuarios((r.j&&r.j.erro)||'Erro ao resetar a senha.');return;}carregarUsuarios();})
    .catch(function(e){if(e&&e.message==='401'){return;}mostrarErroUsuarios('Erro ao resetar a senha.');});
  }
  function editarUsuario(id,campos){
    apiEnvio('/api/admin/usuarios/'+encodeURIComponent(id),'PATCH',campos)
    .then(function(r){if(!r.ok){mostrarErroUsuarios((r.j&&r.j.erro)||'Erro ao atualizar operador.');return;}carregarUsuarios();})
    .catch(function(e){if(e&&e.message==='401'){return;}mostrarErroUsuarios('Erro ao atualizar operador.');});
  }
  function removerUsuario(id,usuario){
    if(!window.confirm('Remover o operador "'+usuario+'"? Essa ação não pode ser desfeita.')){return;}
    apiEnvio('/api/admin/usuarios/'+encodeURIComponent(id),'DELETE')
    .then(function(r){if(!r.ok){mostrarErroUsuarios((r.j&&r.j.erro)||'Erro ao remover operador.');return;}carregarUsuarios();})
    .catch(function(e){if(e&&e.message==='401'){return;}mostrarErroUsuarios('Erro ao remover operador.');});
  }

  window.addEventListener('DOMContentLoaded',function(){
    $('login-btn').onclick=doLogin;
    $('p').addEventListener('keydown',function(e){if(e.key==='Enter'){doLogin();}});
    $('logout-btn').onclick=function(){pararPolling();setToken('');show('login');};
    $('nav-painel-btn').onclick=function(){mostrarTab('painel');};
    $('nav-usuarios-btn').onclick=function(){mostrarTab('usuarios');carregarUsuarios();};
    $('usuario-form').addEventListener('submit',criarUsuario);
    if(getToken()){iniciarPainel();}else{show('login');}
  });
})();`;
