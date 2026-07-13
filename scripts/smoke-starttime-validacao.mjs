// Smoke de Gap 4/CR-05 (TOOL-07/FUN-01/FUN-06): prova a funcao pura
// `slotContemHorario` em tools/create-calendar-event.ts — valida se um
// `startTime` proposto pelo LLM esta de fato entre os slots livres reais
// retornados por GET /calendars/{id}/free-slots, normalizando por INSTANTE
// (epoch), nao por string (slot e startTime podem vir com timezone/offset
// diferentes representando o MESMO horario).
//
// Mesma limitacao/solucao documentada em scripts/smoke-overflow.mjs: o loader
// nativo de TS do Node (--experimental-strip-types) NAO resolve os imports
// relativos sem extensao de create-calendar-event.ts ('../ghl',
// './move-pipeline-stage', '../sessao', '../dupla-acao') — so o bundler do
// Mastra (esbuild) resolve isso. Solucao: extrai o CORPO REAL da funcao
// exportada `slotContemHorario` do arquivo fonte e executa via `new
// Function` — prova o comportamento real (nao duplica a logica a mao num
// segundo lugar que pode divergir do codigo de producao).

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const arquivoPath = resolve(projectRoot, 'src/mastra/tools/create-calendar-event.ts');

const src = await readFile(arquivoPath, 'utf8').catch(() => null);
if (src === null) {
  console.error(`[smoke-starttime] TOOL-07/FUN-01/FUN-06 FALHOU: arquivo nao encontrado (${arquivoPath})`);
  process.exit(1);
}

const match = src.match(
  /export function slotContemHorario\([\s\S]*?\)[\s\S]*?:\s*boolean\s*\{([\s\S]*?)\n\}/,
);
if (!match) {
  console.error('[smoke-starttime] TOOL-07/FUN-01/FUN-06 FALHOU: funcao slotContemHorario nao encontrada (ou assinatura mudou) em create-calendar-event.ts');
  process.exit(1);
}

const slotContemHorario = new Function('slots', 'startTime', match[1]);

const falhas = [];
function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// ---- Caso 1: match exato (mesma string) -> true ----
checar(
  'caso1: match exato de string -> true',
  slotContemHorario(['2026-07-20T14:00:00-03:00'], '2026-07-20T14:00:00-03:00') === true,
);

// ---- Caso 2: mesmo instante, timezone/offset diferente -> true (normalizacao) ----
checar(
  'caso2: mesmo instante com timezone/offset diferente (Z vs -03:00) -> true',
  slotContemHorario(['2026-07-20T17:00:00Z'], '2026-07-20T14:00:00-03:00') === true,
);

// ---- Caso 3: horario diferente (nao livre) -> false ----
checar(
  'caso3: horario fora dos slots -> false',
  slotContemHorario(['2026-07-20T09:00:00-03:00'], '2026-07-20T14:00:00-03:00') === false,
);

// ---- Caso 4: lista de slots vazia -> false ----
checar(
  'caso4: lista de slots vazia -> false',
  slotContemHorario([], '2026-07-20T14:00:00-03:00') === false,
);

// ---- Caso 5 (bonus): startTime invalido (NaN) -> false, nao lanca excecao ----
checar(
  'caso5: startTime invalido (nao-data) -> false',
  slotContemHorario(['2026-07-20T14:00:00-03:00'], 'nao-e-uma-data') === false,
);

// ---- Caso 6 (bonus): slot invalido misturado com slot valido -> ainda descarta o invalido corretamente ----
checar(
  'caso6: slot invalido misturado com valido -> ainda ignora o invalido, casa o valido',
  slotContemHorario(['nao-e-uma-data', '2026-07-20T14:00:00-03:00'], '2026-07-20T14:00:00-03:00') === true,
);

// ---- Caso 7: horario alucinado pelo LLM (fora de qualquer slot real) -> false ----
checar(
  'caso7: horario alucinado (fora do periodo/slots reais) -> false, tool deve responder sucesso:false',
  slotContemHorario(['2026-07-20T09:00:00-03:00', '2026-07-20T10:00:00-03:00'], '2026-07-25T23:00:00-03:00') === false,
);

if (falhas.length > 0) {
  console.error('[smoke-starttime] TOOL-07/FUN-01/FUN-06 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-starttime] TOOL-07/FUN-01/FUN-06 OK');
