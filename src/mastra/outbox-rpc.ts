// Helper transacional do Caminho B (Portão 1, Fase 18 — decisão travada do
// operador 2026-08-21, 18-CONTEXT.md decisões 1/2). Ponto ÚNICO de entrada
// das mutações transacionais: toda mutação vira UMA chamada
// `POST /rest/v1/rpc/{nomeRpc}` com a service key — uma chamada PostgREST =
// uma transação no banco (a RPC faz a escrita do agregado + o INSERT no
// outbox no mesmo corpo plpgsql, ver sql/escala/12_rpc_registrar_desfecho.sql).
// As LEITURAS continuam via PostgREST puro (src/mastra/supabase.ts) — não
// passam por aqui.
//
// Molde EXATO de I/O self-contido de src/mastra/supabase.ts (SUPABASE_REST_URL
// + headers() com apikey/Authorization Bearer + checarConfig), mas módulo
// PRÓPRIO: importa só SUPABASE_URL/SUPABASE_SERVICE_KEY de config.ts e
// fetchTimeout de http.ts — NUNCA importa supabase.ts (preserva
// testabilidade standalone via `node --experimental-strip-types`, sem puxar
// o grafo de imports do módulo maior).
//
// LGPD/segurança (WR-03, mesmo padrão do resto do projeto): NUNCA loga a
// service key nem os args da mutação (podem conter telefone/CPF/resultado) —
// as mensagens de erro citam só o NOME da env faltando, o nome da RPC, ou o
// status HTTP. NUNCA usa duas chamadas para compor uma mutação — é
// exatamente o bug de dual-write que este Portão fecha (design §3.0/§3.1).

import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from './config.ts';
import { fetchTimeout } from './http.ts';

/** Descritor de UMA chamada REST — retornar isto (em vez de já disparar o
 *  fetch) deixa a invariante "uma chamada só" estrutural e verificável por
 *  smoke offline (montarChamadaRpc é pura, sem I/O). */
export interface ChamadaRpc {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/**
 * Monta o descritor da ÚNICA chamada REST que materializa a mutação —
 * `POST /rest/v1/rpc/{nomeRpc}` com a service key. Função PURA (sem I/O),
 * testável offline (mesmo molde de `montarFiltroFollowUps` em supabase.ts).
 *
 * LANÇA (nunca monta URL/descritor incompleto):
 *  - SUPABASE_URL ausente -> cita 'SUPABASE_URL ausente' (WR-03).
 *  - SUPABASE_SERVICE_KEY ausente -> cita 'SUPABASE_SERVICE_KEY ausente' (WR-03).
 *  - nomeRpc vazio -> nunca monta URL sem nome de RPC.
 */
export function montarChamadaRpc(nomeRpc: string, args: Record<string, unknown>): ChamadaRpc {
  if (!SUPABASE_URL) {
    throw new Error('[outbox-rpc] SUPABASE_URL ausente — nao da para chamar a RPC transacional');
  }
  if (!SUPABASE_SERVICE_KEY) {
    throw new Error('[outbox-rpc] SUPABASE_SERVICE_KEY ausente — nao da para autenticar na RPC transacional');
  }
  if (!nomeRpc) {
    throw new Error('[outbox-rpc] montarChamadaRpc chamado sem nomeRpc — nao da para montar a URL da RPC');
  }
  return {
    url: `${SUPABASE_URL}/rest/v1/rpc/${nomeRpc}`,
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args ?? {}),
  };
}

/**
 * Chama a RPC transacional `nomeRpc` com `args` — o ÚNICO ponto que fala com
 * `/rpc/` neste projeto. Faz UMA `fetchTimeout` (POST) a partir do descritor
 * de `montarChamadaRpc`; NUNCA emite duas chamadas para compor uma mutação
 * (o bug de dual-write que o Portão 1 fecha — design §3.0/§3.1).
 *
 * Contrato de erro (WR-03, mesmo molde de supabase.ts): config ausente LANÇA
 * antes de qualquer I/O (via montarChamadaRpc); falha de rede LANÇA citando
 * só o nome da RPC (nunca args); resposta não-2xx LANÇA
 * `[outbox-rpc] HTTP <status> ao chamar RPC <nomeRpc>` (nunca inclui
 * corpo/args no erro — LGPD); 204/corpo vazio devolve `null`.
 */
export async function comOutboxRpc<T = unknown>(nomeRpc: string, args: Record<string, unknown>): Promise<T> {
  const chamada = montarChamadaRpc(nomeRpc, args);
  let res: Response;
  try {
    res = await fetchTimeout(chamada.url, {
      method: chamada.method,
      headers: chamada.headers,
      body: chamada.body,
    });
  } catch (e) {
    throw new Error(
      `[outbox-rpc] falha de rede ao chamar RPC ${nomeRpc}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[outbox-rpc] HTTP ${res.status} ao chamar RPC ${nomeRpc}`);
  }
  if (res.status === 204) return null as T;
  const texto = await res.text();
  if (!texto) return null as T;
  return JSON.parse(texto) as T;
}
