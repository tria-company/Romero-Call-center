#!/usr/bin/env node
// scripts/classificar-erro.smoke.mjs
//
// Smoke determinístico (sem rede) do classificador PURO transitório×permanente
// (`src/mastra/classificar-erro.ts`, Fase 19.1 Plano 01, DUR-01/DUR-02). Cobre
// a matriz inteira do <behavior> do plano: rede/timeout, status HTTP conhecido
// (5xx/429/408/425/411 → transitório; 404/400/401/403/422 → permanente),
// marcadores de origem (ClickUp/Deepgram/storage/Supabase) e o default
// conservador (origem/status desconhecido → transitório — decisão travada
// "nada descartado sem humano"). Também prova que `motivo` NUNCA ecoa a
// mensagem crua de entrada (LGPD — T-19.1-01-I: sem telefone/URL/token no log).
//
// Uso: node --experimental-strip-types scripts/classificar-erro.smoke.mjs

import { classificarErro } from '../src/mastra/classificar-erro.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function checarClassificacao(rotulo, erro, tipoEsperado, origemEsperada) {
  const resultado = classificarErro(erro);
  checar(
    resultado.tipo === tipoEsperado,
    `${rotulo}: tipo deveria ser '${tipoEsperado}', recebido '${resultado.tipo}' (${JSON.stringify(resultado)})`,
  );
  if (origemEsperada) {
    checar(
      resultado.origem === origemEsperada,
      `${rotulo}: origem deveria ser '${origemEsperada}', recebido '${resultado.origem}' (${JSON.stringify(resultado)})`,
    );
  }
  return resultado;
}

function abortError(mensagem) {
  return Object.assign(new Error(mensagem), { name: 'AbortError' });
}

function testeRedeTimeout() {
  checarClassificacao('AbortError', abortError('The operation was aborted'), 'transitorio', 'rede');
  checarClassificacao('ECONNRESET', new Error('read ECONNRESET'), 'transitorio', 'rede');
  checarClassificacao('ETIMEDOUT', new Error('connect ETIMEDOUT 1.2.3.4:443'), 'transitorio', 'rede');
  checarClassificacao('EAI_AGAIN', new Error('getaddrinfo EAI_AGAIN storage.wavoip.com'), 'transitorio', 'rede');
  checarClassificacao('fetch failed', new Error('fetch failed'), 'transitorio', 'rede');
  checarClassificacao('string "aborted"', 'request aborted by client', 'transitorio', 'rede');
}

function testeStatusTransitorio() {
  checarClassificacao("'HTTP 500'", 'HTTP 500 Internal Server Error', 'transitorio');
  checarClassificacao("'503'", 'upstream respondeu 503', 'transitorio');
  checarClassificacao("'429'", '429 too many requests', 'transitorio');
  checarClassificacao("'408'", 'timeout (408) no upstream', 'transitorio');
  checarClassificacao("'425'", 'too early (425)', 'transitorio');
  checarClassificacao("'(411)'", 'resposta sem content-length (411)', 'transitorio');
}

function testeStatusPermanente() {
  checarClassificacao("'(404) task not found'", '(404) task not found', 'permanente');
  checarClassificacao("'nao encontrada' 404", '404 - task nao encontrada', 'permanente');
  checarClassificacao("'(400) bad audio'", '(400) bad audio', 'permanente');
  checarClassificacao("'401 unauthorized'", '401 unauthorized', 'permanente');
  checarClassificacao("'403 forbidden'", '403 forbidden', 'permanente');
  checarClassificacao("'422 unprocessable'", '422 unprocessable entity', 'permanente');
}

function testeMarcadoresOrigem() {
  // ClickUp degradado: 500 com marcador — transitório + origem clickup.
  checarClassificacao(
    'clickup degradado (500 + publicapi-tasks)',
    'GET publicapi-tasks respondeu 500 apos timeout interno',
    'transitorio',
    'clickup',
  );
  // ClickUp degradado SEM status extraível — ainda transitório via marcador puro.
  checarClassificacao(
    'clickup degradado (cluster.local, sem status)',
    'erro interno em cluster.local ao consultar tasks',
    'transitorio',
    'clickup',
  );
  // Deepgram: 400 (audio corrompido) -> permanente, origem deepgram.
  checarClassificacao('deepgram 400 (audio invalido)', 'deepgram respondeu 400: invalid audio format', 'permanente', 'deepgram');
  // Deepgram: 411 (sem content-length do storage) -> transitorio, origem deepgram.
  checarClassificacao('deepgram 411 (sem content-length)', 'deepgram url-mode falhou (411) storage sem content-length', 'transitorio', 'deepgram');
  // Storage Wavoip generico -> origem storage (status 5xx generico).
  checarClassificacao('storage wavoip 500', 'storage.wavoip.com respondeu 500', 'transitorio', 'storage');
  // Supabase generico -> origem supabase.
  checarClassificacao('supabase 500', 'supabase rest respondeu 500 internal error', 'transitorio', 'supabase');
}

function testeDefaultConservador() {
  checarClassificacao("'erro esquisito'", 'erro esquisito', 'transitorio', 'desconhecido');
  checarClassificacao('objeto nao-Error/string', { algumaCoisa: true }, 'transitorio', 'desconhecido');
  checarClassificacao('undefined', undefined, 'transitorio', 'desconhecido');
}

function testeAceitaErrorOuString() {
  const viaError = classificarErro(new Error('HTTP 500'));
  const viaString = classificarErro('HTTP 500');
  checar(viaError.tipo === 'transitorio', `classificarErro(Error) deveria classificar igual a string, recebido: ${JSON.stringify(viaError)}`);
  checar(viaString.tipo === 'transitorio', `classificarErro(string) deveria funcionar, recebido: ${JSON.stringify(viaString)}`);
}

function testeMotivoSemPii() {
  const telefone = '+5511987654321';
  const url = 'https://storage.wavoip.com/rec/abc123?token=SEGREDO';
  const resultado = classificarErro(new Error(`falha ao baixar gravacao do lead ${telefone} em ${url} (500)`));
  checar(
    !resultado.motivo.includes(telefone),
    `motivo NUNCA deve ecoar telefone da mensagem crua (LGPD T-19.1-01-I), recebido motivo: '${resultado.motivo}'`,
  );
  checar(
    !resultado.motivo.includes(url) && !resultado.motivo.includes('SEGREDO'),
    `motivo NUNCA deve ecoar URL/token da mensagem crua (LGPD T-19.1-01-I), recebido motivo: '${resultado.motivo}'`,
  );
  checar(resultado.motivo.length < 60, `motivo deveria ser um rotulo curto, recebido (${resultado.motivo.length} chars): '${resultado.motivo}'`);
}

function main() {
  testeRedeTimeout();
  testeStatusTransitorio();
  testeStatusPermanente();
  testeMarcadoresOrigem();
  testeDefaultConservador();
  testeAceitaErrorOuString();
  testeMotivoSemPii();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
