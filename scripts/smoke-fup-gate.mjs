// Smoke do gate de follow-up do formulario (/api/fup/pode-enviar).
//
// Objetivo: o Workflow [04] do GHL reenviava lembrete/convite do formulario
// por tempo/mudanca de estagio SEM checar se o lead ja tinha respondido
// (178/321 contatos receberam template duplicado). O gate move essa regra pro
// sistema: o Workflow consulta este endpoint (por ghl_contact_id) e so envia
// se {enviar:true}.
//
// Duas partes:
//  1) SOURCE-READ (mesmo molde de smoke-webhook-formulario-auth.mjs): index.ts
//     e supabase.ts importam dezenas de modulos relativos sem extensao que o
//     loader nativo de TS do Node (--experimental-strip-types) nao resolve
//     fora do bundler do Mastra. Entao provamos por leitura de fonte que a
//     rota, o token fail-closed, a funcao de consulta e a derivacao existem e
//     estao na ordem correta (asserts por indice de string, nao so presenca).
//  2) TRUTH-TABLE (logica pura): um espelho da regra de decisao prova a
//     tabela-verdade (respondido => enviar:false; pendente/nao-encontrado =>
//     enviar:true). O source-read (parte 1) garante que o codigo real casa
//     com esse espelho.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const indexPath = resolve(projectRoot, 'src/mastra/index.ts');
const supabasePath = resolve(projectRoot, 'src/mastra/supabase.ts');
const configPath = resolve(projectRoot, 'src/mastra/config.ts');

const indexSrc = await readFile(indexPath, 'utf8').catch(() => null);
const supabaseSrc = await readFile(supabasePath, 'utf8').catch(() => null);
const configSrc = await readFile(configPath, 'utf8').catch(() => null);

const falhas = [];
function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

for (const [nome, src, p] of [['index.ts', indexSrc, indexPath], ['supabase.ts', supabaseSrc, supabasePath], ['config.ts', configSrc, configPath]]) {
  if (src === null) {
    console.error(`[smoke-fup-gate] FALHOU: arquivo nao encontrado (${p})`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------
// config.ts: FUP_GATE_TOKEN fail-closed (token vazio => endpoint desabilitado)
// ---------------------------------------------------------------------
checar(
  "config.ts exporta FUP_GATE_TOKEN (process.env.FUP_GATE_TOKEN || '')",
  /export const FUP_GATE_TOKEN\s*=\s*process\.env\.FUP_GATE_TOKEN\s*\|\|\s*''/.test(configSrc),
);

// ---------------------------------------------------------------------
// supabase.ts: statusFormularioPorContato + conexao FORMS_* com fallback +
// derivacao de respondido/iniciado + fail-safe.
// ---------------------------------------------------------------------
checar(
  'supabase.ts exporta statusFormularioPorContato(ghlContactId)',
  /export async function statusFormularioPorContato\(\s*ghlContactId/.test(supabaseSrc),
);
checar(
  'supabase.ts usa FORMS_SUPABASE_URL com fallback para SUPABASE_URL',
  /FORMS_SUPABASE_URL\s*=\s*process\.env\.FORMS_SUPABASE_URL\s*\|\|\s*SUPABASE_URL/.test(supabaseSrc),
);
checar(
  'supabase.ts usa FORMS_SUPABASE_KEY com fallback para SERVICE_ROLE/ANON',
  /FORMS_SUPABASE_KEY\s*=[\s\S]*process\.env\.FORMS_SUPABASE_KEY[\s\S]*SUPABASE_SERVICE_ROLE_KEY[\s\S]*SUPABASE_ANON_KEY/.test(supabaseSrc),
);
checar(
  'supabase.ts consulta a tabela usi_pesquisa_respostas por ghl_contact_id',
  /usi_pesquisa_respostas[\s\S]*ghl_contact_id=eq\.\$\{encodeURIComponent\(ghlContactId\)\}/.test(supabaseSrc),
);
checar(
  "supabase.ts deriva respondido = status === 'respondido' || respondido_at != null",
  /respondido\s*=\s*row\.status\s*===\s*'respondido'\s*\|\|\s*row\.respondido_at\s*!=\s*null/.test(supabaseSrc),
);
checar(
  "supabase.ts deriva iniciado = status === 'iniciado' || iniciado_at != null",
  /iniciado\s*=\s*row\.status\s*===\s*'iniciado'\s*\|\|\s*row\.iniciado_at\s*!=\s*null/.test(supabaseSrc),
);
checar(
  'supabase.ts e fail-safe: retorno vazio tem respondido:false (nao barra envio por falha de infra)',
  /const vazio:\s*StatusFormulario\s*=\s*\{\s*encontrado:\s*false,\s*status:\s*null,\s*respondido:\s*false,\s*iniciado:\s*false\s*\}/.test(supabaseSrc),
);

// ---------------------------------------------------------------------
// index.ts: import + rota GET '/api/fup/pode-enviar' com token ANTES do
// contactId ANTES da consulta; enviar = !respondido; 401 e 400.
// ---------------------------------------------------------------------
checar(
  "index.ts importa statusFormularioPorContato de './supabase'",
  /import\s*\{[^}]*statusFormularioPorContato[^}]*\}\s*from\s*['"]\.\/supabase['"]/.test(indexSrc),
);
checar(
  "index.ts importa FUP_GATE_TOKEN de './config'",
  /import\s*\{[^}]*FUP_GATE_TOKEN[^}]*\}\s*from\s*['"]\.\/config['"]/.test(indexSrc),
);

const inicioRota = indexSrc.indexOf("path: '/api/fup/pode-enviar'");
checar("rota '/api/fup/pode-enviar' encontrada em index.ts", inicioRota !== -1);

let corpoRota = '';
if (inicioRota !== -1) {
  const resto = indexSrc.slice(inicioRota + "path: '/api/fup/pode-enviar'".length);
  const proximoPath = resto.indexOf("path: '");
  corpoRota = proximoPath !== -1 ? resto.slice(0, proximoPath) : resto;
}

if (corpoRota) {
  checar("rota e GET (method: 'GET')", /method:\s*'GET'/.test(corpoRota));

  const idxToken = corpoRota.indexOf('FUP_GATE_TOKEN');
  const idxUnauthorized = corpoRota.indexOf("status: 'unauthorized' }, 401");
  const idxContactId = corpoRota.indexOf("query('contactId')");
  const idx400 = corpoRota.indexOf("obrigatorio' }, 400");
  const idxStatusCall = corpoRota.indexOf('statusFormularioPorContato(');
  const idxEnviar = corpoRota.search(/enviar:\s*!st\.respondido/);

  checar('corpo da rota referencia FUP_GATE_TOKEN', idxToken !== -1);
  checar("corpo da rota retorna 401 unauthorized quando token invalido", idxUnauthorized !== -1);
  checar('corpo da rota le contactId da query', idxContactId !== -1);
  checar('corpo da rota retorna 400 quando contactId ausente', idx400 !== -1);
  checar('corpo da rota chama statusFormularioPorContato(...)', idxStatusCall !== -1);
  checar('corpo da rota responde enviar: !st.respondido (decisao central)', idxEnviar !== -1);

  if (idxToken !== -1 && idxUnauthorized !== -1) {
    checar('token e validado ANTES do 401 (fail-closed)', idxToken < idxUnauthorized);
  }
  if (idxUnauthorized !== -1 && idxStatusCall !== -1) {
    checar('401 (token) aparece ANTES da consulta ao Supabase (nao consulta sem auth)', idxUnauthorized < idxStatusCall);
  }
  if (idx400 !== -1 && idxStatusCall !== -1) {
    checar('400 (contactId obrigatorio) aparece ANTES da consulta ao Supabase', idx400 < idxStatusCall);
  }
}

// ---------------------------------------------------------------------
// TRUTH-TABLE (logica pura, espelho da regra provada por source-read acima):
// decidirEnvio(status) => { respondido, enviar }
//   respondido => enviar:false ; pendente/iniciado/null => enviar:true
// ---------------------------------------------------------------------
function decidirEnvioMirror(row) {
  // Espelho de statusFormularioPorContato + (enviar = !respondido).
  if (!row) return { respondido: false, enviar: true }; // nao encontrado (fail-safe)
  const respondido = row.status === 'respondido' || row.respondido_at != null;
  return { respondido, enviar: !respondido };
}

const casos = [
  { nome: 'respondido (status)', row: { status: 'respondido', respondido_at: null }, enviarEsperado: false },
  { nome: 'respondido (respondido_at)', row: { status: 'pendente', respondido_at: '2026-07-17T12:00:00Z' }, enviarEsperado: false },
  { nome: 'pendente', row: { status: 'pendente', respondido_at: null }, enviarEsperado: true },
  { nome: 'iniciado', row: { status: 'iniciado', respondido_at: null }, enviarEsperado: true },
  { nome: 'nao encontrado (fail-safe)', row: null, enviarEsperado: true },
];

for (const caso of casos) {
  const r = decidirEnvioMirror(caso.row);
  checar(`truth-table: ${caso.nome} => enviar:${caso.enviarEsperado}`, r.enviar === caso.enviarEsperado);
}

if (falhas.length > 0) {
  console.error('[smoke-fup-gate] FALHOU:');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('[smoke-fup-gate] gate de follow-up (rota + token + consulta + decisao) OK');
