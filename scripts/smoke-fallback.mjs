// Smoke de HARD-07: prova a cascata de fallback (fallback.ts) — LLM
// secundario -> cache de fallback -> resposta segura (handoff humano), SEM
// LOOP (cada nivel no maximo 1x), crise pulando DIRETO pro handoff, e o
// handoff parseando como saida VALIDA no shape da Camila (nunca uma frase
// canned). Modulo puro/injetavel (so importa camila-schema.ts) — importado
// direto via node --experimental-strip-types, mesmo padrao de
// smoke-resiliencia.mjs/smoke-camila-schema.mjs.

import { resolverFallback, montarHandoffPadrao, MENSAGEM_CVV_188 } from '../src/mastra/fallback.ts';
import { parseSaidaCamila } from '../src/mastra/camila-schema.ts';

const falhas = [];

function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

function saidaValidaCamila(mensagens = ['oi'], overrides = {}) {
  return JSON.stringify({
    acao: 'responder',
    mensagens,
    proximo_estado: 'S',
    tools_a_executar: [],
    sinal_alerta: null,
    ...overrides,
  });
}

// ============================================================================
// CASO 1: secundario retorna JSON valido -> nivel 'secundario', cache/handoff
// NUNCA chamados (cada nivel 1x, ordem certa).
// ============================================================================
{
  let chamadasSecundario = 0;
  let chamadasCache = 0;
  let chamadasHandoff = 0;

  const saidaOk = saidaValidaCamila(['resposta do secundario']);

  const resultado = await resolverFallback({
    lead: '5511999990001',
    texto: 'oi, tudo bem?',
    crise: false,
    secundario: async () => {
      chamadasSecundario++;
      return saidaOk;
    },
    cacheBuscar: async () => {
      chamadasCache++;
      return null;
    },
    montarHandoff: (lead) => {
      chamadasHandoff++;
      return montarHandoffPadrao(lead);
    },
  });

  checar('caso1: tipo=secundario', resultado.tipo === 'secundario');
  checar('caso1: saida = a do secundario', resultado.saida === saidaOk);
  checar('caso1: secundario chamado exatamente 1x', chamadasSecundario === 1);
  checar('caso1: cacheBuscar NUNCA chamado (secundario ja resolveu)', chamadasCache === 0);
  checar('caso1: montarHandoff NUNCA chamado', chamadasHandoff === 0);
}

// ============================================================================
// CASO 2: secundario retorna JSON INVALIDO -> cai pro cache; cache tem HIT do
// MESMO lead -> nivel 'cache'. Handoff nunca chamado.
// ============================================================================
{
  let chamadasSecundario = 0;
  let chamadasCache = 0;
  let chamadasHandoff = 0;

  const saidaCacheada = saidaValidaCamila(['resposta cacheada do lead']);

  const resultado = await resolverFallback({
    lead: '5511999990002',
    texto: 'pergunta repetida',
    crise: false,
    secundario: async () => {
      chamadasSecundario++;
      return 'isso nao e JSON valido nenhum';
    },
    cacheBuscar: async (lead) => {
      chamadasCache++;
      checar('caso2: cacheBuscar recebeu o lead certo', lead === '5511999990002');
      return saidaCacheada;
    },
    montarHandoff: (lead) => {
      chamadasHandoff++;
      return montarHandoffPadrao(lead);
    },
  });

  checar('caso2: tipo=cache', resultado.tipo === 'cache');
  checar('caso2: saida = a cacheada', resultado.saida === saidaCacheada);
  checar('caso2: secundario chamado exatamente 1x', chamadasSecundario === 1);
  checar('caso2: cacheBuscar chamado exatamente 1x', chamadasCache === 1);
  checar('caso2: montarHandoff NUNCA chamado (cache ja resolveu)', chamadasHandoff === 0);
}

// ============================================================================
// CASO 3: secundario retorna null e cache MISS -> nivel 'handoff'. A saida
// PARSEIA como ok:true e declara escalate_to_human (NAO e frase canned).
// ============================================================================
{
  let chamadasSecundario = 0;
  let chamadasCache = 0;
  let chamadasHandoff = 0;

  const resultado = await resolverFallback({
    lead: '5511999990003',
    texto: 'mensagem qualquer',
    crise: false,
    secundario: async () => {
      chamadasSecundario++;
      return null;
    },
    cacheBuscar: async () => {
      chamadasCache++;
      return null;
    },
    montarHandoff: (lead) => {
      chamadasHandoff++;
      return montarHandoffPadrao(lead);
    },
  });

  checar('caso3: tipo=handoff', resultado.tipo === 'handoff');
  checar('caso3: secundario chamado exatamente 1x', chamadasSecundario === 1);
  checar('caso3: cacheBuscar chamado exatamente 1x', chamadasCache === 1);
  checar('caso3: montarHandoff chamado exatamente 1x', chamadasHandoff === 1);

  const parse = parseSaidaCamila(resultado.saida);
  checar('caso3: saida do handoff PARSEIA (ok:true)', parse.ok === true);
  if (parse.ok) {
    checar('caso3: acao=escalar', parse.data.acao === 'escalar');
    checar(
      'caso3: declara escalate_to_human em tools_a_executar',
      parse.data.tools_a_executar.some((t) => t.tool === 'escalate_to_human'),
    );
    checar('caso3: mensagens[] vazio (nao repete frase canned ao lead)', parse.data.mensagens.length === 0);
  }
  checar(
    'caso3: nao ha mensagem canned de erro (texto fixo do Teste 4) na saida',
    !/reenviar a ultima mensagem|tive um problema/i.test(resultado.saida),
  );
}

// ============================================================================
// CASO 4 (mais critico): crise=true -> vai DIRETO pro handoff, SEM invocar
// secundario nem cacheBuscar (T-05-04-04 — nao atrasa a escalacao).
// ============================================================================
{
  let chamadasSecundario = 0;
  let chamadasCache = 0;
  let chamadasHandoff = 0;

  const resultado = await resolverFallback({
    lead: '5511999990004',
    texto: 'nao aguento mais, quero morrer',
    crise: true,
    secundario: async () => {
      chamadasSecundario++;
      return saidaValidaCamila(['nunca deveria chegar aqui']);
    },
    cacheBuscar: async () => {
      chamadasCache++;
      return null;
    },
    montarHandoff: (lead) => {
      chamadasHandoff++;
      // CR-02: o wiring real (index.ts) repassa o flag de crise pro helper.
      return montarHandoffPadrao(lead, true);
    },
  });

  checar('caso4: tipo=handoff (crise direto)', resultado.tipo === 'handoff');
  checar('caso4: secundario NUNCA chamado', chamadasSecundario === 0);
  checar('caso4: cacheBuscar NUNCA chamado', chamadasCache === 0);
  checar('caso4: montarHandoff chamado exatamente 1x', chamadasHandoff === 1);

  const parse = parseSaidaCamila(resultado.saida);
  checar('caso4: saida do handoff de crise tambem PARSEIA (ok:true)', parse.ok === true);
}

// ============================================================================
// CASO 4b (CR-02, review Fase 5): handoff CRISE-AWARE — montarHandoffPadrao
// (lead, true) leva a mensagem CVV-188 do Safety Envelope item 13 (o lead em
// sofrimento agudo NUNCA recebe silencio), motivo 'sofrimento_agudo' (chave
// que acionarHumanoGarantido usa pra marcar a task URGENTE com "protocolo
// CVV 188 / contato IMEDIATO") e sinal_alerta 'sofrimento_agudo'. O handoff
// SEM crise permanece com motivo 'falha_tecnica' e mensagens[] vazio.
// ============================================================================
{
  const parseCrise = parseSaidaCamila(montarHandoffPadrao('5511999990004', true));
  checar('caso4b: handoff de crise PARSEIA (ok:true)', parseCrise.ok === true);
  if (parseCrise.ok) {
    checar('caso4b: acao=escalar', parseCrise.data.acao === 'escalar');
    checar('caso4b: mensagens[] tem exatamente a mensagem CVV-188 (nunca silencio em crise)', parseCrise.data.mensagens.length === 1 && parseCrise.data.mensagens[0] === MENSAGEM_CVV_188);
    checar('caso4b: mensagem menciona CVV e 188', /CVV/.test(parseCrise.data.mensagens[0]) && /188/.test(parseCrise.data.mensagens[0]));
    const escalate = parseCrise.data.tools_a_executar.find((t) => t.tool === 'escalate_to_human');
    checar('caso4b: declara escalate_to_human', !!escalate);
    checar('caso4b: motivo=sofrimento_agudo (gatilho do marcador URGENTE/CVV na task)', escalate?.args?.motivo === 'sofrimento_agudo');
    checar('caso4b: sinal_alerta=sofrimento_agudo', parseCrise.data.sinal_alerta === 'sofrimento_agudo');
  }

  const parseSemCrise = parseSaidaCamila(montarHandoffPadrao('5511999990004'));
  checar('caso4b: handoff SEM crise segue com mensagens[] vazio', parseSemCrise.ok === true && parseSemCrise.data.mensagens.length === 0);
  if (parseSemCrise.ok) {
    const escalateSemCrise = parseSemCrise.data.tools_a_executar.find((t) => t.tool === 'escalate_to_human');
    checar('caso4b: handoff SEM crise segue com motivo=falha_tecnica', escalateSemCrise?.args?.motivo === 'falha_tecnica');
    checar('caso4b: handoff SEM crise segue com sinal_alerta=null', parseSemCrise.data.sinal_alerta === null);
  }
}

// ============================================================================
// CASO 5: SEM LOOP — mesmo quando secundario lanca excecao (nao so retorna
// null), a cascata NAO propaga o erro nem re-tenta o mesmo nivel; segue pro
// proximo nivel normalmente, 1x cada.
// ============================================================================
{
  let chamadasSecundario = 0;
  let chamadasCache = 0;

  const resultado = await resolverFallback({
    lead: '5511999990005',
    texto: 'teste de excecao',
    crise: false,
    secundario: async () => {
      chamadasSecundario++;
      throw new Error('falha simulada de rede no secundario');
    },
    cacheBuscar: async () => {
      chamadasCache++;
      return null;
    },
    montarHandoff: (lead) => montarHandoffPadrao(lead),
  });

  checar('caso5: nao propaga excecao — resolve normalmente', resultado.tipo === 'handoff');
  checar('caso5: secundario chamado exatamente 1x (nao re-tenta)', chamadasSecundario === 1);
  checar('caso5: cacheBuscar chamado exatamente 1x', chamadasCache === 1);
}

// ============================================================================
// CASO 6 (isolamento por lead): cacheBuscar('leadB') NUNCA devolve o que foi
// guardado para 'leadA' — simula um cache real particionado por lead (mesma
// fronteira do 05-02) e prova que a cascata repassa o `lead` certo, nunca
// cruza.
// ============================================================================
{
  const armazenamentoFake = new Map([['leadA', saidaValidaCamila(['resposta exclusiva do leadA'])]]);

  const cacheBuscarFake = async (lead) => armazenamentoFake.get(lead) ?? null;

  const resultadoA = await resolverFallback({
    lead: 'leadA',
    texto: 'oi',
    crise: false,
    secundario: async () => null,
    cacheBuscar: cacheBuscarFake,
    montarHandoff: (lead) => montarHandoffPadrao(lead),
  });
  checar('caso6: leadA recebe sua propria resposta cacheada', resultadoA.tipo === 'cache');

  const resultadoB = await resolverFallback({
    lead: 'leadB',
    texto: 'oi',
    crise: false,
    secundario: async () => null,
    cacheBuscar: cacheBuscarFake,
    montarHandoff: (lead) => montarHandoffPadrao(lead),
  });
  checar('caso6: leadB NUNCA recebe a resposta cacheada de leadA (isolamento)', resultadoB.tipo !== 'cache');
  checar('caso6: leadB cai pro handoff (cache miss legitimo)', resultadoB.tipo === 'handoff');
}

if (falhas.length > 0) {
  console.error('[smoke-fallback] HARD-07 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-fallback] HARD-07 OK');
