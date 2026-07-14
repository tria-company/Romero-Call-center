// Smoke de HARD-08 (Fase 5, plano 05-06): prova executavel do modulo
// observabilidade.ts — custo por modelo, log JSON estruturado sem texto
// bruto, e fail-open quando a persistencia (banco) lanca. Modulo PURO (so
// exporta funcoes, zero import de config/azure/supabase) — importamos
// direto via node --experimental-strip-types (mesmo padrao de
// scripts/smoke-camila-schema.mjs).

import {
  estimarCusto,
  registrarMetricaLLM,
  normalizarModelo,
  CUSTO_POR_MODELO,
  CAMILA_PROMPT_VERSION,
  QUALIFICADOR_PROMPT_VERSION,
} from '../src/mastra/observabilidade.ts';

const falhas = [];

function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// ---- Caso 1: estimarCusto com modelo conhecido -> custo > 0 ----
{
  const r = estimarCusto({ modelo: 'gpt-5.1', promptTokens: 1000, completionTokens: 200 });
  checar('caso1: conhecido=true', r.conhecido === true);
  checar('caso1: custo > 0', r.custo > 0);
}

// ---- Caso 2: estimarCusto com modelo desconhecido -> custo 0, conhecido:false, sem lancar ----
{
  let lancou = false;
  let r;
  try {
    r = estimarCusto({ modelo: 'modelo-fantasma-xyz', promptTokens: 500, completionTokens: 100 });
  } catch {
    lancou = true;
  }
  checar('caso2: nao lanca', lancou === false);
  checar('caso2: custo=0', r?.custo === 0);
  checar('caso2: conhecido=false', r?.conhecido === false);
}

// ---- Caso 2b (WR-05, review Fase 5): nome de DEPLOYMENT Azure diferente do
// nome canonico do modelo NAO zera o custo silenciosamente — normalizarModelo
// mapeia deployment->modelo e estimarCusto devolve custo real/conhecido. ----
{
  checar('caso2b: normalizarModelo("gpt51-prod") -> gpt-5.1', normalizarModelo('gpt51-prod') === 'gpt-5.1');
  checar('caso2b: normalizarModelo("gpt-5-mini-sdr") -> gpt-5-mini', normalizarModelo('gpt-5-mini-sdr') === 'gpt-5-mini');
  checar('caso2b: normalizarModelo("meu-gpt-4.1-mini") -> gpt-4.1-mini', normalizarModelo('meu-gpt-4.1-mini') === 'gpt-4.1-mini');
  checar('caso2b: normalizarModelo("text-embedding-prod") -> text-embedding-3-large', normalizarModelo('text-embedding-prod') === 'text-embedding-3-large');
  checar('caso2b: nome canonico passa intacto', normalizarModelo('gpt-5.1') === 'gpt-5.1');
  checar('caso2b: nome irreconhecivel passa intacto (vira conhecido:false)', normalizarModelo('deployment-misterioso') === 'deployment-misterioso');

  const rDeployment = estimarCusto({ modelo: 'gpt51-prod', promptTokens: 1000, completionTokens: 200 });
  checar('caso2b: estimarCusto com nome de deployment -> conhecido=true', rDeployment.conhecido === true);
  checar('caso2b: estimarCusto com nome de deployment -> custo > 0 (nao zera silenciosamente)', rDeployment.custo > 0);
  const rCanonico = estimarCusto({ modelo: 'gpt-5.1', promptTokens: 1000, completionTokens: 200 });
  checar('caso2b: custo do deployment == custo do modelo canonico', rDeployment.custo === rCanonico.custo);

  // Warning 1x por modelo desconhecido (o "custo 0" deixa de ser invisivel).
  const warnsOriginais = console.warn;
  let warns = 0;
  console.warn = () => { warns++; };
  try {
    estimarCusto({ modelo: 'deployment-sem-preco-abc', promptTokens: 10, completionTokens: 5 });
    estimarCusto({ modelo: 'deployment-sem-preco-abc', promptTokens: 10, completionTokens: 5 });
  } finally {
    console.warn = warnsOriginais;
  }
  checar('caso2b: modelo desconhecido gera warning UMA unica vez (nao spamma)', warns === 1);
}

// ---- Caso 3: CUSTO_POR_MODELO cobre os 4 modelos esperados ----
{
  checar('caso3: gpt-5.1 na tabela', !!CUSTO_POR_MODELO['gpt-5.1']);
  checar('caso3: gpt-5-mini na tabela', !!CUSTO_POR_MODELO['gpt-5-mini']);
  checar('caso3: gpt-4.1-mini na tabela', !!CUSTO_POR_MODELO['gpt-4.1-mini']);
  checar('caso3: text-embedding-3-large na tabela', !!CUSTO_POR_MODELO['text-embedding-3-large']);
}

// ---- Caso 4: registrarMetricaLLM emite log JSON estruturado SEM texto bruto ----
{
  const logsOriginais = console.log;
  const capturados = [];
  console.log = (...args) => capturados.push(args);
  try {
    registrarMetricaLLM({
      modelo: 'gpt-5.1',
      tipo: 'camila_primaria',
      promptTokens: 300,
      completionTokens: 80,
      latenciaMs: 1234,
      promptVersao: CAMILA_PROMPT_VERSION,
      telefone: '5511999999999',
      conversationId: 'conv-abc',
      cacheHit: false,
    });
  } finally {
    console.log = logsOriginais;
  }

  const linha = capturados.find((args) => args[0] === '[metrica-llm]');
  checar('caso4: emitiu linha [metrica-llm]', !!linha);

  if (linha) {
    const json = JSON.parse(linha[1]);
    checar('caso4: tem totalTokens=380', json.totalTokens === 380);
    checar('caso4: tem custoEstimado > 0', json.custoEstimado > 0);
    checar('caso4: tem promptVersao', json.promptVersao === CAMILA_PROMPT_VERSION);
    checar('caso4: tem telefone', json.telefone === '5511999999999');
    // LGPD (T-05-06-01): nenhuma chave de texto bruto
    const chaves = Object.keys(json);
    checar('caso4: sem chave "texto"', !chaves.includes('texto'));
    checar('caso4: sem chave "mensagem"', !chaves.includes('mensagem'));
    checar('caso4: sem chave "resposta"', !chaves.includes('resposta'));
    checar('caso4: sem chave "mensagens"', !chaves.includes('mensagens'));
  }
}

// ---- Caso 5: fail-open — persist que lanca nao derruba registrarMetricaLLM ----
{
  let capturouErroConsole = false;
  const errOriginal = console.error;
  console.error = () => { capturouErroConsole = true; };

  let lancouParaCaller = false;
  try {
    registrarMetricaLLM(
      {
        modelo: 'gpt-5-mini',
        tipo: 'qualificador',
        promptTokens: 100,
        completionTokens: 20,
        latenciaMs: 500,
        promptVersao: QUALIFICADOR_PROMPT_VERSION,
        telefone: '5511888888888',
      },
      async () => {
        throw new Error('banco read-only (quota 402) — simulado no smoke');
      },
    );
  } catch {
    lancouParaCaller = true;
  }

  checar('caso5: registrarMetricaLLM nao lanca pro caller mesmo com persist falho', lancouParaCaller === false);

  // O persist e chamado de forma fire-and-forget (Promise.resolve().catch),
  // entao aguardamos um tick pra garantir que o catch interno rodou antes
  // de checar (evita falso-negativo por race). console.error so e restaurado
  // DEPOIS desse wait, senao o catch async chega depois do restore e o flag
  // nunca vira true.
  await new Promise((resolve) => setTimeout(resolve, 50));
  console.error = errOriginal;
  checar('caso5: erro de persist foi capturado internamente (fail-open)', capturouErroConsole === true);
}

// ---- Caso 6: cache HIT registra tokens/custo 0 (mensuravel a economia) ----
{
  const logsOriginais = console.log;
  const capturados = [];
  console.log = (...args) => capturados.push(args);
  try {
    registrarMetricaLLM({
      modelo: 'gpt-5.1',
      tipo: 'camila_primaria',
      promptTokens: 0,
      completionTokens: 0,
      latenciaMs: 12,
      promptVersao: CAMILA_PROMPT_VERSION,
      telefone: '5511999999999',
      cacheHit: true,
    });
  } finally {
    console.log = logsOriginais;
  }
  const linha = capturados.find((args) => args[0] === '[metrica-llm]');
  if (linha) {
    const json = JSON.parse(linha[1]);
    checar('caso6: cacheHit=true', json.cacheHit === true);
    checar('caso6: totalTokens=0', json.totalTokens === 0);
    checar('caso6: custoEstimado=0', json.custoEstimado === 0);
  } else {
    falhas.push('caso6: nao emitiu linha [metrica-llm]');
  }
}

// ---- Caso 7 (WR-05): custoConhecido/tokensEstimados chegam ao persist
// injetado (antes eram calculados e DESCARTADOS na persistencia — cache HIT
// com custo 0 real e deployment sem preco com custo 0 incognita ficavam
// indistinguiveis na tabela). ----
{
  const logsOriginais = console.log;
  const warnsOriginais = console.warn;
  console.log = () => {};
  console.warn = () => {};
  let persistido = null;
  try {
    registrarMetricaLLM(
      {
        modelo: 'deployment-sem-preco-nenhum-xyz',
        tipo: 'camila_primaria',
        promptTokens: 100,
        completionTokens: 50,
        latenciaMs: 800,
        promptVersao: CAMILA_PROMPT_VERSION,
        telefone: '5511999999999',
        tokensEstimados: true,
      },
      async (dados) => {
        persistido = dados;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20)); // persist e fire-and-forget
  } finally {
    console.log = logsOriginais;
    console.warn = warnsOriginais;
  }
  checar('caso7 (WR-05): persist recebeu custoConhecido=false (custo 0 e INCOGNITA, nao zero real)', persistido?.custoConhecido === false);
  checar('caso7 (WR-05): persist recebeu tokensEstimados=true (tokens sao estimativa)', persistido?.tokensEstimados === true);
  checar('caso7 (WR-05): persist recebeu custoEstimado=0', persistido?.custoEstimado === 0);
}

if (falhas.length > 0) {
  console.error('[smoke-observabilidade] HARD-08 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-observabilidade] HARD-08 OK');
