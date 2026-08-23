// Materializacao de NOTAS (comentarios historicos do ClickUp) + migracao dos
// binarios de gravacao para o store canonico = Supabase Storage (Fase 17-A,
// Plano 05 — MODELO-07/R7). SO POPULA: nenhuma rota le `notas`/Storage nesta
// fase (a inversao de leitura e a Phase 19, 17-CONTEXT.md decisao 3).
//
// Modulo SELF-CONTIDO de I/O (mesmo molde do bloco mensagens_whatsapp de
// supabase.ts): monta o REST/Storage URL a partir de SUPABASE_URL e os headers
// de SUPABASE_SERVICE_KEY, SEM modificar supabase.ts.
//
// Contrato de erro (WR-03): `upsertNotas`/`subirGravacaoStorage`/
// `garantirBucketGravacoes` sao no-op quando o Supabase NAO esta configurado, e
// LANCAM em erro de rede/HTTP quando esta (nunca mascaram falha como sucesso
// vazio). `mapaComentarioParaNota` e PURO e NUNCA lanca (comentario vazio ->
// null).
//
// LGPD-01 (R13): a tabela `notas` e service_role-only (grant do 17-01) e o
// bucket de gravacoes e PRIVADO (public:false). Nenhuma funcao aqui loga
// telefone/CPF/corpo de comentario/gravacao — so contagem/ids.

import {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUPABASE_TABLE_NOTAS,
  SUPABASE_STORAGE_BUCKET_GRAVACOES,
} from './config.ts';
import { fetchTimeout } from './http.ts';

// Endpoints montados do env — instancia self-hosted, nunca hardcoded (D-P4-11).
const SUPABASE_REST_URL = `${SUPABASE_URL}/rest/v1`;
const SUPABASE_STORAGE_URL = `${SUPABASE_URL}/storage/v1`;

function headers(): Record<string, string> {
  return {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function supabaseConfigurado(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
}

/** Uma linha de `notas` — materializa UM comentario historico do ClickUp
 *  (get_task_comments). `clickup_comment_id` e a chave de idempotencia. */
export interface NotaRow {
  aggregate: 'lead' | 'ligacao';
  aggregate_id: string;
  autor: string | null;
  corpo: string;
  criado_em: string | null; // ISO
  clickup_comment_id: string;
}

/** Extrai o texto de um comentario do ClickUp: `comment_text` (texto plano)
 *  tem precedencia; senao concatena os blocos de `comment` (rich text). */
function extrairCorpoComentario(comentario: any): string {
  if (typeof comentario?.comment_text === 'string' && comentario.comment_text.trim() !== '') {
    return comentario.comment_text;
  }
  if (Array.isArray(comentario?.comment)) {
    return comentario.comment
      .map((bloco: any) => (typeof bloco?.text === 'string' ? bloco.text : ''))
      .join('');
  }
  return '';
}

/** Normaliza a data do comentario (ClickUp manda epoch-ms como string) -> ISO,
 *  ou null quando ausente/invalida. */
function normalizarData(date: unknown): string | null {
  if (date === null || date === undefined || date === '') return null;
  const n = Number(date);
  const ms = Number.isFinite(n) ? n : Date.parse(String(date));
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

/**
 * PURO. Mapeia um comentario do ClickUp (get_task_comments) -> linha de `notas`.
 * Comentario vazio/sem texto -> null (pulado), NUNCA lanca. Sem `id` de
 * comentario (chave de idempotencia) tambem -> null. `aggregate` diz se a task
 * dona e um LEAD (Lista 01) ou uma LIGACAO (Lista 02); `aggregateId` e o
 * clickup_task_id dessa task.
 */
export function mapaComentarioParaNota(
  comentario: any,
  aggregate: 'lead' | 'ligacao',
  aggregateId: string,
): NotaRow | null {
  if (!comentario || !aggregateId) return null;
  const corpo = extrairCorpoComentario(comentario).trim();
  if (!corpo) return null; // comentario vazio -> pulado, nunca lanca
  const commentId = comentario.id !== undefined && comentario.id !== null ? String(comentario.id) : '';
  if (!commentId) return null; // sem chave de idempotencia nao da pra materializar
  const autorBruto = comentario.user?.username ?? comentario.user?.email ?? null;
  return {
    aggregate,
    aggregate_id: String(aggregateId),
    autor: autorBruto ? String(autorBruto) : null,
    corpo,
    criado_em: normalizarData(comentario.date),
    clickup_comment_id: commentId,
  };
}

/**
 * Upsert (merge por `clickup_comment_id`) de um LOTE de notas — re-rodar o
 * backfill NAO duplica (idempotente). No-op sem Supabase configurado; LANCA em
 * erro de rede/HTTP (WR-03) com o NOME da tabela no erro. Devolve quantas
 * linhas foram enviadas. NUNCA loga corpo/autor (LGPD).
 */
export async function upsertNotas(rows: NotaRow[]): Promise<number> {
  if (!supabaseConfigurado()) return 0;
  if (rows.length === 0) return 0;
  let res: Response;
  try {
    // on_conflict=clickup_comment_id: a PK da tabela e `id` (identity); o merge
    // precisa resolver pela UNIQUE de clickup_comment_id, senao re-runs INSEREM
    // e violam a unique (mesmo cuidado de upsertLigacoesEspelho).
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_NOTAS}?on_conflict=clickup_comment_id`, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
  } catch (e) {
    throw new Error(
      `[notas] falha de rede ao upsertar ${rows.length} nota(s): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[notas] HTTP ${res.status} ao upsertar notas em ${SUPABASE_TABLE_NOTAS}`);
  }
  return rows.length;
}

/**
 * Garante o bucket de gravacoes PRIVADO (public:false — LGPD-01/R13). Cria via
 * `POST /storage/v1/bucket` se nao existir; bucket ja existente (400/409) e
 * tolerado (idempotente). No-op sem Supabase configurado. LANCA em outro erro
 * de rede/HTTP. Devolve o nome do bucket.
 */
export async function garantirBucketGravacoes(): Promise<string> {
  const bucket = SUPABASE_STORAGE_BUCKET_GRAVACOES;
  if (!supabaseConfigurado()) return bucket;
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_STORAGE_URL}/bucket`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ id: bucket, name: bucket, public: false }),
    });
  } catch (e) {
    throw new Error(
      `[notas] falha de rede ao garantir o bucket de gravacoes: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // Bucket ja existe -> 400 (Duplicate) / 409. Idempotente: segue em frente.
  if (res.ok || res.status === 400 || res.status === 409) return bucket;
  throw new Error(`[notas] HTTP ${res.status} ao criar o bucket privado de gravacoes (${bucket})`);
}

/** Encoda cada segmento do path do objeto (mantendo `/` como separador de pasta). */
function encodeStoragePath(path: string): string {
  return path
    .split('/')
    .filter((seg) => seg !== '')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/**
 * Migra o binario de UMA gravacao de `urlGravacao` (ClickUp) para o Supabase
 * Storage, fazendo STREAMING download->upload (o corpo do download alimenta o
 * upload diretamente — NUNCA materializa o audio de 60-90min inteiro em RAM,
 * mesmo cuidado do streaming de transcricao — T-17-05-M). Devolve o PONTEIRO do
 * Storage (`bucket/path`) para virar `midia_ref`/`url_gravacao`. LANCA em erro
 * de config/rede/HTTP (WR-03). NUNCA loga a url/binario (LGPD).
 */
export async function subirGravacaoStorage(urlGravacao: string, path: string): Promise<string> {
  if (!supabaseConfigurado()) {
    throw new Error('[notas] Supabase nao configurado — sem SUPABASE_URL/SUPABASE_SERVICE_KEY nao da pra subir a gravacao');
  }
  if (!urlGravacao || !path) {
    throw new Error('[notas] subirGravacaoStorage chamado sem urlGravacao/path');
  }
  const bucket = SUPABASE_STORAGE_BUCKET_GRAVACOES;

  // Download em streaming — raw fetch (sem timeout curto do fetchTimeout, que
  // abortaria a transferencia longa de um audio grande no meio).
  let origem: Response;
  try {
    origem = await fetch(urlGravacao);
  } catch (e) {
    throw new Error(`[notas] falha de rede ao baixar a gravacao: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!origem.ok || !origem.body) {
    throw new Error(`[notas] GET da gravacao falhou (${origem.status})`);
  }
  const contentType = origem.headers.get('content-type') || 'application/octet-stream';

  // Upload em streaming: o ReadableStream do download vira o body do upload
  // (duplex:'half' exigido pelo fetch do Node p/ body-stream). Sem buffer intermediario.
  const destino = `${SUPABASE_STORAGE_URL}/object/${bucket}/${encodeStoragePath(path)}`;
  let res: Response;
  try {
    res = await fetch(destino, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': contentType,
        'x-upsert': 'true', // re-run sobrescreve o mesmo objeto (idempotente)
      },
      body: origem.body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  } catch (e) {
    throw new Error(`[notas] falha de rede ao subir a gravacao ao Storage: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[notas] HTTP ${res.status} ao subir a gravacao ao Storage (${bucket})`);
  }
  return `${bucket}/${path}`; // ponteiro do store canonico
}
