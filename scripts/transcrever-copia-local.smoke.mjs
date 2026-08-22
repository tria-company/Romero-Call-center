#!/usr/bin/env node
// scripts/transcrever-copia-local.smoke.mjs
//
// Smoke HERMETICO (sem rede, sem envs reais) da Fase 19.1 Plano 03 (DUR-05/
// DUR-06, C4 do CONTEXT.md) — resolve a descoberta de 22/08 (18 gravacoes
// presas com "transcricao falhou" generico, sem causa isolada). Monkeypatcha
// `globalThis.fetch` (mesmo seam de scripts/streaming-transcricao.smoke.mjs)
// pra provar, sem tocar rede real:
//
//   PARTE A — src/mastra/deepgram.ts: transcreverGravacaoLocal(fonte, params)
//     A1) sucesso: bytes/stream validos -> devolve transcript rotulado,
//         streaming via duplex:'half' + Content-Length repassado da nossa
//         copia (nunca materializa o ReadableStream inteiro).
//     A2) falha HTTP do Deepgram (400) -> LANCA Error com "(400)" na mensagem.
//     A3) transcript vazio no payload -> LANCA Error "transcript vazio".
//     A4) mensagem e LGPD-safe: host FIXO da Deepgram (nunca telefone/URL
//         assinada — a funcao nem recebe recordUrl/telefone, so `fonte`
//         (stream+headers) e `params`).
//
//   PARTE B — src/mastra/processador.ts: processarRecordJob (record path)
//     B1) guardarGravacao roda ANTES de transcrever: se a copia propria falha
//         (download da nossa copia), o POST pro Deepgram NUNCA acontece — e o
//         erro relancado carrega a causa (classificarErro rotula certo).
//     B2) fluxo completo (copia OK, baixarGravacao OK) com falha SO no
//         Deepgram (400): confirma a ORDEM das 6 chamadas HTTP (existencia ->
//         bucket -> download -> upload -> baixarGravacao -> Deepgram) e que o
//         erro relancado por processarRecordJob preserva a causa especifica
//         (classificarErro -> permanente/deepgram), nao mais o "transcricao
//         falhou call=..." generico de antes.
//
// Env fake definido ANTES do import (config.ts le process.env na carga do
// modulo) — nunca a instancia real. REDIS_URL fica AUSENTE de proposito:
// estado-webhook.ts cai no modo 'memoria' (recordJaProcessado sem rede).
//
// Uso: node --experimental-strip-types scripts/transcrever-copia-local.smoke.mjs

process.env.SUPABASE_URL ||= 'https://smoke.invalido.local';
process.env.SUPABASE_SERVICE_KEY ||= 'smoke-fake-service-key';
process.env.SUPABASE_STORAGE_BUCKET_GRAVACOES ||= 'gravacoes';

const { transcreverGravacaoLocal, montarParamsListen } = await import('../src/mastra/deepgram.ts');
const { processarRecordJob } = await import('../src/mastra/processador.ts');
const { classificarErro } = await import('../src/mastra/classificar-erro.ts');

const fetchOriginal = globalThis.fetch;

const falhas = [];
function checar(condicao, mensagem) {
  if (condicao) {
    console.log('  ✅', mensagem);
  } else {
    console.error('  ❌', mensagem);
    falhas.push(mensagem);
  }
}

function streamFake(bytes = new Uint8Array([1, 2, 3])) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Monkeypatcha globalThis.fetch com uma fila de respostas por sequencia de chamada; restaura no finally do chamador. */
function criarFetchGlobalRoteirizado(respostas) {
  const chamadas = [];
  globalThis.fetch = async (url, init = {}) => {
    chamadas.push({ url: String(url), init });
    const proxima = respostas[chamadas.length - 1];
    if (!proxima) throw new Error(`smoke: chamada inesperada #${chamadas.length} -> ${url}`);
    if (typeof proxima === 'function') return proxima(url, init);
    return proxima;
  };
  return chamadas;
}

// ===== PARTE A — transcreverGravacaoLocal =====

async function testeA1_sucessoStreaming() {
  console.log("\n[A1] transcreverGravacaoLocal — sucesso streaming (Content-Length presente)...");
  const stream = streamFake();
  const chamadas = criarFetchGlobalRoteirizado([
    {
      ok: true,
      status: 200,
      json: async () => ({
        results: { channels: [{ alternatives: [{ transcript: 'ola gabinete' }] }] },
      }),
    },
  ]);
  try {
    const fonte = { stream, contentType: 'audio/mpeg', contentLength: '3' };
    const t = await transcreverGravacaoLocal(fonte, montarParamsListen());
    checar(typeof t === 'string' && t.trim().length > 0, `deveria devolver transcript nao-vazio, recebido: ${JSON.stringify(t)}`);
    checar(chamadas.length === 1, `esperava 1 chamada (POST /v1/listen), recebeu ${chamadas.length}`);
    const init = chamadas[0].init;
    checar(init?.duplex === 'half', `streaming deveria usar duplex:'half', recebido ${init?.duplex}`);
    checar(init?.body === stream, 'body do upload deveria ser o MESMO ReadableStream da fonte (identidade, sem materializar)');
    const headersUpload = new Headers(init?.headers);
    checar(headersUpload.get('content-length') === '3', `Content-Length deveria ser repassado da fonte, recebido ${headersUpload.get('content-length')}`);
    checar(chamadas[0].url.includes('api.deepgram.com/v1/listen'), `URL deveria ser o /v1/listen da Deepgram, recebido ${chamadas[0].url}`);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

async function testeA2_falhaHttpComStatus() {
  console.log('\n[A2] transcreverGravacaoLocal — falha HTTP do Deepgram (400) LANCA com status na mensagem...');
  criarFetchGlobalRoteirizado([
    { ok: false, status: 400, text: async () => 'Bad audio format' },
  ]);
  try {
    const fonte = { stream: streamFake(), contentType: 'audio/mpeg', contentLength: '3' };
    await transcreverGravacaoLocal(fonte, montarParamsListen());
    checar(false, 'deveria LANCAR em POST nao-ok (400)');
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    checar(mensagem.includes('(400)'), `mensagem deveria carregar o status (400), recebido: "${mensagem}"`);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

async function testeA3_transcriptVazio() {
  console.log('\n[A3] transcreverGravacaoLocal — payload sem transcript LANCA "transcript vazio"...');
  criarFetchGlobalRoteirizado([
    { ok: true, status: 200, json: async () => ({ results: { channels: [] } }) },
  ]);
  try {
    const fonte = { stream: streamFake(), contentType: 'audio/mpeg', contentLength: '3' };
    await transcreverGravacaoLocal(fonte, montarParamsListen());
    checar(false, 'deveria LANCAR quando o payload nao tem transcript');
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    checar(mensagem.includes('transcript vazio'), `mensagem deveria dizer "transcript vazio", recebido: "${mensagem}"`);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

async function testeA4_mensagemLgpdSafe() {
  console.log('\n[A4] transcreverGravacaoLocal — mensagem de erro e LGPD-safe (host fixo, sem telefone/URL assinada)...');
  criarFetchGlobalRoteirizado([
    { ok: false, status: 500, text: async () => 'internal error' },
  ]);
  try {
    const fonte = { stream: streamFake(), contentType: 'audio/mpeg', contentLength: '3' };
    await transcreverGravacaoLocal(fonte, montarParamsListen());
    checar(false, 'deveria LANCAR em 500');
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    checar(mensagem.includes('host=api.deepgram.com'), `mensagem deveria carregar host FIXO da Deepgram, recebido: "${mensagem}"`);
    checar(!/\d{2,3}9?\d{7,8}/.test(mensagem), 'mensagem nunca deveria conter algo parecido com telefone (LGPD)');
    checar(!mensagem.includes('storage.wavoip'), 'mensagem nunca deveria conter o storage terceiro (a funcao nem recebe a record_url)');
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

// ===== PARTE B — processarRecordJob (record path) =====

function dadosJobRecord(callId, recordUrl) {
  return {
    whatsappCallId: callId,
    telefone: '5511999999999',
    recordUrl,
    payload: {},
    eventoDuravelId: null,
    deviceId: undefined,
  };
}

async function testeB1_guardarGravacaoAntesDeTranscrever() {
  console.log('\n[B1] processarRecordJob — falha na copia propria: Deepgram NUNCA e chamado (ordem)...');
  const chamadas = criarFetchGlobalRoteirizado([
    { ok: false, status: 404, headers: new Headers({}) }, // HEAD do object -> nao existe
    { ok: true, status: 200, headers: new Headers({}) }, // GET bucket -> ja existe (no-op)
    () => { throw new Error('mock: rede caiu ao baixar a gravacao do storage'); }, // GET record_url (download) -> falha de rede
  ]);
  try {
    await processarRecordJob(dadosJobRecord('call-b1', 'https://storage.exemplo.invalido/audio-b1.mp3'));
    checar(false, 'processarRecordJob deveria LANCAR quando guardarGravacao falha');
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    checar(chamadas.length === 3, `so deveriam ter acontecido as 3 chamadas da copia propria (nada de Deepgram), recebeu ${chamadas.length}`);
    checar(
      !chamadas.some((c) => c.url.includes('deepgram')),
      'Deepgram NUNCA deveria ser chamado quando a copia propria falha (guardarGravacao roda ANTES de transcrever)',
    );
    const classificado = classificarErro(mensagem);
    checar(classificado.tipo === 'transitorio', `falha de rede na copia deveria classificar transitorio, recebido ${classificado.tipo}`);
    checar(classificado.origem === 'storage', `origem deveria ser storage, recebido ${classificado.origem}`);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

async function testeB2_ordemCompletaECausaPreservada() {
  console.log('\n[B2] processarRecordJob — copia+baixar OK, Deepgram falha (400): ordem das 6 chamadas + causa preservada...');
  const streamDownload = streamFake();
  const streamCopia = streamFake();
  const chamadas = criarFetchGlobalRoteirizado([
    { ok: false, status: 404, headers: new Headers({}) }, // 1) HEAD do object -> nao existe
    { ok: true, status: 200, headers: new Headers({}) }, // 2) GET bucket -> ja existe (no-op)
    {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mpeg', 'content-length': '3' }),
      body: streamDownload,
    }, // 3) GET record_url (download da copia)
    { ok: true, status: 200, headers: new Headers({}) }, // 4) POST upload da copia
    {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mpeg', 'content-length': '3' }),
      body: streamCopia,
    }, // 5) GET baixarGravacao (le a NOSSA copia de volta)
    { ok: false, status: 400, text: async () => 'audio invalido' }, // 6) POST /v1/listen Deepgram -> falha permanente
  ]);
  try {
    await processarRecordJob(dadosJobRecord('call-b2', 'https://storage.exemplo.invalido/audio-b2.mp3'));
    checar(false, 'processarRecordJob deveria LANCAR quando o Deepgram falha (causa preservada, nao o generico de antes)');
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    checar(chamadas.length === 6, `esperava as 6 chamadas na ordem certa (copia -> baixar -> deepgram), recebeu ${chamadas.length}`);

    const idxDeepgram = chamadas.findIndex((c) => c.url.includes('deepgram'));
    checar(idxDeepgram === 5, `POST ao Deepgram deveria ser a ULTIMA chamada (indice 5), recebido indice ${idxDeepgram}`);
    checar(
      chamadas.slice(0, 5).every((c) => !c.url.includes('deepgram')),
      'nenhuma chamada anterior a ultima deveria ser pro Deepgram (guardarGravacao/baixarGravacao rodam ANTES)',
    );

    checar(
      !mensagem.includes('transcricao falhou call='),
      `o throw generico de antes NAO deveria mais ser a mensagem — a causa especifica deve substitui-lo, recebido: "${mensagem}"`,
    );
    checar(mensagem.includes('(400)'), `mensagem re-lancada por processarRecordJob deveria preservar o status (400), recebido: "${mensagem}"`);

    const classificado = classificarErro(mensagem);
    checar(classificado.tipo === 'permanente', `400 do Deepgram deveria classificar permanente, recebido ${classificado.tipo}`);
    checar(classificado.origem === 'deepgram', `origem deveria ser deepgram, recebido ${classificado.origem}`);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

async function main() {
  console.log('=== Smoke transcricao da copia local — deepgram.ts + processador.ts (Fase 19.1 Plano 03, DUR-05/DUR-06) ===');
  await testeA1_sucessoStreaming();
  await testeA2_falhaHttpComStatus();
  await testeA3_transcriptVazio();
  await testeA4_mensagemLgpdSafe();
  await testeB1_guardarGravacaoAntesDeTranscrever();
  await testeB2_ordemCompletaECausaPreservada();

  if (falhas.length > 0) {
    console.error(`\n=== RESULTADO: FAIL — ${falhas.length} asserção(ões) falharam ===`);
    for (const f of falhas) console.error('  -', f);
    process.exit(1);
  }
  console.log('\n=== RESULTADO: PASS — transcreverGravacaoLocal (causa especifica) + ordem copia-antes-de-transcrever provadas (sem rede) ===');
  process.exit(0);
}

main().catch((e) => {
  globalThis.fetch = fetchOriginal;
  console.error(`\n=== RESULTADO: FAIL — ${e?.message || e} ===`);
  process.exit(1);
});
