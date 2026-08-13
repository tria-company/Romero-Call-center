#!/usr/bin/env node
// scripts/streaming-transcricao.smoke.mjs
//
// Smoke HERMETICO (sem rede, sem DEEPGRAM_API_KEY) do streaming
// download->upload de transcreverBytes (RESIL-05/D-07, Fase 09 Plano 02):
// monkeypatcha globalThis.fetch pra provar, sem tocar a rede real, as 3
// branches introduzidas na Task 1:
//
//   A) streaming — Content-Length presente no download: o upload usa
//      dl.body (ReadableStream) como body, com duplex:'half' e o header
//      Content-Length repassado do download (D-07).
//   B) fallback — Content-Length ausente no download: o upload cai pro
//      arrayBuffer() completo, sem duplex e sem Content-Length manual
//      (preserva o fix do 411 quando o header nao esta disponivel).
//   C) cleanup em erro — a branch de streaming, quando o upload lanca no
//      meio do pipe, cancela o ReadableStream do download antes de
//      retornar null (T-09-06 — sem vazamento de stream/socket).
//
// Padrao (analog scripts/deepgram-411-fallback.smoke.mjs): import dinamico
// direto do fonte via `node --experimental-strip-types` (funciona porque
// deepgram.ts usa imports internos com extensao `.ts`, resolviveis
// standalone). transcreverBytes NAO checa DEEPGRAM_API_KEY, entao roda sem
// .env.
//
// Uso: node --experimental-strip-types scripts/streaming-transcricao.smoke.mjs
// Seguranca/LGPD: nao faz rede nenhuma (fetch e monkeypatchado com stubs
// locais); nunca imprime process.env.

const { transcreverBytes, montarParamsListen } = await import('../src/mastra/deepgram.ts');

const fetchOriginal = globalThis.fetch;

/** Devolve um ReadableStream simples com 1 chunk, e opcionalmente rastreia cancel(). */
function criarStreamFake(onCancel) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
    cancel(reason) {
      if (onCancel) onCancel(reason);
    },
  });
}

const RESPOSTA_TRANSCRICAO_OK = {
  ok: true,
  status: 200,
  json: async () => ({
    results: { channels: [{ alternatives: [{ transcript: 'ola mundo' }] }] },
  }),
};

async function checarStreaming() {
  console.log('\n[A/3] streaming — Content-Length presente no download...');
  let capturedInit = null;
  let chamada = 0;
  const streamDownload = criarStreamFake();

  globalThis.fetch = async (_url, init) => {
    chamada += 1;
    if (chamada === 1) {
      // GET download
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/mpeg', 'content-length': '3' }),
        body: streamDownload,
        arrayBuffer: async () => {
          throw new Error('nao deveria chamar arrayBuffer() na branch de streaming');
        },
      };
    }
    // POST upload
    capturedInit = init;
    return RESPOSTA_TRANSCRICAO_OK;
  };

  try {
    const params = montarParamsListen();
    const t = await transcreverBytes('exemplo.invalido/audio.mp3 (sem protocolo — evita URL real no smoke)', params);
    if (!t || typeof t !== 'string' || t.trim().length === 0) {
      throw new Error('transcript vazio/null na branch de streaming');
    }
    if (capturedInit?.duplex !== 'half') {
      throw new Error(`duplex esperado 'half', recebido: ${capturedInit?.duplex}`);
    }
    const headersUpload = new Headers(capturedInit.headers);
    if (headersUpload.get('content-length') !== '3') {
      throw new Error(`content-length esperado '3', recebido: ${headersUpload.get('content-length')}`);
    }
    if (capturedInit.body !== streamDownload) {
      throw new Error('body do upload nao e o MESMO ReadableStream do download (identidade)');
    }
    console.log(`  PASS streaming: duplex=half content-length=3 body=identico transcript.chars=${t.length}`);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

async function checarFallback() {
  console.log('\n[B/3] fallback — Content-Length ausente no download...');
  let capturedInit = null;
  let chamada = 0;

  globalThis.fetch = async (_url, init) => {
    chamada += 1;
    if (chamada === 1) {
      // GET download SEM content-length
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/mpeg' }),
        body: criarStreamFake(),
        arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer,
      };
    }
    // POST upload
    capturedInit = init;
    return RESPOSTA_TRANSCRICAO_OK;
  };

  try {
    const params = montarParamsListen();
    const t = await transcreverBytes('exemplo.invalido/audio.mp3 (sem protocolo — evita URL real no smoke)', params);
    if (!t || typeof t !== 'string' || t.trim().length === 0) {
      throw new Error('transcript vazio/null na branch de fallback');
    }
    if (capturedInit?.duplex !== undefined) {
      throw new Error(`duplex esperado undefined no fallback, recebido: ${capturedInit?.duplex}`);
    }
    const ehArrayBuffer = capturedInit.body instanceof ArrayBuffer || ArrayBuffer.isView(capturedInit.body);
    if (!ehArrayBuffer) {
      throw new Error('body do upload deveria ser ArrayBuffer/typed array no fallback, nao ReadableStream');
    }
    console.log(`  PASS fallback: sem duplex, body=buffer transcript.chars=${t.length}`);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

async function checarCleanupEmErro() {
  console.log('\n[C/3] cleanup em erro — upload lanca no meio do pipe (streaming)...');
  let cancelado = false;
  let chamada = 0;
  const streamDownload = criarStreamFake(() => {
    cancelado = true;
  });

  globalThis.fetch = async (_url, _init) => {
    chamada += 1;
    if (chamada === 1) {
      // GET download com content-length (entra na branch de streaming)
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/mpeg', 'content-length': '3' }),
        body: streamDownload,
        arrayBuffer: async () => {
          throw new Error('nao deveria chamar arrayBuffer() na branch de streaming');
        },
      };
    }
    // POST upload lanca (falha no meio do pipe)
    throw new Error('boom');
  };

  try {
    const params = montarParamsListen();
    const t = await transcreverBytes('exemplo.invalido/audio.mp3 (sem protocolo — evita URL real no smoke)', params);
    if (t !== null) {
      throw new Error(`esperado null (fail-open) apos erro no upload, recebido: ${t}`);
    }
    if (!cancelado) {
      throw new Error('stream de download nao foi cancelado apos erro no upload (T-09-06)');
    }
    console.log('  PASS cleanup: transcreverBytes retornou null e cancelado=true');
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

async function main() {
  console.log('=== Smoke Deepgram — streaming download->upload (Fase 09 Plano 02, RESIL-05) ===');
  await checarStreaming();
  await checarFallback();
  await checarCleanupEmErro();
  console.log('\n=== RESULTADO: PASS — streaming, fallback e cleanup em erro provados (sem rede) ===');
  process.exit(0);
}

main().catch((e) => {
  globalThis.fetch = fetchOriginal;
  console.error(`\n=== RESULTADO: FAIL — ${e?.message || e} ===`);
  process.exit(1);
});
