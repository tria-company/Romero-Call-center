// Smoke de CAM-05/TOOL-09 (Gap 7/CR-07 + fechamento residual CR-02/Gap 7):
// prova que o escalate_to_human aciona um humano de forma GARANTIDA (task
// URGENTE + move pra RETORNAR_CONTATO), independente de SUPORTE_GRUPO_JID
// estar configurado, que a pausa da IA (trocarAgente 'humano') continua
// funcionando, E que o resultado reportado e HONESTO quando as tools
// reusadas (createTask/movePipelineStage) falham (retornam
// {sucesso:false} — elas NUNCA lancam excecao).
//
// Duas camadas de prova:
//  1. Assert por leitura de FONTE (nao unit-testavel sem GHL real p/ parte
//     de I/O) — mesma abordagem de scripts/smoke-prioridade-task.mjs /
//     smoke-update-contact-field.mjs: verifica presenca/ausencia de
//     trechos no arquivo fonte de producao.
//  2. Assert COMPORTAMENTAL do caminho de FALHA (molde de
//     smoke-webhook-formulario-dedup.mjs): extrai o CORPO REAL da funcao
//     `acionarHumanoGarantido` do arquivo fonte e executa via
//     AsyncFunction, injetando stubs de createTask/movePipelineStage
//     (sucesso:false) + consultarNotificacao/registrarNotificacao/
//     rotularMotivo — prova que o retorno e {taskOk:false, moveOk:false} e
//     que a idempotencia NAO e registrada na falha total (retry permitido).
//     Escolhida a extracao de `acionarHumanoGarantido` (nao do `execute`
//     inteiro) porque suas dependencias (createTask, movePipelineStage,
//     consultarNotificacao, registrarNotificacao, rotularMotivo) sao todas
//     injetaveis como parametros — evita o problema de imports
//     extensionless de ghl.ts/sessao.ts que impede importar o modulo
//     direto sob --experimental-strip-types.
//
// 3a rodada (CR-01/CR-02/WR-02): a prova comportamental foi ESTENDIDA pra
// cobrir tambem a CAMADA INTERNA que a rodada anterior stubava por inteiro:
//  - secao 8c: idempotencia POR CANAL (WR-02) — sucesso parcial (task ok,
//    move falhou) nao consome a janela do canal falhado; a chamada seguinte
//    re-tenta SO o move e nao re-cria a task.
//  - secao 9: corpo REAL de createTask.execute (create-task.ts) executado
//    com fetch stub FALHANDO — prova que o retry apos falha total
//    RE-TENTA o POST de verdade (nao devolve {sucesso:true} fake de cache,
//    CR-01) e que a janela so e registrada apos res.ok (sucesso real).

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const arquivoPath = resolve(projectRoot, 'src/mastra/tools/escalate-to-human.ts');
const createTaskPath = resolve(projectRoot, 'src/mastra/tools/create-task.ts');

const src = await readFile(arquivoPath, 'utf8').catch(() => null);
if (src === null) {
  console.error(`[smoke-escalacao] CAM-05/TOOL-09 FALHOU: arquivo nao encontrado (${arquivoPath})`);
  process.exit(1);
}

const createTaskSrc = await readFile(createTaskPath, 'utf8').catch(() => null);
if (createTaskSrc === null) {
  console.error(`[smoke-escalacao] CAM-05/TOOL-09 FALHOU: arquivo nao encontrado (${createTaskPath})`);
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

// 5. (Fechamento CR-02/Gap 7 residual) execute() retorna sucesso DERIVADO
// (taskOk || moveOk || grupoOk), nao um `sucesso: true` incondicional.
if (!/taskOk\s*\|\|\s*moveOk\s*\|\|\s*grupoOk/.test(execBody)) {
  falhas.push('execute() nao deriva sucesso de taskOk || moveOk || grupoOk (pode estar reportando sucesso:true incondicional)');
}

// 6. Marcador de erro inconfundivel quando nenhum canal humano-visivel foi
// acionado (task, move e grupo falharam).
if (!/\[escalate-to-human\]\[SEM-SINAL-HUMANO\]/.test(src)) {
  falhas.push('marcador [escalate-to-human][SEM-SINAL-HUMANO] nao encontrado - falha total pode estar sendo reportada como sucesso silencioso');
}

// 7. acionarHumanoGarantido captura o retorno real das tools reusadas (nao
// apenas dispara e ignora) - declara retorno { taskOk, moveOk }.
if (!/return\s*\{\s*taskOk/.test(src)) {
  falhas.push('acionarHumanoGarantido nao declara retorno { taskOk, ... } - pode estar descartando o resultado real do acionamento');
}

// 7b. (CR-01/CR-02, 3a rodada) NENHUMA camada de escalate-to-human.ts nem
// de create-task.ts pode usar jaNotificouRecentemente (registra a janela
// ANTES da tentativa que pode falhar -> retry devolve sucesso fake). As
// duas precisam do split consultarNotificacao/registrarNotificacao.
// (comentarios explicando o padrao antigo sao ok - testa codigo real.)
const createTaskSemComentarios = createTaskSrc.replace(/\/\/.*$/gm, '');
if (/jaNotificouRecentemente/.test(srcSemComentarios)) {
  falhas.push('escalate-to-human.ts ainda usa jaNotificouRecentemente (register-before-attempt) - retry pos-falha devolve sucesso fake (CR-02)');
}
if (/jaNotificouRecentemente/.test(createTaskSemComentarios)) {
  falhas.push('create-task.ts ainda usa jaNotificouRecentemente (register-before-attempt) - retry pos-falha devolve {sucesso:true} fake (CR-01)');
}
if (!/import\s*\{\s*consultarNotificacao,\s*registrarNotificacao\s*\}\s*from\s*['"]\.\.\/notificacoes['"]/.test(createTaskSrc)) {
  falhas.push("create-task.ts nao importa { consultarNotificacao, registrarNotificacao } de '../notificacoes' (split consult/register ausente)");
}
// Ordem dentro de create-task.ts: consulta -> POST (fetchTimeout) -> res.ok
// -> registrarNotificacao (registro SO apos sucesso real do POST).
{
  const idxConsulta = createTaskSrc.indexOf('consultarNotificacao(telefone, `create-task:${titulo}`)');
  const idxFetch = createTaskSrc.indexOf('await fetchTimeout(');
  const idxResOk = createTaskSrc.indexOf('if (!res.ok)');
  const idxRegistro = createTaskSrc.indexOf('registrarNotificacao(telefone, `create-task:${titulo}`)');
  if (idxConsulta === -1) falhas.push('create-task.ts: consultarNotificacao(telefone, `create-task:${titulo}`) nao encontrado');
  if (idxRegistro === -1) falhas.push('create-task.ts: registrarNotificacao(telefone, `create-task:${titulo}`) nao encontrado');
  if (idxConsulta !== -1 && idxFetch !== -1 && idxConsulta > idxFetch) {
    falhas.push('create-task.ts: consulta de idempotencia aparece DEPOIS do fetch (deveria vir antes da tentativa)');
  }
  if (idxRegistro !== -1 && idxResOk !== -1 && idxRegistro < idxResOk) {
    falhas.push('create-task.ts: registrarNotificacao aparece ANTES da checagem res.ok (registro deve ser SO apos sucesso real do POST)');
  }
}
// notificarGrupoSuporte: consulta -> enviarAvisoAoSuporte -> registro.
{
  const idxConsultaGrupo = src.indexOf('consultarNotificacao(telefone, `escalate:${motivo}`)');
  const idxEnvioGrupo = src.indexOf('await enviarAvisoAoSuporte(');
  const idxRegistroGrupo = src.indexOf('registrarNotificacao(telefone, `escalate:${motivo}`)');
  if (idxConsultaGrupo === -1) falhas.push('notificarGrupoSuporte: consultarNotificacao(telefone, `escalate:${motivo}`) nao encontrado (split CR-02 ausente)');
  if (idxRegistroGrupo === -1) falhas.push('notificarGrupoSuporte: registrarNotificacao(telefone, `escalate:${motivo}`) nao encontrado (split CR-02 ausente)');
  if (idxConsultaGrupo !== -1 && idxEnvioGrupo !== -1 && idxRegistroGrupo !== -1
      && !(idxConsultaGrupo < idxEnvioGrupo && idxEnvioGrupo < idxRegistroGrupo)) {
    falhas.push('notificarGrupoSuporte: ordem esperada consulta -> enviarAvisoAoSuporte -> registro nao confirmada (registro deve ser SO apos entrega real)');
  }
}
// 7c. (WR-02) chaves de idempotencia POR CANAL no acionamento garantido.
if (!/escalate-task:/.test(src) || !/escalate-move:/.test(src)) {
  falhas.push('acionarHumanoGarantido nao usa chaves por canal (escalate-task:/escalate-move:) - sucesso parcial volta a travar o retry do canal falhado (WR-02)');
}

// 7d. (05-03, HARD-05) INVARIANTE DE CRISE: as 3 chamadas GHL do protocolo
// de escalacao (task, move, aviso ao grupo) precisam estar envolvidas por
// chamarComResiliencia com {crise:true} - o bypass que garante que o
// breaker('ghl') NUNCA bloqueia a escalacao de sofrimento agudo (CVV 188).
if (!/import\s*\{\s*chamarComResiliencia\s*\}\s*from\s*['"]\.\.\/resiliencia['"]/.test(src)) {
  falhas.push('escalate-to-human.ts nao importa chamarComResiliencia de ../resiliencia (bypass de crise HARD-05 ausente)');
}
const ocorrenciasCriseBypass = (src.match(/chamarComResiliencia\([\s\S]{0,200}?crise:\s*true/g) || []).length;
if (ocorrenciasCriseBypass < 3) {
  falhas.push(
    `escalate-to-human.ts deveria envolver as 3 chamadas GHL de crise (task/move/grupo) com chamarComResiliencia({crise:true}), encontrado ${ocorrenciasCriseBypass}`,
  );
}

// ---------------------------------------------------------------------
// 8. Prova COMPORTAMENTAL do caminho de FALHA: extrai o corpo real de
// `acionarHumanoGarantido` e executa via AsyncFunction, injetando stubs.
// ---------------------------------------------------------------------
const fnMatch = src.match(
  /async function acionarHumanoGarantido\([\s\S]*?\)\s*:\s*Promise<AcionamentoResultado>\s*\{([\s\S]*?)\n\}/,
);

if (!fnMatch) {
  falhas.push('nao foi possivel extrair o corpo de acionarHumanoGarantido (assinatura mudou?) - prova comportamental pulada');
} else {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  // O corpo extraido e TypeScript (nao JS puro) - a AsyncFunction constructor
  // so aceita JS. Remove as anotacoes TS-only que aparecem neste corpo
  // especifico (nao um transpiler generico - so o que existe aqui):
  // non-null assertion (`.execute!(`) e cast `as any`.
  const corpo = fnMatch[1].replace(/\.execute!\(/g, '.execute(').replace(/\s+as\s+any/g, '');

  // 05-03 (HARD-05): acionarHumanoGarantido agora envolve createTask.execute
  // e movePipelineStage.execute com chamarComResiliencia(fn, {recurso:'ghl',
  // crise:true}) — o bypass de crise SO adiciona timeout em volta de fn (nao
  // muda a logica de sucesso/retry), entao o stub aqui e um passthrough fiel
  // ao comportamento real com crise:true (sempre executa fn, sem breaker).
  const chamarComResilienciaStub = async (fn) => fn();

  function montarAcionarHumanoGarantido({ createTaskSucesso, moveSucesso }) {
    const registrarChamadas = [];
    const createTaskStub = {
      execute: async () => (createTaskSucesso ? { sucesso: true } : { sucesso: false, motivo: 'stub' }),
    };
    const movePipelineStageStub = {
      execute: async () => (moveSucesso ? { sucesso: true } : { sucesso: false, motivo: 'stub' }),
    };
    const consultarNotificacaoStub = () => false; // nunca "ja notificado" nos cenarios de teste
    const registrarNotificacaoStub = (telefone, chave) => registrarChamadas.push({ telefone, chave });
    const rotularMotivoStub = (motivo) => motivo;

    const fn = new AsyncFunction(
      'telefone',
      'motivo',
      'resumo',
      'consultarNotificacao',
      'registrarNotificacao',
      'createTask',
      'movePipelineStage',
      'rotularMotivo',
      'chamarComResiliencia',
      corpo,
    );

    const run = (telefone, motivo, resumo) =>
      fn(telefone, motivo, resumo, consultarNotificacaoStub, registrarNotificacaoStub, createTaskStub, movePipelineStageStub, rotularMotivoStub, chamarComResilienciaStub);

    return { run, registrarChamadas };
  }

  try {
    // 8a. Caminho de FALHA TOTAL: createTask e movePipelineStage retornam
    // {sucesso:false}. Esperado: {taskOk:false, moveOk:false} e
    // registrarNotificacao NAO chamado (idempotencia nao consumida - retry
    // permitido na proxima chamada).
    const falhaTotal = montarAcionarHumanoGarantido({ createTaskSucesso: false, moveSucesso: false });
    const resultadoFalha = await falhaTotal.run('5511999998888', 'sofrimento_agudo', 'lead em crise, teste smoke');

    if (resultadoFalha?.taskOk !== false || resultadoFalha?.moveOk !== false) {
      falhas.push(
        `caminho de falha: esperado {taskOk:false,moveOk:false}, recebido ${JSON.stringify(resultadoFalha)}`,
      );
    }
    if (falhaTotal.registrarChamadas.length !== 0) {
      falhas.push(
        'caminho de falha: registrarNotificacao foi chamado mesmo com createTask/movePipelineStage retornando sucesso:false (idempotencia consumida indevidamente - impede retry)',
      );
    }

    // 8b. Caminho de SUCESSO: createTask retorna {sucesso:true}. Esperado:
    // taskOk===true e registrarNotificacao chamado (janela marcada apos
    // sucesso real).
    const sucessoParcial = montarAcionarHumanoGarantido({ createTaskSucesso: true, moveSucesso: false });
    const resultadoSucesso = await sucessoParcial.run('5511999998888', 'sofrimento_agudo', 'lead em crise, teste smoke');

    if (resultadoSucesso?.taskOk !== true) {
      falhas.push(`caminho de sucesso parcial: esperado taskOk===true, recebido ${JSON.stringify(resultadoSucesso)}`);
    }
    if (sucessoParcial.registrarChamadas.length === 0) {
      falhas.push('caminho de sucesso parcial: registrarNotificacao nao foi chamado apos createTask retornar sucesso:true');
    }

    // 8c. (WR-02, 3a rodada) idempotencia POR CANAL com cache ESTATEFUL:
    // chamada 1 = task ok + move falha -> retorno honesto {taskOk:true,
    // moveOk:false}; chamada 2 (move consertado) -> re-tenta SO o move
    // (task nao e re-criada: cache hit por canal) e retorna
    // {taskOk:true, moveOk:true} com verdade por-canal, nao hardcoded.
    {
      const cache = new Set();
      const contadores = { task: 0, move: 0 };
      const flags = { taskSucesso: true, moveSucesso: false };
      const createTaskStub = {
        execute: async () => {
          contadores.task += 1;
          return flags.taskSucesso ? { sucesso: true } : { sucesso: false, motivo: 'stub' };
        },
      };
      const movePipelineStageStub = {
        execute: async () => {
          contadores.move += 1;
          return flags.moveSucesso ? { sucesso: true } : { sucesso: false, motivo: 'stub' };
        },
      };
      const consultarStateful = (telefone, chave) => cache.has(`${telefone}:${chave}`);
      const registrarStateful = (telefone, chave) => cache.add(`${telefone}:${chave}`);
      const fnStateful = new AsyncFunction(
        'telefone', 'motivo', 'resumo',
        'consultarNotificacao', 'registrarNotificacao',
        'createTask', 'movePipelineStage', 'rotularMotivo',
        'chamarComResiliencia',
        corpo,
      );
      const runStateful = (t, m, r) =>
        fnStateful(t, m, r, consultarStateful, registrarStateful, createTaskStub, movePipelineStageStub, (x) => x, chamarComResilienciaStub);

      const r1 = await runStateful('5511999998888', 'sofrimento_agudo', 'teste WR-02 parcial');
      if (r1?.taskOk !== true || r1?.moveOk !== false) {
        falhas.push(`WR-02 chamada 1 (task ok, move falha): esperado {taskOk:true,moveOk:false}, recebido ${JSON.stringify(r1)}`);
      }
      flags.moveSucesso = true; // "GHL voltou" pro canal do move
      const r2 = await runStateful('5511999998888', 'sofrimento_agudo', 'teste WR-02 retry do move');
      if (r2?.taskOk !== true || r2?.moveOk !== true) {
        falhas.push(`WR-02 chamada 2 (retry do move): esperado {taskOk:true,moveOk:true}, recebido ${JSON.stringify(r2)}`);
      }
      if (contadores.task !== 1) {
        falhas.push(`WR-02: createTask deveria rodar 1x (cache hit por canal na 2a chamada), rodou ${contadores.task}x`);
      }
      if (contadores.move !== 2) {
        falhas.push(`WR-02: movePipelineStage deveria rodar 2x (retry do canal falhado), rodou ${contadores.move}x`);
      }
    }
  } catch (e) {
    falhas.push(`prova comportamental lancou excecao inesperada: ${e?.stack || e}`);
  }
}

// ---------------------------------------------------------------------
// 9. (CR-01, 3a rodada) Prova COMPORTAMENTAL da CAMADA INTERNA: corpo REAL
// de createTask.execute (create-task.ts) com fetch stub. E exatamente a
// camada que a versao anterior deste smoke stubava por inteiro — o bug do
// register-before-attempt vivia aqui e passava despercebido.
// ---------------------------------------------------------------------
const execCreateTaskMatch = createTaskSrc.match(
  /execute:\s*async\s*\(\{\s*telefone,\s*titulo,\s*corpo,\s*bantTotal\s*\}\)\s*=>\s*\{([\s\S]*?)\n  \},\n\}\);/,
);

if (!execCreateTaskMatch) {
  falhas.push('nao foi possivel extrair o corpo de createTask.execute (assinatura mudou?) - prova comportamental da camada interna pulada');
} else {
  const AsyncFunctionCT = Object.getPrototypeOf(async () => {}).constructor;
  const corpoCreateTask = execCreateTaskMatch[1];

  function montarCreateTask() {
    const cache = new Set();
    const registrarChamadas = [];
    const estado = { fetchOk: false, fetchCalls: 0 };
    const consultar = (telefone, chave) => cache.has(`${telefone}:${chave}`);
    const registrar = (telefone, chave) => {
      registrarChamadas.push({ telefone, chave });
      cache.add(`${telefone}:${chave}`);
    };
    const fetchTimeoutStub = async () => {
      estado.fetchCalls += 1;
      return estado.fetchOk
        ? { ok: true, text: async () => '{}' }
        : { ok: false, status: 500, text: async () => 'stub: GHL fora do ar' };
    };
    const fn = new AsyncFunctionCT(
      'telefone', 'titulo', 'corpo', 'bantTotal',
      'consultarNotificacao', 'registrarNotificacao',
      'GHL_PIT_TOKEN', 'buscarContactIdPorTelefone', 'prioridadePorBant',
      'fetchTimeout', 'GHL_BASE_URL', 'GHL_API_VERSION_V2',
      corpoCreateTask,
    );
    const run = (telefone, titulo) =>
      fn(
        telefone, titulo, 'corpo de teste', 12,
        consultar, registrar,
        'stub-pit-token', async () => 'contact-stub-123',
        () => ({ prioridade: 'URGENTE', horas: 2 }),
        fetchTimeoutStub, 'http://stub.local', 'v2',
      );
    return { run, registrarChamadas, estado };
  }

  try {
    // 9a. FALHA TOTAL + RETRY: com o POST falhando, a 1a chamada retorna
    // {sucesso:false}; a 2a chamada (retry, mesmo titulo) precisa
    // RE-TENTAR o POST de verdade (fetchCalls===2) e retornar
    // {sucesso:false} de novo — NAO um {sucesso:true} fake de cache.
    // registrarNotificacao nunca pode rodar sem sucesso real.
    const cenarioFalha = montarCreateTask();
    const f1 = await cenarioFalha.run('5511999998888', 'ESCALACAO URGENTE - teste');
    const f2 = await cenarioFalha.run('5511999998888', 'ESCALACAO URGENTE - teste');
    if (f1?.sucesso !== false) {
      falhas.push(`create-task falha 1a chamada: esperado {sucesso:false}, recebido ${JSON.stringify(f1)}`);
    }
    if (f2?.sucesso !== false) {
      falhas.push(`create-task RETRY apos falha: esperado {sucesso:false} honesto, recebido ${JSON.stringify(f2)} (sucesso fake de cache = CR-01 reintroduzido)`);
    }
    if (cenarioFalha.estado.fetchCalls !== 2) {
      falhas.push(`create-task RETRY apos falha: POST deveria ser re-tentado (2 fetches), houve ${cenarioFalha.estado.fetchCalls} (janela consumida antes do sucesso = CR-01)`);
    }
    if (cenarioFalha.registrarChamadas.length !== 0) {
      falhas.push('create-task: registrarNotificacao rodou sem nenhum POST bem-sucedido (registro antes do sucesso real = CR-01)');
    }

    // 9b. SUCESSO + IDEMPOTENCIA LEGITIMA: com o POST ok, a 1a chamada
    // registra a janela; a 2a chamada e no-op honesto (sem novo POST).
    const cenarioSucesso = montarCreateTask();
    cenarioSucesso.estado.fetchOk = true;
    const s1 = await cenarioSucesso.run('5511999998888', 'ESCALACAO URGENTE - teste');
    const s2 = await cenarioSucesso.run('5511999998888', 'ESCALACAO URGENTE - teste');
    if (s1?.sucesso !== true) {
      falhas.push(`create-task sucesso 1a chamada: esperado {sucesso:true}, recebido ${JSON.stringify(s1)}`);
    }
    if (cenarioSucesso.registrarChamadas.length !== 1) {
      falhas.push(`create-task sucesso: registrarNotificacao deveria rodar exatamente 1x apos res.ok, rodou ${cenarioSucesso.registrarChamadas.length}x`);
    }
    if (s2?.sucesso !== true || cenarioSucesso.estado.fetchCalls !== 1) {
      falhas.push(`create-task idempotencia legitima: 2a chamada apos sucesso real deveria ser no-op {sucesso:true} sem novo POST (fetches=${cenarioSucesso.estado.fetchCalls}, retorno=${JSON.stringify(s2)})`);
    }
  } catch (e) {
    falhas.push(`prova comportamental da camada interna (create-task) lancou excecao inesperada: ${e?.stack || e}`);
  }
}

if (falhas.length > 0) {
  console.error('[smoke-escalacao] CAM-05/TOOL-09 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-escalacao] CAM-05/TOOL-09 OK');
