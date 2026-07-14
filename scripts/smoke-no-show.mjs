// Smoke de FUN-03/FUN-04 (loop de no-show): prova a funcao pura
// `decidirNoShow` em src/mastra/no-show.ts — a maquina de estados que decide
// se o lead que faltou a call comercial deve ser recuperado (Camila natural
// + task pro SDR humano) ou virar Perdido (2o no-show ou 48h de silencio).
//
// Mesma limitacao/solucao documentada em scripts/smoke-lembretes.mjs: o
// loader nativo de TS do Node (--experimental-strip-types) NAO resolve os
// imports relativos sem extensao de no-show.ts ('./supabase', './sessao',
// './bloqueio', './tools/move-pipeline-stage', './tools/create-task',
// './agents/camila', './index') — so o bundler do Mastra (esbuild) resolve
// isso. Solucao pra `decidirNoShow` (funcao PURA, sem I/O): extrai o CORPO
// REAL via regex e executa via `new Function` — prova o comportamento real
// (nao duplica a logica a mao num segundo lugar que pode divergir do codigo
// de producao).
//
// As acoes REAIS do loop (dispararRecuperacaoNoShow/processarNoShows, Task 2
// deste plano) tem dependencias de I/O nao-triviais (GHL, Camila via
// generate, Supabase) que tornam a extracao comportamental completa via
// AsyncFunction fragil/arriscada de manter — a prova aqui usa asserts de
// FONTE por indice de string (presenca + ORDEM), mesmo molde de
// scripts/smoke-webhook-formulario-auth.mjs / scripts/smoke-escalacao.mjs.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const arquivoPath = resolve(projectRoot, 'src/mastra/no-show.ts');

const src = await readFile(arquivoPath, 'utf8').catch(() => null);
if (src === null) {
  console.error(`[smoke-no-show] FUN-03/FUN-04 FALHOU: arquivo nao encontrado (${arquivoPath})`);
  process.exit(1);
}

const falhas = [];
function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// ---------------------------------------------------------------------
// 1. Prova COMPORTAMENTAL de decidirNoShow (funcao pura, sem I/O).
// ---------------------------------------------------------------------
const match = src.match(
  /export function decidirNoShow\([\s\S]*?\)\s*:\s*DecisaoNoShow\s*\{([\s\S]*?)\n\}/,
);
if (!match) {
  console.error('[smoke-no-show] FUN-03/FUN-04 FALHOU: funcao decidirNoShow nao encontrada (ou assinatura mudou) em no-show.ts');
  process.exit(1);
}

const decidirNoShow = new Function('args', match[1]);

const CALL_START = new Date('2026-07-20T14:00:00Z').getTime();
const MIN = 60 * 1000;
const H = 60 * 60 * 1000;

// ---- Caso 1: dentro dos 15min, sem resposta, tentativas 0 -> 'nada' ----
{
  const r = decidirNoShow({
    callStartMs: CALL_START, nowMs: CALL_START + 10 * MIN,
    leadRespondeuAposCall: false, tentativas: 0, ultimaRecuperacaoMs: null, terminal: false,
  });
  checar("caso1: dentro dos 15min, sem resposta, tentativas 0 -> 'nada'", r?.acao === 'nada');
}

// ---- Caso 2: 16min apos call_start, sem resposta, tentativas 0 -> 'recuperar' ----
{
  const r = decidirNoShow({
    callStartMs: CALL_START, nowMs: CALL_START + 16 * MIN,
    leadRespondeuAposCall: false, tentativas: 0, ultimaRecuperacaoMs: null, terminal: false,
  });
  checar("caso2: 16min apos call_start, sem resposta, tentativas 0 -> 'recuperar'", r?.acao === 'recuperar');
}

// ---- Caso 3: 16min apos call_start (reagendada), sem resposta, tentativas 1 -> 'perdido_2o_noshow' ----
{
  const r = decidirNoShow({
    callStartMs: CALL_START, nowMs: CALL_START + 16 * MIN,
    leadRespondeuAposCall: false, tentativas: 1, ultimaRecuperacaoMs: CALL_START - 2 * H, terminal: false,
  });
  checar("caso3: 2o no-show (tentativas 1, call reagendada) -> 'perdido_2o_noshow'", r?.acao === 'perdido_2o_noshow');
  checar("caso3: motivo === '2º no-show'", r?.motivo === '2º no-show');
}

// ---- Caso 4: tentativas 1, silencio 49h desde ultima_recuperacao -> 'perdido_48h' ----
{
  const r = decidirNoShow({
    callStartMs: CALL_START, nowMs: CALL_START + 49 * H,
    leadRespondeuAposCall: false, tentativas: 1, ultimaRecuperacaoMs: CALL_START, terminal: false,
  });
  checar("caso4: silencio 49h desde ultima_recuperacao -> 'perdido_48h'", r?.acao === 'perdido_48h');
  checar("caso4: motivo === '48h sem resposta'", r?.motivo === '48h sem resposta');
}

// ---- Caso 5: tentativas 1, silencio 47h -> 'nada' (ainda dentro do prazo) ----
{
  const r = decidirNoShow({
    callStartMs: CALL_START, nowMs: CALL_START + 47 * H,
    leadRespondeuAposCall: false, tentativas: 1, ultimaRecuperacaoMs: CALL_START, terminal: false,
  });
  checar("caso5: silencio 47h -> 'nada' (ainda dentro do prazo de 48h)", r?.acao === 'nada');
}

// ---- Caso 6: leadRespondeuAposCall true -> 'nada' ----
{
  const r = decidirNoShow({
    callStartMs: CALL_START, nowMs: CALL_START + 20 * MIN,
    leadRespondeuAposCall: true, tentativas: 0, ultimaRecuperacaoMs: null, terminal: false,
  });
  checar("caso6: leadRespondeuAposCall true -> 'nada' (lead engajou, nao e no-show)", r?.acao === 'nada');
}

// ---- Caso 7: terminal true -> 'nada' (loop encerrado, sem reabrir) ----
{
  const r = decidirNoShow({
    callStartMs: CALL_START, nowMs: CALL_START + 20 * MIN,
    leadRespondeuAposCall: false, tentativas: 2, ultimaRecuperacaoMs: CALL_START, terminal: true,
  });
  checar("caso7: terminal true -> 'nada' (loop encerrado, sem reabrir)", r?.acao === 'nada');
}

// ---- Caso 8: callStart NaN -> 'nada' (fail-safe) ----
{
  const r = decidirNoShow({
    callStartMs: NaN, nowMs: CALL_START,
    leadRespondeuAposCall: false, tentativas: 0, ultimaRecuperacaoMs: null, terminal: false,
  });
  checar("caso8: callStart NaN -> 'nada' (fail-safe, nunca move card por engano)", r?.acao === 'nada');
}

// ---------------------------------------------------------------------
// 2. Asserts de FONTE (presenca + ORDEM) do despacho de acoes reais
// (dispararRecuperacaoNoShow/processarNoShows — Task 2). Ver nota de topo
// do arquivo sobre a escolha por source-read em vez de extracao AsyncFunction.
// ---------------------------------------------------------------------
checar(
  "no-show.ts importa movePipelineStage de './tools/move-pipeline-stage'",
  /import\s*\{\s*movePipelineStage\s*\}\s*from\s*['"]\.\/tools\/move-pipeline-stage['"]/.test(src),
);
checar(
  "no-show.ts importa createTask de './tools/create-task'",
  /import\s*\{\s*createTask\s*\}\s*from\s*['"]\.\/tools\/create-task['"]/.test(src),
);
checar(
  "no-show.ts importa camilaAgent de './agents/camila'",
  /import\s*\{\s*camilaAgent\s*\}\s*from\s*['"]\.\/agents\/camila['"]/.test(src),
);
checar(
  "no-show.ts importa despacharSaidaCamila de './index' (import circular deliberado, mesmo padrao de dupla-acao.ts)",
  /import\s*\{[^}]*despacharSaidaCamila[^}]*\}\s*from\s*['"]\.\/index['"]/.test(src),
);
checar(
  "no-show.ts importa getSessao de './sessao' e estaBloqueado de './bloqueio' (guarda de crise)",
  /from\s*['"]\.\/sessao['"]/.test(src) && /from\s*['"]\.\/bloqueio['"]/.test(src),
);
checar(
  "no-show.ts importa buscarCallsParaNoShow/registrarNoShowRecuperacao/marcarCallTerminal de './supabase'",
  /buscarCallsParaNoShow/.test(src) && /registrarNoShowRecuperacao/.test(src) && /marcarCallTerminal/.test(src),
);

const fnRecuperacaoMatch = src.match(
  /export async function dispararRecuperacaoNoShow\([\s\S]*?\n\}/,
);
checar('funcao dispararRecuperacaoNoShow encontrada em no-show.ts', !!fnRecuperacaoMatch);
if (fnRecuperacaoMatch) {
  const corpo = fnRecuperacaoMatch[0];
  const idxMoveNoShow = corpo.search(/movePipelineStage\.execute![\s\S]{0,80}NO_SHOW/);
  const idxCreateTask = corpo.indexOf('createTask.execute!(');
  const idxDespacha = corpo.indexOf('despacharSaidaCamila(');
  checar('dispararRecuperacaoNoShow move o card pra NO_SHOW (movePipelineStage.execute!)', idxMoveNoShow !== -1);
  checar('dispararRecuperacaoNoShow cria a task pro SDR humano (createTask.execute!)', idxCreateTask !== -1);
  checar('dispararRecuperacaoNoShow despacha a mensagem natural da Camila (despacharSaidaCamila)', idxDespacha !== -1);
  checar(
    'dispararRecuperacaoNoShow captura retorno real (nao presume sucesso) — declara { moveOk',
    /\{\s*moveOk/.test(corpo),
  );
  checar(
    'marcador [no-show][SEM-SINAL] presente pra falha total (T-02-07, mesmo padrao honesto de escalate-to-human.ts)',
    /\[no-show\]\[SEM-SINAL\]/.test(corpo),
  );
}

const fnProcessarMatch = src.match(
  /export async function processarNoShows\([\s\S]*?\n\}/,
);
checar('funcao processarNoShows encontrada em no-show.ts', !!fnProcessarMatch);
// CR-05: a guarda de crise e a DURAVEL (leadEmPausaDuravel) — alem de
// sessao ('humano') e estaBloqueado, consulta a conversa aberta
// 'aguardando_humano' SEM janela de tempo (sobrevive a restart + >24h de
// silencio, mesmo padrao do webhook do formulario em index.ts).
const fnPausaMatch = src.match(
  /export async function leadEmPausaDuravel\([\s\S]*?\n\}/,
);
checar('CR-05: funcao leadEmPausaDuravel encontrada em no-show.ts (guarda de crise duravel compartilhada)', !!fnPausaMatch);
if (fnPausaMatch) {
  const corpoPausa = fnPausaMatch[0];
  checar("CR-05: leadEmPausaDuravel checa agenteAtual === 'humano' (sessao)", /agenteAtual[^;\n]*['"]humano['"]/.test(corpoPausa));
  checar('CR-05: leadEmPausaDuravel checa estaBloqueado(...)', corpoPausa.indexOf('estaBloqueado(') !== -1);
  checar('CR-05: leadEmPausaDuravel consulta o sinal DURAVEL buscarConversaAguardandoHumano(...) (sem janela de 24h)', corpoPausa.indexOf('buscarConversaAguardandoHumano(') !== -1);
  checar('CR-05: leadEmPausaDuravel resolve customer por telefone quando row.customer_id e null (mesma sequencia do index.ts)', corpoPausa.indexOf('buscarCustomerPorTelefone(') !== -1);
}

if (fnProcessarMatch) {
  const corpo = fnProcessarMatch[0];

  const idxGuardaCrise = corpo.indexOf('leadEmPausaDuravel(');
  const idxContinueGuarda = corpo.indexOf('continue', Math.max(idxGuardaCrise, 0));
  const idxDispararRecuperacao = corpo.indexOf('dispararRecuperacaoNoShow(');
  const idxMovePerdido = corpo.search(/movePipelineStage\.execute![\s\S]{0,80}PERDIDO/);

  checar('processarNoShows usa a guarda de crise duravel leadEmPausaDuravel(...) (T-02-06 + CR-05)', idxGuardaCrise !== -1);
  checar('processarNoShows tem um "continue" apos a guarda de crise (pula o lead, nao so loga)', idxContinueGuarda !== -1);

  if (idxGuardaCrise !== -1 && idxDispararRecuperacao !== -1) {
    checar(
      'T-02-06: guarda de crise precede a chamada de recuperacao (dispararRecuperacaoNoShow) — nao move/manda mensagem antes de checar crise',
      idxGuardaCrise < idxDispararRecuperacao,
    );
  }
  if (idxGuardaCrise !== -1 && idxMovePerdido !== -1) {
    checar(
      'T-02-06: guarda de crise precede o move pra PERDIDO — nao move o card antes de checar crise',
      idxGuardaCrise < idxMovePerdido,
    );
  }

  // WR-02: sinal de resposta do lead vem do CUSTOMER (todas as conversas),
  // nao so da conversa congelada em row.conversation_id.
  const idxUltimaMsgCustomer = corpo.indexOf('buscarUltimaMsgLeadDoCustomer(');
  checar('WR-02: processarNoShows deriva leadRespondeuAposCall via buscarUltimaMsgLeadDoCustomer (customer inteiro, nao conversa congelada)', idxUltimaMsgCustomer !== -1);
  checar('WR-02: embed da conversa congelada permanece apenas como fallback', corpo.indexOf('auton_sdr_conversations?.last_lead_message_at') !== -1);

  // CR-06: lead que respondeu depois da call fecha a row como 'realizada'
  // (status transiciona — a janela de 200 rows nao starva com rows zumbis).
  checar('CR-06: processarNoShows fecha a row como realizada quando o lead respondeu apos a call (marcarCallRealizada)',
    /if\s*\(leadRespondeuAposCall[\s\S]{0,250}?marcarCallRealizada\(/.test(corpo));

  // CR-02: a tentativa de recuperacao (e o relogio de 48h) SO e registrada
  // quando o canal visivel ao lead confirmou (camilaOk) — falha total NAO
  // queima a unica recuperacao permitida.
  const idxResultado = corpo.search(/const resultado = await dispararRecuperacaoNoShow\(/);
  const idxCamilaOk = corpo.search(/if\s*\(\s*resultado\.camilaOk\s*\)/);
  const idxRegistrar = corpo.indexOf('registrarNoShowRecuperacao(');
  checar('CR-02: processarNoShows captura o retorno honesto de dispararRecuperacaoNoShow (const resultado = await ...)', idxResultado !== -1);
  checar('CR-02: processarNoShows checa resultado.camilaOk antes de registrar a tentativa', idxCamilaOk !== -1);
  if (idxCamilaOk !== -1 && idxRegistrar !== -1) {
    checar(
      'CR-02: registrarNoShowRecuperacao so ocorre DEPOIS da checagem de camilaOk (sem registro em falha total)',
      idxCamilaOk < idxRegistrar,
    );
  }
  // CR-02 (retry cap): backoff in-memory evita re-disparo da recuperacao a
  // cada tick de 60s quando a Camila esta permanentemente quebrada.
  checar('CR-02: backoff de retry presente (proximaTentativaRecuperacao.set em falha)', corpo.indexOf('proximaTentativaRecuperacao.set(') !== -1);
  checar('CR-02: backoff consultado antes de re-disparar (proximaTentativaRecuperacao.get)', corpo.indexOf('proximaTentativaRecuperacao.get(') !== -1);

  checar('processarNoShows move o card pra PERDIDO no caminho terminal (movePipelineStage.execute!)', idxMovePerdido !== -1);

  const idxMarcarTerminal = corpo.indexOf('marcarCallTerminal(');
  const idxMoveSucesso = corpo.search(/moveResult\??\.sucesso/);
  checar('processarNoShows chama marcarCallTerminal(...) no caminho Perdido', idxMarcarTerminal !== -1);
  checar('processarNoShows verifica moveResult?.sucesso antes de decidir se marca terminal', idxMoveSucesso !== -1);
  if (idxMoveSucesso !== -1 && idxMarcarTerminal !== -1) {
    checar(
      'T-02-07: marcarCallTerminal so e chamado DEPOIS de checar moveResult?.sucesso (nao marca terminal sem move confirmado)',
      idxMoveSucesso < idxMarcarTerminal,
    );
  }

  // WR-03: o encerramento automatico (Perdido) e um proxy fraco e
  // irreversivel — cria task pro SDR humano VALIDAR antes de descartar.
  const idxTaskValidacao = corpo.indexOf('createTask.execute!');
  checar('WR-03: caminho terminal cria task de validacao pro SDR humano (createTask.execute!)', idxTaskValidacao !== -1);
  if (idxTaskValidacao !== -1 && idxMovePerdido !== -1 && idxMarcarTerminal !== -1) {
    checar(
      'WR-03: task de validacao criada apos o move confirmado e antes de marcar terminal',
      idxMovePerdido < idxTaskValidacao && idxTaskValidacao < idxMarcarTerminal,
    );
  }

  checar(
    'marcador [no-show][SEM-SINAL] presente no caminho de falha do move pra PERDIDO',
    /\[no-show\]\[SEM-SINAL\]/.test(corpo),
  );
  checar(
    'processarNoShows repassa decisao.motivo pro marcarCallTerminal (motivo correto por ramificacao)',
    /marcarCallTerminal\([^)]*decisao\.motivo/.test(corpo),
  );
}

// ---------------------------------------------------------------------
// 3. Asserts de FONTE em supabase.ts — transicoes de status (CR-06) e
// escritas honestas (WR-01: PATCH checa res.ok e retorna boolean).
// ---------------------------------------------------------------------
const supabasePath = resolve(projectRoot, 'src/mastra/supabase.ts');
const supabaseSrc = await readFile(supabasePath, 'utf8').catch(() => null);
checar('supabase.ts encontrado', supabaseSrc !== null);
if (supabaseSrc !== null) {
  const fnTerminal = supabaseSrc.match(/export async function marcarCallTerminal\([\s\S]*?\n\}/);
  checar('funcao marcarCallTerminal encontrada em supabase.ts', !!fnTerminal);
  if (fnTerminal) {
    checar("CR-06: marcarCallTerminal transiciona status: 'no_show' (row sai das varreduras status=eq.agendada)", /status:\s*'no_show'/.test(fnTerminal[0]));
    checar('WR-01: marcarCallTerminal checa res.ok (PATCH perdido nao e silencioso)', /res\.ok/.test(fnTerminal[0]));
  }

  const fnRealizada = supabaseSrc.match(/export async function marcarCallRealizada\([\s\S]*?\n\}/);
  checar('CR-06: funcao marcarCallRealizada encontrada em supabase.ts', !!fnRealizada);
  if (fnRealizada) {
    checar("CR-06: marcarCallRealizada transiciona status: 'realizada'", /status:\s*'realizada'/.test(fnRealizada[0]));
    checar('WR-01: marcarCallRealizada checa res.ok', /res\.ok/.test(fnRealizada[0]));
  }

  const fnRegistrar = supabaseSrc.match(/export async function registrarNoShowRecuperacao\([\s\S]*?\n\}/);
  checar('funcao registrarNoShowRecuperacao encontrada em supabase.ts', !!fnRegistrar);
  if (fnRegistrar) {
    checar('WR-01: registrarNoShowRecuperacao checa res.ok e retorna boolean', /res\.ok/.test(fnRegistrar[0]) && /Promise<boolean>/.test(fnRegistrar[0]));
  }

  const fnMarcarEnviado = supabaseSrc.match(/export async function marcarLembreteEnviado\([\s\S]*?\n\}/);
  checar('funcao marcarLembreteEnviado encontrada em supabase.ts', !!fnMarcarEnviado);
  if (fnMarcarEnviado) {
    checar('WR-01: marcarLembreteEnviado checa res.ok e retorna boolean', /res\.ok/.test(fnMarcarEnviado[0]) && /Promise<boolean>/.test(fnMarcarEnviado[0]));
  }
}

// CR-03: o canal de envio reporta sucesso HONESTO — enviarMensagem retorna
// Promise<boolean> e enviarMensagemUnica propaga !res.ok como false (sem
// isso, toques/confirmacoes eram marcados como entregues com GHL fora do ar).
const ghlPath = resolve(projectRoot, 'src/mastra/ghl.ts');
const ghlSrc = await readFile(ghlPath, 'utf8').catch(() => null);
checar('ghl.ts encontrado', ghlSrc !== null);
if (ghlSrc !== null) {
  checar('CR-03: enviarMensagem retorna Promise<boolean> (entrega confirmada, nao void)',
    /export async function enviarMensagem\([\s\S]{0,400}?\)\s*:\s*Promise<boolean>/.test(ghlSrc));
  const fnUnica = ghlSrc.match(/async function enviarMensagemUnica\([\s\S]*?\n\}/);
  checar('funcao enviarMensagemUnica encontrada em ghl.ts', !!fnUnica);
  if (fnUnica) {
    checar('CR-03: enviarMensagemUnica retorna false quando !res.ok (falha GHL nao vira sucesso)',
      /if\s*\(!res\.ok\)\s*\{[\s\S]*?return false/.test(fnUnica[0]) && /return true/.test(fnUnica[0]));
  }
}

if (falhas.length > 0) {
  console.error('[smoke-no-show] FUN-03/FUN-04 FALHOU:');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('[smoke-no-show] FUN-03/FUN-04 OK');
