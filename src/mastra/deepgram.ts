// Transcricao de audio via Deepgram (pre-recorded API, entrada por URL, com
// fallback binario).
//
// A gravacao da call vem como `record_url` no evento RECORD do webhook Wavoip.
// A API /v1/listen da Deepgram baixa e transcreve a partir da URL — nao
// precisamos baixar o audio nem lidar com base64/SSRF do nosso lado no
// caminho feliz (url-mode).
//
// Fallback binario: em producao real o POST url-mode pode devolver 411
// (Length Required) mesmo quando a MESMA requisicao roda 200 fora do
// servidor — a causa e o corpo (JSON `{ url }`) sem Content-Length
// determinístico nesse ambiente. Quando o POST url-mode falha com 4xx, o
// fallback baixa o audio da mesma record_url e re-POSTa os bytes COMPLETOS
// (ArrayBuffer, nao stream), o que garante Content-Length deterministico.
//
// diarize + utterances = transcript rotulado por falante (call tem 2 pessoas:
// o closer e o lead), formatado como "Falante N: ...\nFalante N: ...".
//
// A gravacao e MONO (MP3 Monaural) — nao ha separacao por canal, entao o
// unico jeito de saber quem e quem e pos-processar os rotulos da
// diarizacao: `rotularPapeis` decide, por keyword-score determinístico
// (sem LLM), quem falou o script de abertura do gabinete (vira
// "Atendente") e rotula os demais como "Lead"/"Lead N". Critério
// conservador — na duvida (poucas keywords, empate), mantem "Falante N"
// intacto pra nunca inverter papeis por engano.

import { DEEPGRAM_API_KEY, DEEPGRAM_MODEL, DEEPGRAM_LANGUAGE } from './config.ts';
import { fetchTimeout } from './http.ts';

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';
// Transcricao de uma call inteira pode levar minutos — uma call de 60-90 min
// passa facil dos 120s antigos, o que fazia a transcricao falhar e a analise
// se perder. Timeout generoso (bem acima do fetch default de 15s). Tambem usado
// no download do fallback binario (audio de uma call inteira).
const TIMEOUT_TRANSCRICAO_MS = 600_000;

/** Monta os query params do /v1/listen — os MESMOS para url-mode e binario. */
export function montarParamsListen(): URLSearchParams {
  return new URLSearchParams({
    model: DEEPGRAM_MODEL,
    language: DEEPGRAM_LANGUAGE,
    smart_format: 'true',
    punctuate: 'true',
    diarize: 'true',
    utterances: 'true',
  });
}

/**
 * Extrai o transcript do payload de resposta da Deepgram: prefere utterances
 * (rotulado por falante) e cai para o transcript plano do primeiro canal.
 * Retorna string nao-vazia ou null.
 */
export function parseTranscript(data: any): string | null {
  // 1) Preferir utterances (rotulado por falante).
  const utterances = data?.results?.utterances;
  if (Array.isArray(utterances) && utterances.length) {
    const linhas = utterances
      .map((u: any) => {
        const falante = u?.speaker != null ? `Falante ${u.speaker}` : 'Falante';
        const texto = String(u?.transcript || '').trim();
        return texto ? `${falante}: ${texto}` : '';
      })
      .filter(Boolean);
    if (linhas.length) return linhas.join('\n');
  }

  // 2) Fallback: transcript plano do primeiro canal.
  const plano = String(
    data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '',
  ).trim();
  return plano || null;
}

const LINHA_FALANTE_REGEX = /^Falante (\d+): (.*)$/;

/** Normalizador case/acento-insensitive pro score de `rotularPapeis`. */
function normalizarParaScore(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Peso por keyword (contando ocorrências × peso) usado em `rotularPapeis`. */
const PESOS_KEYWORDS: Array<[string, number]> = [
  ['aqui e do gabinete', 5],
  ['gabinete', 3],
  ['deputado', 2],
  ['romero', 2],
  ['albuquerque', 2],
];

/**
 * Rotula os falantes de um transcript diarizado (`Falante N: texto`) por
 * papel: quem fala o script de abertura do gabinete vira "Atendente"; os
 * demais viram "Lead" (2 falantes) ou "Lead 1", "Lead 2"... na ordem de
 * primeira aparição (3+ falantes). Pura e determinística — sem LLM.
 *
 * Critério conservador: se há menos de 2 falantes distintos, OU o maior
 * score é 0, OU há empate no topo do score, devolve o `transcript`
 * INALTERADO (nunca inverte papéis por engano). Linhas fora do padrão
 * `Falante N: texto` passam intocadas, mantendo posição/ordem.
 */
export function rotularPapeis(transcript: string): string {
  const linhas = transcript.split('\n');

  const textoPorFalante = new Map<string, string[]>();
  const ordemAparicao: string[] = [];
  for (const linha of linhas) {
    const m = linha.match(LINHA_FALANTE_REGEX);
    if (!m) continue;
    const [, n, texto] = m;
    if (!textoPorFalante.has(n)) {
      textoPorFalante.set(n, []);
      ordemAparicao.push(n);
    }
    textoPorFalante.get(n)!.push(texto);
  }

  if (textoPorFalante.size < 2) return transcript;

  const scorePorFalante = new Map<string, number>();
  for (const [n, textos] of textoPorFalante) {
    const normalizado = normalizarParaScore(textos.join(' '));
    let score = 0;
    for (const [kw, peso] of PESOS_KEYWORDS) {
      const ocorrencias = normalizado.split(kw).length - 1;
      score += ocorrencias * peso;
    }
    scorePorFalante.set(n, score);
  }

  let maxScore = -Infinity;
  for (const score of scorePorFalante.values()) {
    if (score > maxScore) maxScore = score;
  }
  if (maxScore === 0) return transcript;

  const vencedores = [...scorePorFalante.entries()].filter(([, s]) => s === maxScore);
  if (vencedores.length !== 1) return transcript;

  const [vencedor] = vencedores[0];

  const papelPorFalante = new Map<string, string>();
  papelPorFalante.set(vencedor, 'Atendente');
  const outros = ordemAparicao.filter((n) => n !== vencedor);
  if (textoPorFalante.size === 2) {
    papelPorFalante.set(outros[0], 'Lead');
  } else {
    outros.forEach((n, i) => papelPorFalante.set(n, `Lead ${i + 1}`));
  }

  return linhas
    .map((linha) => {
      const m = linha.match(LINHA_FALANTE_REGEX);
      if (!m) return linha;
      const [, n, texto] = m;
      const papel = papelPorFalante.get(n) ?? `Falante ${n}`;
      return `${papel}: ${texto}`;
    })
    .join('\n');
}

/** Host da URL para log seguro — nunca a URL completa (pode ter assinatura). */
function hostSeguro(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalido';
  }
}

/** Corpo de erro truncado (~200 chars, whitespace colapsado) para log seguro. */
function truncarCorpo(texto: string): string {
  return texto.replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Fallback binario (D-03/D-05): baixa o audio da record_url e re-POSTa os
 * bytes COMPLETOS (ArrayBuffer) pro /v1/listen — Content-Length
 * deterministico, ao contrario do caminho url-mode que pode devolver 411 em
 * producao. Fail-open: retorna null em qualquer falha, nunca lanca.
 */
export async function transcreverBytes(
  recordUrl: string,
  params: URLSearchParams,
): Promise<string | null> {
  const host = hostSeguro(recordUrl);
  try {
    const dl = await fetchTimeout(recordUrl, { method: 'GET' }, TIMEOUT_TRANSCRICAO_MS);
    if (!dl.ok) {
      console.error(`[deepgram] fallback: download da record_url falhou (${dl.status}) host=${host}`);
      return null;
    }
    // Corpo COMPLETO como bytes (nunca .body/stream) — buffer completo faz o
    // undici mandar Content-Length deterministico no re-POST; e a raiz da
    // correcao do 411.
    const bytes = await dl.arrayBuffer();
    const contentType = dl.headers.get('content-type') || 'audio/mpeg';

    const res = await fetchTimeout(
      `${DEEPGRAM_URL}?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${DEEPGRAM_API_KEY}`,
          'Content-Type': contentType,
          'Accept': 'application/json',
        },
        body: bytes,
      },
      TIMEOUT_TRANSCRICAO_MS,
    );
    if (!res.ok) {
      const corpo = truncarCorpo(await res.text());
      console.error(
        `[deepgram] fallback binario POST /v1/listen falhou (${res.status}) host=${host} body=${corpo}`,
      );
      return null;
    }
    const data = await res.json();
    console.log('[deepgram] transcrito via caminho=binario');
    const t = parseTranscript(data);
    return t ? rotularPapeis(t) : null;
  } catch (e) {
    console.error(`[deepgram] fallback binario erro (host=${host}):`, e);
    return null;
  }
}

/**
 * Transcreve a gravacao da call a partir da record_url (Deepgram pre-recorded,
 * url-mode). Em falha 4xx do POST url-mode (ex: 411), cai pro fallback
 * binario (download + re-POST de bytes). Retorna o transcript (rotulado por
 * falante quando ha utterances) ou null em qualquer falha — fail-open, nunca
 * lanca pro caller.
 */
export async function transcreverCallUrl(recordUrl: string): Promise<string | null> {
  if (!DEEPGRAM_API_KEY) {
    console.warn('[deepgram] DEEPGRAM_API_KEY nao configurado — transcricao pulada');
    return null;
  }
  if (!recordUrl) return null;

  const params = montarParamsListen();

  try {
    const res = await fetchTimeout(
      `${DEEPGRAM_URL}?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${DEEPGRAM_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ url: recordUrl }),
      },
      TIMEOUT_TRANSCRICAO_MS,
    );
    if (!res.ok) {
      const corpo = truncarCorpo(await res.text());
      const host = hostSeguro(recordUrl);
      console.error(`[deepgram] url-mode POST /v1/listen falhou (${res.status}) host=${host} body=${corpo}`);
      if (res.status >= 400 && res.status < 500) {
        // 4xx (inclui o 411 provado em producao) — cai pro fallback binario.
        return await transcreverBytes(recordUrl, params);
      }
      // 5xx/outros — erro server-side transiente da Deepgram, sem fallback.
      return null;
    }
    const data = await res.json();
    console.log('[deepgram] transcrito via caminho=url-mode');
    const t = parseTranscript(data);
    return t ? rotularPapeis(t) : null;
  } catch (e) {
    console.error('[deepgram] erro ao transcrever:', e);
    return null;
  }
}
