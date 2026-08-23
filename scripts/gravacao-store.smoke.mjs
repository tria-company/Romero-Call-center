#!/usr/bin/env node
// scripts/gravacao-store.smoke.mjs
//
// Smoke offline (sem rede) do client de cópia própria da gravação
// (`src/mastra/gravacao-store.ts`, Fase 19.1 Plano 02, DUR-05). Injeta um
// `fetchImpl` fake determinístico em cada chamada (seam do próprio módulo —
// nenhum monkeypatch de `globalThis.fetch`), provando:
//
//   1. garantirBucketGravacoes cria o bucket como `public:false` quando GET
//      devolve 404, é no-op quando o bucket já existe (200) e quando o POST
//      de criação devolve 409 (corrida entre réplicas).
//   2. guardarGravacao é IDEMPOTENTE — HEAD 200 no object não re-baixa nem
//      re-sobe nada (nenhuma outra chamada acontece).
//   3. guardarGravacao usa POST em `/storage/v1/object/<bucket>/<path>` com
//      Content-Type/Content-Length repassados do header de download.
//   4. Uma falha 411 no download da record_url vira Error cuja mensagem
//      `classificarErro` (classificar-erro.ts) rotula transitório/'storage'.
//   5. caminhoGravacao é determinístico para o mesmo callId.
//
// Env fake (nunca a instância real) definido ANTES do import — config.ts lê
// process.env na carga do módulo. Determinístico, sem rede, PASS/FAIL claro,
// exit != 0 em falha. NUNCA imprime service key/URL (LGPD).
//
// Uso: node --experimental-strip-types scripts/gravacao-store.smoke.mjs

process.env.SUPABASE_URL ||= 'https://smoke.invalido.local';
process.env.SUPABASE_SERVICE_KEY ||= 'smoke-fake-service-key';
process.env.SUPABASE_STORAGE_BUCKET_GRAVACOES ||= 'gravacoes';

const { garantirBucketGravacoes, guardarGravacao, caminhoGravacao } = await import(
  '../src/mastra/gravacao-store.ts'
);
const { classificarErro } = await import('../src/mastra/classificar-erro.ts');

const falhas = [];
function checar(condicao, mensagem) {
  if (condicao) {
    console.log('  ✅', mensagem);
  } else {
    console.error('  ❌', mensagem);
    falhas.push(mensagem);
  }
}

function headersResposta(obj) {
  return new Headers(obj);
}

function streamFake(bytes = new Uint8Array([1, 2, 3])) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Roteador de respostas por sequência de chamadas — cada teste monta a própria fila. */
function criarFetchRoteirizado(respostas) {
  const chamadas = [];
  const fetchImpl = async (url, init = {}) => {
    chamadas.push({ url, init });
    const proxima = respostas[chamadas.length - 1];
    if (!proxima) throw new Error(`smoke: chamada inesperada #${chamadas.length} -> ${url}`);
    if (typeof proxima === 'function') return proxima(url, init);
    return proxima;
  };
  return { fetchImpl, chamadas };
}

// ===== 1) garantirBucketGravacoes =====

async function testeBucketCriaQuandoAusente() {
  console.log('\n[1a] garantirBucketGravacoes — GET 404 -> POST cria bucket public:false...');
  const { fetchImpl, chamadas } = criarFetchRoteirizado([
    { ok: false, status: 404, headers: headersResposta({}) },
    { ok: true, status: 200, headers: headersResposta({}) },
  ]);
  await garantirBucketGravacoes(fetchImpl);
  checar(chamadas.length === 2, `esperava 2 chamadas (GET+POST), recebeu ${chamadas.length}`);
  checar(chamadas[0].url.endsWith('/storage/v1/bucket/gravacoes'), `GET deveria ser no bucket, url=${chamadas[0].url}`);
  checar(chamadas[1].url.endsWith('/storage/v1/bucket'), `POST deveria ser na coleção de buckets, url=${chamadas[1].url}`);
  checar(chamadas[1].init?.method === 'POST', 'criação deveria ser POST');
  const corpo = JSON.parse(chamadas[1].init?.body ?? '{}');
  checar(corpo.id === 'gravacoes' && corpo.name === 'gravacoes', `corpo deveria ter id/name=gravacoes, recebido ${JSON.stringify(corpo)}`);
  checar(corpo.public === false, `bucket deveria ser criado PRIVADO (public:false, LGPD), recebido public=${corpo.public}`);
}

async function testeBucketNoOpQuandoJaExiste() {
  console.log('\n[1b] garantirBucketGravacoes — GET 200 -> no-op (sem POST)...');
  const { fetchImpl, chamadas } = criarFetchRoteirizado([
    { ok: true, status: 200, headers: headersResposta({}) },
  ]);
  await garantirBucketGravacoes(fetchImpl);
  checar(chamadas.length === 1, `esperava 1 chamada (só GET), recebeu ${chamadas.length}`);
}

async function testeBucketToleraCorridaNoPost() {
  console.log('\n[1c] garantirBucketGravacoes — GET 404 -> POST 409 (corrida) -> sucesso...');
  const { fetchImpl, chamadas } = criarFetchRoteirizado([
    { ok: false, status: 404, headers: headersResposta({}) },
    { ok: false, status: 409, headers: headersResposta({}), text: async () => 'Duplicate' },
  ]);
  await garantirBucketGravacoes(fetchImpl);
  checar(chamadas.length === 2, `esperava 2 chamadas (GET+POST), recebeu ${chamadas.length}`);
}

async function testeBucketAusenteSelfHosted400() {
  console.log('\n[1d] garantirBucketGravacoes — GET 400 corpo "Bucket not found" (self-hosted) -> POST cria...');
  // Quirk real de prod (2026-08-22): storage-api self-hosted responde bucket
  // ausente com HTTP 400 e corpo {"statusCode":"404","error":"Bucket not found"}.
  const { fetchImpl, chamadas } = criarFetchRoteirizado([
    {
      ok: false,
      status: 400,
      headers: headersResposta({}),
      text: async () => '{"statusCode":"404","error":"Bucket not found","message":"Bucket not found"}',
    },
    { ok: true, status: 200, headers: headersResposta({}) },
  ]);
  await garantirBucketGravacoes(fetchImpl);
  checar(chamadas.length === 2, `esperava 2 chamadas (GET+POST cria), recebeu ${chamadas.length}`);
  checar(chamadas[1].init?.method === 'POST', 'apos 400-com-404 no corpo, deveria criar via POST');
}

async function testeBucket400GenericoAindaLanca() {
  console.log('\n[1e] garantirBucketGravacoes — GET 400 genérico (sem "not found") -> LANÇA...');
  const { fetchImpl } = criarFetchRoteirizado([
    { ok: false, status: 400, headers: headersResposta({}), text: async () => '{"error":"Invalid token"}' },
  ]);
  let lancou = false;
  try {
    await garantirBucketGravacoes(fetchImpl);
  } catch {
    lancou = true;
  }
  checar(lancou, '400 sem "Bucket not found" no corpo deveria continuar lançando (erro real)');
}

// ===== 2) guardarGravacao — idempotência =====

async function testeGuardarIdempotente() {
  console.log('\n[2] guardarGravacao — HEAD 200 (já existe) -> NÃO re-baixa...');
  const { fetchImpl, chamadas } = criarFetchRoteirizado([
    { ok: true, status: 200, headers: headersResposta({}) }, // HEAD do object
  ]);
  const path = await guardarGravacao('call-idempotente', 'https://storage.wavoip.com/audio.mp3', undefined, fetchImpl);
  checar(chamadas.length === 1, `esperava 1 chamada só (HEAD), recebeu ${chamadas.length} — não deveria re-baixar/re-subir`);
  checar(chamadas[0].init?.method === 'HEAD', `checagem de existência deveria ser HEAD, recebido ${chamadas[0].init?.method}`);
  checar(typeof path === 'string' && path.length > 0, `deveria devolver o path, recebido ${JSON.stringify(path)}`);
}

// ===== 3) guardarGravacao — shape do upload (streaming) =====

async function testeGuardarShapeUpload() {
  console.log('\n[3] guardarGravacao — fluxo completo: HEAD 404 -> bucket já existe -> download -> upload streaming...');
  const { fetchImpl, chamadas } = criarFetchRoteirizado([
    { ok: false, status: 404, headers: headersResposta({}) }, // HEAD do object -> não existe
    { ok: true, status: 200, headers: headersResposta({}) }, // GET bucket -> já existe (garantirBucketGravacoes no-op)
    {
      ok: true,
      status: 200,
      headers: headersResposta({ 'content-type': 'audio/mpeg', 'content-length': '3' }),
      body: streamFake(),
    }, // GET record_url (download)
    { ok: true, status: 200, headers: headersResposta({}) }, // POST object (upload)
  ]);
  const path = await guardarGravacao('call-nova-xyz', 'https://storage.wavoip.com/audio.mp3', undefined, fetchImpl);
  checar(chamadas.length === 4, `esperava 4 chamadas (HEAD, GET bucket, GET record_url, POST upload), recebeu ${chamadas.length}`);

  const chamadaUpload = chamadas[3];
  checar(chamadaUpload.url.includes(`/storage/v1/object/gravacoes/${path}`), `POST deveria ser no object certo, url=${chamadaUpload.url}`);
  checar(chamadaUpload.init?.method === 'POST', 'upload deveria ser POST');
  checar(chamadaUpload.init?.duplex === 'half', `upload deveria usar duplex:'half' (streaming), recebido ${chamadaUpload.init?.duplex}`);
  const headersUpload = new Headers(chamadaUpload.init?.headers);
  checar(headersUpload.get('content-type') === 'audio/mpeg', `Content-Type deveria ser repassado do download, recebido ${headersUpload.get('content-type')}`);
  checar(headersUpload.get('content-length') === '3', `Content-Length deveria ser repassado do download, recebido ${headersUpload.get('content-length')}`);
}

// ===== 4) 411 no download vira Error classificável =====

async function teste411VirouErroClassificavel() {
  console.log("\n[4] guardarGravacao — 411 no download vira Error que classificarErro rotula transitorio/'storage'...");
  const { fetchImpl } = criarFetchRoteirizado([
    { ok: false, status: 404, headers: headersResposta({}) }, // HEAD do object -> não existe
    { ok: true, status: 200, headers: headersResposta({}) }, // GET bucket -> já existe
    { ok: false, status: 411, headers: headersResposta({}) }, // GET record_url -> 411 (sem content-length)
  ]);
  try {
    await guardarGravacao('call-411', 'https://storage.wavoip.com/audio-sem-tamanho.mp3', undefined, fetchImpl);
    checar(false, 'guardarGravacao deveria LANÇAR em download 411');
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    checar(mensagem.includes('411'), `mensagem deveria carregar o status 411, recebido: "${mensagem}"`);
    checar(!mensagem.includes('audio-sem-tamanho'), 'mensagem NUNCA deveria carregar a record_url completa (LGPD)');
    const classificado = classificarErro(mensagem);
    checar(classificado.tipo === 'transitorio', `classificarErro deveria rotular transitorio, recebido ${classificado.tipo}`);
    checar(classificado.origem === 'storage', `classificarErro deveria rotular origem=storage, recebido ${classificado.origem}`);
  }
}

// ===== 5) caminhoGravacao determinístico =====

function testeCaminhoDeterministico() {
  console.log('\n[5] caminhoGravacao — determinístico para o mesmo callId...');
  const a = caminhoGravacao('call-determ-1');
  const b = caminhoGravacao('call-determ-1');
  checar(a === b, `mesmo callId deveria produzir o mesmo path, recebido "${a}" vs "${b}"`);
  checar(a.endsWith('/call-determ-1.mp3'), `path deveria terminar em /call-determ-1.mp3, recebido "${a}"`);
  checar(/^\d{4}-\d{2}\//.test(a), `path deveria começar com AAAA-MM/, recebido "${a}"`);
  const outro = caminhoGravacao('call-determ-2');
  checar(a !== outro, 'callIds diferentes deveriam produzir paths diferentes');
}

async function main() {
  console.log('=== Smoke gravacao-store — bucket idempotente + cópia por streaming (Fase 19.1 Plano 02, DUR-05) ===');
  await testeBucketCriaQuandoAusente();
  await testeBucketNoOpQuandoJaExiste();
  await testeBucketToleraCorridaNoPost();
  await testeBucketAusenteSelfHosted400();
  await testeBucket400GenericoAindaLanca();
  await testeGuardarIdempotente();
  await testeGuardarShapeUpload();
  await teste411VirouErroClassificavel();
  testeCaminhoDeterministico();

  if (falhas.length > 0) {
    console.error(`\n=== RESULTADO: FAIL — ${falhas.length} asserção(ões) falharam ===`);
    for (const f of falhas) console.error('  -', f);
    process.exit(1);
  }
  console.log('\n=== RESULTADO: PASS — bucket idempotente, guardar idempotente, upload streaming, erro classificável e path determinístico provados (sem rede) ===');
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n=== RESULTADO: FAIL — ${e?.message || e} ===`);
  process.exit(1);
});
