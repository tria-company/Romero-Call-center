// Smoke de FUN-05: prova a regra de coordenacao "quem agenda primeiro move
// o stage; o outro para" — funcao pura podeAgendar em dupla-acao.ts.
//
// Por que nao importar o modulo direto: dupla-acao.ts importa './sessao',
// './agents/camila', './index' (extensionless) — o loader nativo de TS do
// Node (--experimental-strip-types) NAO resolve imports relativos sem
// extensao, so o bundler do Mastra (esbuild) resolve isso. Mesma limitacao
// documentada em scripts/smoke-prioridade-task.mjs e
// scripts/smoke-update-contact-field.mjs.
//
// Solucao: extrai o CORPO REAL da funcao exportada `podeAgendar` do arquivo
// fonte e executa via `new Function` — prova o comportamento real (nao
// duplica a logica a mao num segundo lugar que pode divergir do codigo de
// producao).

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const arquivoPath = resolve(projectRoot, 'src/mastra/dupla-acao.ts');

const src = await readFile(arquivoPath, 'utf8').catch(() => null);
if (src === null) {
  console.error(`[smoke-coordenacao] FUN-05 FALHOU: arquivo nao encontrado (${arquivoPath})`);
  process.exit(1);
}

const match = src.match(
  /export function podeAgendar\([\s\S]*?\)[\s\S]*?:\s*boolean\s*\{([\s\S]*?)\n\}/,
);
if (!match) {
  console.error('[smoke-coordenacao] FUN-05 FALHOU: funcao podeAgendar nao encontrada (ou assinatura mudou) em dupla-acao.ts');
  process.exit(1);
}

const podeAgendar = new Function('stageAtual', 'ownerAtual', 'quem', match[1]);

const falhas = [];

function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// ---- Caso 1 (behavior): stage ainda QUALIFICADO e sem owner -> true ----
checar(
  'caso1: stage=QUALIFICADO sem owner -> ia pode agendar',
  podeAgendar('QUALIFICADO', undefined, 'ia') === true,
);
checar(
  'caso1b: stage=QUALIFICADO sem owner -> humano pode agendar',
  podeAgendar('QUALIFICADO', undefined, 'humano') === true,
);

// ---- Caso 2 (behavior): IA tenta agendar mas humano ja marcou CALL_AGENDADA -> false ----
checar(
  'caso2: stage=CALL_AGENDADA (humano ja agendou) -> ia NAO pode agendar',
  podeAgendar('CALL_AGENDADA', 'humano', 'ia') === false,
);

// ---- Caso 3 (bonus): owner ja setado pro OUTRO lado, mesmo com stage ainda nao refletindo CALL_AGENDADA ----
checar(
  'caso3: owner=humano (race, stage ainda QUALIFICADO) -> ia NAO pode agendar',
  podeAgendar('QUALIFICADO', 'humano', 'ia') === false,
);
checar(
  'caso3b: owner=ia (race, stage ainda QUALIFICADO) -> humano NAO pode agendar',
  podeAgendar('QUALIFICADO', 'ia', 'humano') === false,
);

// ---- Caso 4 (bonus): mesmo lado que ja e o owner pode retentar (idempotencia) ----
checar(
  'caso4: owner=ia, quem=ia (retentativa do mesmo lado) -> pode (idempotente)',
  podeAgendar('QUALIFICADO', 'ia', 'ia') === true,
);

// ---- Caso 5 (bonus): idempotencia — CALL_AGENDADA 2x nao gera efeito duplicado (mesmo lado que agendou tambem para) ----
checar(
  'caso5: stage=CALL_AGENDADA, owner=ia, quem=ia -> NAO pode reagendar (idempotente, sem duplicar)',
  podeAgendar('CALL_AGENDADA', 'ia', 'ia') === false,
);

if (falhas.length > 0) {
  console.error('[smoke-coordenacao] FUN-05 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-coordenacao] FUN-05 OK');
