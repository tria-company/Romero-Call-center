// Smoke de TOOL-06: prova a regra de prioridade por BANT (Filtro 3 do
// playbook) usada em create-task.ts pra calcular dueDate da task do SDR
// humano: 10-12 URGENTE (<=2h uteis) / 7-9 ALTA (<=24h) / 5-6 MEDIA (<=48h).
//
// Por que nao importar o modulo direto: create-task.ts importa ghl.ts, que
// por sua vez importa ./sessao (extensionless) — o loader nativo de TS do
// Node (--experimental-strip-types) NAO resolve imports relativos sem
// extensao, so o bundler do Mastra (esbuild) resolve isso. Mesma limitacao
// documentada em scripts/smoke-update-contact-field.mjs.
//
// Solucao: extrai o CORPO REAL da funcao exportada `prioridadePorBant` do
// arquivo fonte e executa via `new Function` — prova comportamento real
// (nao duplica a logica a mao num segundo lugar que pode divergir do
// codigo de producao).

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const arquivoPath = resolve(projectRoot, 'src/mastra/tools/create-task.ts');

const src = await readFile(arquivoPath, 'utf8').catch(() => null);
if (src === null) {
  console.error(`[smoke-prioridade] TOOL-06 FALHOU: arquivo nao encontrado (${arquivoPath})`);
  process.exit(1);
}

const match = src.match(/export function prioridadePorBant\([\s\S]*?\)[\s\S]*?\{([\s\S]*?)\n\}/);
if (!match) {
  console.error('[smoke-prioridade] TOOL-06 FALHOU: funcao prioridadePorBant nao encontrada (ou assinatura mudou) em create-task.ts');
  process.exit(1);
}

const prioridadePorBant = new Function('total', match[1]);

const casos = [
  [12, 'URGENTE'],
  [10, 'URGENTE'],
  [9, 'ALTA'],
  [8, 'ALTA'],
  [7, 'ALTA'],
  [6, 'MEDIA'],
  [5, 'MEDIA'],
  [4, 'BAIXA'],
];

const falhas = [];
for (const [total, esperado] of casos) {
  const resultado = prioridadePorBant(total);
  if (!resultado || resultado.prioridade !== esperado) {
    falhas.push(`prioridadePorBant(${total}).prioridade = ${resultado?.prioridade}, esperado ${esperado}`);
  }
}

if (falhas.length > 0) {
  console.error('[smoke-prioridade] TOOL-06 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-prioridade] TOOL-06 OK');
