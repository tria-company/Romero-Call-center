// Smoke de CAM-02/Gap 3 (CR-01, plano 01-09) — atualizado no plano 04-01
// (CLEAN-01, remocao do agente vendedor/Sofia): prova o roundtrip de
// agenteParaEnum/enumParaAgente pros 3 estados logicos vivos do SDR
// ('qualificador'/'camila'/'humano') — a persistencia real do agente_atual
// no Supabase depende desse par de funcoes serem inversas uma da outra
// (fecha a assimetria do 'humano' e o fallback silencioso de
// 'camila'/'qualificador' pra pausa segura). Tambem prova que o valor
// LEGADO 'vendedor' (linhas gravadas antes da limpeza, agente removido)
// retoma como 'humano' — nunca resolve pro agente Closer inexistente.
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

// ---- Agente logico 'vendedor' (Closer) foi REMOVIDO (CLEAN-01) ----
// agenteParaEnum('vendedor') nao mapeia mais pro proprio enum 'vendedor':
// 'vendedor' nao existe na tabela de agentes logicos vivos, entao cai no
// fallback fail-safe — o valor de enum de pausa segura.
checar(
  "vendedor (removido): agenteParaEnum('vendedor') === 'atendimento_humano' (fallback fail-safe, agente logico nao existe mais)",
  agenteParaEnum('vendedor') === 'atendimento_humano',
);
// Linha LEGADA no Postgres (agente_atual='vendedor', gravada antes da
// limpeza): enumParaAgente precisa retomar como pausa segura ('humano'),
// nunca resolver pro agente Closer/Sofia removido.
checar(
  "vendedor (legado no enum): enumParaAgente('vendedor') === 'humano' (retomada segura de linha legada)",
  enumParaAgente('vendedor') === 'humano',
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

// ---- Composicao: enumParaAgente(agenteParaEnum(x)) === x para os 3 estados
// logicos VIVOS do SDR ('vendedor' foi removido — CLEAN-01 — e nao compoe
// mais, ja coberto separadamente acima como fallback fail-safe/legado) ----
for (const x of ['qualificador', 'camila', 'humano']) {
  checar(
    `composicao: enumParaAgente(agenteParaEnum('${x}')) === '${x}'`,
    enumParaAgente(agenteParaEnum(x)) === x,
  );
}

// ---- WR-06 (4a rodada, 04-REVIEW.md): writers de metadata fazem MERGE ----
// Os 3 writers de metadata da conversa (criarSessao/atualizarSessao/
// marcarAgendamentoOwner) precisam ler o metadata persistido
// (metadataAtualDaConversa -> buscarConversaPorId) e fazer spread ANTES de
// sobrescrever chaves proprias — clobber apagava `bloqueado_ate` (a perna
// duravel da pausa de crise de bloqueio.ts) e `agendamento_owner`.
// Source-read: asserts estruturais sobre sessao.ts.
checar(
  "WR-06: sessao.ts importa buscarConversaPorId de './supabase' (leitura pro merge)",
  /import\s*\{[\s\S]*?buscarConversaPorId[\s\S]*?\}\s*from\s*['"]\.\/supabase['"]/.test(src),
);
checar(
  'WR-06: helper metadataAtualDaConversa existe (read-modify-write)',
  /async function metadataAtualDaConversa\(/.test(src),
);

// Cada writer precisa (a) chamar metadataAtualDaConversa e (b) fazer spread
// do valor lido no JSON.stringify do metadata.
for (const nomeFn of ['criarSessao', 'atualizarSessao', 'marcarAgendamentoOwner']) {
  const matchFn = src.match(new RegExp(`export async function ${nomeFn}\\([\\s\\S]*?\\n\\}`));
  checar(`WR-06: funcao ${nomeFn} encontrada em sessao.ts`, !!matchFn);
  if (matchFn) {
    const corpo = matchFn[0];
    checar(
      `WR-06: ${nomeFn} le o metadata persistido (metadataAtualDaConversa) antes de gravar`,
      corpo.includes('metadataAtualDaConversa('),
    );
    checar(
      `WR-06: ${nomeFn} faz spread do metadata lido (JSON.stringify({ ...atual, ... }))`,
      /JSON\.stringify\(\{\s*\.\.\.atual/.test(corpo),
    );
  }
}

if (falhas.length > 0) {
  console.error('[smoke-sessao] CAM-02 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-sessao] CAM-02 OK');
