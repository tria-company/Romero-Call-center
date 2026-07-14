// Smoke de GRAV-04 (Fase 3, 03-01): prova a funcao pura `anonimizarTranscricao`
// em src/mastra/anonimizacao.ts — o filtro LGPD deterministico e fail-closed
// que impede que transcricao BRUTA (com potencial dado clinico de PACIENTE)
// seja persistida em custom field GHL.
//
// Mesma limitacao/solucao documentada em scripts/smoke-no-show.mjs: extrai o
// CORPO REAL de anonimizarTranscricao via regex e executa via `new Function`
// (funcao pura, sem I/O/imports) — prova o comportamento real, sem duplicar a
// logica a mao num segundo lugar que poderia divergir do codigo de producao.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const arquivoPath = resolve(projectRoot, 'src/mastra/anonimizacao.ts');

const src = await readFile(arquivoPath, 'utf8').catch(() => null);
if (src === null) {
  console.error(`[smoke-anonimizacao] GRAV-04 FALHOU: arquivo nao encontrado (${arquivoPath})`);
  process.exit(1);
}

const falhas = [];
function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// ---------------------------------------------------------------------
// 0. Prova de FONTE: contrato exportado (tipo separado, export nomeado).
// ---------------------------------------------------------------------
checar(
  'anonimizacao.ts exporta a interface ResultadoAnonimizacao (tipo em interface separada)',
  /export interface ResultadoAnonimizacao\s*\{/.test(src),
);
checar(
  'anonimizacao.ts exporta TERMOS_CLINICOS_REGEX (blocklist configuravel)',
  /export const TERMOS_CLINICOS_REGEX\s*=/.test(src),
);
checar(
  'anonimizacao.ts NAO loga o texto de entrada/saida (LGPD) — nenhum console.log/error/warn com a variavel texto/out bruta',
  !/console\.(log|error|warn)\([^)]*\btexto\b/.test(src) && !/console\.(log|error|warn)\([^)]*\bout\b/.test(src),
);

// ---------------------------------------------------------------------
// 1. Extrai o CORPO REAL da funcao exportada e executa via `new Function`.
// ---------------------------------------------------------------------
const match = src.match(
  /export function anonimizarTranscricao\([\s\S]*?\)\s*:\s*ResultadoAnonimizacao\s*\{([\s\S]*?)\n\}/,
);
if (!match) {
  console.error('[smoke-anonimizacao] GRAV-04 FALHOU: funcao anonimizarTranscricao nao encontrada (ou assinatura mudou) em anonimizacao.ts');
  process.exit(1);
}

const anonimizarTranscricao = new Function('texto', match[1]);

// ---- Caso 1: CPF e redigido, digitos originais NAO aparecem mais ----
{
  const r = anonimizarTranscricao('O paciente informou o CPF 123.456.789-00 pra confirmar cadastro.');
  checar('caso1: CPF redigido -> textoAnon contem [CPF]', r.textoAnon.includes('[CPF]'));
  checar('caso1: CPF redigido -> digitos originais ausentes', !r.textoAnon.includes('123.456.789-00') && !r.textoAnon.includes('123456789'));
  checar('caso1: ok true', r.ok === true);
  checar('caso1: redacoes >= 1', r.redacoes >= 1);
}

// ---- Caso 2: email e telefone redigidos ----
{
  const r = anonimizarTranscricao('Pode me confirmar o email joao.silva@exemplo.com.br e o telefone (11) 91234-5678?');
  checar('caso2: email redigido -> nao contem o endereco original', !r.textoAnon.includes('joao.silva@exemplo.com.br'));
  checar('caso2: email redigido -> marcador [CONTATO] presente', r.textoAnon.includes('[CONTATO]'));
  checar('caso2: telefone redigido -> nao contem os digitos originais', !r.textoAnon.includes('91234-5678'));
  checar('caso2: ok true', r.ok === true);
  checar('caso2: redacoes >= 2 (email + telefone)', r.redacoes >= 2);
}

// ---- Caso 3: nome de paciente por CONTEXTO ----
{
  const r = anonimizarTranscricao('Ontem o paciente Joao Silva relatou dor no peito durante a consulta.');
  checar('caso3: nome de paciente redigido -> [PACIENTE] presente', r.textoAnon.includes('[PACIENTE]'));
  checar('caso3: nome de paciente redigido -> "Joao Silva" ausente', !r.textoAnon.includes('Joao Silva'));
  checar('caso3: mantem o marcador clinico "paciente" legivel', /paciente\s*\[PACIENTE\]/i.test(r.textoAnon));
  checar('caso3: ok true', r.ok === true);
}

// ---- Caso 3b: NAO redige o nome do proprio lead (sem marcador clinico antes) ----
{
  const r = anonimizarTranscricao('Aqui quem fala e Ana Paula, profissional cadastrada no programa.');
  checar('caso3b: nome do proprio lead/profissional (sem marcador clinico antes) NAO e redigido', r.textoAnon.includes('Ana Paula'));
}

// ---- Caso 4: termo da blocklist clinica redigido ----
{
  const r = anonimizarTranscricao('O resultado do exame confirmou o diagnostico de hipertensao.');
  checar('caso4: termo clinico "diagnostico" redigido -> [CLINICO] presente', r.textoAnon.includes('[CLINICO]'));
  checar('caso4: termo clinico "diagnostico" ausente apos redacao', !/\bdiagnostico\b/i.test(r.textoAnon));
  checar('caso4: ok true', r.ok === true);
  checar('caso4: redacoes >= 1', r.redacoes >= 1);
}

// ---- Caso 5: texto limpo (sem PII/termo clinico) passa intacto ----
{
  const texto = 'Muito obrigado pelo seu tempo, vamos agendar a call comercial pra proxima semana.';
  const r = anonimizarTranscricao(texto);
  checar('caso5: texto limpo -> ok true', r.ok === true);
  checar('caso5: texto limpo -> redacoes === 0', r.redacoes === 0);
  checar('caso5: texto limpo -> textoAnon === texto original (nada alterado)', r.textoAnon === texto);
}

// ---- Caso 6: entrada vazia -> fail-closed ----
{
  const r = anonimizarTranscricao('');
  checar("caso6: entrada '' -> ok false", r.ok === false);
  checar("caso6: entrada '' -> textoAnon ''", r.textoAnon === '');
  checar("caso6: entrada '' -> redacoes 0", r.redacoes === 0);
}

// ---- Caso 7: entrada nao-string -> fail-closed (defesa extra, mesmo contrato) ----
{
  const r = anonimizarTranscricao(null);
  checar('caso7: entrada null -> ok false (fail-closed)', r.ok === false);
  checar('caso7: entrada null -> textoAnon vazio', r.textoAnon === '');
}

if (falhas.length > 0) {
  console.error('[smoke-anonimizacao] GRAV-04 FALHOU:');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('[smoke-anonimizacao] GRAV-04 OK');
