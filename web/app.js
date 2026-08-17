(function(){
  var tokenKey='discador_token';
  var wavoip=null, currentCall=null, wavoipToken=null, wantHangup=false;
  var fila=null, filaPollInt=null;
  var timerInt=null, timerStart=0, conectandoTO=null;
  var wakeLock=null, emChamada=false, retornoPainel=null;
  var foiAtendida=false, desfechoEnviado=false, chamadaTaskId=null, votoAtualTaskId=null, votoSel={romero:null,andressa:null};
  // u13: tentativa não-atendida — discagemStart marca quando começou a chamar
  // (pra medir "quanto tempo tentou"); tentativaDiscada = a chamada chegou a
  // discar (senão erro puro não abre a telinha de motivo); encerrandoUI guarda
  // o roteamento pós-chamada pra rodar UMA vez. motivo* = seleção da telinha.
  var discagemStart=0, tentativaDiscada=false, encerrandoUI=false;
  var motivoTaskId=null, motivoCat=null, motivoTentSeg=0;
  // Tom de chamada (WebAudio) — o Wavoip não entrega ringback ao navegador.
  var ringCtx=null, ringOsc=null, ringGain=null, ringTO=null;
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
  // Heartbeat de presença (Operação ao vivo): enquanto logado, avisa o backend a
  // cada 60s que este operador está com o discador aberto — inclusive DURANTE a
  // chamada (o pollFila pausa; este não). Assim o painel do gestor vê quem está
  // online. Best-effort: fetch cru, ignora erro/401 (NÃO usa apiPost pra não
  // deslogar por um ping que falhou).
  var hbInt=null;
  function baterPresenca(){var t=getToken();if(!t){return;}fetch('/api/discador/presenca',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+t},body:'{}'}).catch(function(){});}
  function iniciarHeartbeat(){baterPresenca();if(hbInt){clearInterval(hbInt);}hbInt=setInterval(baterPresenca,60000);}
  function pararHeartbeat(){if(hbInt){clearInterval(hbInt);hbInt=null;}}
  // Logout explícito: some do painel na hora (não espera o TTL de 120s). keepalive
  // pra o request completar mesmo com a UI trocando pra tela de login.
  function sairPresenca(){var t=getToken();if(!t){return;}fetch('/api/discador/sair',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+t},body:'{}',keepalive:true}).catch(function(){});}
  function doLogin(){
    var u=$('u').value.trim(), p=$('p').value;$('login-err').textContent='';
    fetch('/api/discador/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuario:u,senha:p})})
    .then(function(res){return res.json().then(function(j){return {ok:res.ok,j:j};});})
    .then(function(r){if(!r.ok||!r.j.token){$('login-err').textContent='Usuário ou senha inválidos.';return;}setToken(r.j.token);$('p').value='';if(irParaPainel(r.j.token,r.j.panelUrl)){return;}startFila();})
    .catch(function(){$('login-err').textContent='Erro ao entrar.';});
  }
  function startFila(){show('fila');carregarFila();iniciarHeartbeat();}
  // Porta unica (u5/u8): o discador e a porta de todos. TODO usuario logado e
  // mandado pro painel, ja logado (token no FRAGMENTO — nao vai ao servidor
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
      mostrarStatus('Você está em dia! Sem ligações na fila agora.');
      return;
    }
    $('fila-status').style.display='none';
    $('fila-contador').textContent='Próxima ligação';
    var lista=$('fila-lista');
    lista.textContent='';
    lista.style.display='block';
    // u22: dica pro atendente leigo saber o que fazer na fila.
    var hint=document.createElement('div');hint.className='fila-hint';hint.textContent='Toque em Ligar para começar o atendimento.';
    lista.appendChild(hint);
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
  function voltarParaFila(){$('call-overlay').style.display='none';$('voto-overlay').style.display='none';$('motivo-overlay').style.display='none';if(retornoPainel){window.location.href=retornoPainel;return;}carregarFilaSilencioso();}
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
    openCall(lead,'preparando');
    prepararAudio();// desbloqueia o áudio DENTRO do gesto do toque (iOS)
    tocarChamando();// tom já começa aqui (no gesto) — mais confiável p/ autoplay
    // iOS: o prompt de microfone SO aparece se getUserMedia rodar DENTRO do
    // gesto do toque, antes de qualquer await. Pedimos aqui pra conceder a
    // permissao; o SDK depois adquire o proprio stream (sem novo prompt).
    var mic;
    try { mic = navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { mic = Promise.reject(e); }
    mic.then(function(stream){
      try { stream.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
      setCallEstado('chamando');
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
      if(r && r.err){ setCallEstado('erro'); endCallUI(); return; }
      currentCall=(r&&r.call)?r.call:r;
      if(wantHangup){ hangup(); return; }
      setCallEstado('chamando');
      tentativaDiscada=true;discagemStart=Date.now();// u13: começou a tentativa
      iniciarTimeoutConectando();// #1: teto de 90s sem atender
      tocarChamando();// reforça o tom (já iniciado no gesto) agora que discou
      wireCallEvents(currentCall);
    }).catch(function(e){
      if(e&&e.semDeviceLivre){setCallEstado('erro','Sem número livre agora. Tente de novo em instantes.');endCallUI();return;}
      var neg=(e&&(e.name==='NotAllowedError'||e.name==='SecurityError'));
      if(neg){setCallEstado('microfone');}else{setCallEstado('erro');}
      endCallUI();
    });
  }
  function on(call,ev,fn){try{if(call&&call.on){call.on(ev,fn);}}catch(e){}}
  // u22: mapeia o status técnico do SDK pro ESTADO visual do atendente (palavra
  // grande + cor + frase-guia). CALLING/RINGING viram "chamando" (o leigo não
  // precisa distinguir); ACTIVE/ACCEPT = "atendida" (verde, fale agora).
  function mapEstado(s){var m={CALLING:'chamando',RINGING:'chamando',ACTIVE:'atendida',ACCEPT:'atendida',ENDED:'encerrada',NOT_ANSWERED:'naoAtendida',UNANSWERED:'naoAtendida',REJECTED:'recusada'};return m[String(s).toUpperCase()]||'';}
  function wireCallEvents(call){
    // Eventos reais do @wavoip/wavoip-api (CallOutgoingEvents).
    on(call,'status',function(s){var k=mapEstado(s);if(k){setCallEstado(k);}});
    on(call,'peerAccept',function(active){limparTimeoutConectando();if(active&&typeof active.end==='function'){currentCall=active;}foiAtendida=true;enviarDesfecho('atendida');pararChamando();setCallEstado('atendida');startTimer();});
    on(call,'peerReject',function(){enviarDesfecho('recusou');setCallEstado('recusada');endCallUI();});
    // u13: não-atendida NÃO desfecha automático — endCallUI abre a telinha de
    // motivo (o operador escolhe a categoria e aí conclui/sai da fila).
    on(call,'unanswered',function(){setCallEstado('naoAtendida');endCallUI();});
    on(call,'ended',function(){setCallEstado('encerrada');endCallUI();});
    on(call,'connectivityIssue',function(){setCallEstado('problema');});
  }
  function hangup(){
    wantHangup=true; // se pressionado antes do startCall resolver, encerra ao resolver
    var c=currentCall;
    if(c&&typeof c.end==='function'){try{c.end();}catch(e){}}
    // u13: NÃO desfecha aqui. Se atendeu, endCallUI vai pro voto; se só tentou,
    // vai pra telinha de motivo. Se nem discou (erro), volta pra fila.
    setCallEstado('encerrada');endCallUI();
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
  function openCall(lead,status){wantHangup=false;emChamada=true;foiAtendida=false;desfechoEnviado=false;tentativaDiscada=false;discagemStart=0;encerrandoUI=false;chamadaTaskId=(lead&&lead.taskId)||null;pedirWakeLock();var av=$('call-avatar');if(av){av.textContent=initials(lead.nome||lead.telefone);}$('call-nome').textContent=lead.nome||lead.telefone;$('call-tel').textContent=lead.telefone;setCallEstado(status);$('call-timer').textContent='';var sc=$('call-script');if(sc){sc.textContent='Carregando script...';}$('call-overlay').style.display='flex';if(chamadaTaskId){carregarScriptDaChamada(chamadaTaskId);}}
  // u22: estados visuais da chamada, em linguagem de atendente (não de tech):
  // PALAVRA grande + COR (verde=atendeu, azul=chamando, vermelho=não atendeu,
  // âmbar=aviso) + FRASE do que fazer. Centraliza a tradução do jargão do SDK.
  var CALL_ESTADOS={
    preparando:{txt:'Preparando…',cor:'azul',guia:'Se o celular pedir, toque em Permitir o microfone'},
    chamando:{txt:'Chamando…',cor:'azul',guia:'Aguarde — o cliente vai atender'},
    atendida:{txt:'No telefone',cor:'verde',guia:'Fale agora! Siga o roteiro abaixo'},
    naoAtendida:{txt:'Não atendeu',cor:'vermelho',guia:'Sem resposta. Vamos registrar o motivo.'},
    recusada:{txt:'Não atendeu',cor:'vermelho',guia:'Sem resposta. Vamos registrar o motivo.'},
    encerrada:{txt:'Ligação encerrada',cor:'cinza',guia:''},
    problema:{txt:'Conexão instável',cor:'ambar',guia:'A ligação pode cair'},
    microfone:{txt:'Libere o microfone',cor:'ambar',guia:'Toque em Permitir e tente de novo'},
    erro:{txt:'Não deu certo',cor:'ambar',guia:'Toque em Desligar e tente de novo'}
  };
  // 2º arg (detalhe) troca a frase-guia quando precisa (ex.: erro específico).
  function setCallEstado(key,detalhe){
    var e=CALL_ESTADOS[key],box=$('call-estado'),st=$('call-status'),gu=$('call-guia');
    if(!e){if(st){st.textContent=String(key||'');}if(gu){gu.textContent=detalhe||'';}return;}
    if(st){st.textContent=e.txt;}
    if(gu){gu.textContent=(detalhe!=null&&detalhe!=='')?detalhe:e.guia;}
    if(box){box.className='est-'+e.cor;}
  }
  // #1: se ficar 90s sem ser atendida, a chamada encerra sozinha e cai na telinha
  // de motivo (o operador é obrigado a escolher o motivo pra seguir pro próximo).
  function iniciarTimeoutConectando(){limparTimeoutConectando();conectandoTO=setTimeout(function(){if(!foiAtendida){setCallEstado('naoAtendida');hangup();}},90000);}
  function limparTimeoutConectando(){if(conectandoTO){clearTimeout(conectandoTO);conectandoTO=null;}}
  function startTimer(){timerStart=Date.now();if(timerInt){clearInterval(timerInt);}timerInt=setInterval(function(){var s=Math.floor((Date.now()-timerStart)/1000);var mm=Math.floor(s/60),ss=s%60;$('call-timer').textContent=(mm<10?'0':'')+mm+':'+(ss<10?'0':'')+ss;},500);}
  // Tom de chamada ("chamando..."): o Wavoip não entrega ringback ao navegador,
  // então geramos o tom aqui (WebAudio, ~425Hz, cadência 1s liga/4s desliga —
  // padrão BR). prepararAudio roda DENTRO do gesto do toque pra desbloquear o
  // áudio (iOS); toca em "Chamando/Tocando" e para ao atender/recusar/desligar.
  function prepararAudio(){try{var AC=window.AudioContext||window.webkitAudioContext;if(!AC){return;}if(!ringCtx){ringCtx=new AC();}if(ringCtx.state==='suspended'){ringCtx.resume();}}catch(e){}}
  function tocarChamando(){if(ringOsc){return;}if(!ringCtx){return;}try{if(ringCtx.state!=='running'){ringCtx.resume();}}catch(e){}try{ringOsc=ringCtx.createOscillator();ringGain=ringCtx.createGain();ringOsc.type='sine';ringOsc.frequency.value=425;ringGain.gain.value=0.0001;ringOsc.connect(ringGain);ringGain.connect(ringCtx.destination);ringOsc.start();var ligado=false;function ciclo(){if(!ringCtx||!ringGain){return;}ligado=!ligado;var t=ringCtx.currentTime;try{ringGain.gain.setValueAtTime(ligado?0.14:0.0001,t);}catch(e){}ringTO=setTimeout(ciclo,ligado?1000:4000);}ciclo();}catch(e){}}
  function pararChamando(){if(ringTO){clearTimeout(ringTO);ringTO=null;}try{if(ringOsc){ringOsc.stop();ringOsc.disconnect();}}catch(e){}try{if(ringGain){ringGain.disconnect();}}catch(e){}ringOsc=null;ringGain=null;}
  function endCallUI(){pararChamando();limparTimeoutConectando();liberarDeviceDaChamada();emChamada=false;soltarWakeLock();if(timerInt){clearInterval(timerInt);timerInt=null;}currentCall=null;if(encerrandoUI){return;}encerrandoUI=true;var atendida=foiAtendida,tid=chamadaTaskId,discou=tentativaDiscada;var tentSeg=(discou&&discagemStart)?Math.round((Date.now()-discagemStart)/1000):0;setTimeout(function(){if(atendida&&tid){mostrarVoto(tid);}else if(desfechoEnviado){voltarParaFila();}else if(tid&&(discou||wantHangup)){mostrarMotivo(tid,tentSeg);}else{voltarParaFila();}},1400);}
  // u13: telinha de motivo do não-atendimento. Mostra quanto tempo tentou e
  // pede a categoria (+ frase opcional). Só ao concluir dispara o desfecho —
  // que grava o motivo, o tempo de tentativa, comenta e fecha (sai da fila).
  function fmtTentativa(seg){var m=Math.floor(seg/60),s=seg%60;return m+'min '+(s<10?'0':'')+s+'s';}
  function mostrarMotivo(taskId,tentSeg){
    motivoTaskId=taskId;motivoCat=null;motivoTentSeg=tentSeg||0;
    $('motivo-nome').textContent=$('call-nome').textContent||'';
    $('motivo-tentativa').textContent='Tentou por '+fmtTentativa(motivoTentSeg);
    var obs=$('motivo-obs');if(obs){obs.value='';}
    $('motivo-err').textContent='';
    var btns=document.querySelectorAll('#motivo-cats .seg-btn');
    for(var i=0;i<btns.length;i++){btns[i].classList.remove('sel');}
    $('call-overlay').style.display='none';
    $('motivo-overlay').style.display='flex';
  }
  function enviarMotivo(){
    if(!motivoCat){$('motivo-err').textContent='Escolha um motivo.';return;}
    var btn=$('motivo-salvar');btn.disabled=true;btn.textContent='Concluindo...';
    var obsEl=$('motivo-obs');var body={taskId:motivoTaskId,resultado:'nao_atendida',categoria:motivoCat,observacao:obsEl?obsEl.value.trim():'',duracao:motivoTentSeg};
    apiPost('/api/discador/desfecho',body).then(function(res){return res.json().catch(function(){return {};}).then(function(d){return {status:res.status,d:d};});}).then(function(r){
      btn.disabled=false;btn.textContent='Concluir ligação';
      if(r.status!==200){$('motivo-err').textContent='Não deu para concluir. Tente de novo.';return;}
      $('motivo-overlay').style.display='none';voltarParaFila();
    }).catch(function(e){btn.disabled=false;btn.textContent='Concluir ligação';if(e&&e.message==='401'){return;}$('motivo-err').textContent='Não deu para concluir. Tente de novo.';});
  }
  // Pos-ligacao (SO quando ATENDIDA): pergunta a confirmacao de voto dos
  // candidatos ainda nao preenchidos no lead (Lista 01) e grava. Se o lead ja
  // tem os dois definidos, ou nao ha lead resolvido, so fecha a overlay da
  // chamada. Best-effort: qualquer erro so fecha a overlay (nunca trava o operador).
  // #4: em TODA ligação atendida, pergunta o voto dos DOIS candidatos (mesmo que
  // o lead já tenha algum definido) — o operador re-confirma e a IA avalia depois.
  function mostrarVoto(taskId){
    api('/api/discador/voto/'+encodeURIComponent(taskId)).then(function(res){return res.json().catch(function(){return {};});}).then(function(st){
      if(!(st&&st.temLead)){voltarParaFila();return;}
      abrirVoto(taskId,true,true);
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
    $('logout-btn').onclick=function(){if(emChamada&&!confirm('Há uma ligação em andamento. Sair mesmo assim?')){return;}sairPresenca();pararHeartbeat();setToken('');show('login');};
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
    // u13: seleção de motivo (chips) + concluir a não-atendida.
    var mc=$('motivo-cats');
    if(mc){mc.addEventListener('click',function(e){var b=e.target&&e.target.closest?e.target.closest('.seg-btn'):null;if(!b){return;}var all=mc.querySelectorAll('.seg-btn');for(var i=0;i<all.length;i++){all[i].classList.remove('sel');}b.classList.add('sel');motivoCat=b.getAttribute('data-cat');$('motivo-err').textContent='';});}
    var ms=$('motivo-salvar');if(ms){ms.onclick=enviarMotivo;}
    // Chamadas longas: evitar perder a ligacao por refresh/fechar/logout sem querer
    // e re-adquirir o Wake Lock quando a aba volta a ficar visivel.
    window.addEventListener('beforeunload',function(e){if(emChamada){e.preventDefault();e.returnValue='';return '';}});
    document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'&&emChamada&&!wakeLock){pedirWakeLock();}});
    window.addEventListener('offline',function(){if(emChamada){setCallEstado('problema','Sem internet — a ligação pode cair');}});
    window.addEventListener('online',function(){if(emChamada){setCallEstado(foiAtendida?'atendida':'chamando');}});
    // Handoff (quick-260815-r3): consome #token (auto-login) e &task (deep-link)
    // e LIMPA o fragmento do historico (o token nao pode vazar em back/forward).
    var hp=lerParamsDoHash();
    if(hp.token){setToken(hp.token);}
    try{history.replaceState(null,'',location.pathname+location.search);}catch(e){}
    // Porta unica (u5/u8): com &task e o usuario indo LIGAR (handoff de chamada)
    // — NUNCA redireciona, abre a Ligacao aqui. Sem &task, manda TODO MUNDO pro
    // painel; o painel roteia por papel (gestor -> painel, atendente -> /fila).
    if(getToken()){if(hp.task){api('/api/discador/me').then(function(res){return res.json();}).then(function(me){if(me&&me.panelUrl){retornoPainel=me.panelUrl.replace(/[/]+$/,'')+'/fila';}}).catch(function(){});startFila();abrirLigacaoPorTask(hp.task);}else{api('/api/discador/me').then(function(res){return res.json();}).then(function(me){if(me&&irParaPainel(getToken(),me.panelUrl)){return;}startFila();}).catch(function(){startFila();});}}else{show('login');}
    if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){});}
  });
})();
