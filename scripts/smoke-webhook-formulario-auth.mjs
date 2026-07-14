// Smoke de CR-01/CR-03/WR-05 (01-15, gap closure — blindagem do webhook do
// formulario 14q): prova por LEITURA DE FONTE (source-read, mesmo molde de
// scripts/smoke-escalacao.mjs) que as 3 guardas introduzidas nesta fase
// existem e estao NA ORDEM CORRETA dentro do handler de
// /api/webhook/formulario (src/mastra/index.ts) e em dupla-acao.ts.
//
// Por que source-read (nao unit-test comportamental completo): index.ts e
// dupla-acao.ts importam dezenas de modulos com imports relativos sem
// extensao (ghl.ts, sessao.ts, tools/*) que o loader nativo de TS do Node
// (--experimental-strip-types) nao resolve fora do bundler do Mastra —
// mesma limitacao documentada em smoke-webhook-formulario-dedup.mjs e
// smoke-escalacao.mjs. As asserções por regex comparam INDICES de string
// (`.indexOf`) pra provar ORDEM de codigo, nao so presenca — um trecho
// presente mas fora de ordem (ex: validacao de token movida pra DEPOIS de
// parseFormulario) tambem falha o smoke.
//
// Cobertura:
//   CR-01: validacao de FORMULARIO_WEBHOOK_TOKEN (401 fail-closed) roda
//          ANTES de parseFormulario/tentarRegistrarWebhook/dispararDuplaAcao.
//   CR-01 (4a rodada, 04-REVIEW.md) — pausa de crise por SINAIS DURAVEIS:
//     (a) lead FRIO com sessao 'humano' (cold-inbound) que submete o form E
//         qualificado normalmente: o handler NAO usa agenteAtual==='humano'
//         como sinal de supressao em lugar NENHUM, e a promocao pra
//         'qualificador' NAO exclui mais o estado 'humano' (nenhum
//         `!== 'humano'` no corpo do handler).
//     (b) lead em CRISE REAL (conversa 'aguardando_humano' via
//         buscarConversaAguardandoHumano OU bloqueio via estaBloqueado) e
//         SUPRIMIDO com retorno cedo 'em_atendimento_humano' ANTES de tocar
//         a sessao e ANTES do IIFE do pipeline; time e avisado
//         (enviarAvisoAoSuporte); falha na checagem = 503 fail-closed;
//         dupla-acao.ts recusa trocarAgente('camila') em profundidade.
//   WR-01: criarSessao recebe nomeReal (nunca o placeholder 'Não
//          identificado', que clobberaria o nome real no upsert).
//   WR-02: sessao 'camila' (SPIN em andamento) NAO e rebaixada pra
//          'qualificador' (jaEmSpin) e a dupla acao e SUPRIMIDA no re-submit
//          (if (jaEmSpin) guarda dispararDuplaAcao).
//   WR-05: sessao pre-existente fora do SPIN e movida pra 'qualificador'
//          (trocarAgente(telefone, 'qualificador')) antes do pipeline.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const indexPath = resolve(projectRoot, 'src/mastra/index.ts');
const duplaAcaoPath = resolve(projectRoot, 'src/mastra/dupla-acao.ts');
const configPath = resolve(projectRoot, 'src/mastra/config.ts');

const indexSrc = await readFile(indexPath, 'utf8').catch(() => null);
const duplaAcaoSrc = await readFile(duplaAcaoPath, 'utf8').catch(() => null);
const configSrc = await readFile(configPath, 'utf8').catch(() => null);

const falhas = [];

if (indexSrc === null) {
  console.error(`[smoke-webhook-form-auth] FALHOU: arquivo nao encontrado (${indexPath})`);
  process.exit(1);
}
if (duplaAcaoSrc === null) {
  console.error(`[smoke-webhook-form-auth] FALHOU: arquivo nao encontrado (${duplaAcaoPath})`);
  process.exit(1);
}
if (configSrc === null) {
  console.error(`[smoke-webhook-form-auth] FALHOU: arquivo nao encontrado (${configPath})`);
  process.exit(1);
}

function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// ---------------------------------------------------------------------
// 0. Isola o CORPO do handler '/api/webhook/formulario' (da declaracao da
// rota ate o proximo `path:` de outra rota) — todos os asserts de ORDEM
// abaixo comparam indices DENTRO deste corpo, nao do arquivo inteiro.
// ---------------------------------------------------------------------
const inicioHandler = indexSrc.indexOf("path: '/api/webhook/formulario'");
checar("rota '/api/webhook/formulario' encontrada em index.ts", inicioHandler !== -1);

let handlerBody = '';
if (inicioHandler !== -1) {
  const restoAposInicio = indexSrc.slice(inicioHandler + "path: '/api/webhook/formulario'".length);
  const proximoPathRelativo = restoAposInicio.indexOf("path: '");
  checar('proxima rota (path:) encontrada apos o handler do formulario (para isolar o corpo)', proximoPathRelativo !== -1);
  handlerBody = proximoPathRelativo !== -1 ? restoAposInicio.slice(0, proximoPathRelativo) : restoAposInicio;
}

// ---------------------------------------------------------------------
// CR-01: token fail-closed, ANTES de qualquer efeito colateral.
// ---------------------------------------------------------------------
checar(
  "config.ts exporta FORMULARIO_WEBHOOK_TOKEN (process.env.FORMULARIO_WEBHOOK_TOKEN || '')",
  /export const FORMULARIO_WEBHOOK_TOKEN\s*=\s*process\.env\.FORMULARIO_WEBHOOK_TOKEN\s*\|\|\s*''/.test(configSrc),
);
checar(
  "index.ts importa FORMULARIO_WEBHOOK_TOKEN de './config'",
  /import\s*\{[^}]*FORMULARIO_WEBHOOK_TOKEN[^}]*\}\s*from\s*['"]\.\/config['"]/.test(indexSrc),
);

if (handlerBody) {
  const idxTokenRef = handlerBody.indexOf('FORMULARIO_WEBHOOK_TOKEN');
  checar('corpo do handler referencia FORMULARIO_WEBHOOK_TOKEN', idxTokenRef !== -1);

  const idxUnauthorized = handlerBody.indexOf("status: 'unauthorized' }, 401");
  checar("corpo do handler retorna c.json({ status: 'unauthorized' }, 401)", idxUnauthorized !== -1);

  const idxParseFormulario = handlerBody.indexOf('parseFormulario');
  const idxTentarRegistrarWebhook = handlerBody.indexOf('tentarRegistrarWebhook');
  const idxDispararDuplaAcao = handlerBody.indexOf('dispararDuplaAcao');

  checar('parseFormulario e chamado dentro do corpo do handler', idxParseFormulario !== -1);
  checar('tentarRegistrarWebhook e chamado dentro do corpo do handler', idxTentarRegistrarWebhook !== -1);
  checar('dispararDuplaAcao e referenciado dentro do corpo do handler', idxDispararDuplaAcao !== -1);

  if (idxTokenRef !== -1 && idxUnauthorized !== -1) {
    checar(
      'CR-01: validacao de token (referencia a FORMULARIO_WEBHOOK_TOKEN) aparece ANTES do retorno 401 unauthorized',
      idxTokenRef < idxUnauthorized,
    );
  }
  if (idxUnauthorized !== -1 && idxParseFormulario !== -1) {
    checar('CR-01: retorno 401 unauthorized aparece ANTES de parseFormulario (fail-closed antes do parse)', idxUnauthorized < idxParseFormulario);
  }
  if (idxUnauthorized !== -1 && idxTentarRegistrarWebhook !== -1) {
    checar('CR-01: retorno 401 unauthorized aparece ANTES de tentarRegistrarWebhook (fail-closed antes do dedup)', idxUnauthorized < idxTentarRegistrarWebhook);
  }
  if (idxUnauthorized !== -1 && idxDispararDuplaAcao !== -1) {
    checar('CR-01: retorno 401 unauthorized aparece ANTES de dispararDuplaAcao (fail-closed antes da dupla acao)', idxUnauthorized < idxDispararDuplaAcao);
  }

  // -------------------------------------------------------------------
  // CR-01 (4a rodada) — caso (b): pausa de crise por SINAIS DURAVEIS
  // (buscarConversaAguardandoHumano/estaBloqueado) com retorno cedo, ANTES
  // de tocar a sessao e ANTES do IIFE do pipeline.
  // -------------------------------------------------------------------
  const idxBuscarAguardando = handlerBody.indexOf('buscarConversaAguardandoHumano(');
  checar('corpo do handler consulta buscarConversaAguardandoHumano(...) (sinal duravel de crise, sem janela de tempo)', idxBuscarAguardando !== -1);

  const idxEstaBloqueado = handlerBody.indexOf('estaBloqueado(');
  checar('corpo do handler chama estaBloqueado(...) (sinal duravel de bloqueio)', idxEstaBloqueado !== -1);

  checar(
    'CR-01 (4a rodada): a crise e derivada SO dos sinais duraveis (emCriseDuravel = Boolean(conversaCrise) || estaBloqueado)',
    /emCriseDuravel\s*=\s*Boolean\(conversaCrise\)\s*\|\|\s*\(await estaBloqueado\(telefone\)\)/.test(handlerBody),
  );

  const idxEmAtendimentoHumano = handlerBody.indexOf("status: 'em_atendimento_humano'");
  checar("corpo do handler retorna cedo com status 'em_atendimento_humano'", idxEmAtendimentoHumano !== -1);

  const idxEnviarAviso = handlerBody.indexOf('enviarAvisoAoSuporte(');
  checar('corpo do handler chama enviarAvisoAoSuporte(...) na supressao (time e avisado, nao silencio)', idxEnviarAviso !== -1);

  checar(
    'CR-01 (4a rodada): falha na checagem de crise retorna 503 fail-closed (erro_verificacao_crise)',
    /erro_verificacao_crise'\s*\},\s*503/.test(handlerBody),
  );

  const idxGetAgentQualificador = handlerBody.indexOf("getAgent('qualificadorAgent')");
  checar("corpo do handler agenda o pipeline via mastra.getAgent('qualificadorAgent')", idxGetAgentQualificador !== -1);

  if (idxBuscarAguardando !== -1 && idxGetAgentQualificador !== -1) {
    checar('CR-01: guarda de crise (buscarConversaAguardandoHumano) aparece ANTES do IIFE do pipeline', idxBuscarAguardando < idxGetAgentQualificador);
  }
  if (idxEstaBloqueado !== -1 && idxGetAgentQualificador !== -1) {
    checar("CR-01: checagem de estaBloqueado(...) aparece ANTES do IIFE do pipeline (getAgent('qualificadorAgent'))", idxEstaBloqueado < idxGetAgentQualificador);
  }
  if (idxEmAtendimentoHumano !== -1 && idxGetAgentQualificador !== -1) {
    checar("CR-01: retorno cedo 'em_atendimento_humano' aparece ANTES do IIFE do pipeline", idxEmAtendimentoHumano < idxGetAgentQualificador);
  }
  if (idxEnviarAviso !== -1 && idxGetAgentQualificador !== -1) {
    checar('CR-01: enviarAvisoAoSuporte(...) na supressao aparece ANTES do IIFE do pipeline', idxEnviarAviso < idxGetAgentQualificador);
  }

  // -------------------------------------------------------------------
  // CR-01 (4a rodada) — caso (a): lead FRIO com sessao 'humano' que submete
  // o form E qualificado normalmente. O estado logico 'humano' NAO pode ser
  // usado como sinal de supressao (e ambiguo desde o CLEAN-01: tambem
  // significa cold-inbound silenciado) e a promocao pra 'qualificador' NAO
  // pode mais excluir 'humano'.
  // -------------------------------------------------------------------
  checar(
    "CR-01 caso (a): corpo do handler NAO usa agenteAtual === 'humano' como sinal de crise (estado logico ambiguo)",
    !/agenteAtual\s*===\s*['"]humano['"]/.test(handlerBody),
  );
  checar(
    "CR-01 caso (a): a promocao de sessao pre-existente NAO exclui mais o estado 'humano' (nenhum !== 'humano' no handler)",
    !/!==\s*['"]humano['"]/.test(handlerBody),
  );
  checar(
    "CR-01 caso (a): condicao de promocao e !jaEmSpin && agenteAtual !== 'qualificador' (inclui 'humano' frio)",
    /!jaEmSpin\s*&&\s*sessaoExistente\.agenteAtual\s*!==\s*['"]qualificador['"]/.test(handlerBody),
  );

  // A guarda de crise (sinais duraveis) precisa rodar ANTES da promocao da
  // sessao — um lead em crise nunca chega a ter a sessao promovida.
  const idxTrocarQualificador = handlerBody.search(/trocarAgente\([^)]*['"]qualificador['"]\)/);
  if (idxBuscarAguardando !== -1 && idxTrocarQualificador !== -1) {
    checar(
      "CR-01: guarda de crise (buscarConversaAguardandoHumano) aparece ANTES da promocao trocarAgente(..., 'qualificador')",
      idxBuscarAguardando < idxTrocarQualificador,
    );
  }

  // -------------------------------------------------------------------
  // WR-01: criarSessao recebe nomeReal — nunca o placeholder que
  // clobberaria o nome real do customer no upsert (merge-duplicates).
  // -------------------------------------------------------------------
  checar(
    'WR-01: criarSessao do formulario recebe nome: nomeReal (placeholder fica so em logs/notificacoes)',
    /criarSessao\(telefone,\s*\{\s*nome:\s*nomeReal/.test(handlerBody),
  );

  // -------------------------------------------------------------------
  // WR-02: sessao 'camila' (SPIN em andamento) nao e rebaixada (jaEmSpin) e
  // a dupla acao e suprimida no re-submit (sem 2a abertura proativa CAM-01).
  // -------------------------------------------------------------------
  checar(
    "WR-02: jaEmSpin e derivado de agenteAtual === 'camila' (SPIN em andamento)",
    /jaEmSpin\s*=\s*sessaoExistente\.agenteAtual\s*===\s*['"]camila['"]/.test(handlerBody),
  );
  const idxIfJaEmSpin = handlerBody.indexOf('if (jaEmSpin)');
  const idxDispararDuplaAcaoCall = handlerBody.indexOf('dispararDuplaAcao({');
  checar('WR-02: existe o branch if (jaEmSpin) que suprime a dupla acao', idxIfJaEmSpin !== -1);
  if (idxIfJaEmSpin !== -1 && idxDispararDuplaAcaoCall !== -1) {
    checar(
      'WR-02: o branch if (jaEmSpin) guarda a chamada dispararDuplaAcao (supressao ANTES do disparo)',
      idxIfJaEmSpin < idxDispararDuplaAcaoCall,
    );
  }

  // -------------------------------------------------------------------
  // WR-05: sessao pre-existente fora do SPIN roteada pra 'qualificador'
  // antes do pipeline.
  // -------------------------------------------------------------------
  checar("corpo do handler chama trocarAgente(telefone, 'qualificador') (WR-05)", idxTrocarQualificador !== -1);
  if (idxTrocarQualificador !== -1 && idxGetAgentQualificador !== -1) {
    checar("WR-05: trocarAgente(..., 'qualificador') aparece ANTES do IIFE do pipeline", idxTrocarQualificador < idxGetAgentQualificador);
  }
}

// ---------------------------------------------------------------------
// CR-03 (defesa em profundidade): dupla-acao.ts recusa trocarAgente('camila')
// quando o agente atual e 'humano'.
// ---------------------------------------------------------------------
checar(
  "dupla-acao.ts importa getSessao de './sessao'",
  /import\s*\{[^}]*getSessao[^}]*\}\s*from\s*['"]\.\/sessao['"]/.test(duplaAcaoSrc),
);

const funcMatch = duplaAcaoSrc.match(
  /async function dispararAberturaProativaCamila\([\s\S]*?\n\}\n/,
);
checar('funcao dispararAberturaProativaCamila encontrada em dupla-acao.ts (assinatura mudou?)', !!funcMatch);

if (funcMatch) {
  const corpoFuncao = funcMatch[0];
  const idxGetSessaoNaFuncao = corpoFuncao.indexOf('getSessao(');
  const idxHumanoNaFuncao = corpoFuncao.search(/['"]humano['"]/);
  const idxTrocarCamila = corpoFuncao.search(/trocarAgente\(\s*telefone\s*,\s*['"]camila['"]\s*\)/);

  checar('dispararAberturaProativaCamila chama getSessao(...) antes de trocar pra camila', idxGetSessaoNaFuncao !== -1);
  checar("dispararAberturaProativaCamila referencia o literal 'humano' (checagem de pausa de crise)", idxHumanoNaFuncao !== -1);
  checar("dispararAberturaProativaCamila chama trocarAgente(telefone, 'camila')", idxTrocarCamila !== -1);

  if (idxGetSessaoNaFuncao !== -1 && idxTrocarCamila !== -1) {
    checar(
      "CR-03 (defesa em profundidade): getSessao(...) e chamado ANTES de trocarAgente(telefone, 'camila')",
      idxGetSessaoNaFuncao < idxTrocarCamila,
    );
  }
  if (idxHumanoNaFuncao !== -1 && idxTrocarCamila !== -1) {
    checar(
      "CR-03 (defesa em profundidade): checagem do literal 'humano' aparece ANTES de trocarAgente(telefone, 'camila')",
      idxHumanoNaFuncao < idxTrocarCamila,
    );
  }

  // A recusa precisa de fato interromper a funcao (return false) — nao so
  // logar e seguir em frente trocando pra camila mesmo assim.
  checar(
    'dispararAberturaProativaCamila retorna false na recusa (nao apenas loga e continua)',
    /return false/.test(corpoFuncao),
  );
}

if (falhas.length > 0) {
  console.error('[smoke-webhook-form-auth] CR-01 (auth + crise duravel)/WR-01/WR-02/WR-05 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-webhook-form-auth] CR-01 (auth + crise duravel casos a/b)/WR-01/WR-02/WR-05 OK');
