// Smoke de TOOL-04: prova a guarda anti bant_* de chaveBloqueada em
// update-contact-field.ts.
//
// Por que nao importar o modulo direto: update-contact-field.ts importa
// ghl.ts, que por sua vez importa ./sessao (extensionless) — o loader nativo
// de TS do Node (--experimental-strip-types) NAO resolve imports relativos
// sem extensao, so o bundler do Mastra (esbuild) resolve isso. Mesma
// limitacao documentada em scripts/smoke-transcricao.mjs.
//
// Solucao: extrai o CORPO REAL da funcao exportada `chaveBloqueada` do
// arquivo fonte e executa via `new Function` — prova comportamento real
// (nao duplica a logica a mao num segundo lugar que pode divergir do
// codigo de producao).

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const arquivoPath = resolve(projectRoot, 'src/mastra/tools/update-contact-field.ts');

const src = await readFile(arquivoPath, 'utf8').catch(() => null);
if (src === null) {
  console.error(`[smoke-ucf] TOOL-04 FALHOU: arquivo nao encontrado (${arquivoPath})`);
  process.exit(1);
}

const match = src.match(/export function chaveBloqueada\(chave: string\): boolean \{([\s\S]*?)\n\}/);
if (!match) {
  console.error('[smoke-ucf] TOOL-04 FALHOU: funcao chaveBloqueada nao encontrada (ou assinatura mudou) em update-contact-field.ts');
  process.exit(1);
}

const chaveBloqueada = new Function('chave', match[1]);

const casos = [
  ['bant_total', true],
  ['BANT_need', true],
  ['spin_stage', false],
  ['ancora_abordagem', false],
];

const falhas = [];
for (const [chave, esperado] of casos) {
  const resultado = chaveBloqueada(chave);
  if (resultado !== esperado) {
    falhas.push(`chaveBloqueada('${chave}') = ${resultado}, esperado ${esperado}`);
  }
}

if (falhas.length > 0) {
  console.error('[smoke-ucf] TOOL-04 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-ucf] TOOL-04 guard OK');
