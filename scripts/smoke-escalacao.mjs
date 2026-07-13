// Smoke de CAM-05/TOOL-09 (Gap 7/CR-07): prova que o escalate_to_human
// aciona um humano de forma GARANTIDA (task URGENTE + move pra
// RETORNAR_CONTATO), independente de SUPORTE_GRUPO_JID estar configurado, e
// que a pausa da IA (trocarAgente 'humano') continua funcionando.
//
// Assert por leitura de FONTE (nao unit-testavel sem GHL real - a tool faz
// I/O real via create-task.ts/move-pipeline-stage.ts). Mesma abordagem de
// scripts/smoke-prioridade-task.mjs / smoke-update-contact-field.mjs: em vez
// de duplicar a logica a mao (podendo divergir do codigo real), verifica
// presenca/ausencia de trechos no arquivo fonte de producao.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const arquivoPath = resolve(projectRoot, 'src/mastra/tools/escalate-to-human.ts');

const src = await readFile(arquivoPath, 'utf8').catch(() => null);
if (src === null) {
  console.error(`[smoke-escalacao] CAM-05/TOOL-09 FALHOU: arquivo nao encontrado (${arquivoPath})`);
  process.exit(1);
}

const falhas = [];

// 1. Importa createTask e movePipelineStage (as tools reusadas pro
// acionamento garantido).
if (!/import\s*\{\s*createTask\s*\}\s*from\s*['"]\.\/create-task['"]/.test(src)) {
  falhas.push('nao importa createTask de ./create-task');
}
if (!/import\s*\{\s*movePipelineStage\s*\}\s*from\s*['"]\.\/move-pipeline-stage['"]/.test(src)) {
  falhas.push('nao importa movePipelineStage de ./move-pipeline-stage');
}

// 2. As tools sao de fato chamadas (nao so importadas) e movePipelineStage
// e chamado com o literal RETORNAR_CONTATO.
if (!/createTask\.execute!?\(/.test(src)) {
  falhas.push('createTask.execute(...) nao e chamado em nenhum lugar do arquivo');
}
if (!/movePipelineStage\.execute!?\(/.test(src)) {
  falhas.push('movePipelineStage.execute(...) nao e chamado em nenhum lugar do arquivo');
}
if (!/movePipelineStage\.execute![\s\S]{0,120}RETORNAR_CONTATO/.test(src)) {
  falhas.push("movePipelineStage nao e chamado com stage: 'RETORNAR_CONTATO'");
}

// 3. trocarAgente(telefone, 'humano') continua presente (pausa da IA -
// TOOL-09 preservado).
if (!/trocarAgente\([^)]*['"]humano['"]\)/.test(src)) {
  falhas.push("trocarAgente(..., 'humano') nao encontrado - pausa da IA pode ter sido removida");
}

// 4. execute() chama o acionamento garantido de forma INCONDICIONAL (nao
// dentro de um if que dependa de SUPORTE_GRUPO_JID). O literal
// SUPORTE_GRUPO_JID nao deveria aparecer em CODIGO real aqui (comentarios
// explicando a decisao sao ok) - a validacao/uso desse env vive em
// config.ts/notificacoes.ts, nao em escalate-to-human.ts.
const srcSemComentarios = src.replace(/\/\/.*$/gm, '');
if (/SUPORTE_GRUPO_JID/.test(srcSemComentarios)) {
  falhas.push(
    'SUPORTE_GRUPO_JID referenciado em codigo (fora de comentario) em escalate-to-human.ts - acionamento garantido pode estar condicionado a ele',
  );
}

const execMatch = src.match(/execute:\s*async[\s\S]*$/);
const execBody = execMatch ? execMatch[0] : '';
if (!/acionarHumanoGarantido\(/.test(execBody)) {
  falhas.push('execute() nao chama o acionamento garantido (acionarHumanoGarantido)');
}

if (falhas.length > 0) {
  console.error('[smoke-escalacao] CAM-05/TOOL-09 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-escalacao] CAM-05/TOOL-09 OK');
