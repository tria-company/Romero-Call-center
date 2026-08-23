// Healthcheck de boot do espelho Supabase — PORTAO-03/R11 (17-03,
// .planning/arquitetura/inversao-supabase-fonte-da-verdade.md §6 Fase A, R11).
//
// Cada DDL nova exige reload do schema-cache do PostgREST self-hosted
// (`NOTIFY pgrst` + kick do authenticator — já embutido em
// `scripts/aplicar-sql.mjs`), mas o NOTIFY não propaga de forma confiável
// neste deploy: 5 tabelas novas = 5 chances de 404 numa escrita futura. Este
// módulo prova, NO BOOT, que cada tabela nova (ligacoes/audios_envios/
// clickup_outbox/clickup_campo_mapa/notas) está VISÍVEL (SELECT) e
// ESCREVÍVEL (INSERT+DELETE de uma linha-sentinela, sem deixar lixo) antes
// de qualquer flip de flag — enquanto uma tabela não passar, o fallback
// 404->ClickUp existente é MANTIDO (nenhuma remoção nesta fase).
//
// O healthcheck NUNCA derruba o boot do processo (diferente de
// `campo-mapa.ts::carregarEValidarCampoMapa`, que falha alto em divergência
// genuína) — ele só REGISTRA o resultado por tabela; degradação graciosa
// perante uma dependência externa (Supabase) fora do ar, mesmo espírito do
// healthcheck raso do serviço.
//
// LGPD: a linha-sentinela usada na prova de escrita NUNCA contém PII (só
// valores fixos/sentinela) e é DELETADA logo em seguida; o log é só o
// resultado por tabela (visível/escrevível), nunca dado.

import { fetchTimeout } from './http.ts';
import {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUPABASE_TABLE_LIGACOES,
  SUPABASE_TABLE_AUDIOS_ENVIOS,
  SUPABASE_TABLE_CLICKUP_OUTBOX,
  SUPABASE_TABLE_CLICKUP_CAMPO_MAPA,
  SUPABASE_TABLE_NOTAS,
} from './config.ts';
import { SUPABASE_REST_URL } from './supabase.ts';

const SENTINELA = '__healthcheck_sentinela__';

function headers(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

/** { selecionavel: SELECT ok (404 = tabela fora do cache do PostgREST); escrevivel:
 *  INSERT+DELETE da linha-sentinela sem erro }. Entrada de `avaliarHealthcheck`. */
export interface ResultadoTabelaHealthcheck {
  selecionavel: boolean;
  escrevivel: boolean;
}

export interface StatusTabelaHealthcheck {
  tabela: string;
  ok: boolean;
}

export interface ResultadoHealthcheck {
  tabelas: StatusTabelaHealthcheck[];
  todasOk: boolean;
}

/**
 * PURA (sem I/O): avalia o resultado por-tabela do healthcheck (SELECT +
 * prova de escrita) e devolve `{ tabela, ok }` por tabela + o agregado
 * `todasOk`. Uma tabela com 404 no SELECT (fora do cache do PostgREST) ->
 * ok=false (mantém o fallback ClickUp). Uma tabela selecionável mas NÃO
 * escrevível -> ok=false. `todasOk` só é `true` quando TODAS as tabelas
 * avaliadas estão ok (e há ao menos 1 tabela — um mapa vazio nunca é "tudo ok").
 */
export function avaliarHealthcheck(
  resultadosPorTabela: Record<string, ResultadoTabelaHealthcheck>,
): ResultadoHealthcheck {
  const tabelas = Object.entries(resultadosPorTabela).map(([tabela, r]) => ({
    tabela,
    ok: r.selecionavel && r.escrevivel,
  }));
  const todasOk = tabelas.length > 0 && tabelas.every((t) => t.ok);
  return { tabelas, todasOk };
}

/** Linha-sentinela (sem PII) + colunas-chave usadas pra localizar/deletar a
 *  linha depois da prova de escrita — uma entrada por tabela nova do espelho
 *  (design §2.1-§2.5). `tabela` é o NOME REAL (já env-configurável — isolamento
 *  homolog `hml_` vs. produção, 17-CONTEXT.md decisão 1) e dobra de chave no
 *  mapa de resultados, pra falar a mesma língua do config em produção. */
interface TabelaEspelhoNova {
  tabela: string;
  linhaSentinela: Record<string, unknown>;
  colunasChave: string[];
}

function tabelasEspelhoNovas(): TabelaEspelhoNova[] {
  return [
    {
      tabela: SUPABASE_TABLE_LIGACOES,
      linhaSentinela: { clickup_task_id: SENTINELA, status: 'aberta' },
      colunasChave: ['clickup_task_id'],
    },
    {
      tabela: SUPABASE_TABLE_AUDIOS_ENVIOS,
      linhaSentinela: { clickup_task_id: SENTINELA, tipo: 'texto' },
      colunasChave: ['clickup_task_id'],
    },
    {
      tabela: SUPABASE_TABLE_CLICKUP_OUTBOX,
      linhaSentinela: { aggregate: 'healthcheck', aggregate_id: 0, op: 'set_campo', dedup_key: SENTINELA, seq: 0 },
      colunasChave: ['dedup_key'],
    },
    {
      tabela: SUPABASE_TABLE_CLICKUP_CAMPO_MAPA,
      linhaSentinela: { lista: '__HEALTHCHECK__', campo_logico: SENTINELA, field_id: 'sentinela', tipo: 'text' },
      colunasChave: ['lista', 'campo_logico'],
    },
    {
      tabela: SUPABASE_TABLE_NOTAS,
      linhaSentinela: { aggregate: 'healthcheck', aggregate_id: 0, clickup_comment_id: SENTINELA, corpo: 'sentinela' },
      colunasChave: ['clickup_comment_id'],
    },
  ];
}

/** SELECT limit=0 — só prova visibilidade (schema-cache). 404 = tabela fora
 *  do cache (fallback ClickUp mantido); qualquer outro erro também `false`
 *  (nunca afirma "ok" sob incerteza). */
async function selecionavel(tabela: string): Promise<boolean> {
  try {
    const res = await fetchTimeout(`${SUPABASE_REST_URL}/${tabela}?limit=0`, { headers: headers() });
    return res.ok;
  } catch {
    return false;
  }
}

/** INSERT (upsert por colunasChave, idempotente — reaplicar não acumula
 *  lixo) da linha-sentinela + DELETE em seguida. Nunca lança — best-effort,
 *  `false` em qualquer falha. Falha ao LIMPAR (delete) é só um warning: a
 *  prova de escrita já foi feita (o INSERT funcionou), não vira `false`. */
async function provaEscrita(t: TabelaEspelhoNova): Promise<boolean> {
  try {
    // on_conflict EXPLÍCITO nas colunasChave: sem isso o PostgREST tenta
    // casar o upsert pela PRIMARY KEY da tabela (que aqui é `id` gerado, não
    // as colunas naturais de dedupe) e reaplicar o healthcheck acumularia
    // uma linha-sentinela por boot em vez de fazer merge — mesmo racional do
    // UNIQUE natural de cada tabela nova (design §2.1-§2.5).
    const onConflict = t.colunasChave.map((c) => encodeURIComponent(c)).join(',');
    const resInsert = await fetchTimeout(`${SUPABASE_REST_URL}/${t.tabela}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: { ...headers(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([t.linhaSentinela]),
    });
    if (!resInsert.ok) return false;
  } catch {
    return false;
  }

  try {
    const filtro = t.colunasChave
      .map((c) => `${c}=eq.${encodeURIComponent(String(t.linhaSentinela[c]))}`)
      .join('&');
    const resDelete = await fetchTimeout(`${SUPABASE_REST_URL}/${t.tabela}?${filtro}`, {
      method: 'DELETE',
      headers: headers(),
    });
    if (!resDelete.ok) {
      console.warn(`[boot-espelho] linha-sentinela de ${t.tabela} nao foi limpa apos a prova de escrita (HTTP ${resDelete.status}) — sem PII, mas verificar manualmente`);
    }
  } catch (e) {
    console.warn(
      `[boot-espelho] falha ao limpar a linha-sentinela de ${t.tabela} apos a prova de escrita: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return true;
}

/**
 * Boot (I/O): pra cada tabela nova do espelho (ligacoes/audios_envios/
 * clickup_outbox/clickup_campo_mapa/notas), prova SELECT (visibilidade) +
 * INSERT/DELETE de uma linha-sentinela sem PII (escrevibilidade), avalia via
 * `avaliarHealthcheck` (pura) e loga só o resultado por tabela — nunca
 * derruba o boot (degradação graciosa perante Supabase indisponível/
 * SUPABASE_URL ausente). Sem SUPABASE_URL/SUPABASE_SERVICE_KEY configurados,
 * TODAS as tabelas saem `ok=false` (mesmo caminho de "indisponível").
 */
export async function healthcheckEspelho(): Promise<ResultadoHealthcheck> {
  const tabelas = tabelasEspelhoNovas();
  const resultadosPorTabela: Record<string, ResultadoTabelaHealthcheck> = {};

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    for (const t of tabelas) resultadosPorTabela[t.tabela] = { selecionavel: false, escrevivel: false };
  } else {
    for (const t of tabelas) {
      const sel = await selecionavel(t.tabela);
      const esc = sel ? await provaEscrita(t) : false;
      resultadosPorTabela[t.tabela] = { selecionavel: sel, escrevivel: esc };
    }
  }

  const avaliacao = avaliarHealthcheck(resultadosPorTabela);
  for (const status of avaliacao.tabelas) {
    console.log(`[boot-espelho] tabela=${status.tabela} ok=${status.ok}`);
  }
  if (!avaliacao.todasOk) {
    console.warn(
      '[boot-espelho] nem todas as tabelas novas do espelho estao visiveis+escrevivies — fallback 404->ClickUp existente MANTIDO',
    );
  }
  return avaliacao;
}
