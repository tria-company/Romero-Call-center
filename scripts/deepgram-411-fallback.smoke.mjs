#!/usr/bin/env node
// scripts/deepgram-411-fallback.smoke.mjs
//
// Smoke do fallback binario da Deepgram (quick-260811-n5l): prova os DOIS
// caminhos de transcricao — url-mode (feliz) e binario (fallback de bytes,
// o mesmo que o handler RECORD dispara quando o url-mode falha em 4xx, ex:
// 411 Length Required visto em producao) — importando deepgram.ts DIRETO do
// fonte (sem replicar logica, ao contrario de scripts/smoke-fundacao.mjs).
// Isso so funciona porque deepgram.ts agora usa imports internos com
// extensao `.ts` (`./config.ts`, `./http.ts`), resolviveis por
// `node --experimental-strip-types` standalone.
//
// Uso: node --env-file=.env --experimental-strip-types scripts/deepgram-411-fallback.smoke.mjs
// Requer rede + DEEPGRAM_API_KEY (no .env).
// LGPD: audio de teste e publico (https://dpgr.am/spacewalk.wav — amostra da
// propria Deepgram), sem PII de lead/call real.
// Seguranca: nunca imprime DEEPGRAM_API_KEY nem qualquer valor de process.env.
//
// Nota (descoberto rodando o smoke com a config REAL do .env): o audio
// publico de teste e em INGLES; DEEPGRAM_LANGUAGE de producao (sem override
// no .env, default 'pt' em config.ts — correto pra calls reais em
// portugues) forca decodificacao em portugues e a Deepgram devolve
// transcript VAZIO pra audio em ingles (confirmado via chamada direta a
// API: language=pt -> transcript="" ; language=multi -> transcript
// completo, mesma requisicao/audio). Isso NAO e bug em
// transcreverCallUrl/transcreverBytes — e mismatch entre o idioma do audio
// publico de teste e o idioma fixo de producao. Pra este smoke provar o
// pipeline REAL (download + re-POST de bytes + parse) sem tocar
// .env/config.ts/producao, sobrescreve DEEPGRAM_LANGUAGE=multi (deteccao
// automatica) so neste processo — e so quando o .env nao definiu o valor
// explicitamente — ANTES do import (por isso o import e dynamic/deferido).
if (!process.env.DEEPGRAM_LANGUAGE) process.env.DEEPGRAM_LANGUAGE = 'multi';
const { transcreverCallUrl, transcreverBytes, montarParamsListen } = await import(
  '../src/mastra/deepgram.ts'
);

const AUDIO = 'https://dpgr.am/spacewalk.wav';

async function checarUrlMode() {
  console.log('\n[1/2] caminho=url-mode — transcreverCallUrl(AUDIO)...');
  const t1 = await transcreverCallUrl(AUDIO);
  if (!t1 || typeof t1 !== 'string' || t1.trim().length === 0) {
    throw new Error('caminho=url-mode: transcript vazio/null');
  }
  console.log(`  PASS caminho=url-mode chars=${t1.length}`);
}

async function checarBinario() {
  console.log('\n[2/2] caminho=binario — transcreverBytes(AUDIO, params)...');
  const params = montarParamsListen();
  const t2 = await transcreverBytes(AUDIO, params);
  if (!t2 || typeof t2 !== 'string' || t2.trim().length === 0) {
    throw new Error('caminho=binario: transcript vazio/null');
  }
  console.log(`  PASS caminho=binario chars=${t2.length}`);
}

async function main() {
  console.log('=== Smoke Deepgram — fallback binario 4xx/411 (quick-260811-n5l) ===');
  await checarUrlMode();
  await checarBinario();
  console.log('\n=== RESULTADO: PASS — os dois caminhos (url-mode e binario) transcreveram ===');
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n=== RESULTADO: FAIL — ${e?.message || e} ===`);
  process.exit(1);
});
