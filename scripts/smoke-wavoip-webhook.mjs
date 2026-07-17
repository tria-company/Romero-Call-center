// Smoke do webhook Wavoip (rastreador de ligacao) — prova por LEITURA DE FONTE
// (mesmo molde de smoke-gravacao-webhook.mjs) que /api/webhook/wavoip:
//   (a) autentica (WAVOIP_WEBHOOK_TOKEN, fail-closed) ANTES de qualquer efeito
//       colateral (correlacao, move de card, download/transcricao/nota);
//   (b) no RECORD, so persiste (nota + campo) DEPOIS do gate `.ok` da
//       anonimizacao (LGPD) — bruto nunca persiste nem loga;
//   (c) mapeia atendeu (status terminal + duration>0) e usa o guard
//       anti-regressao de stage (GHL_STAGES_NAO_REBAIXAR_CALL).
//
// As asserts comparam INDICES de string (.indexOf) pra provar ORDEM de codigo,
// nao so presenca.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const indexSrc = await readFile(resolve(projectRoot, 'src/mastra/index.ts'), 'utf8').catch(() => null);
const ghlSrc = await readFile(resolve(projectRoot, 'src/mastra/ghl.ts'), 'utf8').catch(() => null);
const configSrc = await readFile(resolve(projectRoot, 'src/mastra/config.ts'), 'utf8').catch(() => null);
const supabaseSrc = await readFile(resolve(projectRoot, 'src/mastra/supabase.ts'), 'utf8').catch(() => null);

const falhas = [];
const checar = (d, c) => { if (!c) falhas.push(d); };

for (const [nome, src] of [['index.ts', indexSrc], ['ghl.ts', ghlSrc], ['config.ts', configSrc], ['supabase.ts', supabaseSrc]]) {
  if (src === null) { console.error(`[smoke-wavoip-webhook] FALHOU: ${nome} nao encontrado`); process.exit(1); }
}

// ---------------------------------------------------------------------
// config.ts: token fail-closed, stage CALL_REALIZADA, campo atendeu, guard.
// ---------------------------------------------------------------------
checar(
  "config.ts exporta WAVOIP_WEBHOOK_TOKEN (process.env.WAVOIP_WEBHOOK_TOKEN || '')",
  /export const WAVOIP_WEBHOOK_TOKEN\s*=\s*process\.env\.WAVOIP_WEBHOOK_TOKEN\s*\|\|\s*''/.test(configSrc),
);
checar(
  'config.ts avisa (console.warn) quando WAVOIP_WEBHOOK_TOKEN vazio (fail-closed)',
  /if\s*\(!WAVOIP_WEBHOOK_TOKEN\)\s*\{[\s\S]{0,400}?console\.warn/.test(configSrc),
);
checar('config.ts adiciona CALL_REALIZADA em GHL_STAGES', /CALL_REALIZADA:\s*'39afb559-afb7-421f-b716-da5c940e6714'/.test(configSrc));
checar('config.ts exporta GHL_OPP_ATENDEU_FIELD_ID', /export const GHL_OPP_ATENDEU_FIELD_ID\s*=/.test(configSrc));
checar('config.ts exporta GHL_OPP_ATENDEU_FIELD_KEY', /export const GHL_OPP_ATENDEU_FIELD_KEY\s*=/.test(configSrc));
checar(
  'config.ts exporta GHL_STAGES_NAO_REBAIXAR_CALL (guard anti-regressao) incluindo CALL_REALIZADA/GANHO/PERDIDO',
  /export const GHL_STAGES_NAO_REBAIXAR_CALL\s*=/.test(configSrc) &&
    /GHL_STAGES\.CALL_REALIZADA/.test(configSrc) && /GHL_STAGES\.GANHO/.test(configSrc) && /GHL_STAGES\.PERDIDO/.test(configSrc),
);

// ---------------------------------------------------------------------
// supabase.ts: correlacao whatsapp_call_id -> telefone.
// ---------------------------------------------------------------------
checar('supabase.ts exporta salvarWavoipCall', /export async function salvarWavoipCall\(/.test(supabaseSrc));
checar('supabase.ts exporta buscarTelefonePorWavoipCall', /export async function buscarTelefonePorWavoipCall\(/.test(supabaseSrc));
checar('supabase.ts usa a tabela auton_sdr_wavoip_calls', supabaseSrc.includes('auton_sdr_wavoip_calls'));

// ---------------------------------------------------------------------
// ghl.ts: update de oportunidade (campo + stage com guard) e nota.
// ---------------------------------------------------------------------
checar('ghl.ts exporta atualizarOportunidadeCall', /export async function atualizarOportunidadeCall\(/.test(ghlSrc));
checar('ghl.ts exporta registrarNotaObservacao', /export async function registrarNotaObservacao\(/.test(ghlSrc));
checar('ghl.ts importa GHL_STAGES_NAO_REBAIXAR_CALL / GHL_OPP_ATENDEU_FIELD_ID do config', /GHL_STAGES_NAO_REBAIXAR_CALL/.test(ghlSrc) && /GHL_OPP_ATENDEU_FIELD_ID/.test(ghlSrc));

const fnUpdate = ghlSrc.match(/export async function atualizarOportunidadeCall\([\s\S]*?\n\}/);
checar('atualizarOportunidadeCall encontrada em ghl.ts', !!fnUpdate);
if (fnUpdate) {
  const corpo = fnUpdate[0];
  checar("atualizarOportunidadeCall grava field_value 'Sim'/'Não' (campo atendeu)", /field_value:\s*atendeu\s*\?\s*'Sim'\s*:\s*'Não'/.test(corpo));
  checar('atualizarOportunidadeCall aplica o guard GHL_STAGES_NAO_REBAIXAR_CALL antes de mover', corpo.indexOf('GHL_STAGES_NAO_REBAIXAR_CALL') !== -1);
  checar('atualizarOportunidadeCall so seta pipelineStageId=CALL_REALIZADA quando vaiMover', /if\s*\(vaiMover\)/.test(corpo) && /GHL_STAGES\.CALL_REALIZADA/.test(corpo));
  checar('atualizarOportunidadeCall usa Version V2 (GHL_API_VERSION_V2) no PUT', corpo.indexOf('GHL_API_VERSION_V2') !== -1);
}

const fnNota = ghlSrc.match(/export async function registrarNotaObservacao\([\s\S]*?\n\}/);
checar('registrarNotaObservacao encontrada em ghl.ts', !!fnNota);
if (fnNota) {
  const corpo = fnNota[0];
  checar('registrarNotaObservacao faz POST em /contacts/${contactId}/notes', /\/contacts\/\$\{contactId\}\/notes/.test(corpo));
  // LGPD: nunca loga o corpo da nota — so o tamanho (corpo.length).
  const semLength = corpo.replace(/corpo\.length/g, '');
  checar('registrarNotaObservacao NUNCA loga o conteudo da nota (so corpo.length)', !/console\.(log|error|warn)\([^)]*\bcorpo\b/.test(semLength));
}

// ---------------------------------------------------------------------
// index.ts: rota, auth-antes-de-efeito, gate anonimizacao, dedup, mapping.
// ---------------------------------------------------------------------
checar("index.ts importa WAVOIP_WEBHOOK_TOKEN de './config'", /import\s*\{\s*WAVOIP_WEBHOOK_TOKEN\s*\}\s*from\s*['"]\.\/config['"]/.test(indexSrc));
checar('index.ts importa atualizarOportunidadeCall e registrarNotaObservacao de ./ghl', /atualizarOportunidadeCall/.test(indexSrc) && /registrarNotaObservacao/.test(indexSrc));
checar('index.ts importa salvarWavoipCall e buscarTelefonePorWavoipCall de ./supabase', /salvarWavoipCall/.test(indexSrc) && /buscarTelefonePorWavoipCall/.test(indexSrc));

const inicio = indexSrc.indexOf("path: '/api/webhook/wavoip'");
checar("rota '/api/webhook/wavoip' encontrada em index.ts", inicio !== -1);

let handler = '';
if (inicio !== -1) {
  const resto = indexSrc.slice(inicio + "path: '/api/webhook/wavoip'".length);
  const prox = resto.indexOf("path: '");
  handler = prox !== -1 ? resto.slice(0, prox) : resto;
}

if (handler) {
  const idxToken = handler.indexOf('WAVOIP_WEBHOOK_TOKEN');
  const idx401 = handler.indexOf("status: 'unauthorized' }, 401");
  const idxSalvarCorrel = handler.indexOf('salvarWavoipCall(');
  const idxUpdate = handler.indexOf('atualizarOportunidadeCall(');
  const idxDownload = handler.indexOf('baixarGravacaoBase64(');
  const idxNota = handler.indexOf('registrarNotaObservacao(');
  const idxPersist = handler.indexOf('persistirTranscricaoContato(');
  const idxAnon = handler.indexOf('anonimizarTranscricao(');
  const idxGateAnon = handler.search(/if\s*\(!anonimizacao\.ok\)/);

  checar('handler referencia WAVOIP_WEBHOOK_TOKEN', idxToken !== -1);
  checar("handler retorna 401 unauthorized", idx401 !== -1);
  // (a) auth ANTES de todo efeito colateral.
  checar('auth (token) aparece ANTES do 401', idxToken !== -1 && idx401 !== -1 && idxToken < idx401);
  checar('401 aparece ANTES de salvarWavoipCall (fail-closed antes da correlacao)', idx401 !== -1 && idxSalvarCorrel !== -1 && idx401 < idxSalvarCorrel);
  checar('401 aparece ANTES de atualizarOportunidadeCall (fail-closed antes do move de card)', idx401 !== -1 && idxUpdate !== -1 && idx401 < idxUpdate);
  checar('401 aparece ANTES de baixarGravacaoBase64 (fail-closed antes do download)', idx401 !== -1 && idxDownload !== -1 && idx401 < idxDownload);

  // (b) gate anonimizacao antes de nota + campo.
  checar('handler checa !anonimizacao.ok (gate LGPD)', idxGateAnon !== -1);
  checar('anonimizarTranscricao aparece ANTES do gate .ok', idxAnon !== -1 && idxGateAnon !== -1 && idxAnon < idxGateAnon);
  checar('registrarNotaObservacao so DEPOIS do gate !anonimizacao.ok (bruto nunca vira nota)', idxGateAnon !== -1 && idxNota !== -1 && idxGateAnon < idxNota);
  checar('persistirTranscricaoContato so DEPOIS do gate !anonimizacao.ok', idxGateAnon !== -1 && idxPersist !== -1 && idxGateAnon < idxPersist);

  // (c) mapping atendeu + dedup + status terminal + correlacao no RECORD.
  checar('handler deriva atendeu de status terminal + duration>0', /atendeu\s*=\s*\[[^\]]*'ENDED'[^\]]*\]\.includes\(status\)\s*&&\s*duration\s*>\s*0/.test(handler));
  checar('handler filtra status TERMINAIS (nao age em ring/calling)', /TERMINAIS\s*=\s*\[/.test(handler) && /NOT_ANSWERED/.test(handler));
  checar('handler faz dedup via tentarRegistrarWebhook (wavoip-call/wavoip-record)', handler.indexOf('tentarRegistrarWebhook(') !== -1 && /wavoip-call\|/.test(handler) && /wavoip-record\|/.test(handler));
  checar('RECORD resolve telefone via buscarTelefonePorWavoipCall antes de baixar', handler.indexOf('buscarTelefonePorWavoipCall(') !== -1);
  checar('handler NUNCA loga transcricaoBruta (LGPD)', !/console\.(log|error|warn)\([^)]*transcricaoBruta/.test(handler));
  checar('handler NUNCA loga anonimizacao.textoAnon (LGPD)', !/console\.(log|error|warn)\([^)]*anonimizacao\.textoAnon/.test(handler));
}

if (falhas.length > 0) {
  console.error('[smoke-wavoip-webhook] FALHOU:');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('[smoke-wavoip-webhook] OK');
