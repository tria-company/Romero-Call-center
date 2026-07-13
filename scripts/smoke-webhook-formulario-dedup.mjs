// Smoke de CAM-01/QUAL-04 (Gap 5/CR-06): prova o determinismo e a
// idempotencia do hash de dedup do webhook do formulario 14q —
// construirHashFormulario em src/mastra/index.ts.
//
// Contexto: o GHL Workflow dispara o webhook do form 2-3x por retry. O
// handler /api/webhook/formulario deduplica via tentarRegistrarWebhook(hash)
// ANTES de disparar o Qualificador + dispararDuplaAcao — pra isso funcionar,
// o hash precisa ser DETERMINISTICO (mesmo submit => mesmo hash, mesmo que o
// GHL anexe timestamps/IDs volateis diferentes em cada retry) e SENSIVEL
// (telefone/conteudo/bucket diferentes => hash diferente, senao um submit
// legitimo seria engolido como duplicado).
//
// Por que nao importar o modulo direto: index.ts importa dezenas de modulos
// com imports relativos sem extensao — o loader nativo de TS do Node
// (--experimental-strip-types) nao resolve isso, so o bundler do Mastra.
// Mesma limitacao documentada em scripts/smoke-coordenacao.mjs.
//
// Solucao: extrai o CORPO REAL da funcao exportada `construirHashFormulario`
// do arquivo fonte e executa via `new Function`, injetando createHash — prova
// o comportamento real (nao duplica a logica a mao num segundo lugar).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const arquivoPath = resolve(projectRoot, 'src/mastra/index.ts');

const src = await readFile(arquivoPath, 'utf8').catch(() => null);
if (src === null) {
  console.error(`[smoke-webhook-form] CAM-01/QUAL-04 FALHOU: arquivo nao encontrado (${arquivoPath})`);
  process.exit(1);
}

const match = src.match(
  /export function construirHashFormulario\([\s\S]*?\)[\s\S]*?:\s*string\s*\{([\s\S]*?)\n\}/,
);
if (!match) {
  console.error('[smoke-webhook-form] CAM-01/QUAL-04 FALHOU: funcao construirHashFormulario nao encontrada (ou assinatura mudou) em src/mastra/index.ts');
  process.exit(1);
}

const construirHashFormulario = new Function('createHash', 'telefone', 'payload', 'minBucket', match[1]);
const hash = (telefone, payload, minBucket) => construirHashFormulario(createHash, telefone, payload, minBucket);

const falhas = [];

function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// Payload representativo do submit do form 14q (GHL Workflow)
const payloadBase = {
  telefone: '5511999998888',
  nome: 'Dra. Ana',
  q01_profissao: 'Nutricionista',
  q02_registro_ativo: 'sim',
  q03_tempo_atuacao_anos: '8',
  q04_area_foco: 'Saude da mulher',
  q05_modelo_atendimento: 'autonomo',
  q06_pacientes_semana: '25',
  q07_ticket_medio: '1.500,00',
  q08_aplicou_ads: 'sim',
  q09_canal_captacao: 'instagram',
  q10_indicou_curso: 'sim',
  q11_motivo_interesse: 'quero escalar meus atendimentos',
  q12_modulo_interrompido: 'nenhum',
  q13_congresso_sp: 'nao',
  q14_maior_dificuldade: 'tempo de anamnese',
};

const TEL = '5511999998888';
const BUCKET = 29_000_000; // minBucket ficticio fixo

// ---- 1. Determinismo: mesmo (telefone, payload, minBucket) => mesmo hash ----
const h1 = hash(TEL, payloadBase, BUCKET);
const h2 = hash(TEL, payloadBase, BUCKET);
checar('determinismo: mesma entrada 2x => mesmo hash', h1 === h2);
checar('hash tem formato sha1 hex (40 chars)', typeof h1 === 'string' && /^[0-9a-f]{40}$/.test(h1));

// ---- 2. Idempotencia por janela: payload CLONADO (retry do GHL) no mesmo bucket => mesmo hash ----
const payloadRetry = JSON.parse(JSON.stringify(payloadBase));
checar(
  'idempotencia: payload identico clonado (retry) no mesmo bucket => mesmo hash (seria descartado como duplicado)',
  hash(TEL, payloadRetry, BUCKET) === h1,
);

// ---- 2b. Retry com campo volatil diferente (timestamp/ID do GHL) => MESMO hash (dedup nao fura) ----
const payloadRetryVolatil = { ...payloadBase, timestamp: '2026-07-13T21:00:03Z', eventId: 'evt_abc123' };
checar(
  'idempotencia: retry com timestamp/eventId volateis diferentes => mesmo hash (campos volateis fora do hash)',
  hash(TEL, payloadRetryVolatil, BUCKET) === h1,
);

// ---- 2c. Mesmas chaves em ordem de insercao diferente => mesmo hash (chaves ordenadas) ----
const payloadDesordenado = {};
for (const chave of Object.keys(payloadBase).reverse()) payloadDesordenado[chave] = payloadBase[chave];
checar(
  'determinismo: mesmas chaves em ordem de insercao diferente => mesmo hash',
  hash(TEL, payloadDesordenado, BUCKET) === h1,
);

// ---- 3. Sensibilidade: minBucket diferente => hash diferente ----
checar(
  'sensibilidade: minBucket diferente (re-submit legitimo em outra janela) => hash diferente',
  hash(TEL, payloadBase, BUCKET + 1) !== h1,
);

// ---- 4. Sensibilidade: telefone diferente => hash diferente ----
checar(
  'sensibilidade: telefone diferente => hash diferente',
  hash('5511888887777', payloadBase, BUCKET) !== h1,
);

// ---- 5. Sensibilidade: um campo do form alterado => hash diferente ----
const payloadCampoAlterado = { ...payloadBase, q14_maior_dificuldade: 'captacao de pacientes' };
checar(
  'sensibilidade: um campo do form (q14) alterado => hash diferente',
  hash(TEL, payloadCampoAlterado, BUCKET) !== h1,
);

if (falhas.length > 0) {
  console.error('[smoke-webhook-form] CAM-01/QUAL-04 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-webhook-form] CAM-01/QUAL-04 OK');
