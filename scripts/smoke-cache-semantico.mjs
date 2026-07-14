// Smoke de HARD-04: prova o cache semantico in-memory particionado por lead
// (cache-semantico.ts) — hit por similaridade dentro do MESMO lead,
// ISOLAMENTO cross-lead (miss mesmo com texto/embedding identico), fail-open
// quando o embedder lanca, expiracao por TTL, cap/LRU por lead e miss
// abaixo do limiar de similaridade.
//
// Modulo puro sem imports de azure/config no topo (embedder e injetado) —
// aqui usamos um embedder FAKE deterministico (hash de tokens em vetor de
// contagem), sem nenhuma credencial/rede, mesmo padrao de
// scripts/smoke-camila-schema.mjs (import direto via
// node --experimental-strip-types).

import { CacheSemantico, cosseno, saidaCacheavel } from '../src/mastra/cache-semantico.ts';

const falhas = [];

function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// ---- Embedder FAKE deterministico: hash de tokens -> vetor de contagem ----
// Dimensao alta (512) pra minimizar colisao de hash entre tokens distintos
// nos textos de teste abaixo (confirmado numericamente: textos com tokens
// disjuntos produzem cosseno exatamente 0).
const DIM_FAKE = 512;

function tokenizar(texto) {
  const normalizado = String(texto).toLowerCase().normalize('NFKC');
  return normalizado.match(/[a-z0-9à-ÿ]+/gi) || [];
}

function hashToken(tok) {
  let h = 0;
  for (let i = 0; i < tok.length; i++) {
    h = (h * 31 + tok.charCodeAt(i)) >>> 0;
  }
  return h % DIM_FAKE;
}

function criarEmbedderFake() {
  return async (texto) => {
    const vetor = new Array(DIM_FAKE).fill(0);
    for (const tok of tokenizar(texto)) {
      vetor[hashToken(tok)] += 1;
    }
    return vetor;
  };
}

// Limiar usado nos testes (abaixo do default 0.92 de producao, calibrado pra
// bater com a similaridade real produzida pelo embedder FAKE hash-based —
// ver calculo em <read_first>/comentario da 05-02-PLAN.md; o modulo aceita
// limiar por config, entao o valor de producao continua o default do env
// SDR_CACHE_LIMIAR/0.92, so este smoke usa um limiar proprio pra caber no
// "embedding" grosseiro do fake).
const LIMIAR_TESTE = 0.8;

// ---- caso 0: cosseno() pura ----
{
  checar('caso0: cosseno(a,a) = 1 (vetor identico)', Math.abs(cosseno([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  checar('caso0: cosseno(a,b ortogonais) = 0', cosseno([1, 0], [0, 1]) === 0);
  checar('caso0: cosseno com vetores de tamanhos diferentes = 0 (nao lanca)', cosseno([1, 2], [1, 2, 3]) === 0);
  checar('caso0: cosseno com vetor vazio = 0 (nao lanca)', cosseno([], []) === 0);
  checar('caso0: cosseno com norma zero = 0 (nao lanca)', cosseno([0, 0], [1, 1]) === 0);
}

// ---- caso 1: HIT dentro do MESMO lead por similaridade (pergunta reformulada) ----
{
  const cache = new CacheSemantico({ embedder: criarEmbedderFake(), limiar: LIMIAR_TESTE, ttlMs: 60_000, maxPorLead: 10 });
  await cache.guardar('5511AAA', 'como funciona o metodo ADS?', 'RESPOSTA_METODO_ADS');
  const hit = await cache.buscar('5511AAA', 'como e que funciona o metodo ADS');
  checar('caso1: HIT — pergunta reformulada do mesmo lead reusa a resposta cacheada', hit === 'RESPOSTA_METODO_ADS');
}

// ---- caso 2: MISS quando a similaridade fica abaixo do limiar (pergunta DIFERENTE) ----
{
  const cache = new CacheSemantico({ embedder: criarEmbedderFake(), limiar: LIMIAR_TESTE, ttlMs: 60_000, maxPorLead: 10 });
  await cache.guardar('5511AAA', 'como funciona o metodo ADS?', 'RESPOSTA_METODO_ADS');
  const miss = await cache.buscar('5511AAA', 'quais sao os planos disponiveis?');
  checar('caso2: MISS — pergunta de assunto diferente nao reusa resposta de outro assunto', miss === null);
}

// ---- caso 3: ISOLAMENTO POR LEAD (T-05-02-01) — o mais critico ----
{
  const cache = new CacheSemantico({ embedder: criarEmbedderFake(), limiar: LIMIAR_TESTE, ttlMs: 60_000, maxPorLead: 10 });
  await cache.guardar('5511AAA', 'planos?', 'RESPOSTA_PLANOS_LEAD_A');

  // Texto IDENTICO -> embedding IDENTICO (cosseno=1) — MESMO ASSIM tem que
  // dar MISS, porque o lead e diferente. Isolamento nunca pode ser
  // contornado so por a pergunta ser igual.
  const missCrossLead = await cache.buscar('5511BBB', 'planos?');
  checar(
    'caso3: ISOLAMENTO — buscar(leadB) NUNCA devolve resposta guardada por guardar(leadA), mesmo com embedding identico',
    missCrossLead === null,
  );

  // Confirma que o lead A CONTINUA funcionando normalmente no proprio bucket
  // (a checagem de isolamento nao quebrou o cache do lead legitimo).
  const hitMesmoLead = await cache.buscar('5511AAA', 'planos?');
  checar('caso3b: leadA continua com HIT no proprio bucket apos a tentativa cross-lead', hitMesmoLead === 'RESPOSTA_PLANOS_LEAD_A');
}

// ---- caso 4: FAIL-OPEN (T-05-02-03) — embedder que lanca nunca derruba o caller ----
{
  const embedderQuebrado = async () => {
    throw new Error('deployment de embedding ausente/timeout (simulado)');
  };
  const cache = new CacheSemantico({ embedder: embedderQuebrado, limiar: LIMIAR_TESTE, ttlMs: 60_000, maxPorLead: 10 });

  let lancouBuscar = false;
  let resultadoBuscar;
  try {
    resultadoBuscar = await cache.buscar('5511AAA', 'oi, tudo bem?');
  } catch {
    lancouBuscar = true;
  }
  checar('caso4: buscar() NUNCA lanca quando o embedder lanca', lancouBuscar === false);
  checar('caso4: buscar() devolve null (MISS) quando o embedder lanca', resultadoBuscar === null);

  let lancouGuardar = false;
  try {
    await cache.guardar('5511AAA', 'oi, tudo bem?', 'resposta qualquer');
  } catch {
    lancouGuardar = true;
  }
  checar('caso4: guardar() NUNCA lanca quando o embedder lanca (no-op)', lancouGuardar === false);

  // Confirma que o guardar() acima realmente virou no-op (nada foi persistido).
  const buscaAposFalhaGuardar = await cache.buscar('5511AAA', 'oi, tudo bem?');
  checar('caso4b: guardar() com embedder quebrado nao persiste nada (no-op real)', buscaAposFalhaGuardar === null);
}

// ---- caso 5: TTL expira -> MISS ----
{
  const cache = new CacheSemantico({ embedder: criarEmbedderFake(), limiar: LIMIAR_TESTE, ttlMs: 30, maxPorLead: 10 });
  await cache.guardar('5511AAA', 'pergunta de teste do ttl curto', 'RESPOSTA_TTL');

  const hitAntesDeExpirar = await cache.buscar('5511AAA', 'pergunta de teste do ttl curto');
  checar('caso5: HIT imediatamente apos guardar (antes do TTL expirar)', hitAntesDeExpirar === 'RESPOSTA_TTL');

  await new Promise((resolve) => setTimeout(resolve, 80));

  const missAposExpirar = await cache.buscar('5511AAA', 'pergunta de teste do ttl curto');
  checar('caso5b: MISS apos o TTL expirar', missAposExpirar === null);
}

// ---- caso 6: cap/LRU — acima do tamanho maximo por lead, descarta a mais antiga ----
{
  const cache = new CacheSemantico({ embedder: criarEmbedderFake(), limiar: LIMIAR_TESTE, ttlMs: 60_000, maxPorLead: 2 });
  await cache.guardar('5511AAA', 'assunto um exclusivo', 'RESP_1');
  await cache.guardar('5511AAA', 'assunto dois distinto', 'RESP_2');
  // maxPorLead=2 — esta 3a entrada deve descartar a MAIS ANTIGA (RESP_1).
  await cache.guardar('5511AAA', 'assunto tres diferente', 'RESP_3');

  const buscaEntradaDescartada = await cache.buscar('5511AAA', 'assunto um exclusivo');
  checar('caso6: cap/LRU descarta a entrada mais antiga acima de maxPorLead', buscaEntradaDescartada === null);

  const buscaEntradaRecente = await cache.buscar('5511AAA', 'assunto tres diferente');
  checar('caso6b: entrada mais recente permanece disponivel apos o cap', buscaEntradaRecente === 'RESP_3');
}

// ---- caso 7: leads/texto invalidos -> nunca lanca, sempre MISS/no-op seguro ----
{
  const cache = new CacheSemantico({ embedder: criarEmbedderFake(), limiar: LIMIAR_TESTE, ttlMs: 60_000, maxPorLead: 10 });
  checar('caso7: buscar com lead vazio = null', (await cache.buscar('', 'oi')) === null);
  checar('caso7: buscar com texto vazio = null', (await cache.buscar('5511AAA', '')) === null);
  let lancou = false;
  try {
    await cache.guardar('', '', '');
  } catch {
    lancou = true;
  }
  checar('caso7: guardar com campos vazios nao lanca (no-op)', lancou === false);
}

// ---- caso 8 (CR-01, review Fase 5): saidaCacheavel — SO saida sem efeito
// colateral e cacheavel. Saida com tools_a_executar[] (re-executaria as
// tools num HIT: double booking/re-escalacao/regressao de spin_stage) e a
// saida do PROTOCOLO DE CRISE (acao 'escalar' + 1 mensagem CVV, Safety
// Envelope item 13 — exatamente o shape que o guard antigo `enviouAlgo`
// cacheava) NUNCA podem ser cacheadas. ----
{
  const respostaLimpa = JSON.stringify({
    acao: 'responder',
    mensagens: ['a call e com o closer, ele te mostra o Metodo ADS'],
    proximo_estado: 'I',
    tools_a_executar: [],
    sinal_alerta: null,
  });
  checar('caso8: responder sem tools e CACHEAVEL', saidaCacheavel(respostaLimpa) === true);

  const respostaComTool = JSON.stringify({
    acao: 'responder',
    mensagens: ['agendei pra amanha as 15h!'],
    proximo_estado: 'AGUARDANDO_CALL',
    tools_a_executar: [{ tool: 'create_calendar_event', args: { startTime: '2026-07-15T15:00:00-03:00' } }],
    sinal_alerta: null,
  });
  checar('caso8: responder COM tools_a_executar NAO e cacheavel (double booking num HIT)', saidaCacheavel(respostaComTool) === false);

  const respostaComUpdateField = JSON.stringify({
    acao: 'responder',
    mensagens: ['perfeito, anotei aqui'],
    proximo_estado: 'N',
    tools_a_executar: [{ tool: 'update_contact_field', args: { chave: 'spin_stage', valor: 'N' } }],
    sinal_alerta: null,
  });
  checar('caso8: responder com update_contact_field NAO e cacheavel (regressao de spin_stage num HIT)', saidaCacheavel(respostaComUpdateField) === false);

  // O shape MANDATORIO do protocolo de crise (Safety Envelope item 13):
  // acao 'escalar' COM 1 mensagem CVV + escalate_to_human — era exatamente o
  // caso que o guard antigo cacheava (mensagem enviada => enviouAlgo=true).
  const respostaCrise = JSON.stringify({
    acao: 'escalar',
    mensagens: ['Preciso te dizer uma coisa: o CVV atende 24h no 188 e no cvv.org.br. Vou pausar nossa conversa aqui.'],
    proximo_estado: 'PAUSADO_HUMANO',
    tools_a_executar: [{ tool: 'escalate_to_human', args: { motivo: 'sofrimento_agudo' } }],
    sinal_alerta: 'sofrimento_agudo',
  });
  checar('caso8: saida do protocolo de CRISE (escalar + CVV) NAO e cacheavel', saidaCacheavel(respostaCrise) === false);

  // Mesmo um 'responder' sem tools mas com sinal de sofrimento agudo nao
  // entra no cache (cinto-e-suspensorio do predicado).
  const respostaResponderComSinalCrise = JSON.stringify({
    acao: 'responder',
    mensagens: ['voce ta segura agora?'],
    proximo_estado: 'PAUSADO_HUMANO',
    tools_a_executar: [],
    sinal_alerta: 'sofrimento_agudo',
  });
  checar('caso8: responder com sinal_alerta=sofrimento_agudo NAO e cacheavel', saidaCacheavel(respostaResponderComSinalCrise) === false);

  checar('caso8: acao=aguardar NAO e cacheavel', saidaCacheavel(JSON.stringify({ acao: 'aguardar', mensagens: [], proximo_estado: 'S', tools_a_executar: [], sinal_alerta: null })) === false);
  checar('caso8: JSON invalido NAO e cacheavel', saidaCacheavel('lixo nao-JSON') === false);
  checar('caso8: saidaCacheavel nunca lanca com entrada nao-string', (() => { try { return saidaCacheavel(undefined) === false; } catch { return false; } })());
}

if (falhas.length > 0) {
  console.error('[smoke-cache-semantico] HARD-04 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-cache-semantico] HARD-04 OK');
// CacheSemantico registra um setInterval de cleanup (unref'd), mas o smoke
// sai explicitamente por consistencia com os demais smokes com timers
// (fila-prioridade.mjs).
process.exit(0);
