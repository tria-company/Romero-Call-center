(function(){
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
    if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){});}
  });
})();
