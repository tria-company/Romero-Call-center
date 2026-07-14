// Smoke de HARD-05/HARD-06: prova a camada de resiliencia (resiliencia.ts) —
// circuit breaker por recurso (abre apos N falhas, fast-fail, half-open
// recupera, isolamento llm/ghl), bulkhead (limita concorrencia por recurso),
// backoffComJitter (dessincroniza retries) e idempotencia de nivel-chamada
// (nao duplica efeito no retry). O caso MAIS CRITICO: bypass de CRISE
// executa mesmo com o breaker aberto (invariante inviolavel do projeto).
//
// resiliencia.ts le limiar/cooldown/limite via process.env em MODULE LOAD
// TIME (top-level const) — por isso configuramos os envs ANTES do import e
// usamos `await import(...)` dinamico (import estatico e hoisted e rodaria
// antes de qualquer linha deste arquivo, inclusive antes de setar os envs),
// mesmo padrao de scripts/smoke-fila-prioridade.mjs.

process.env.SDR_BREAKER_LIMIAR_FALHAS = '3';
process.env.SDR_BREAKER_COOLDOWN_MS = '120'; // curto o bastante pro smoke esperar, longo o bastante pra nao expirar durante o fast-fail check
process.env.SDR_BULKHEAD_LIMITE = '10'; // default alto — o teste de bulkhead usa uma instancia PROPRIA com limite proprio
process.env.SDR_IDEMPOTENCIA_JANELA_MS = '60000';

const {
  CircuitBreaker,
  Bulkhead,
  chamarComResiliencia,
  backoffComJitter,
  ErroBreakerAberto,
  ErroBulkheadSaturado,
  tentarMarcarDespacho,
} = await import('../src/mastra/resiliencia.ts');

const falhas = [];

function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// CASO 0: CircuitBreaker — classe pura, white-box (instancia PROPRIA, isolada
// dos singletons usados por chamarComResiliencia).
// ============================================================================
{
  const breaker = new CircuitBreaker({ limiarFalhas: 2, cooldownMs: 80 });

  checar('caso0: recurso novo comeca CLOSED', breaker.estado('r1') === 'closed');
  checar('caso0: CLOSED permite chamada', breaker.permite('r1') === true);

  breaker.falha('r1');
  checar('caso0: 1a falha (abaixo do limiar=2) mantem CLOSED', breaker.estado('r1') === 'closed');

  breaker.falha('r1');
  checar('caso0: 2a falha (atinge o limiar=2) ABRE o circuito', breaker.estado('r1') === 'open');
  checar('caso0: OPEN nao permite chamada (fast-fail)', breaker.permite('r1') === false);

  // Isolamento: 'r2' nunca foi tocado — precisa continuar CLOSED mesmo com r1 OPEN.
  checar('caso0: ISOLAMENTO — recurso r2 continua CLOSED com r1 OPEN', breaker.estado('r2') === 'closed');
  checar('caso0: ISOLAMENTO — r2 permite chamada normalmente', breaker.permite('r2') === true);

  await sleep(100); // > cooldownMs (80ms)
  checar('caso0: apos cooldown, estado() reporta HALF-OPEN', breaker.estado('r1') === 'half-open');
  checar('caso0: apos cooldown, permite() volta a true (tentativa de teste)', breaker.permite('r1') === true);

  breaker.sucesso('r1');
  checar('caso0: sucesso em half-open -> CLOSED (reseta contador)', breaker.estado('r1') === 'closed');

  // Reabre e testa: falha em half-open -> volta pra OPEN (nao fecha por engano).
  breaker.falha('r1');
  breaker.falha('r1');
  checar('caso0b: 2 falhas de novo reabrem o circuito', breaker.estado('r1') === 'open');
  await sleep(100);
  checar('caso0b: cooldown expira de novo -> half-open', breaker.estado('r1') === 'half-open');
  breaker.falha('r1'); // falha NA tentativa de teste (half-open)
  checar('caso0b: falha em HALF-OPEN volta pra OPEN (nao fecha)', breaker.estado('r1') === 'open');
}

// ============================================================================
// CASO 1: Bulkhead — classe pura, limita concorrencia por recurso.
// ============================================================================
{
  const bulkhead = new Bulkhead({ limitePorRecurso: 2 });
  let emVooAgora = 0;
  let picoObservado = 0;

  const trabalhador = async () => {
    await bulkhead.adquirir('pool-teste');
    emVooAgora++;
    picoObservado = Math.max(picoObservado, emVooAgora);
    await sleep(40);
    emVooAgora--;
    bulkhead.liberar('pool-teste');
  };

  await Promise.all([trabalhador(), trabalhador(), trabalhador(), trabalhador(), trabalhador()]);

  checar('caso1: bulkhead — pico de concorrencia NUNCA excede o limite configurado (2)', picoObservado <= 2 && picoObservado > 0);
  checar('caso1: bulkhead — emUsoAtual volta a 0 apos todos os trabalhadores liberarem', bulkhead.emUsoAtual('pool-teste') === 0);

  // Isolamento de pool: outro recurso no MESMO bulkhead comeca com uso 0,
  // independente do pico observado acima em 'pool-teste'.
  checar('caso1b: bulkhead — recurso diferente comeca com emUsoAtual=0 (isolamento)', bulkhead.emUsoAtual('outro-pool') === 0);
}

// ============================================================================
// CASO 1c (WR-03, review Fase 5): corrida de overshoot fechada — liberar()
// com fila nao-vazia TRANSFERE a vaga (handoff) em vez de decrementar +
// acordar; sob pressao de adquirir() concorrente misturado com liberacoes,
// emUsoAtual NUNCA excede o limite. O teste antigo (caso 1) media o pico via
// contador externo — este mede o CONTADOR INTERNO do bulkhead a cada
// aquisicao, que era exatamente o que estourava na corrida.
// ============================================================================
{
  const bulkhead = new Bulkhead({ limitePorRecurso: 2, filaEsperaMax: 100 });
  let picoInterno = 0;
  const trabalhadores = [];
  for (let i = 0; i < 30; i++) {
    trabalhadores.push((async () => {
      await bulkhead.adquirir('pool-corrida');
      picoInterno = Math.max(picoInterno, bulkhead.emUsoAtual('pool-corrida'));
      // Mistura microtask/macrotask pra intercalar liberacoes e aquisicoes
      // pendentes (a janela da corrida original era exatamente essa).
      if (i % 2 === 0) await Promise.resolve();
      else await sleep(1);
      picoInterno = Math.max(picoInterno, bulkhead.emUsoAtual('pool-corrida'));
      bulkhead.liberar('pool-corrida');
    })());
  }
  await Promise.all(trabalhadores);
  checar(`caso1c (WR-03): contador interno do bulkhead nunca excede o limite (pico=${picoInterno}, limite=2)`, picoInterno <= 2 && picoInterno > 0);
  checar('caso1c (WR-03): emUsoAtual volta a 0 e fila de espera vazia no fim', bulkhead.emUsoAtual('pool-corrida') === 0 && bulkhead.tamanhoFilaEspera('pool-corrida') === 0);
}

// ============================================================================
// CASO 1d (WR-03): fila de espera BOUNDED — acima do cap, adquirir() rejeita
// com ErroBulkheadSaturado (rejeicao honesta -> caller degrada pro fallback)
// em vez de enfileirar pra sempre (memoria sem limite).
// ============================================================================
{
  const bulkhead = new Bulkhead({ limitePorRecurso: 1, filaEsperaMax: 2 });
  await bulkhead.adquirir('pool-saturado'); // ocupa a unica vaga
  const espera1 = bulkhead.adquirir('pool-saturado'); // fila: 1
  const espera2 = bulkhead.adquirir('pool-saturado'); // fila: 2 (cap)

  let erroSaturacao = null;
  try {
    await bulkhead.adquirir('pool-saturado'); // fila cheia -> rejeita
  } catch (e) {
    erroSaturacao = e;
  }
  checar('caso1d (WR-03): fila no cap rejeita com ErroBulkheadSaturado', erroSaturacao instanceof ErroBulkheadSaturado);
  checar("caso1d (WR-03): erro tipado tem codigo 'bulkhead_saturado'", erroSaturacao?.codigo === 'bulkhead_saturado');
  checar('caso1d (WR-03): fila de espera reporta 2 (cap)', bulkhead.tamanhoFilaEspera('pool-saturado') === 2);

  // Drena: liberar 3x resolve os 2 waiters (handoff) e zera o contador.
  bulkhead.liberar('pool-saturado');
  await espera1;
  bulkhead.liberar('pool-saturado');
  await espera2;
  bulkhead.liberar('pool-saturado');
  checar('caso1d (WR-03): apos drenar, emUsoAtual=0 e fila vazia', bulkhead.emUsoAtual('pool-saturado') === 0 && bulkhead.tamanhoFilaEspera('pool-saturado') === 0);
}

// ============================================================================
// CASO 2: backoffComJitter — delay sempre > 0, <= teto, e varia entre chamadas.
// ============================================================================
{
  const teto = 5_000;
  const amostras = Array.from({ length: 20 }, () => backoffComJitter(2, 1_000, teto));

  checar('caso2: backoffComJitter sempre > 0 em todas as amostras', amostras.every((v) => v > 0));
  checar('caso2: backoffComJitter sempre <= teto em todas as amostras', amostras.every((v) => v <= teto));

  const valoresUnicos = new Set(amostras);
  checar('caso2: backoffComJitter VARIA entre chamadas com a mesma tentativa (jitter real, nao backoff fixo)', valoresUnicos.size > 1);

  // tentativas maiores -> exponencial cresce (teto do proprio calculo tende a
  // subir) — sanity check de que nao e uma constante disfarçada.
  const amostrasTentativaAlta = Array.from({ length: 20 }, () => backoffComJitter(6, 1_000, teto));
  checar(
    'caso2b: com tentativa alta, o teto efetivo satura em tetoMs (amostras podem chegar perto do teto)',
    Math.max(...amostrasTentativaAlta) <= teto && Math.max(...amostrasTentativaAlta) > Math.max(...amostras) * 0.3,
  );
}

// ============================================================================
// CASO 3: chamarComResiliencia — breaker('llm') abre apos N falhas e
// FAST-FAILS (sem executar fn); breaker('ghl') permanece CLOSED (isolamento).
// ============================================================================
{
  let chamadasLlmExecutadas = 0;
  const fnLlmFalha = async () => {
    chamadasLlmExecutadas++;
    throw new Error('falha simulada do LLM (Azure indisponivel)');
  };

  // 3 falhas consecutivas (SDR_BREAKER_LIMIAR_FALHAS=3) -> abre 'llm'.
  for (let i = 0; i < 3; i++) {
    try {
      await chamarComResiliencia(fnLlmFalha, { recurso: 'llm', tentativas: 1 });
    } catch {
      // esperado — cada tentativa falha de verdade ate atingir o limiar
    }
  }
  checar('caso3: apos 3 falhas consecutivas, fn foi executada exatamente 3x', chamadasLlmExecutadas === 3);

  // 4a chamada: breaker DEVE estar OPEN -> fast-fail SEM executar fn.
  let erroCapturado = null;
  try {
    await chamarComResiliencia(fnLlmFalha, { recurso: 'llm', tentativas: 1 });
  } catch (e) {
    erroCapturado = e;
  }
  checar('caso3: 4a chamada rejeita com ErroBreakerAberto (fast-fail)', erroCapturado instanceof ErroBreakerAberto);
  checar('caso3: 4a chamada NAO executa fn (contador nao incrementou)', chamadasLlmExecutadas === 3);
  checar("caso3: erro tipado tem codigo 'breaker_open' (gatilho documentado do fallback 05-04)", erroCapturado?.codigo === 'breaker_open');

  // ISOLAMENTO: breaker('ghl') nunca foi tocado — deve continuar CLOSED e
  // executar fn normalmente, mesmo com 'llm' aberto.
  let chamadasGhlExecutadas = 0;
  const fnGhlSucesso = async () => {
    chamadasGhlExecutadas++;
    return 'ghl-ok';
  };
  const resultadoGhl = await chamarComResiliencia(fnGhlSucesso, { recurso: 'ghl', tentativas: 1 });
  checar('caso3: ISOLAMENTO — breaker("ghl") CLOSED executa fn normalmente com "llm" aberto', resultadoGhl === 'ghl-ok');
  checar('caso3: ISOLAMENTO — fn do ghl foi de fato executada', chamadasGhlExecutadas === 1);
}

// ============================================================================
// CASO 4: CRISE bypassa o breaker aberto — o caso MAIS CRITICO do plano.
// ============================================================================
{
  // Abre o breaker('ghl') de proposito (3 falhas consecutivas, crise:false).
  let falhasGhl = 0;
  const fnGhlFalha = async () => {
    falhasGhl++;
    throw new Error('falha simulada do GHL (fora do ar)');
  };
  for (let i = 0; i < 3; i++) {
    try {
      await chamarComResiliencia(fnGhlFalha, { recurso: 'ghl', tentativas: 1 });
    } catch {
      // esperado
    }
  }
  checar('caso4: setup — breaker("ghl") agora esta ABERTO (3 falhas)', falhasGhl === 3);

  // Confirma que SEM crise, a proxima chamada de fato fast-fail (breaker
  // realmente abriu, nao e um falso-positivo do teste).
  let confirmaAberto = null;
  try {
    await chamarComResiliencia(fnGhlFalha, { recurso: 'ghl', tentativas: 1 });
  } catch (e) {
    confirmaAberto = e;
  }
  checar('caso4: confirmacao — sem crise, breaker("ghl") aberto rejeita com ErroBreakerAberto', confirmaAberto instanceof ErroBreakerAberto);

  // O TESTE CRITICO: com crise:true, a MESMA chamada para 'ghl' (ainda
  // ABERTO) precisa EXECUTAR fn — nunca 'breaker_open'. Este e o caminho de
  // escalate-to-human.ts (sofrimento agudo, protocolo CVV 188).
  let fnCriseExecutada = false;
  const fnCrise = async () => {
    fnCriseExecutada = true;
    return 'escalacao-enviada';
  };
  const resultadoCrise = await chamarComResiliencia(fnCrise, { recurso: 'ghl', crise: true });
  checar('caso4: INVARIANTE — crise:true EXECUTA fn mesmo com breaker("ghl") aberto', fnCriseExecutada === true);
  checar('caso4: INVARIANTE — crise:true devolve o resultado real de fn (nao breaker_open)', resultadoCrise === 'escalacao-enviada');
}

// ============================================================================
// CASO 5: half-open recupera — apos o cooldown, uma chamada de teste bem
// sucedida fecha o circuito de novo.
// ============================================================================
{
  let falhasIniciais = 0;
  const fnFalhaTemporaria = async () => {
    falhasIniciais++;
    throw new Error('falha temporaria (simula pico transitorio)');
  };

  for (let i = 0; i < 3; i++) {
    try {
      await chamarComResiliencia(fnFalhaTemporaria, { recurso: 'llm-recuperavel', tentativas: 1 });
    } catch {
      // esperado
    }
  }
  checar('caso5: setup — breaker("llm-recuperavel") aberto apos 3 falhas', falhasIniciais === 3);

  let rejeitadoAntesDoCooldown = null;
  try {
    await chamarComResiliencia(fnFalhaTemporaria, { recurso: 'llm-recuperavel', tentativas: 1 });
  } catch (e) {
    rejeitadoAntesDoCooldown = e;
  }
  checar('caso5: antes do cooldown expirar, ainda fast-fail', rejeitadoAntesDoCooldown instanceof ErroBreakerAberto);

  await sleep(160); // > SDR_BREAKER_COOLDOWN_MS (120ms)

  let chamadaRecuperacaoExecutou = false;
  const fnSucessoRecuperacao = async () => {
    chamadaRecuperacaoExecutou = true;
    return 'recuperado';
  };
  const resultadoRecuperacao = await chamarComResiliencia(fnSucessoRecuperacao, { recurso: 'llm-recuperavel', tentativas: 1 });
  checar('caso5: apos cooldown, chamada de teste (half-open) EXECUTA fn', chamadaRecuperacaoExecutou === true);
  checar('caso5: apos cooldown, chamada de teste retorna o resultado real', resultadoRecuperacao === 'recuperado');

  // Confirma que o circuito FECHOU de verdade: uma unica falha isolada agora
  // NAO deveria reabrir o circuito (limiar=3, precisa de 3 falhas CONSECUTIVAS
  // a partir do estado fechado) — a proxima chamada de sucesso deve executar
  // normalmente sem fast-fail.
  let executouAposRecuperacao = false;
  await chamarComResiliencia(
    async () => {
      executouAposRecuperacao = true;
      return 'ok';
    },
    { recurso: 'llm-recuperavel', tentativas: 1 },
  );
  checar('caso5: circuito fechado de verdade — proxima chamada executa sem fast-fail', executouAposRecuperacao === true);
}

// ============================================================================
// CASO 6: idempotencia — chamada concorrente com a MESMA idempotencyKey nao
// duplica o efeito (reusa a mesma promise em vez de re-executar fn).
// ============================================================================
{
  let execucoes = 0;
  const fnComEfeito = async () => {
    execucoes++;
    await sleep(20);
    return `efeito-${execucoes}`;
  };

  const chave = 'lead-5511999:turno-42';
  const [r1, r2] = await Promise.all([
    chamarComResiliencia(fnComEfeito, { recurso: 'llm-idemp', idempotencyKey: chave }),
    chamarComResiliencia(fnComEfeito, { recurso: 'llm-idemp', idempotencyKey: chave }),
  ]);
  checar('caso6: idempotencia — fn executada UMA UNICA VEZ para 2 chamadas concorrentes com a mesma chave', execucoes === 1);
  checar('caso6: idempotencia — as 2 chamadas concorrentes devolvem o MESMO resultado', r1 === r2 && r1 === 'efeito-1');

  // Chamada subsequente (nao concorrente, mas dentro da janela) com a MESMA
  // chave tambem reusa o resultado, sem re-executar.
  const r3 = await chamarComResiliencia(fnComEfeito, { recurso: 'llm-idemp', idempotencyKey: chave });
  checar('caso6b: idempotencia — chamada subsequente na MESMA janela reusa o resultado (nao re-executa)', execucoes === 1 && r3 === 'efeito-1');

  // Chave DIFERENTE -> executa normalmente (idempotencia nao trava chamadas
  // legitimamente distintas).
  const r4 = await chamarComResiliencia(fnComEfeito, { recurso: 'llm-idemp', idempotencyKey: 'lead-5511999:turno-43' });
  checar('caso6c: idempotencia — chave DIFERENTE executa fn de novo (nao e um lock global)', execucoes === 2 && r4 === 'efeito-2');

  // Falha com idempotencyKey -> NAO trava a janela pra sempre; uma proxima
  // chamada com a MESMA chave apos a falha deve poder tentar de novo
  // (retry honesto, sem cache de erro fake).
  let tentativasComFalha = 0;
  const fnFalhaDepoisSucesso = async () => {
    tentativasComFalha++;
    if (tentativasComFalha === 1) throw new Error('falha na 1a tentativa (simulada)');
    return 'sucesso-na-2a-chamada-externa';
  };
  const chaveComFalha = 'lead-5511888:turno-7';
  let primeiraFalhou = false;
  try {
    await chamarComResiliencia(fnFalhaDepoisSucesso, { recurso: 'llm-idemp-falha', idempotencyKey: chaveComFalha, tentativas: 1 });
  } catch {
    primeiraFalhou = true;
  }
  checar('caso6d: idempotencia — 1a chamada com a chave falha (repassa o erro)', primeiraFalhou === true);

  const resultadoRetry = await chamarComResiliencia(fnFalhaDepoisSucesso, {
    recurso: 'llm-idemp-falha',
    idempotencyKey: chaveComFalha,
    tentativas: 1,
  });
  checar(
    'caso6d: idempotencia — apos falha, uma NOVA chamada externa com a MESMA chave PODE re-tentar (nao trava o erro na janela)',
    resultadoRetry === 'sucesso-na-2a-chamada-externa' && tentativasComFalha === 2,
  );
}

// ============================================================================
// CASO 7: retry interno (tentativas>1) usa backoffComJitter entre tentativas
// (nao e imediato/sincrono) e conta as tentativas corretamente.
// ============================================================================
{
  let tentativasFeitas = 0;
  const inicio = Date.now();
  const fnFalhaDuasVezes = async () => {
    tentativasFeitas++;
    if (tentativasFeitas < 3) throw new Error(`falha na tentativa ${tentativasFeitas}`);
    return 'sucesso-na-3a-tentativa';
  };

  const resultado = await chamarComResiliencia(fnFalhaDuasVezes, { recurso: 'llm-retry-interno', tentativas: 3 });
  const duracao = Date.now() - inicio;

  checar('caso7: retry interno tenta ate conseguir (3 tentativas)', tentativasFeitas === 3);
  checar('caso7: retry interno devolve o resultado da tentativa bem-sucedida', resultado === 'sucesso-na-3a-tentativa');
  // 2 esperas de backoffComJitter(1) e backoffComJitter(2) com base 1000ms
  // (default) somam pelo menos alguns ms (piso minimo de 1ms cada) — o que
  // importa aqui e que NAO foi instantaneo (retry linear ingenuo tambem
  // levaria tempo > 0, mas confirma que o loop de espera de fato rodou).
  checar('caso7: retry interno NAO e instantaneo (esperou entre tentativas)', duracao > 0);
}

// ============================================================================
// CASO 8 (WR-08, review Fase 5): idempotencia de DESPACHO — a idempotencia
// de chamada (caso 6) garante 1 chamada LLM, mas os EFEITOS (mensagens/
// tools) vivem no dispatcher: tentarMarcarDespacho garante que so o PRIMEIRO
// caller com a chave (lead+turno) despacha; o concorrente pula.
// ============================================================================
{
  const chaveTurno = 'lead-5511777:turno-99';
  checar('caso8 (WR-08): 1o caller com a chave PODE despachar (true)', tentarMarcarDespacho(chaveTurno) === true);
  checar('caso8 (WR-08): 2o caller com a MESMA chave NAO despacha (false — dedup de efeito)', tentarMarcarDespacho(chaveTurno) === false);
  checar('caso8 (WR-08): chave DIFERENTE despacha normalmente (nao e lock global)', tentarMarcarDespacho('lead-5511777:turno-100') === true);
  checar('caso8 (WR-08): chave vazia nunca bloqueia (fail-open)', tentarMarcarDespacho('') === true && tentarMarcarDespacho('') === true);
}

if (falhas.length > 0) {
  console.error('[smoke-resiliencia] HARD-05/HARD-06 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-resiliencia] HARD-05/HARD-06 OK');
// resiliencia.ts registra um setInterval de limpeza de idempotencia
// (unref'd), mas o smoke sai explicitamente por consistencia com os demais
// smokes com timers (fila-prioridade.mjs, cache-semantico.mjs).
process.exit(0);
