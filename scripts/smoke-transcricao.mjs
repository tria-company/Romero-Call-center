// Smoke estatico de INFRA-03: garante que a transcricao de audio (Whisper/Azure)
// nao foi afetada pela troca dos deployments de chat (GPT-4.1 -> GPT-5.1/GPT-5-mini).
//
// Decisao (01-01, fase 01-virada-fluxo-vertical): o audio permanece no Azure Whisper
// via deployment de transcricao proprio (AZURE_OPENAI_DEPLOYMENT_TRANSCRICAO), chamado
// por fetch direto em ghl.ts (transcreverAudio). A troca dos modelos de chat da Camila
// e do Qualificador para GPT-5.1/GPT-5-mini nao toca esse path. Este smoke prova isso
// por assercao estatica no texto de ghl.ts, sem chamar a API paga da Azure.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const ghlPath = resolve(projectRoot, 'src/mastra/ghl.ts');

const src = await readFile(ghlPath, 'utf8');

const falhas = [];

// (a) transcreverAudio continua definida
if (!/export\s+async\s+function\s+transcreverAudio\s*\(/.test(src)) {
  falhas.push('funcao transcreverAudio nao encontrada (ou assinatura mudou) em ghl.ts');
}

// (b) ainda referencia o deployment de transcricao proprio e o header api-key
if (!src.includes('AZURE_OPENAI_DEPLOYMENT_TRANSCRICAO')) {
  falhas.push('ghl.ts nao referencia mais AZURE_OPENAI_DEPLOYMENT_TRANSCRICAO');
}
if (!src.includes("'api-key'")) {
  falhas.push('ghl.ts nao referencia mais o header api-key (auth da transcricao Azure)');
}

// (c) o arquivo do canal (transcricao incluida) nao referencia os deployments de chat.
// Isso prova que a troca de modelo de chat (GPT41 -> GPT51/GPT5_MINI) e independente
// do path de transcricao de audio.
const deploymentsDeChat = ['AZURE_OPENAI_DEPLOYMENT_GPT51', 'AZURE_OPENAI_DEPLOYMENT_GPT5_MINI', 'AZURE_OPENAI_DEPLOYMENT_GPT41'];
for (const dep of deploymentsDeChat) {
  if (src.includes(dep)) {
    falhas.push(`ghl.ts referencia ${dep} — transcricao deveria ser independente dos deployments de chat`);
  }
}

if (falhas.length > 0) {
  console.error('[smoke-transcricao] INFRA-03 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-transcricao] INFRA-03 OK');
