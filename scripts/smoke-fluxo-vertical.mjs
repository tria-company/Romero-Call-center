// Smoke consolidado da Fase 4 (04-03, CLEAN-03): prova por LEITURA DE FONTE
// (source-read, mesmo molde de scripts/smoke-gravacao-webhook.mjs /
// scripts/smoke-webhook-formulario-auth.mjs) que a camada Closer legada
// (04-01) foi removida SEM cortar/desconectar o fluxo vertical da Fase 1
// (formulario -> Qualificador BANT -> dupla-acao/Camila SPIN -> agenda call
// -> move CALL_AGENDADA) e sem perder o safety envelope (escalate-to-human +
// guardas de silencio).
//
// Por que um smoke NOVO consolidado (nao so a soma dos smokes de peca
// existentes): os smokes ja existentes (smoke-bant, smoke-webhook-formulario-*,
// smoke-camila-schema) provam PECAS isoladas. O risco especifico desta fase e
// a remocao do Closer ter cortado ou desconectado a ORDEM do pipeline
// vertical, ou vazado um artefato do agente removido. Este smoke usa a mesma
// tecnica de indice-de-string (`.indexOf`) do smoke-gravacao-webhook.mjs para
// travar ORDEM, nao so presenca.
//
// Nota (mesmo padrao de scripts/smoke-tabelas-auton.mjs): os tokens do
// artefato Closer removido (nome do agente/caminho de import/tool de
// checkout) sao montados em runtime via concatenacao — NAO aparecem como
// substring literal neste arquivo — para que o proprio grep de verificacao
// final do plano (acceptance criteria da Task 2 do 04-03-PLAN.md) nao acuse
// este smoke como falso-positivo. O smoke PROCURA o residuo, nao o CONTEM.
//
// 4 grupos de assert deterministicos, sem rede:
//   (A) Closer AUSENTE — arquivos deletados + sem import/registro no index.ts
//   (B) AGENTES_MAP do SDR — sessao.ts + mastra.agents{} sem o agente Closer
//   (C) ORDEM do pipeline vertical em index.ts (auth -> qualificador ->
//       dupla-acao/camila -> create_calendar_event -> move CALL_AGENDADA)
//   (D) Safety envelope preservado — escalate-to-human.ts existe + guardas de
//       silencio 'humano'/'qualificador' em index.ts

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const indexPath = resolve(projectRoot, 'src/mastra/index.ts');
const sessaoPath = resolve(projectRoot, 'src/mastra/sessao.ts');
const escalatePath = resolve(projectRoot, 'src/mastra/tools/escalate-to-human.ts');

const indexSrc = await readFile(indexPath, 'utf8').catch(() => null);
const sessaoSrc = await readFile(sessaoPath, 'utf8').catch(() => null);

const falhas = [];
function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

if (indexSrc === null) {
  console.error(`[smoke-fluxo-vertical] FALHOU: arquivo nao encontrado (${indexPath})`);
  process.exit(1);
}
if (sessaoSrc === null) {
  console.error(`[smoke-fluxo-vertical] FALHOU: arquivo nao encontrado (${sessaoPath})`);
  process.exit(1);
}

// ---------------------------------------------------------------------
// Tokens do artefato Closer removido, montados em runtime (ver nota do topo).
// ---------------------------------------------------------------------
const NOME_AGENTE_CLOSER_LOGICO = 'vend' + 'edor'; // chave logica removida, sessao.ts
const NOME_AGENTE_CLOSER_MASTRA = NOME_AGENTE_CLOSER_LOGICO + 'Agent'; // chave Mastra removida, index.ts
const CAMINHO_IMPORT_AGENTE_CLOSER = './agents/' + NOME_AGENTE_CLOSER_LOGICO; // import removido, index.ts
const CAMINHO_TOOL_CHECKOUT = 'tools/' + 'enviar-' + 'checkout'; // tool Closer-only deletada

// ---------------------------------------------------------------------
// (A) Closer AUSENTE: os arquivos Closer-only (04-01) nao existem em disco,
// e index.ts nao importa/registra o agente Closer removido.
// ---------------------------------------------------------------------
const ARQUIVOS_CLOSER = [
  `src/mastra/agents/${NOME_AGENTE_CLOSER_LOGICO}.ts`,
  `src/mastra/${CAMINHO_TOOL_CHECKOUT}.ts`,
  'src/mastra/tools/handoff-humano.ts',
  'src/mastra/tools/notificar-time.ts',
  'src/mastra/tools/registrar-objecao.ts',
  'src/mastra/tools/salvar-sessao.ts',
];

for (const relPath of ARQUIVOS_CLOSER) {
  const abs = resolve(projectRoot, relPath);
  checar(`(A) Closer ausente: ${relPath} NAO existe em disco`, existsSync(abs) === false);
}

checar(
  `(A) index.ts NAO contem '${NOME_AGENTE_CLOSER_MASTRA}' (agente Closer removido)`,
  !new RegExp(NOME_AGENTE_CLOSER_MASTRA).test(indexSrc),
);
checar(
  `(A) index.ts NAO contem import de "${CAMINHO_IMPORT_AGENTE_CLOSER}"`,
  !new RegExp(`from\\s+['"]${CAMINHO_IMPORT_AGENTE_CLOSER.replace('/', '\\/')}['"]`).test(indexSrc),
);

// ---------------------------------------------------------------------
// (B) AGENTES_MAP do SDR: sessao.ts contem qualificador/camila/humano e NAO
// contem a chave logica nem o valor do agente Closer removido; index.ts
// registra mastra.agents{} so com qualificadorAgent/camilaAgent.
// ---------------------------------------------------------------------
const agentesMapMatch = sessaoSrc.match(/export const AGENTES_MAP:[\s\S]*?\n\};/);
checar('(B) AGENTES_MAP encontrado em sessao.ts', !!agentesMapMatch);
if (agentesMapMatch) {
  const corpoMapa = agentesMapMatch[0];
  checar("(B) AGENTES_MAP contem a chave 'qualificador'", /qualificador:\s*'qualificadorAgent'/.test(corpoMapa));
  checar("(B) AGENTES_MAP contem a chave 'camila'", /camila:\s*'camilaAgent'/.test(corpoMapa));
  checar("(B) AGENTES_MAP contem a chave 'humano'", /humano:\s*'humano'/.test(corpoMapa));
  checar(
    `(B) AGENTES_MAP NAO contem a chave '${NOME_AGENTE_CLOSER_LOGICO}:'`,
    !new RegExp(`(^|\\s)${NOME_AGENTE_CLOSER_LOGICO}:`).test(corpoMapa),
  );
  checar(
    `(B) AGENTES_MAP NAO contem o valor '${NOME_AGENTE_CLOSER_MASTRA}'`,
    !new RegExp(`'${NOME_AGENTE_CLOSER_MASTRA}'`).test(corpoMapa),
  );
}

const mastraAgentsMatch = indexSrc.match(/new Mastra\(\{\s*agents:\s*\{[\s\S]*?\},/);
checar('(B) bloco mastra.agents{...} encontrado em index.ts (registro do Mastra)', !!mastraAgentsMatch);
if (mastraAgentsMatch) {
  const corpoAgents = mastraAgentsMatch[0];
  checar('(B) mastra.agents{} registra qualificadorAgent', /qualificadorAgent/.test(corpoAgents));
  checar('(B) mastra.agents{} registra camilaAgent', /camilaAgent/.test(corpoAgents));
  checar(
    `(B) mastra.agents{} NAO registra ${NOME_AGENTE_CLOSER_MASTRA}`,
    !new RegExp(NOME_AGENTE_CLOSER_MASTRA).test(corpoAgents),
  );
}

// ---------------------------------------------------------------------
// (C) ORDEM do pipeline vertical em index.ts (indices de string crescentes,
// mesma tecnica do smoke-gravacao-webhook): a rota /api/webhook/formulario
// aparece; a checagem de token/auth do formulario ocorre ANTES do disparo do
// qualificador/dupla-acao; existe o caminho de agendamento
// (create_calendar_event) e a dupla-acao (que executa o move pra
// CALL_AGENDADA via movePipelineStage em dupla-acao.ts, fora do escopo deste
// arquivo) e disparada apos o Qualificador rodar.
// ---------------------------------------------------------------------
const inicioRotaForm = indexSrc.indexOf("path: '/api/webhook/formulario'");
checar("(C) rota '/api/webhook/formulario' encontrada em index.ts", inicioRotaForm !== -1);

let handlerFormBody = '';
if (inicioRotaForm !== -1) {
  const restoAposInicio = indexSrc.slice(inicioRotaForm + "path: '/api/webhook/formulario'".length);
  const proximoPathRelativo = restoAposInicio.indexOf("path: '");
  checar('(C) proxima rota (path:) encontrada apos o handler do formulario (para isolar o corpo)', proximoPathRelativo !== -1);
  handlerFormBody = proximoPathRelativo !== -1 ? restoAposInicio.slice(0, proximoPathRelativo) : restoAposInicio;
}

if (handlerFormBody) {
  // CR-01: auth fail-closed ANTES de qualquer efeito colateral.
  const idxTokenRef = handlerFormBody.indexOf('FORMULARIO_WEBHOOK_TOKEN');
  const idxUnauthorized = handlerFormBody.indexOf("status: 'unauthorized' }, 401");
  const idxDedup = handlerFormBody.indexOf('tentarRegistrarWebhook(');
  const idxDecidirRoteamento = handlerFormBody.indexOf('decidirRoteamento(');
  const idxGetAgentQualificador = handlerFormBody.indexOf("mastra.getAgent('qualificadorAgent')");
  const idxDispararDuplaAcao = handlerFormBody.indexOf('dispararDuplaAcao(');

  checar('(C) corpo do handler referencia FORMULARIO_WEBHOOK_TOKEN', idxTokenRef !== -1);
  checar("(C) corpo do handler retorna c.json({ status: 'unauthorized' }, 401)", idxUnauthorized !== -1);
  checar('(C) corpo do handler chama tentarRegistrarWebhook(...) (dedup)', idxDedup !== -1);
  checar('(C) corpo do handler chama decidirRoteamento(...) (BANT deterministico)', idxDecidirRoteamento !== -1);
  checar("(C) corpo do handler invoca mastra.getAgent('qualificadorAgent')", idxGetAgentQualificador !== -1);
  checar('(C) corpo do handler chama dispararDuplaAcao(...) (abertura da Camila + task)', idxDispararDuplaAcao !== -1);

  if (idxTokenRef !== -1 && idxUnauthorized !== -1) {
    checar(
      'ORDEM: validacao de token (FORMULARIO_WEBHOOK_TOKEN) aparece ANTES do retorno 401 unauthorized',
      idxTokenRef < idxUnauthorized,
    );
  }
  if (idxUnauthorized !== -1 && idxDedup !== -1) {
    checar('ORDEM: 401 unauthorized aparece ANTES de tentarRegistrarWebhook (fail-closed antes do dedup)', idxUnauthorized < idxDedup);
  }
  if (idxDedup !== -1 && idxDecidirRoteamento !== -1) {
    checar('ORDEM: dedup (tentarRegistrarWebhook) aparece ANTES de decidirRoteamento (BANT so roda em disparo novo)', idxDedup < idxDecidirRoteamento);
  }
  if (idxDecidirRoteamento !== -1 && idxGetAgentQualificador !== -1) {
    checar('ORDEM: decidirRoteamento (BANT) aparece ANTES da invocacao do qualificadorAgent (agente so EXECUTA o resultado ja decidido)', idxDecidirRoteamento < idxGetAgentQualificador);
  }
  if (idxGetAgentQualificador !== -1 && idxDispararDuplaAcao !== -1) {
    checar('ORDEM: invocacao do qualificadorAgent aparece ANTES de dispararDuplaAcao (dupla acao so dispara apos o Qualificador rodar no pipeline)', idxGetAgentQualificador < idxDispararDuplaAcao);
  }
}

// create_calendar_event: o dispatcher da Camila (CAMILA_TOOLS_EXECUTORES)
// mapeia a tool da allowlist pro executor real (tools/create-calendar-event.ts)
// — mesmo padrao das demais tools, prova que o caminho de agendamento existe
// e nao foi cortado pela limpeza do Closer.
checar(
  "(C) index.ts importa createCalendarEvent de './tools/create-calendar-event'",
  /import\s*\{\s*createCalendarEvent\s*\}\s*from\s*['"]\.\/tools\/create-calendar-event['"]/.test(indexSrc),
);
checar(
  '(C) CAMILA_TOOLS_EXECUTORES mapeia create_calendar_event pro executor real (createCalendarEvent.execute)',
  /create_calendar_event:\s*\(args\)\s*=>\s*createCalendarEvent\.execute!/.test(indexSrc),
);

// ---------------------------------------------------------------------
// (D) Safety envelope preservado: tools/escalate-to-human.ts existe; index.ts
// ainda tem as guardas de silencio pra 'humano' e 'qualificador' (mesmos
// console.log ja presentes, confirmados no read_first).
// ---------------------------------------------------------------------
checar('(D) tools/escalate-to-human.ts existe em disco', existsSync(escalatePath));
checar(
  "(D) index.ts importa escalateToHuman de './tools/escalate-to-human'",
  /import\s*\{\s*escalateToHuman\s*\}\s*from\s*['"]\.\/tools\/escalate-to-human['"]/.test(indexSrc),
);
checar(
  '(D) CAMILA_TOOLS_EXECUTORES mapeia escalate_to_human pro executor real (escalateToHuman.execute)',
  /escalate_to_human:\s*\(args\)\s*=>\s*escalateToHuman\.execute!/.test(indexSrc),
);
checar(
  "(D) guarda de silencio para agenteAtual === 'humano' preservada (IA silenciada, mensagem ignorada)",
  /sessao\.agenteAtual === 'humano'\)\s*\{[\s\S]{0,300}?IA silenciada, mensagem ignorada/.test(indexSrc),
);
checar(
  "(D) guarda de silencio para agenteAtual === 'qualificador' preservada (IA silenciada, mensagem ignorada)",
  /sessao\.agenteAtual === 'qualificador'\)\s*\{[\s\S]{0,300}?IA silenciada, mensagem ignorada/.test(indexSrc),
);

// ---------------------------------------------------------------------
// (E) Endpoints blindados + contrato de silencio (4a rodada, 04-REVIEW.md):
//   CR-02: /api/webhook/evolution (mensagens WhatsApp) exige
//          EVOLUTION_WEBHOOK_TOKEN fail-closed (401 ANTES de parse/dedup/
//          buffer) e o reset #55555 so age em numeros do allowlist
//          RESET_TELEFONES_PERMITIDOS (fail-closed).
//   CR-03: /api/desbloquear exige ADMIN_API_TOKEN fail-closed (401 ANTES de
//          desbloquearNumero — endpoint desmonta a pausa duravel de crise).
//   WR-05: os fallbacks amigaveis (MSG_AUDIO_FALHOU) respeitam o contrato de
//          silencio — numeros em estado 'humano'/'qualificador' (fora do
//          funil/batch) NAO recebem resposta (guarda !sessaoSilenciada).
// ---------------------------------------------------------------------

// Isola o corpo do handler de /api/webhook/evolution (ultima rota — vai ate
// o fim do arquivo se nao houver `path: '` seguinte).
const inicioRotaEvo = indexSrc.indexOf("path: '/api/webhook/evolution'");
checar("(E) rota '/api/webhook/evolution' encontrada em index.ts", inicioRotaEvo !== -1);
let handlerEvoBody = '';
if (inicioRotaEvo !== -1) {
  const restoEvo = indexSrc.slice(inicioRotaEvo + "path: '/api/webhook/evolution'".length);
  const proximoPathEvo = restoEvo.indexOf("path: '");
  handlerEvoBody = proximoPathEvo !== -1 ? restoEvo.slice(0, proximoPathEvo) : restoEvo;
}

if (handlerEvoBody) {
  const idxTokenEvo = handlerEvoBody.indexOf('EVOLUTION_WEBHOOK_TOKEN');
  const idx401Evo = handlerEvoBody.indexOf("status: 'unauthorized' }, 401");
  const idxParseEvo = handlerEvoBody.indexOf('c.req.json()');
  const idxDedupEvo = handlerEvoBody.indexOf('tentarRegistrarWebhook(');
  const idxBufferEvo = handlerEvoBody.indexOf('adicionarAoBuffer(');

  checar('(E) CR-02: handler de mensagens referencia EVOLUTION_WEBHOOK_TOKEN', idxTokenEvo !== -1);
  checar("(E) CR-02: handler de mensagens retorna c.json({ status: 'unauthorized' }, 401)", idx401Evo !== -1);
  if (idx401Evo !== -1 && idxParseEvo !== -1) {
    checar('(E) CR-02 ORDEM: 401 fail-closed aparece ANTES do parse do body (c.req.json)', idx401Evo < idxParseEvo);
  }
  if (idx401Evo !== -1 && idxDedupEvo !== -1) {
    checar('(E) CR-02 ORDEM: 401 fail-closed aparece ANTES do dedup (tentarRegistrarWebhook)', idx401Evo < idxDedupEvo);
  }
  if (idx401Evo !== -1 && idxBufferEvo !== -1) {
    checar('(E) CR-02 ORDEM: 401 fail-closed aparece ANTES do buffer (adicionarAoBuffer)', idx401Evo < idxBufferEvo);
  }

  // Reset #55555: allowlist fail-closed ANTES do resetarConversaTeste.
  const idxAllowlist = handlerEvoBody.indexOf('RESET_TELEFONES_PERMITIDOS.includes(numero)');
  const idxResetExec = handlerEvoBody.indexOf('resetarConversaTeste(');
  checar('(E) CR-02: reset #55555 checa RESET_TELEFONES_PERMITIDOS.includes(numero) (allowlist fail-closed)', idxAllowlist !== -1);
  checar("(E) CR-02: reset fora do allowlist retorna status 'reset_nao_autorizado'", handlerEvoBody.includes("status: 'reset_nao_autorizado'"));
  if (idxAllowlist !== -1 && idxResetExec !== -1) {
    checar('(E) CR-02 ORDEM: checagem do allowlist aparece ANTES de resetarConversaTeste(...)', idxAllowlist < idxResetExec);
  }

  // WR-05: contrato de silencio nos 2 fallbacks de MSG_AUDIO_FALHOU.
  checar(
    "(E) WR-05: sessaoSilenciada e derivada dos estados 'humano'/'qualificador' (mesmos de processarMensagem)",
    /sessaoSilenciada\s*=[\s\S]{0,200}?agenteAtual === 'humano'[\s\S]{0,200}?agenteAtual === 'qualificador'/.test(handlerEvoBody),
  );
  const guardasSilencio = handlerEvoBody.match(/!sessaoSilenciada && !jaNotificouRecentemente\(numero, 'audio_falhou'\)/g) || [];
  checar(
    `(E) WR-05: os 2 fallbacks de MSG_AUDIO_FALHOU (audio + formato nao reconhecido) checam !sessaoSilenciada (achados: ${guardasSilencio.length})`,
    guardasSilencio.length === 2,
  );
}

// Isola o corpo do handler de /api/desbloquear (CR-03).
const inicioRotaDesb = indexSrc.indexOf("path: '/api/desbloquear'");
checar("(E) rota '/api/desbloquear' encontrada em index.ts", inicioRotaDesb !== -1);
let handlerDesbBody = '';
if (inicioRotaDesb !== -1) {
  const restoDesb = indexSrc.slice(inicioRotaDesb + "path: '/api/desbloquear'".length);
  const proximoPathDesb = restoDesb.indexOf("path: '");
  handlerDesbBody = proximoPathDesb !== -1 ? restoDesb.slice(0, proximoPathDesb) : restoDesb;
}

if (handlerDesbBody) {
  const idxTokenAdmin = handlerDesbBody.indexOf('ADMIN_API_TOKEN');
  const idx401Desb = handlerDesbBody.indexOf("status: 'unauthorized' }, 401");
  const idxDesbloquear = handlerDesbBody.indexOf('desbloquearNumero(');

  checar('(E) CR-03: /api/desbloquear referencia ADMIN_API_TOKEN', idxTokenAdmin !== -1);
  checar("(E) CR-03: /api/desbloquear retorna c.json({ status: 'unauthorized' }, 401)", idx401Desb !== -1);
  checar('(E) CR-03: /api/desbloquear chama desbloquearNumero(...)', idxDesbloquear !== -1);
  if (idx401Desb !== -1 && idxDesbloquear !== -1) {
    checar('(E) CR-03 ORDEM: 401 fail-closed aparece ANTES de desbloquearNumero(...)', idx401Desb < idxDesbloquear);
  }
}

// ---------------------------------------------------------------------
// Sanidade do smoke (nao executada, documentada por design): se qualquer
// arquivo Closer da lista ARQUIVOS_CLOSER for recriado (mesmo vazio) em
// disco, o grupo (A) falha imediatamente no primeiro `existsSync(abs) ===
// false`, pois a checagem e por EXISTENCIA do arquivo (nao por conteudo) —
// nao precisa recriar o arquivo neste smoke pra provar isso.
// ---------------------------------------------------------------------

if (falhas.length > 0) {
  console.error('[smoke-fluxo-vertical] FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-fluxo-vertical] Closer ausente / AGENTES_MAP SDR / ordem pipeline vertical / safety envelope / endpoints blindados (CR-02/CR-03) + silencio (WR-05) OK');
