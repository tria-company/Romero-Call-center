// src/mastra/gravacao-store.ts
//
// Cópia própria da gravação (Fase 19.1 Plano 02, DUR-05, decisão C4 do
// CONTEXT.md): baixar a gravação do storage.wavoip.com UMA vez e persistir
// no Supabase Storage num bucket PRIVADO — transcrição e TODOS os retries
// (plano 19.1-04) leem da NOSSA cópia daqui em diante. Mata a classe inteira:
// 411/sem-content-length, degradação do storage no pico, expiração de
// gravação.
//
// Molde de acesso reusado de supabase.ts: headers() com `apikey` +
// `Authorization: Bearer ${SUPABASE_SERVICE_KEY}`, SUPABASE_URL nunca
// hardcoded, `fetchTimeout` (http.ts) por baixo. Base REST:
// `${SUPABASE_URL}/storage/v1`.
//
// Padrão de erro: WR-03 (molde de supabase.ts/clickup.ts) — TODAS as funções
// deste módulo LANÇAM em falha de config/infra/HTTP, nunca mascaram como
// no-op silencioso (a cópia é infra CRÍTICA desta fase, diferente da
// durabilidade OPCIONAL do webhook em supabase.ts). Erros de rede/HTTP
// carregam origem+status na mensagem e ficam marcados com `.classificado`
// (classificar-erro.ts) para o consumidor (worker, plano 19.1-04) decidir
// retry sem precisar re-parsear a mensagem.
//
// LGPD: bucket PRIVADO (sem URL pública); logs/mensagens de erro carregam só
// host/status — NUNCA a record_url completa (pode ter assinatura), telefone
// ou a service key.
//
// `fetchImpl` é injetável em toda função de I/O (parâmetro opcional, default
// `fetchTimeout`/fetch global) — permite ao smoke (`scripts/gravacao-store.smoke.mjs`)
// rodar 100% offline, sem rede real.

import { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_STORAGE_BUCKET_GRAVACOES } from './config.ts';
import { fetchTimeout } from './http.ts';
import { classificarErro, type ErroClassificado } from './classificar-erro.ts';

type FetchLike = (url: string, options?: RequestInit) => Promise<Response>;

// Download/upload de uma gravação inteira (60-90min) pode levar minutos —
// mesmo teto generoso de deepgram.ts (transcreverBytes), bem acima do
// default de 15s do fetchTimeout global.
const TIMEOUT_LONGO_MS = 600_000;

const fetchPadrao: FetchLike = (url, options) => fetchTimeout(url, options ?? {});
const fetchLongo: FetchLike = (url, options) => fetchTimeout(url, options ?? {}, TIMEOUT_LONGO_MS);

/** Lança erro claro de config ausente (WR-03) — nunca resolve vazio/no-op. */
function checarConfig(): void {
  if (!SUPABASE_URL) {
    throw new Error('[gravacao-store] SUPABASE_URL ausente — nao da para persistir a copia da gravacao');
  }
  if (!SUPABASE_SERVICE_KEY) {
    throw new Error('[gravacao-store] SUPABASE_SERVICE_KEY ausente — nao da para autenticar no Supabase Storage');
  }
}

function headers(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  };
}

function storageBase(): string {
  return `${SUPABASE_URL}/storage/v1`;
}

function urlObjeto(path: string): string {
  return `${storageBase()}/object/${SUPABASE_STORAGE_BUCKET_GRAVACOES}/${path}`;
}

/** Host da URL para log seguro — nunca a URL completa (pode ter assinatura, LGPD). */
function hostSeguro(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalido';
  }
}

/**
 * Erro de infra/rede/HTTP já classificado (transitório×permanente,
 * classificar-erro.ts) — o consumidor (worker, plano 19.1-04) lê
 * `.classificado` direto, sem re-parsear a mensagem. A MENSAGEM em si segue
 * LGPD-safe (só origem+status, nunca URL/telefone/service key).
 */
function erroClassificavel(mensagem: string): Error & { classificado: ErroClassificado } {
  const erro = new Error(mensagem) as Error & { classificado: ErroClassificado };
  erro.classificado = classificarErro(mensagem);
  return erro;
}

/**
 * Deriva o object path determinístico do Supabase Storage para a gravação de
 * uma call — `${AAAA-MM}/${callId}.mp3`, particionado por mês (organização do
 * bucket). PURA (sem I/O): dado o mesmo callId no mesmo mês corrente, sempre
 * devolve o mesmo path. O callId é o `whatsappCallId` — identificador estável
 * do evento RECORD.
 */
export function caminhoGravacao(callId: string): string {
  const agora = new Date();
  const ano = agora.getUTCFullYear();
  const mes = String(agora.getUTCMonth() + 1).padStart(2, '0');
  const idSeguro = String(callId || '').trim() || 'sem-call-id';
  return `${ano}-${mes}/${idSeguro}.mp3`;
}

/**
 * Garante que o bucket PRIVADO de gravações existe — idempotente, sem
 * checkpoint de operador. GET no bucket; 200 = já existe (no-op). 404 = cria
 * via POST `{ id, name, public: false }` (LGPD — nunca bucket público). 409
 * ou corpo "already exists" no POST = corrida entre réplicas, tratado como
 * sucesso. Qualquer outra falha de rede/HTTP LANÇA (mensagem LGPD-safe: só
 * status + nome do bucket, nunca a service key).
 */
export async function garantirBucketGravacoes(fetchImpl: FetchLike = fetchPadrao): Promise<void> {
  checarConfig();
  const bucket = SUPABASE_STORAGE_BUCKET_GRAVACOES;

  let existente: Response;
  try {
    existente = await fetchImpl(`${storageBase()}/bucket/${bucket}`, { headers: headers() });
  } catch {
    throw erroClassificavel(`[gravacao-store] falha de rede ao verificar bucket (${bucket}) origem=supabase`);
  }
  if (existente.status === 200) return; // já existe — no-op

  // Bucket ausente: hosted responde 404; o storage-api SELF-HOSTED (quirk
  // observado em prod 2026-08-22) responde HTTP 400 com corpo
  // {"statusCode":"404","error":"Bucket not found"}. Sem tratar o 400-com-404,
  // o caminho de criação nunca roda e TODO job de gravação estaciona.
  let ausente = existente.status === 404;
  if (!ausente && existente.status === 400) {
    let corpoVerificacao = '';
    try {
      corpoVerificacao = await existente.text();
    } catch {
      // corpo indisponível — segue só com o status (vai lançar abaixo).
    }
    ausente = /bucket not found|"statusCode"\s*:\s*"?404"?/i.test(corpoVerificacao);
  }
  if (!ausente) {
    throw erroClassificavel(`[gravacao-store] HTTP ${existente.status} ao verificar bucket (${bucket}) origem=supabase`);
  }

  let criado: Response;
  try {
    criado = await fetchImpl(`${storageBase()}/bucket`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bucket, name: bucket, public: false }),
    });
  } catch {
    throw erroClassificavel(`[gravacao-store] falha de rede ao criar bucket (${bucket}) origem=supabase`);
  }
  if (criado.ok || criado.status === 409) return; // criado agora, ou corrida (já existe)

  let corpo = '';
  try {
    corpo = await criado.text();
  } catch {
    // corpo indisponível — segue com o status apenas.
  }
  if (/already exists/i.test(corpo)) return; // corrida entre réplicas, tolerada

  throw erroClassificavel(`[gravacao-store] HTTP ${criado.status} ao criar bucket (${bucket}) origem=supabase`);
}

/**
 * Persiste a cópia própria da gravação — IDEMPOTENTE: se o object já existe
 * (HEAD 200) devolve o path sem re-baixar. Senão garante o bucket, baixa a
 * `recordUrl` (timeout longo — molde de transcreverBytes/deepgram.ts) e faz
 * upload por STREAMING: pipe direto do `ReadableStream` de download pro
 * corpo do POST (`duplex: 'half'`), repassando Content-Length/Content-Type do
 * header de download — NUNCA materializa 60-90min de áudio em RAM. Sem
 * Content-Length no download (raro — chunked), cai pro `arrayBuffer()`
 * completo (mesmo fallback D-07 do deepgram.ts). Retorna o object path.
 *
 * Falhas de rede/HTTP LANÇAM (WR-03) com origem+status na mensagem, para o
 * classificador (classificar-erro.ts) rotular certo — nunca a `recordUrl`
 * completa nem telefone, só o host (LGPD).
 */
export async function guardarGravacao(
  callId: string,
  recordUrl: string,
  contentTypeFallback?: string,
  fetchImpl: FetchLike = fetchLongo,
): Promise<string> {
  checarConfig();
  const path = caminhoGravacao(callId);
  const objectUrl = urlObjeto(path);

  let jaExiste = false;
  try {
    const existente = await fetchImpl(objectUrl, { method: 'HEAD', headers: headers() });
    jaExiste = existente.status === 200;
  } catch {
    jaExiste = false; // falha ao checar existência — segue para (re)tentar criar, não bloqueia
  }
  if (jaExiste) return path; // idempotente — não re-baixa

  await garantirBucketGravacoes(fetchImpl);

  const host = hostSeguro(recordUrl);
  let dl: Response;
  try {
    dl = await fetchImpl(recordUrl, { method: 'GET' });
  } catch {
    throw erroClassificavel(`[gravacao-store] falha de rede ao baixar gravacao origem=storage host=${host}`);
  }
  if (!dl.ok) {
    throw erroClassificavel(`[gravacao-store] download da record_url falhou (${dl.status}) origem=storage host=${host}`);
  }

  const contentType = dl.headers.get('content-type') || contentTypeFallback || 'audio/mpeg';
  const contentLength = dl.headers.get('content-length');

  let up: Response;
  if (contentLength && dl.body) {
    // Streaming: pipe direto do download pro upload — nunca materializa o
    // áudio inteiro em RAM (mesmo padrão de transcreverBytes, deepgram.ts).
    up = await fetchImpl(objectUrl, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': contentType, 'Content-Length': contentLength },
      body: dl.body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  } else {
    // Fallback: sem Content-Length conhecido, mantém o buffer completo.
    const bytes = await dl.arrayBuffer();
    up = await fetchImpl(objectUrl, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': contentType },
      body: bytes,
    });
  }
  if (!up.ok) {
    throw erroClassificavel(`[gravacao-store] upload da gravacao falhou (${up.status}) origem=storage`);
  }
  return path;
}

/**
 * Lê a cópia própria de volta por STREAMING — devolve o corpo como
 * `ReadableStream` + headers (content-type/content-length), para a
 * transcrição fazer pipe pro Deepgram sem materializar 60-90min em RAM. O
 * bucket é PRIVADO: o GET exige o mesmo Bearer (service key) do restante do
 * módulo. LANÇA em erro de rede/HTTP (mensagem LGPD-safe — nunca a service
 * key).
 */
export async function baixarGravacao(
  path: string,
  fetchImpl: FetchLike = fetchLongo,
): Promise<{ stream: ReadableStream; contentType: string; contentLength: string | null }> {
  checarConfig();
  let res: Response;
  try {
    res = await fetchImpl(urlObjeto(path), { headers: headers() });
  } catch {
    throw erroClassificavel('[gravacao-store] falha de rede ao ler copia da gravacao origem=supabase');
  }
  if (!res.ok || !res.body) {
    throw erroClassificavel(`[gravacao-store] HTTP ${res.status} ao ler copia da gravacao origem=supabase`);
  }
  return {
    stream: res.body,
    contentType: res.headers.get('content-type') || 'audio/mpeg',
    contentLength: res.headers.get('content-length'),
  };
}
