#!/usr/bin/env node
// scripts/correlacao-durabilidade.smoke.mjs
//
// Smoke HERMÉTICO (sem rede, sem Redis) da Fase 19.1 Plano 08 (DUR-02/06/07)
// — correlação durável (taskId no job) + parking classificado como
// permanente + observabilidade do ramo. Importa `decidirTaskIdRecord`
// (processador.ts, helper PURO extraído do ladder de resolução do RECORD) e
// `classificarErro` (classificar-erro.ts) — mesmo molde hermético de
// `transcrever-copia-local.smoke.mjs` (env fake ANTES do import; REDIS_URL
// ausente -> estado-webhook/metricas caem no modo memória).
//
//   PARTE A — decidirTaskIdRecord (processador.ts, PURO):
//     A1) prefere taskIdData quando presente, ignora redis/clickup.
//     A2) sem taskIdData, prefere taskIdRedis quando presente.
//     A3) sem taskIdData/taskIdRedis, usa taskIdClickup.
//     A4) todos ausentes -> { estacionar: true }, sem taskId.
//
//   PARTE B — classificarErro (classificar-erro.ts):
//     B1) mensagem estável 'sem correlacao call→task (call=...)' -> permanente.
//     B2) uma mensagem qualquer (sem marcador conhecido) continua transitório
//         (default conservador — não quebrado pelo novo marcador).
//
// (PARTE C — registrarEstacionamentoCorrelacao, metricas.ts — estendida
// pela Task 3 deste plano, ver comentário mais abaixo no arquivo.)
//
// Uso: node --experimental-strip-types scripts/correlacao-durabilidade.smoke.mjs

process.env.SUPABASE_URL ||= 'https://smoke.invalido.local';
process.env.SUPABASE_SERVICE_KEY ||= 'smoke-fake-service-key';
process.env.SUPABASE_STORAGE_BUCKET_GRAVACOES ||= 'gravacoes';

const { decidirTaskIdRecord } = await import('../src/mastra/processador.ts');
const { classificarErro } = await import('../src/mastra/classificar-erro.ts');

const falhas = [];
function checar(condicao, mensagem) {
  if (condicao) {
    console.log('  ✅', mensagem);
  } else {
    console.error('  ❌', mensagem);
    falhas.push(mensagem);
  }
}

// ===== PARTE A — decidirTaskIdRecord =====

function testeDecideDataPrimeiro() {
  const r = decidirTaskIdRecord({ taskIdData: 'task-data', taskIdRedis: 'task-redis', taskIdClickup: 'task-clickup' });
  checar(r.taskId === 'task-data' && r.estacionar === false, `deveria preferir taskIdData, recebido: ${JSON.stringify(r)}`);
}

function testeDecideRedisSemData() {
  const r = decidirTaskIdRecord({ taskIdData: null, taskIdRedis: 'task-redis', taskIdClickup: 'task-clickup' });
  checar(r.taskId === 'task-redis' && r.estacionar === false, `sem data deveria preferir taskIdRedis, recebido: ${JSON.stringify(r)}`);
}

function testeDecideClickupSemDataERedis() {
  const r = decidirTaskIdRecord({ taskIdData: null, taskIdRedis: null, taskIdClickup: 'task-clickup' });
  checar(r.taskId === 'task-clickup' && r.estacionar === false, `sem data/redis deveria usar taskIdClickup, recebido: ${JSON.stringify(r)}`);
}

function testeDecideEstacionaSemNenhum() {
  const r = decidirTaskIdRecord({ taskIdData: null, taskIdRedis: null, taskIdClickup: null });
  checar(r.estacionar === true && r.taskId === undefined, `todos ausentes deveria estacionar sem taskId, recebido: ${JSON.stringify(r)}`);
}

// ===== PARTE B — classificarErro =====

function testeMensagemEstavelSemCorrelacaoEhPermanente() {
  const erro = new Error('sem correlacao call→task (call=abc123)');
  const r = classificarErro(erro);
  checar(r.tipo === 'permanente', `mensagem estável de correlação ausente deveria classificar permanente, recebido: ${JSON.stringify(r)}`);
  checar(r.motivo === 'correlacao-ausente', `motivo deveria ser 'correlacao-ausente', recebido: ${r.motivo}`);
}

function testeMensagemQualquerContinuaTransitorio() {
  const erro = new Error('algo genérico deu errado, origem desconhecida');
  const r = classificarErro(erro);
  checar(r.tipo === 'transitorio', `mensagem sem marcador conhecido deveria seguir o default conservador (transitório), recebido: ${JSON.stringify(r)}`);
}

function testeMensagemDeRedeNaoQuebra() {
  const erro = new Error('fetch failed');
  const r = classificarErro(erro);
  checar(r.tipo === 'transitorio' && r.origem === 'rede', `marcador de rede pré-existente não deveria ser afetado pelo novo marcador, recebido: ${JSON.stringify(r)}`);
}

async function main() {
  testeDecideDataPrimeiro();
  testeDecideRedisSemData();
  testeDecideClickupSemDataERedis();
  testeDecideEstacionaSemNenhum();
  testeMensagemEstavelSemCorrelacaoEhPermanente();
  testeMensagemQualquerContinuaTransitorio();
  testeMensagemDeRedeNaoQuebra();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
