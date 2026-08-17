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
  /* combobox de membro: clica -> abre todos; digita -> filtra */
  .combo{position:relative}
  .combo-lista{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:40;max-height:260px;overflow:auto;background:#0e3260;border:1px solid var(--line-2);border-radius:12px;box-shadow:0 12px 32px rgba(2,6,16,.55)}
  .combo-item{padding:12px 14px;cursor:pointer;font-size:15px;color:var(--ink);border-bottom:1px solid var(--line)}
  .combo-item:last-child{border-bottom:none}
  .combo-item:hover,.combo-item.sel{background:rgba(61,139,255,.22)}
  .combo-item.vazio{color:var(--dim)}
  /* conexoes wavoip: cada aparelho + selo de status */
  .wdev{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card);margin-bottom:8px}
  .wdot{width:11px;height:11px;border-radius:50%;flex:none}
  .wdot.on{background:#2ec46b;box-shadow:0 0 8px rgba(46,196,107,.6)}
  .wdot.mid{background:#f0b429}
  .wdot.off{background:#ff5c5c}
  .wdot.zzz{background:#6e86a8}
  .wbadge{font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
  .wbadge.ok{color:#2ec46b;border-color:rgba(46,196,107,.45)}
  .wbadge.no{color:#f0b429;border-color:rgba(240,180,41,.45)}
  .wowner{font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid rgba(61,139,255,.45);color:#7fb0ff;white-space:nowrap;font-weight:700}
  .wowner.livre{color:var(--dim-2);border-color:var(--line);font-weight:400}
  .cnum-row{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card);margin-bottom:8px}
  .cnum-main{flex:1;min-width:0}
  .cnum-nome{font-weight:700}
  .cnum-sub{font-size:12px;color:var(--dim)}
  .cnum-nums{display:flex;gap:18px;align-items:flex-start;text-align:right;flex:none}
  .cnum-metric{display:flex;flex-direction:column;line-height:1.15}
  .cnum-metric b{font-size:17px}
  .cnum-metric .rot{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim-2)}
  .cnum-metric .det{font-size:11px;color:var(--dim);margin-top:2px}
  @media(max-width:640px){.cnum-nums{gap:12px}.cnum-metric b{font-size:15px}}
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

      <section id="chamadas-bloco" class="bloco">
        <div class="bloco-title">Chamadas por número</div>
        <div id="chamadas-erro" class="erro-bloco" style="display:none"></div>
        <div id="chamadas-lista"><p class="muted">Carregando…</p></div>
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
          <div id="wrap-membro"></div>
          <select id="sel-device" class="field">
            <option value="">— pool/global —</option>
          </select>
          <button type="submit" class="primary">Criar operador</button>
        </form>
      </section>

      <section id="wavoip-bloco" class="bloco" style="display:none">
        <div class="bloco-title">Conexões Wavoip</div>
        <p class="muted" style="margin:0">Aparelhos da conta Wavoip — status ao vivo e webhook de produção.</p>
        <div id="wavoip-erro" class="erro-bloco" style="display:none"></div>
        <div id="wavoip-acoes" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0"></div>
        <div id="wavoip-lista"></div>
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
  function pollTick(){buscarMetricas();carregarChamadasPorNumero();}
  function iniciarPolling(){
    if(pollTimer){return;}
    pollTick();
    pollTimer=setInterval(pollTick,pollMs);
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
    carregarUsuarios();
    // Os devices (números Wavoip) do dropdown de operador são carregados ao
    // abrir a aba Usuários (carregarWavoip) — junto com a seção Conexões.
  }
  document.addEventListener('visibilitychange',function(){
    if(document.visibilityState==='visible'){if(getToken()){iniciarPolling();}}
    else{pararPolling();}
  });

  // ============ Usuários (gestão de operadores — Fase 11) ============
  // Aba visível só para gestor: a autoridade real é o gate server-side em
  // /api/admin/usuarios* (403 pra atendente) — o hide aqui é so conveniencia de UI.
  var MEMBROS=[], DEVICES=[], comboMembroForm=null;
  // Último snapshot dos aparelhos Wavoip (pra repintar a lista de Conexões
  // quando a lista de operadores muda — os "donos" vêm de ULTIMA_LISTA).
  var WAVOIP_DEVS=[], WAVOIP_AUTO=false;
  function esc(s){
    return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function mostrarTab(tab){
    $('painel-tab').style.display=(tab==='painel')?'block':'none';
    $('usuarios-bloco').style.display=(tab==='usuarios')?'flex':'none';
    $('wavoip-bloco').style.display=(tab==='usuarios')?'flex':'none';
  }
  // ===== Conexões Wavoip (auto-descoberta + status + auto-webhook) =====
  function statusWavoip(s){
    s=String(s||'').toLowerCase();
    if(s==='open'){return {dot:'on',txt:'Conectado'};}
    if(s==='connecting'||s==='building'||s==='restarting'){return {dot:'mid',txt:'Conectando'};}
    if(s==='hibernating'){return {dot:'zzz',txt:'Hibernando'};}
    return {dot:'off',txt:'Caiu'};
  }
  function fmtNumWav(n){n=String(n||'');return n?('+'+n):'(sem número)';}
  // ===== Chamadas por número (tabela do Painel) =====
  function carregarChamadasPorNumero(){
    var lista=$('chamadas-lista'),erro=$('chamadas-erro');
    if(!lista){return;}
    api('/api/admin/chamadas-por-numero').then(function(res){return res.json().then(function(j){return {status:res.status,j:j};});}).then(function(r){
      if(r.status!==200){erro.textContent='Não foi possível carregar as chamadas por número agora.';erro.style.display='block';return;}
      if(r.j.naoConfig){erro.style.display='none';lista.innerHTML='<p class="muted">Conta Wavoip não configurada (WAVOIP_API_EMAIL / WAVOIP_API_PASSWORD no servidor).</p>';return;}
      erro.style.display='none';
      renderChamadasPorNumero(r.j.numeros||[]);
    }).catch(function(e){if(e&&e.message==='401'){return;}});
  }
  function renderChamadasPorNumero(numeros){
    var lista=$('chamadas-lista');if(!lista){return;}
    lista.innerHTML='';
    // Mostra os números "reais" (com número), com dono, ou com chamada hoje —
    // esconde os hibernando sem número (ruído). Se filtrar tudo, mostra todos.
    var vis=numeros.filter(function(d){return d.numero||d.operador||(d.hoje&&d.hoje.total>0);});
    if(!vis.length){vis=numeros;}
    if(!vis.length){lista.innerHTML='<p class="muted">Nenhum número na conta.</p>';return;}
    for(var i=0;i<vis.length;i++){(function(d){
      var st=statusWavoip(d.status);
      var h=d.hoje||{total:0,atendidas:0,nao:0};
      var nome=(d.nome&&d.nome!=='Nome do dispositivo')?d.nome:fmtNumWav(d.numero);
      var dono=d.operador?('👤 '+esc(String(d.operador))):'<span class="muted">livre</span>';
      var row=document.createElement('div');row.className='cnum-row';
      var dot=document.createElement('span');dot.className='wdot '+st.dot;row.appendChild(dot);
      var main=document.createElement('div');main.className='cnum-main';
      main.innerHTML='<div class="cnum-nome">'+esc(nome)+'</div><div class="cnum-sub">'+esc(fmtNumWav(d.numero))+' · '+esc(st.txt)+' · '+dono+'</div>';
      row.appendChild(main);
      var nums=document.createElement('div');nums.className='cnum-nums';
      nums.innerHTML=
        '<div class="cnum-metric"><b>'+(h.total||0)+'</b><span class="rot">hoje</span><span class="det">'+(h.atendidas||0)+'✓ · '+(h.nao||0)+'✗</span></div>'
        +'<div class="cnum-metric"><b>'+(d.callsMade||0)+'</b><span class="rot">total</span></div>';
      row.appendChild(nums);
      lista.appendChild(row);
    })(vis[i]);}
  }
  function carregarWavoip(){
    var lista=$('wavoip-lista'),acoes=$('wavoip-acoes'),erro=$('wavoip-erro');
    erro.style.display='none';acoes.innerHTML='';lista.innerHTML='<p class="muted">Carregando aparelhos…</p>';
    api('/api/admin/wavoip/dispositivos').then(function(res){return res.json().then(function(j){return {status:res.status,j:j};});}).then(function(r){
      if(r.status!==200){setDevices([]);lista.innerHTML='';erro.textContent='Não foi possível consultar a Wavoip agora.';erro.style.display='block';return;}
      if(r.j.naoConfig){setDevices([]);lista.innerHTML='';erro.textContent='Conta Wavoip não configurada (WAVOIP_API_EMAIL / WAVOIP_API_PASSWORD no .env do servidor).';erro.style.display='block';return;}
      var devs=r.j.dispositivos||[];
      // Mesma lista alimenta o dropdown de device do operador (associação).
      setDevices(devs.map(function(d){return {deviceId:String(d.id),numero:d.numero||'',nome:d.nome||'',status:d.status||'',conectado:!!d.conectado};}));
      renderWavoip(devs,!!r.j.autoWebhook);
    }).catch(function(e){if(e&&e.message==='401'){return;}setDevices([]);lista.innerHTML='';erro.textContent='Erro ao consultar a Wavoip.';erro.style.display='block';});
  }
  // Atualiza o inventário de devices e re-renderiza o que depende dele
  // (dropdown do formulário + rótulo "Device" nos cards de operador).
  function setDevices(lista){DEVICES=lista||[];preencherSelectDevices();renderUsuarios(ULTIMA_LISTA);}
  function renderWavoip(devs,autoWebhook){WAVOIP_DEVS=devs||[];WAVOIP_AUTO=!!autoWebhook;pintarWavoip();}
  function pintarWavoip(){
    var devs=WAVOIP_DEVS,autoWebhook=WAVOIP_AUTO;
    var lista=$('wavoip-lista'),acoes=$('wavoip-acoes');
    if(!lista||!acoes){return;}
    var conectados=devs.filter(function(d){return d.conectado;}).length;
    var faltando=devs.filter(function(d){return d.conectado&&d.webhookOk===false;}).length;
    acoes.innerHTML='';
    var resumo=document.createElement('span');resumo.className='muted';resumo.textContent=conectados+' conectado(s) de '+devs.length+' aparelho(s)';acoes.appendChild(resumo);
    if(!autoWebhook){var av=document.createElement('span');av.className='wbadge no';av.textContent='auto-webhook off (defina WAVOIP_WEBHOOK_URL)';acoes.appendChild(av);}
    else if(faltando>0){var b=document.createElement('button');b.type='button';b.className='primary';b.textContent='Configurar webhook em '+faltando+' conectado(s)';b.onclick=function(){sincronizarWebhooks(b);};acoes.appendChild(b);}
    else if(conectados>0){var ok=document.createElement('span');ok.className='wbadge ok';ok.textContent='webhook ok em todos os conectados';acoes.appendChild(ok);}
    lista.innerHTML='';
    devs.slice().sort(function(a,b){return (b.conectado?1:0)-(a.conectado?1:0);}).forEach(function(d){
      var st=statusWavoip(d.status);
      var row=document.createElement('div');row.className='wdev';
      var dot=document.createElement('span');dot.className='wdot '+st.dot;row.appendChild(dot);
      var info=document.createElement('div');info.style.flex='1';info.style.minWidth='0';
      info.innerHTML='<div style="font-weight:700">'+esc(d.nome||'(sem nome)')+'</div><div class="muted" style="font-size:12px">'+esc(fmtNumWav(d.numero))+' · '+esc(st.txt)+'</div>';
      row.appendChild(info);
      // Quem está com este número (exclusividade device↔operador).
      var dono=donoDevice(d.id);
      var donoEl=document.createElement('span');donoEl.className='wowner'+(dono?'':' livre');donoEl.textContent=dono?('👤 '+dono):'livre';row.appendChild(donoEl);
      if(d.conectado&&autoWebhook){
        var wb=document.createElement('span');
        if(d.webhookOk===true){wb.className='wbadge ok';wb.textContent='webhook ✓';}
        else if(d.webhookOk===false){wb.className='wbadge no';wb.textContent='webhook faltando';}
        else{wb.className='wbadge';wb.textContent='webhook ?';}
        row.appendChild(wb);
      }
      lista.appendChild(row);
    });
    if(!devs.length){lista.innerHTML='<p class="muted">Nenhum aparelho na conta.</p>';}
  }
  function sincronizarWebhooks(btn){
    btn.disabled=true;btn.textContent='Configurando…';$('wavoip-erro').style.display='none';
    apiEnvio('/api/admin/wavoip/webhooks/sincronizar','POST',{}).then(function(r){
      if(!r.ok){$('wavoip-erro').textContent=(r.j&&r.j.erro)||'Erro ao configurar webhooks.';$('wavoip-erro').style.display='block';btn.disabled=false;return;}
      carregarWavoip();
    }).catch(function(e){if(e&&e.message==='401'){return;}btn.disabled=false;$('wavoip-erro').textContent='Erro ao configurar webhooks.';$('wavoip-erro').style.display='block';});
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
  // Combobox de membro: UM campo so. Clicar abre a lista com TODOS; digitar
  // filtra; clicar num nome seleciona (o id fica em lerId). A selecao so muda
  // ao clicar num item — digitar sem escolher volta ao valor anterior no blur.
  // Vanilla, dentro de template literal: sem crase nem cifrao-chave.
  function criarComboMembro(valorInicialId){
    var wrap=document.createElement('div');wrap.className='combo';
    var inp=document.createElement('input');inp.className='field';inp.autocomplete='off';
    inp.placeholder='Clique para ver todos ou digite o nome...';
    var lista=document.createElement('div');lista.className='combo-lista';lista.style.display='none';
    wrap.appendChild(inp);wrap.appendChild(lista);
    var selId=(valorInicialId!=null&&valorInicialId!=='')?String(valorInicialId):'';
    if(selId){inp.value=nomeMembro(selId);}
    var aberto=false;
    function render(filtro){
      lista.innerHTML='';
      var q=(filtro||'').trim().toLowerCase();
      var itens=[{id:'',rot:'— sem vínculo —',vazio:true}];
      for(var i=0;i<MEMBROS.length;i++){var m=MEMBROS[i];var rot=(m.nome||m.email||m.id);
        if(q&&String(rot).toLowerCase().indexOf(q)===-1&&String(m.email||'').toLowerCase().indexOf(q)===-1){continue;}
        itens.push({id:String(m.id),rot:rot,vazio:false});}
      if(itens.length===1&&q){itens.push({id:'',rot:'nenhum membro encontrado',vazio:true,nao:true});}
      for(var k=0;k<itens.length;k++){(function(it){
        var d=document.createElement('div');
        d.className='combo-item'+(it.vazio?' vazio':'')+(it.id&&it.id===selId?' sel':'');
        d.textContent=it.rot;
        d.onmousedown=function(e){e.preventDefault();if(it.nao){return;}selId=it.id;inp.value=it.id?it.rot:'';fechar();};
        lista.appendChild(d);
      })(itens[k]);}
    }
    function abrir(filtro){aberto=true;render(filtro||'');lista.style.display='block';}
    function fechar(){aberto=false;lista.style.display='none';}
    inp.addEventListener('focus',function(){try{inp.select();}catch(e){}abrir('');});
    inp.addEventListener('click',function(){if(!aberto){abrir('');}});
    inp.addEventListener('input',function(){abrir(inp.value);});
    inp.addEventListener('blur',function(){setTimeout(function(){fechar();inp.value=selId?nomeMembro(selId):'';},160);});
    wrap.lerId=function(){return selId;};
    return wrap;
  }
  // Rótulo legível de um device Wavoip: "Romero 01 · +55… · Conectado". O nome
  // default da Wavoip ("Nome do dispositivo") é tratado como sem-nome.
  function rotDevice(d){
    var nome=(d.nome&&d.nome!=='Nome do dispositivo')?d.nome:'';
    var num=d.numero?('+'+d.numero):'';
    var base=nome||num||('device '+d.deviceId);
    var partes=[base];
    if(nome&&num){partes.push(num);}
    partes.push(statusWavoip(d.status).txt);
    return partes.join(' · ');
  }
  function nomeDevice(id){
    if(!id){return '— pool/global —';}
    for(var i=0;i<DEVICES.length;i++){if(String(DEVICES[i].deviceId)===String(id)){return rotDevice(DEVICES[i]);}}
    return 'device '+id;
  }
  // Operador (usuario) já associado a este deviceId, ou '' se livre. Fonte:
  // a lista de operadores (ULTIMA_LISTA), campo wavoip_device_id.
  function donoDevice(id){
    var alvo=String(id||'');if(!alvo){return '';}
    for(var i=0;i<ULTIMA_LISTA.length;i++){if(String(ULTIMA_LISTA[i].wavoip_device_id||'')===alvo){return ULTIMA_LISTA[i].usuario;}}
    return '';
  }
  // Monta as <option> de um <select> de device: pool/global + os aparelhos
  // ASSOCIÁVEIS (com número), conectados primeiro. Esconde os já associados a
  // OUTRO operador (exclusividade). Mantém sempre o já-selecionado (alvo), pra
  // edição não perder o vínculo atual nem esconder o próprio número.
  function montarOpcoesDevice(sel,valorAtual){
    sel.innerHTML='';
    var op0=document.createElement('option');op0.value='';op0.textContent='— pool/global —';sel.appendChild(op0);
    var alvo=(valorAtual==null)?'':String(valorAtual);
    var ordenados=DEVICES.slice().sort(function(a,b){return (b.conectado?1:0)-(a.conectado?1:0);});
    for(var i=0;i<ordenados.length;i++){
      var d=ordenados[i];var idd=String(d.deviceId);
      if(idd===alvo){/* o próprio: sempre entra */}
      else if(!d.numero){continue;}        // sem número: não é associável
      else if(donoDevice(idd)){continue;}   // já é de outro operador: esconde
      var op=document.createElement('option');op.value=d.deviceId;op.textContent=rotDevice(d);
      if(idd===alvo){op.selected=true;}
      sel.appendChild(op);
    }
  }
  function preencherSelectMembros(valorAtual){
    // (Re)cria o combobox do formulário no contêiner fixo. Chamado quando os
    // membros carregam e ao resetar o form após criar um operador.
    var wrap=$('wrap-membro');if(!wrap){return;}
    wrap.innerHTML='';
    comboMembroForm=criarComboMembro(valorAtual!=null?valorAtual:'');
    wrap.appendChild(comboMembroForm);
  }
  function preencherSelectDevices(valorAtual){
    var sel=$('sel-device');if(!sel){return;}
    montarOpcoesDevice(sel,valorAtual);
  }
  function carregarMembros(){
    api('/api/admin/clickup-membros').then(function(res){
      if(!res.ok){return;}
      return res.json().then(function(j){MEMBROS=j.membros||[];preencherSelectMembros();renderUsuarios(ULTIMA_LISTA);});
    }).catch(function(){});
  }
  var ULTIMA_LISTA=[];
  function renderUsuarios(usuarios){
    ULTIMA_LISTA=usuarios||[];
    var lista=$('usuarios-lista');lista.innerHTML='';
    if(!ULTIMA_LISTA.length){
      var vazio=document.createElement('div');vazio.className='muted';vazio.textContent='Nenhum operador cadastrado ainda.';lista.appendChild(vazio);
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
    // Donos mudaram: repinta as Conexões (chip do operador) e re-filtra o
    // dropdown do formulário preservando a seleção atual (exclusividade).
    if(WAVOIP_DEVS.length){pintarWavoip();}
    var selForm=$('sel-device');if(selForm){montarOpcoesDevice(selForm,selForm.value||'');}
  }
  function ativarEdicao(card,u){
    card.innerHTML='';
    var titulo=document.createElement('div');titulo.innerHTML='<b>'+esc(u.usuario)+'</b>';card.appendChild(titulo);
    var selPapel=document.createElement('select');selPapel.className='field';selPapel.style.marginTop='8px';
    ['atendente','gestor'].forEach(function(p){var op=document.createElement('option');op.value=p;op.textContent=(p==='gestor'?'Gestor':'Atendente');if(p===u.papel){op.selected=true;}selPapel.appendChild(op);});
    card.appendChild(selPapel);
    var selMembro=criarComboMembro(u.clickup_member_id);selMembro.style.marginTop='8px';
    card.appendChild(selMembro);
    var selDevice=document.createElement('select');selDevice.className='field';selDevice.style.marginTop='8px';
    montarOpcoesDevice(selDevice,u.wavoip_device_id);
    card.appendChild(selDevice);
    var linhaBtns=document.createElement('div');linhaBtns.style.cssText='display:flex;gap:8px;margin-top:10px';
    var btnSalvar=document.createElement('button');btnSalvar.type='button';btnSalvar.className='ghost';btnSalvar.textContent='Salvar';
    var btnCancelar=document.createElement('button');btnCancelar.type='button';btnCancelar.className='ghost';btnCancelar.textContent='Cancelar';
    linhaBtns.appendChild(btnSalvar);linhaBtns.appendChild(btnCancelar);card.appendChild(linhaBtns);
    btnCancelar.onclick=function(){renderUsuarios(ULTIMA_LISTA);};
    btnSalvar.onclick=function(){
      editarUsuario(u.id,{papel:selPapel.value,clickup_member_id:selMembro.lerId()||null,wavoip_device_id:selDevice.value||null});
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
    var membro=comboMembroForm?comboMembroForm.lerId():'';
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
    $('nav-usuarios-btn').onclick=function(){mostrarTab('usuarios');carregarUsuarios();carregarWavoip();};
    $('usuario-form').addEventListener('submit',criarUsuario);
    if(getToken()){iniciarPainel();}else{show('login');}
  });
})();`;
