// Smoke de FUN-06: prova o algoritmo DETERMINISTICO de overflow de closer
// (Sidnei primeiro; Petriv so quando o Sidnei nao tem slot no periodo
// pedido) — funcao pura escolherCloser em tools/create-calendar-event.ts.
//
// Por que nao importar o modulo direto: create-calendar-event.ts importa
// '../ghl', './move-pipeline-stage', '../sessao', '../dupla-acao'
// (extensionless) — o loader nativo de TS do Node (--experimental-strip-types)
// NAO resolve imports relativos sem extensao, so o bundler do Mastra
// (esbuild) resolve isso. Mesma limitacao documentada em
// scripts/smoke-coordenacao.mjs e scripts/smoke-prioridade-task.mjs.
//
// Solucao: extrai o CORPO REAL da funcao exportada `escolherCloser` do
// arquivo fonte e executa via `new Function` — prova o comportamento real
// (nao duplica a logica a mao num segundo lugar que pode divergir do codigo
// de producao). Os IDs de closer (GHL_CLOSER_SIDNEI/PETRIV) sao lidos do
// config.ts real (sem imports problematicos) e passados como parametros
// extras da funcao gerada, ja que o corpo extraido referencia esses nomes
// como se fossem modulo-scope.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GHL_CLOSER_SIDNEI, GHL_CLOSER_PETRIV } from '../src/mastra/config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const arquivoPath = resolve(projectRoot, 'src/mastra/tools/create-calendar-event.ts');

const src = await readFile(arquivoPath, 'utf8').catch(() => null);
if (src === null) {
  console.error(`[smoke-overflow] FUN-06 FALHOU: arquivo nao encontrado (${arquivoPath})`);
  process.exit(1);
}

const match = src.match(
  /export function escolherCloser\([\s\S]*?\)[\s\S]*?:\s*EscolhaCloser \| null\s*\{([\s\S]*?)\n\}/,
);
if (!match) {
  console.error('[smoke-overflow] FUN-06 FALHOU: funcao escolherCloser nao encontrada (ou assinatura mudou) em create-calendar-event.ts');
  process.exit(1);
}

const escolherCloser = new Function(
  'slotsSidnei',
  'slotsPetriv',
  'GHL_CLOSER_SIDNEI',
  'GHL_CLOSER_PETRIV',
  match[1],
);

const falhas = [];
function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// ---- Caso 1: Sidnei com slot -> sempre Sidnei (mesmo com Petriv tambem livre) ----
const r1 = escolherCloser(['2026-07-20T09:00:00-03:00'], ['2026-07-20T10:00:00-03:00'], GHL_CLOSER_SIDNEI, GHL_CLOSER_PETRIV);
checar(
  'caso1: Sidnei com slot (Petriv tambem livre) -> escolhe Sidnei',
  r1 !== null && r1.closer === 'sidnei' && r1.closerId === GHL_CLOSER_SIDNEI,
);

// ---- Caso 2: Sidnei vazio + Petriv com slot -> Petriv ----
const r2 = escolherCloser([], ['2026-07-20T10:00:00-03:00'], GHL_CLOSER_SIDNEI, GHL_CLOSER_PETRIV);
checar(
  'caso2: Sidnei sem slot + Petriv com slot -> escolhe Petriv',
  r2 !== null && r2.closer === 'petriv' && r2.closerId === GHL_CLOSER_PETRIV,
);

// ---- Caso 3: ambos vazios -> null (ofertar outros horarios/escalar) ----
const r3 = escolherCloser([], [], GHL_CLOSER_SIDNEI, GHL_CLOSER_PETRIV);
checar('caso3: Sidnei e Petriv sem slot -> null', r3 === null);

if (falhas.length > 0) {
  console.error('[smoke-overflow] FUN-06 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-overflow] FUN-06 OK');
