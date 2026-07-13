// Smoke de CAM-02/Gap 3 (CR-01, plano 01-09): prova o roundtrip de
// agenteParaEnum/enumParaAgente pros 4 estados logicos do agente
// ('vendedor'/'qualificador'/'camila'/'humano') — a persistencia real do
// agente_atual no Supabase depende desse par de funcoes serem inversas uma
// da outra (fecha a assimetria do 'humano' e o fallback silencioso de
// 'camila'/'qualificador' pra 'vendedor').
//
// Por que nao importar sessao.ts direto: ele importa './supabase' e
// './config' extensionless — o loader nativo de TS do Node
// (--experimental-strip-types) NAO resolve imports relativos sem extensao,
// so o bundler do Mastra (esbuild) resolve isso. Mesma limitacao documentada
// em scripts/smoke-coordenacao.mjs.
//
// Solucao: extrai o CORPO REAL das funcoes exportadas `agenteParaEnum` e
// `enumParaAgente` do arquivo fonte e executa via `new Function` — prova o
// comportamento real (nao duplica a logica a mao num segundo lugar que pode
// divergir do codigo de producao).

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const arquivoPath = resolve(projectRoot, 'src/mastra/sessao.ts');

const src = await readFile(arquivoPath, 'utf8').catch(() => null);
if (src === null) {
  console.error(`[smoke-sessao] CAM-02 FALHOU: arquivo nao encontrado (${arquivoPath})`);
  process.exit(1);
}

const matchParaEnum = src.match(
  /export function agenteParaEnum\([\s\S]*?\)[\s\S]*?:\s*string\s*\{([\s\S]*?)\n\}/,
);
if (!matchParaEnum) {
  console.error('[smoke-sessao] CAM-02 FALHOU: funcao agenteParaEnum nao encontrada (ou assinatura mudou) em sessao.ts');
  process.exit(1);
}

const matchEnumPara = src.match(
  /export function enumParaAgente\([\s\S]*?\)[\s\S]*?:\s*string\s*\{([\s\S]*?)\n\}/,
);
if (!matchEnumPara) {
  console.error('[smoke-sessao] CAM-02 FALHOU: funcao enumParaAgente nao encontrada (ou assinatura mudou) em sessao.ts');
  process.exit(1);
}

// Os corpos extraidos sao TypeScript (ex: `const mapa: Record<string,
// string> = {...}`) — `new Function` so aceita JS puro. Strip da anotacao de
// tipo do local var declarada dentro do corpo (unica sintaxe TS presente
// nessas 2 funcoes) antes de reconstruir.
function paraJs(corpoTs) {
  return corpoTs.replace(/:\s*Record<[^>]*>/g, '');
}

const agenteParaEnum = new Function('agente', paraJs(matchParaEnum[1]));
const enumParaAgente = new Function('enumValor', paraJs(matchEnumPara[1]));

const falhas = [];

function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// ---- Roundtrip dos 4 estados logicos ----
checar(
  "vendedor: agenteParaEnum('vendedor') === 'vendedor'",
  agenteParaEnum('vendedor') === 'vendedor',
);
checar(
  "vendedor: enumParaAgente('vendedor') === 'vendedor'",
  enumParaAgente('vendedor') === 'vendedor',
);

checar(
  "qualificador: agenteParaEnum('qualificador') === 'qualificador' (nao cai no fallback 'vendedor')",
  agenteParaEnum('qualificador') === 'qualificador',
);
checar(
  "qualificador: enumParaAgente('qualificador') === 'qualificador'",
  enumParaAgente('qualificador') === 'qualificador',
);

checar(
  "camila: agenteParaEnum('camila') === 'camila' (nao cai no fallback 'vendedor')",
  agenteParaEnum('camila') === 'camila',
);
checar(
  "camila: enumParaAgente('camila') === 'camila'",
  enumParaAgente('camila') === 'camila',
);

// ---- Roundtrip assimetrico do 'humano' (Gap 3 principal) ----
checar(
  "humano: agenteParaEnum('humano') === 'atendimento_humano'",
  agenteParaEnum('humano') === 'atendimento_humano',
);
checar(
  "humano: enumParaAgente('atendimento_humano') === 'humano' (regressao da assimetria e detectada aqui)",
  enumParaAgente('atendimento_humano') === 'humano',
);

// ---- Composicao: enumParaAgente(agenteParaEnum(x)) === x para os 4 estados ----
for (const x of ['vendedor', 'qualificador', 'camila', 'humano']) {
  checar(
    `composicao: enumParaAgente(agenteParaEnum('${x}')) === '${x}'`,
    enumParaAgente(agenteParaEnum(x)) === x,
  );
}

if (falhas.length > 0) {
  console.error('[smoke-sessao] CAM-02 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-sessao] CAM-02 OK');
