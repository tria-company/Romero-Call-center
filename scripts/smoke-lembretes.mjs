// Smoke de TOOL-08/FUN-02 (lembretes de call): prova a funcao pura
// `proximoLembreteDevido` em src/mastra/lembretes.ts — decide qual toque
// temporizado (D-1/H-1/5min) esta devido AGORA com base no call_start_at e
// nos flags *_sent_at ja enviados, na ORDEM correta de urgencia (m5 > h1 > d1),
// sem nunca disparar apos a call ja ter comecado nem reenviar um toque ja
// marcado.
//
// Mesma limitacao/solucao documentada em scripts/smoke-starttime-validacao.mjs:
// o loader nativo de TS do Node (--experimental-strip-types) NAO resolve os
// imports relativos sem extensao de lembretes.ts ('./supabase', './sessao',
// './bloqueio', './ghl', './tools/schedule-reminder') — so o bundler do
// Mastra (esbuild) resolve isso. Solucao: extrai o CORPO REAL da funcao
// exportada `proximoLembreteDevido` do arquivo fonte e executa via
// `new Function` — prova o comportamento real (nao duplica a logica a mao
// num segundo lugar que pode divergir do codigo de producao).

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const arquivoPath = resolve(projectRoot, 'src/mastra/lembretes.ts');

const src = await readFile(arquivoPath, 'utf8').catch(() => null);
if (src === null) {
  console.error(`[smoke-lembretes] TOOL-08/FUN-02 FALHOU: arquivo nao encontrado (${arquivoPath})`);
  process.exit(1);
}

const match = src.match(
  /export function proximoLembreteDevido\([\s\S]*?\)\s*:\s*'d1'\s*\|\s*'h1'\s*\|\s*'m5'\s*\|\s*null\s*\{([\s\S]*?)\n\}/,
);
if (!match) {
  console.error('[smoke-lembretes] TOOL-08/FUN-02 FALHOU: funcao proximoLembreteDevido nao encontrada (ou assinatura mudou) em lembretes.ts');
  process.exit(1);
}

const proximoLembreteDevido = new Function('callStartMs', 'nowMs', 'sent', match[1]);

const falhas = [];
function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

const CALL_START = new Date('2026-07-20T14:00:00Z').getTime();
const H = 60 * 60 * 1000;
const MIN = 60 * 1000;
const NADA = { d1: false, h1: false, m5: false };

// ---- Caso 1: 25h antes, nada enviado -> null (fora da janela D-1) ----
checar(
  'caso1: 25h antes, nada enviado -> null (fora da janela D-1)',
  proximoLembreteDevido(CALL_START, CALL_START - 25 * H, NADA) === null,
);

// ---- Caso 2: exatamente 24h antes -> 'd1' ----
checar(
  "caso2: exatamente 24h antes -> 'd1'",
  proximoLembreteDevido(CALL_START, CALL_START - 24 * H, NADA) === 'd1',
);

// ---- Caso 3: 30min antes, d1 ja enviado -> 'h1' ----
checar(
  "caso3: 30min antes com d1 ja enviado -> 'h1'",
  proximoLembreteDevido(CALL_START, CALL_START - 30 * MIN, { d1: true, h1: false, m5: false }) === 'h1',
);

// ---- Caso 4: 2min antes, h1 enviado -> 'm5' ----
checar(
  "caso4: 2min antes com h1 enviado -> 'm5'",
  proximoLembreteDevido(CALL_START, CALL_START - 2 * MIN, { d1: true, h1: true, m5: false }) === 'm5',
);

// ---- Caso 5: 5min antes, todos ja enviados -> null (anti-reenvio) ----
checar(
  'caso5: 5min antes com todos os toques ja enviados -> null (anti-reenvio)',
  proximoLembreteDevido(CALL_START, CALL_START - 5 * MIN, { d1: true, h1: true, m5: true }) === null,
);

// ---- Caso 6: 10min DEPOIS do call_start -> null (call ja comecou) ----
checar(
  'caso6: 10min depois do call_start -> null (call ja comecou, vira assunto do loop de no-show)',
  proximoLembreteDevido(CALL_START, CALL_START + 10 * MIN, NADA) === null,
);

// ---- Caso 7: row criada tarde (20min antes, d1 nunca enviado) -> 'h1', NAO 'd1' (sem toque stale) ----
checar(
  "caso7: row criada tarde (20min antes, d1 nunca enviado) -> 'h1' (nao dispara toque stale 'd1')",
  proximoLembreteDevido(CALL_START, CALL_START - 20 * MIN, NADA) === 'h1',
);

// ---- Caso 8: callStart invalido (NaN) -> null ----
checar(
  'caso8: callStart invalido (NaN) -> null',
  proximoLembreteDevido(NaN, CALL_START, NADA) === null,
);

// ---------------------------------------------------------------------
// WR-05: prova COMPORTAMENTAL de diaRelativoSaoPaulo — o texto do toque D-1
// deriva do DIA REAL da call no fuso America/Sao_Paulo ("hoje"/"amanhã"),
// nao do offset nominal de 24h (call criada com <24h de antecedencia dispara
// o d1 no MESMO dia — dizer "amanhã" estaria errado).
// ---------------------------------------------------------------------
const matchDia = src.match(
  /export function diaRelativoSaoPaulo\([\s\S]*?\)\s*:\s*'hoje'\s*\|\s*'amanha'\s*\|\s*'outro'\s*\{([\s\S]*?)\n\}/,
);
if (!matchDia) {
  console.error('[smoke-lembretes] WR-05 FALHOU: funcao diaRelativoSaoPaulo nao encontrada (ou assinatura mudou) em lembretes.ts');
  process.exit(1);
}
const diaRelativoSaoPaulo = new Function('callStartMs', 'nowMs', matchDia[1]);

// 2026-07-20T15:00:00Z = 20/07 12:00 em Sao Paulo (UTC-3).
const AGORA_SP_MEIO_DIA = new Date('2026-07-20T15:00:00Z').getTime();
checar(
  "wr05-a: call 2h a frente (mesmo dia SP) -> 'hoje'",
  diaRelativoSaoPaulo(AGORA_SP_MEIO_DIA + 2 * H, AGORA_SP_MEIO_DIA) === 'hoje',
);
checar(
  "wr05-b: call 24h a frente -> 'amanha'",
  diaRelativoSaoPaulo(AGORA_SP_MEIO_DIA + 24 * H, AGORA_SP_MEIO_DIA) === 'amanha',
);
checar(
  "wr05-c: call 72h a frente -> 'outro'",
  diaRelativoSaoPaulo(AGORA_SP_MEIO_DIA + 72 * H, AGORA_SP_MEIO_DIA) === 'outro',
);
// Timezone-aware: 2026-07-21T02:00:00Z ainda e 20/07 23:00 em SP -> 'hoje'
// (em UTC ja seria dia 21 — prova que a comparacao usa America/Sao_Paulo).
checar(
  "wr05-d: call 21/07 02:00 UTC (= 20/07 23:00 SP) com agora 20/07 12:00 SP -> 'hoje' (fuso SP, nao UTC)",
  diaRelativoSaoPaulo(new Date('2026-07-21T02:00:00Z').getTime(), AGORA_SP_MEIO_DIA) === 'hoje',
);

// WR-05 (fonte): mensagemToque recebe callStartMs/nowMs e usa o dia real
// (diaRelativoSaoPaulo) no d1 e o tempo restante real no h1.
const fnToqueMatch = src.match(/function mensagemToque\([\s\S]*?\n\}/);
checar('funcao mensagemToque encontrada em lembretes.ts', !!fnToqueMatch);
if (fnToqueMatch) {
  const corpoToque = fnToqueMatch[0];
  checar('WR-05: mensagemToque recebe callStartMs e nowMs (texto derivado de dados, nao do offset nominal)',
    /callStartMs/.test(corpoToque) && /nowMs/.test(corpoToque));
  checar('WR-05: toque d1 escolhe hoje/amanhã via diaRelativoSaoPaulo', /diaRelativoSaoPaulo\(/.test(corpoToque));
  checar('WR-05: toque h1 calcula o tempo restante real (callStartMs - nowMs)', /callStartMs\s*-\s*nowMs/.test(corpoToque));
}

// ---------------------------------------------------------------------
// CR-03/CR-04/CR-05: asserts de FONTE em processarLembretes /
// iniciarLembretesScheduler (mesmo molde de smoke-no-show.mjs).
// ---------------------------------------------------------------------
const fnProcessarLembretes = src.match(/export async function processarLembretes\([\s\S]*?\n\}/);
checar('funcao processarLembretes encontrada em lembretes.ts', !!fnProcessarLembretes);
if (fnProcessarLembretes) {
  const corpo = fnProcessarLembretes[0];

  // CR-03: envio HONESTO — captura o boolean de enviarMensagem e so marca
  // *_sent_at quando entregue (o `continue` do !entregue precede o marcar).
  const idxEntregue = corpo.search(/const entregue = await enviarMensagem\(/);
  const idxSeNaoEntregue = corpo.search(/if\s*\(\s*!entregue\s*\)/);
  const idxMarcar = corpo.indexOf('marcarLembreteEnviado(');
  checar('CR-03: processarLembretes captura o retorno de enviarMensagem (const entregue = await ...)', idxEntregue !== -1);
  checar('CR-03: processarLembretes checa !entregue (sem confirmacao NAO marca o toque)', idxSeNaoEntregue !== -1);
  checar('CR-03: checagem de entrega precede marcarLembreteEnviado (gate so apos entrega confirmada)',
    idxSeNaoEntregue !== -1 && idxMarcar !== -1 && idxSeNaoEntregue < idxMarcar);

  // WR-01: o resultado de marcarLembreteEnviado tambem e checado (PATCH
  // perdido = reenvio em loop — precisa no minimo logar alto).
  checar('WR-01: processarLembretes checa o boolean de marcarLembreteEnviado', /const marcado = await marcarLembreteEnviado\(/.test(corpo) && /if\s*\(\s*!marcado\s*\)/.test(corpo));

  // CR-05: guarda de crise DURAVEL (leadEmPausaDuravel) antes de qualquer envio.
  const idxPausa = corpo.indexOf('leadEmPausaDuravel(');
  checar('CR-05: processarLembretes usa leadEmPausaDuravel (sinal duravel aguardando_humano, nao so sessao/bloqueio)', idxPausa !== -1);
  checar('CR-05: guarda de crise precede o envio do toque', idxPausa !== -1 && idxEntregue !== -1 && idxPausa < idxEntregue);
}
checar(
  "CR-05: lembretes.ts importa leadEmPausaDuravel de './no-show'",
  /import\s*\{[^}]*leadEmPausaDuravel[^}]*\}\s*from\s*['"]\.\/no-show['"]/.test(src),
);

// CR-04: mutex de reentrancia no scheduler — um tick de 60s nunca sobrepoe
// o anterior (recuperacao de no-show pode levar minutos).
const fnScheduler = src.match(/export function iniciarLembretesScheduler\([\s\S]*?\n\}/);
checar('funcao iniciarLembretesScheduler encontrada em lembretes.ts', !!fnScheduler);
if (fnScheduler) {
  const corpo = fnScheduler[0];
  checar('CR-04: flag de reentrancia declarada (let tickEmExecucao = false)', /let tickEmExecucao = false/.test(corpo));
  checar('CR-04: tick novo aborta se o anterior ainda roda (if (tickEmExecucao) return)', /if\s*\(\s*tickEmExecucao\s*\)\s*return/.test(corpo));
  checar('CR-04: flag liberada em finally (nao trava o scheduler apos erro)', /finally\s*\{[\s\S]*?tickEmExecucao = false/.test(corpo));
  checar('CR-04: processarLembretes/processarNoShows sao AGUARDADOS dentro do tick (await — sem fire-and-forget que furaria o mutex)',
    /await processarLembretes\(/.test(corpo) && /await processarNoShows\(/.test(corpo));
}

// ---------------------------------------------------------------------
// CR-01: a persistencia inteira da fase depende do upsert on_conflict=telefone
// conseguir INFERIR um index unico NAO-parcial — Postgres nao infere index
// parcial via PostgREST (42P10 em todo insert; fase inerte). Prova por fonte
// na migration 07 + supabase.ts.
// ---------------------------------------------------------------------
const sqlPath = resolve(projectRoot, 'docs/sql/auton_sdr/07_call_reminders.sql');
const sql = await readFile(sqlPath, 'utf8').catch(() => null);
checar('migration 07_call_reminders.sql encontrada', sql !== null);
if (sql !== null) {
  const stmtUnique = sql.match(/CREATE UNIQUE INDEX IF NOT EXISTS uq_call_reminders_telefone[\s\S]*?;/);
  checar('CR-01: migration 07 cria o index unico CHEIO uq_call_reminders_telefone (telefone)', !!stmtUnique);
  checar('CR-01: o index unico de telefone NAO e parcial (sem WHERE — senao ON CONFLICT(telefone) nao infere, 42P10)',
    !!stmtUnique && !/WHERE/i.test(stmtUnique[0]));
  checar('CR-01: migration 07 dropa o antigo index parcial uq_call_reminders_ativo (bancos que ja rodaram a versao antiga)',
    /DROP INDEX IF EXISTS uq_call_reminders_ativo/.test(sql));

  const supabasePath = resolve(projectRoot, 'src/mastra/supabase.ts');
  const supabaseSrc = await readFile(supabasePath, 'utf8').catch(() => null);
  checar('supabase.ts encontrado', supabaseSrc !== null);
  if (supabaseSrc !== null) {
    checar('CR-01: upsertLembreteCall usa on_conflict=telefone (mesma chave do index unico da migration)',
      /auton_sdr_call_reminders\?on_conflict=telefone/.test(supabaseSrc));
    // CR-06 (defesa em profundidade): a varredura de lembretes filtra
    // terminal=false e limita a janela temporal (nao starva o limit=200).
    const fnPendentes = supabaseSrc.match(/export async function buscarLembretesPendentes\([\s\S]*?\n\}/);
    checar('funcao buscarLembretesPendentes encontrada em supabase.ts', !!fnPendentes);
    if (fnPendentes) {
      checar('CR-06: buscarLembretesPendentes filtra terminal=eq.false', /terminal=eq\.false/.test(fnPendentes[0]));
      checar('CR-06: buscarLembretesPendentes limita a janela temporal (call_start_at=gte)', /call_start_at=gte\./.test(fnPendentes[0]));
    }
    // WR-04: reschedule reabre o loop de no-show (terminal=false no upsert).
    // O objeto de parametros de upsertLembreteCall fecha com `}` em coluna 0,
    // entao a extracao ancora DEPOIS da anotacao de retorno (Promise<...>).
    const fnUpsert = supabaseSrc.match(/export async function upsertLembreteCall\([\s\S]*?Promise<[^>]*>\s*\{[\s\S]*?\n\}/);
    checar('funcao upsertLembreteCall encontrada em supabase.ts', !!fnUpsert);
    if (fnUpsert) {
      checar('WR-04: upsert de reschedule reseta terminal: false', /terminal:\s*false/.test(fnUpsert[0]));
      checar('WR-04: upsert de reschedule reseta motivo_terminal: null', /motivo_terminal:\s*null/.test(fnUpsert[0]));
    }
  }
}

if (falhas.length > 0) {
  console.error('[smoke-lembretes] TOOL-08/FUN-02 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-lembretes] TOOL-08/FUN-02 OK');
