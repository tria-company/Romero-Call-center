// Smoke de GRAV-03 (resgate durável de 48h): prova a funcao pura
// `decidirResgate` em src/mastra/resgates.ts — decide se um lead com sinal
// de desistencia sem fechamento deve ser resgatado (task pro SDR humano),
// cancelado (ja fechou/GANHO) ou aguardar (ainda dentro da janela de 48h).
//
// Mesma limitacao/solucao de scripts/smoke-no-show.mjs: o loader nativo de
// TS do Node (--experimental-strip-types) NAO resolve os imports relativos
// sem extensao de resgates.ts ('./supabase', './tools/create-task',
// './no-show', './ghl', './http', './config') — so o bundler do Mastra
// (esbuild) resolve isso. Solucao pra `decidirResgate` (funcao PURA, sem
// I/O): extrai o CORPO REAL via regex e executa via `new Function` — prova
// o comportamento real (nao duplica a logica a mao num segundo lugar que
// pode divergir do codigo de producao).
//
// As acoes REAIS (agendarResgate48h/leadEstaGanho/processarResgates) tem
// dependencias de I/O nao-triviais (GHL, Supabase, createTask) que tornam a
// extracao comportamental completa via AsyncFunction fragil/arriscada de
// manter — a prova aqui usa asserts de FONTE por indice de string (presenca
// + ORDEM), mesmo molde de scripts/smoke-no-show.mjs.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const arquivoPath = resolve(projectRoot, 'src/mastra/resgates.ts');

const src = await readFile(arquivoPath, 'utf8').catch(() => null);
if (src === null) {
  console.error(`[smoke-resgates] GRAV-03 FALHOU: arquivo nao encontrado (${arquivoPath})`);
  process.exit(1);
}

const falhas = [];
function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// ---------------------------------------------------------------------
// 1. Prova COMPORTAMENTAL de decidirResgate (funcao pura, sem I/O).
// ---------------------------------------------------------------------
const match = src.match(
  /export function decidirResgate\([\s\S]*?\)\s*:\s*DecisaoResgate\s*\{([\s\S]*?)\n\}/,
);
if (!match) {
  console.error('[smoke-resgates] GRAV-03 FALHOU: funcao decidirResgate nao encontrada (ou assinatura mudou) em resgates.ts');
  process.exit(1);
}

const decidirResgate = new Function('args', match[1]);

const RESGATAR_EM = new Date('2026-07-22T10:00:00Z').getTime();
const H = 60 * 60 * 1000;

// ---- Caso 1: antes do prazo (resgatarEm no futuro) -> 'nada' ----
{
  const r = decidirResgate({ resgatarEmMs: RESGATAR_EM, nowMs: RESGATAR_EM - 2 * H, leadGanho: false });
  checar("caso1: antes do prazo de 48h (resgatarEm no futuro) -> 'nada'", r?.acao === 'nada');
}

// ---- Caso 2: apos o prazo, lead NAO-GANHO -> 'resgatar' ----
{
  const r = decidirResgate({ resgatarEmMs: RESGATAR_EM, nowMs: RESGATAR_EM + 1 * H, leadGanho: false });
  checar("caso2: apos o prazo de 48h, lead nao-GANHO -> 'resgatar'", r?.acao === 'resgatar');
}

// ---- Caso 3: apos o prazo, lead GANHO -> 'cancelar' ----
{
  const r = decidirResgate({ resgatarEmMs: RESGATAR_EM, nowMs: RESGATAR_EM + 1 * H, leadGanho: true });
  checar("caso3: apos o prazo, lead GANHO (fechou nesse meio-tempo) -> 'cancelar'", r?.acao === 'cancelar');
}

// ---- Caso 4: exatamente no prazo (nowMs === resgatarEmMs), nao-GANHO -> 'resgatar' ----
{
  const r = decidirResgate({ resgatarEmMs: RESGATAR_EM, nowMs: RESGATAR_EM, leadGanho: false });
  checar("caso4: exatamente no prazo, nao-GANHO -> 'resgatar' (gate e >=, nao so >)", r?.acao === 'resgatar');
}

// ---- Caso 5: NaN em resgatarEmMs -> 'nada' (fail-safe) ----
{
  const r = decidirResgate({ resgatarEmMs: NaN, nowMs: RESGATAR_EM, leadGanho: false });
  checar("caso5: resgatarEmMs NaN -> 'nada' (fail-safe, nunca dispara task por engano)", r?.acao === 'nada');
}

// ---------------------------------------------------------------------
// 2. Asserts de FONTE (presenca + ORDEM) das acoes reais
// (agendarResgate48h/leadEstaGanho/processarResgates).
// ---------------------------------------------------------------------
checar(
  "resgates.ts importa upsertResgate/buscarResgatesPendentes/marcarResgateFeito de './supabase'",
  /upsertResgate/.test(src) && /buscarResgatesPendentes/.test(src) && /marcarResgateFeito/.test(src),
);
checar(
  "resgates.ts importa createTask de './tools/create-task'",
  /import\s*\{\s*createTask\s*\}\s*from\s*['"]\.\/tools\/create-task['"]/.test(src),
);
checar(
  "resgates.ts importa leadEmPausaDuravel de './no-show' (guarda de crise duravel reusada, sem ciclo novo)",
  /import\s*\{\s*leadEmPausaDuravel\s*\}\s*from\s*['"]\.\/no-show['"]/.test(src),
);

const fnAgendarMatch = src.match(/export async function agendarResgate48h\([\s\S]*?\n\}/);
checar('funcao agendarResgate48h encontrada em resgates.ts (contrato consumido pela extracao de sinais, Task 2)', !!fnAgendarMatch);
if (fnAgendarMatch) {
  checar('agendarResgate48h calcula resgatar_em = agora + 48h', /48\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(fnAgendarMatch[0]));
  checar('agendarResgate48h chama upsertResgate(...)', fnAgendarMatch[0].indexOf('upsertResgate(') !== -1);
}

const fnGanhoMatch = src.match(/export async function leadEstaGanho\([\s\S]*?\n\}/);
checar('funcao leadEstaGanho encontrada em resgates.ts (re-check de fechamento, reusavel pela extracao de sinais)', !!fnGanhoMatch);
if (fnGanhoMatch) {
  checar('leadEstaGanho compara pipelineStageId com GHL_STAGES.GANHO', /GHL_STAGES\.GANHO/.test(fnGanhoMatch[0]));
  // WR-04: varre TODAS as opportunities (.some), nao so a [0] — a ordenacao
  // da API nao e garantida e um contato pode ter mais de uma opportunity.
  checar(
    'WR-04: leadEstaGanho varre TODAS as opportunities (opps.some(...)), nao so opportunities[0]',
    /\.some\(\s*\(o\)\s*=>\s*o\?\.pipelineStageId\s*===\s*GHL_STAGES\.GANHO\s*\)/.test(fnGanhoMatch[0]),
  );
  checar(
    'WR-04: leadEstaGanho NAO le mais so opportunities?.[0]',
    !/opportunities\?\.\[0\]/.test(fnGanhoMatch[0]),
  );
}

const fnProcessarMatch = src.match(/export async function processarResgates\([\s\S]*?\n\}/);
checar('funcao processarResgates encontrada em resgates.ts', !!fnProcessarMatch);
if (fnProcessarMatch) {
  const corpo = fnProcessarMatch[0];

  const idxGuardaCrise = corpo.indexOf('leadEmPausaDuravel(');
  const idxContinueGuarda = corpo.indexOf('continue', Math.max(idxGuardaCrise, 0));
  const idxCreateTask = corpo.indexOf('createTask.execute!(');
  const idxMarcarFeito = corpo.search(/marcarResgateFeito\([^)]*['"]feito['"]/);
  const idxMarcarCancelado = corpo.search(/marcarResgateFeito\([^)]*['"]cancelado['"]/);
  const idxSucesso = corpo.search(/if\s*\(\s*r\?\.\s*sucesso\s*\)/);

  checar('T-03-10: processarResgates usa a guarda de crise duravel leadEmPausaDuravel(...)', idxGuardaCrise !== -1);
  checar('processarResgates tem um "continue" apos a guarda de crise (pula o lead, nao so loga)', idxContinueGuarda !== -1);
  if (idxGuardaCrise !== -1 && idxCreateTask !== -1) {
    checar(
      'T-03-10: guarda de crise/pausa precede a criacao da task de resgate (createTask.execute!) — nao dispara task antes de checar crise',
      idxGuardaCrise < idxCreateTask,
    );
  }
  checar('processarResgates chama decidirResgate(...)', corpo.indexOf('decidirResgate(') !== -1);
  checar('processarResgates cria a task de resgate (createTask.execute!)', idxCreateTask !== -1);
  checar("processarResgates marca 'feito' apos sucesso da task (marcarResgateFeito(..., 'feito'))", idxMarcarFeito !== -1);
  checar("processarResgates marca 'cancelado' no caminho de lead ja GANHO (marcarResgateFeito(..., 'cancelado'))", idxMarcarCancelado !== -1);
  if (idxSucesso !== -1 && idxMarcarFeito !== -1) {
    checar(
      "processarResgates so marca 'feito' DEPOIS de checar o sucesso real da task (nao marca terminal sem confirmacao)",
      idxSucesso < idxMarcarFeito,
    );
  }
  checar(
    'marcador [resgates][SEM-SINAL] presente pra falha total na criacao da task (mesmo padrao honesto de no-show.ts/escalate-to-human.ts)',
    /\[resgates\]\[SEM-SINAL\]/.test(corpo),
  );
}

// ---------------------------------------------------------------------
// 3. Asserts de FONTE em lembretes.ts — processarResgates chamado no MESMO
// tick do scheduler (sem setInterval novo).
// ---------------------------------------------------------------------
const lembretesPath = resolve(projectRoot, 'src/mastra/lembretes.ts');
const lembretesSrc = await readFile(lembretesPath, 'utf8').catch(() => null);
checar('lembretes.ts encontrado', lembretesSrc !== null);
if (lembretesSrc !== null) {
  checar(
    "lembretes.ts importa processarResgates de './resgates'",
    /import\s*\{\s*processarResgates\s*\}\s*from\s*['"]\.\/resgates['"]/.test(lembretesSrc),
  );
  const fnIniciar = lembretesSrc.match(/export function iniciarLembretesScheduler\([\s\S]*?\n\}/);
  checar('funcao iniciarLembretesScheduler encontrada em lembretes.ts', !!fnIniciar);
  if (fnIniciar) {
    checar('iniciarLembretesScheduler chama processarResgates(mastra) dentro do MESMO tick (sem scheduler novo)', fnIniciar[0].indexOf('processarResgates(mastra)') !== -1);
    const totalSetInterval = (fnIniciar[0].match(/setInterval\(/g) || []).length;
    checar('apenas 1 setInterval em iniciarLembretesScheduler (processarResgates reusa o tick existente, nao cria um paralelo)', totalSetInterval === 1);
  }
}

// ---------------------------------------------------------------------
// 4. Asserts de FONTE em supabase.ts — helpers de resgate (WR-01: escrita
// honesta) e migration 09_resgates.sql presente/idempotente/[BLOCKING].
// ---------------------------------------------------------------------
const supabasePath = resolve(projectRoot, 'src/mastra/supabase.ts');
const supabaseSrc = await readFile(supabasePath, 'utf8').catch(() => null);
checar('supabase.ts encontrado', supabaseSrc !== null);
if (supabaseSrc !== null) {
  // O objeto de parametros de upsertResgate fecha com `}` antes do retorno
  // de tipo (mesmo formato de upsertLembreteCall) — regex precisa pular
  // ate depois de `Promise<...>` antes de procurar o `\n}` final do corpo
  // (mesma solucao ja usada em scripts/smoke-lembretes.mjs).
  const fnUpsert = supabaseSrc.match(/export async function upsertResgate\([\s\S]*?Promise<[^>]*>\s*\{[\s\S]*?\n\}/);
  checar('funcao upsertResgate encontrada em supabase.ts', !!fnUpsert);
  if (fnUpsert) {
    checar('upsertResgate usa on_conflict=telefone (1 resgate pendente por lead, T-03-09)', /on_conflict=telefone/.test(fnUpsert[0]));
  }

  const fnBuscar = supabaseSrc.match(/export async function buscarResgatesPendentes\([\s\S]*?\n\}/);
  checar('funcao buscarResgatesPendentes encontrada em supabase.ts', !!fnBuscar);
  if (fnBuscar) {
    checar('buscarResgatesPendentes filtra status=eq.pendente', /status=eq\.pendente/.test(fnBuscar[0]));
    checar('buscarResgatesPendentes limita a janela de scan (limit=200, T-03-09)', /limit=200/.test(fnBuscar[0]));
  }

  const fnMarcar = supabaseSrc.match(/export async function marcarResgateFeito\([\s\S]*?\n\}/);
  checar('funcao marcarResgateFeito encontrada em supabase.ts', !!fnMarcar);
  if (fnMarcar) {
    checar('WR-01: marcarResgateFeito checa res.ok e retorna boolean honesto', /res\.ok/.test(fnMarcar[0]) && /Promise<boolean>/.test(fnMarcar[0]));
  }
}

const sqlPath = resolve(projectRoot, 'docs/sql/auton_sdr/09_resgates.sql');
const sqlSrc = await readFile(sqlPath, 'utf8').catch(() => null);
checar('docs/sql/auton_sdr/09_resgates.sql encontrado', sqlSrc !== null);
if (sqlSrc !== null) {
  checar('09_resgates.sql tem cabecalho [BLOCKING]', /\[BLOCKING\]/.test(sqlSrc));
  checar('09_resgates.sql cria a tabela auton_sdr_resgates de forma idempotente (CREATE TABLE IF NOT EXISTS)', /CREATE TABLE IF NOT EXISTS auton_sdr_resgates/.test(sqlSrc));
  checar('09_resgates.sql cria indexes de forma idempotente (CREATE INDEX IF NOT EXISTS)', /CREATE (UNIQUE )?INDEX IF NOT EXISTS/.test(sqlSrc));
  checar('09_resgates.sql tem index unico CHEIO por telefone (uq_resgates_telefone) pro upsert on_conflict=telefone funcionar (mesma licao do CR-01 da 07)', /uq_resgates_telefone/.test(sqlSrc));
}

if (falhas.length > 0) {
  console.error('[smoke-resgates] GRAV-03 FALHOU:');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('[smoke-resgates] GRAV-03 OK');
