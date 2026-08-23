// Integracao com a instancia Supabase self-hosted (D-P4-10) — base de
// militantes/triagem/follow-ups do dossie 360 (DOSS-01/02, Fase 04 Plano 01).
//
// Autenticacao: REST (PostgREST) via headers `apikey` + `Authorization: Bearer`
// com SUPABASE_SERVICE_KEY (server-side only — D-P4-11). NUNCA logar/expor a
// key: mensagens de erro citam so o NOME da env faltando, nunca o valor.
//
// Padrao de erro: TODAS as funcoes deste modulo LANCAM em falha de config/
// infra/HTTP (WR-03, molde de clickup.ts) — nunca mascaram erro como
// resultado vazio. `null` fica reservado a "nao encontrado" legitimo
// (ex: buscarMilitante sem match), distinto de erro.
//
// Esquema (nomes de tabela/coluna) e PARAMETRIZAVEL via config.ts — nunca
// hardcoded aqui. Os valores reais sao descobertos por
// scripts/descobrir-supabase-ghl.mjs (checkpoint 04-05), nunca adivinhados.

import {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUPABASE_TABLE_MILITANTES,
  SUPABASE_TABLE_FOLLOWUPS,
  SUPABASE_COL_ID,
  SUPABASE_COL_CPF,
  SUPABASE_COL_TELEFONE,
  SUPABASE_COL_FOLLOWUP_REF,
  SUPABASE_TABLES_SERVICOS,
  SUPABASE_TABLE_WEBHOOK_EVENTOS,
  SUPABASE_TABLE_LEADS_ESPELHO,
  SUPABASE_TABLE_MENSAGENS_WHATSAPP,
  SUPABASE_TABLE_VOTOS_LIGACAO,
  SUPABASE_TABLE_LIGACOES,
  SUPABASE_TABLE_AUDIOS_ENVIOS,
  SUPABASE_TABLE_ANOTACOES_LIGACAO,
} from './config.ts';
import { fetchTimeout } from './http.ts';
// dossie.ts é módulo PURO (zero-import) — importá-lo aqui não cria ciclo, mesmo
// sentido de outros consumidores (gerar-lote.mjs/montar-dossies.mjs).
import { variantesTelefoneBr } from './dossie.ts';
// telefone-canonico.ts é módulo PURO/self-contained (19-01) — a MESMA
// normalização usada pela escrita (espelho.ts) e pelas RPCs do Caminho B,
// pra 12/13 dígitos do mesmo número casarem a mesma ligação (R4/§5.3).
import { canonizarTelefone, variantesTelefone } from './telefone-canonico.ts';
// ItemFila é tipo PURO (lote.ts, zero-import) — reusar aqui não cria ciclo
// nem acopla este módulo ao client ClickUp (clickup.ts nunca é importado
// por supabase.ts, ver header do arquivo).
import type { ItemFila } from './lote.ts';

// Endpoint REST montado do env — instancia self-hosted, nunca hardcoded (D-P4-11).
export const SUPABASE_REST_URL = `${SUPABASE_URL}/rest/v1`;

function headers(): Record<string, string> {
  return {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

/** Lanca erro claro de config ausente (WR-03/D-P4-11) — nunca resolve vazio. */
function checarConfig(): void {
  if (!SUPABASE_URL) {
    throw new Error('[supabase] SUPABASE_URL ausente — nao da para ler a base self-hosted');
  }
  if (!SUPABASE_SERVICE_KEY) {
    throw new Error('[supabase] SUPABASE_SERVICE_KEY ausente — nao da para autenticar na base self-hosted');
  }
}

// ===== Durabilidade do webhook Wavoip (Fase 2 — escala-150-atendentes) =====
//
// Persiste CADA evento do webhook CRU e ANTES do processamento (a rede de
// segurança do "não perder nenhuma ligação"): se transcrição/LLM/escrita
// falharem ou o processo cair no meio, o evento fica aqui e é reprocessável.
//
// DIVERGÊNCIA CONSCIENTE do padrão WR-03 deste módulo: quando o Supabase NÃO
// está configurado, estas funções NÃO lançam — retornam null / no-op. Motivo:
// durabilidade é infra OPCIONAL (o webhook precisa seguir funcionando inline
// como hoje, sem Supabase). Já um erro de REDE/HTTP com o Supabase configurado
// LANÇA (WR-03) — e o chamador (webhook) loga-e-segue, pra nunca virar 500 por
// causa da gravação de auditoria.

/**
 * Grava um evento do webhook com status inicial `recebido`. Retorna o id da
 * linha (para `marcarEventoWebhook` fechar o desfecho) ou null quando o
 * Supabase não está configurado (durabilidade indisponível — degrada para o
 * comportamento atual). `whatsapp_call_id` fica indexado para o reprocesso.
 */
export async function registrarEventoWebhook(
  tipo: string,
  payload: unknown,
  whatsappCallId: string,
): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const corpo = [{
    tipo,
    whatsapp_call_id: whatsappCallId || null,
    status: 'recebido',
    payload,
  }];
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_WEBHOOK_EVENTOS}`, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'return=representation' },
      body: JSON.stringify(corpo),
    });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao registrar evento do webhook: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `[supabase] HTTP ${res.status} ao registrar evento do webhook em ${SUPABASE_TABLE_WEBHOOK_EVENTOS}`,
    );
  }
  try {
    const linhas = (await res.json()) as Array<{ id?: string }>;
    return linhas?.[0]?.id ?? null;
  } catch {
    return null; // gravou mas não devolveu representação — sem id p/ atualizar depois (aceitável)
  }
}

/**
 * Fecha o desfecho de um evento já registrado (`processado` | `erro`). No-op se
 * `id` for null (durabilidade estava indisponível no registro). LANÇA em erro de
 * rede/HTTP (WR-03) — o chamador loga-e-segue. `detalhe` é truncado (nunca
 * payload gigante/PII crua no campo de desfecho).
 */
export async function marcarEventoWebhook(
  id: string | null,
  status: 'processado' | 'erro',
  detalhe?: string,
): Promise<void> {
  if (!id) return;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  const corpo: Record<string, unknown> = { status, atualizado_em: new Date().toISOString() };
  if (detalhe) corpo.detalhe = detalhe.slice(0, 500);
  let res: Response;
  try {
    res = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_WEBHOOK_EVENTOS}?id=eq.${encodeURIComponent(id)}`,
      { method: 'PATCH', headers: headers(), body: JSON.stringify(corpo) },
    );
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao atualizar evento do webhook: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `[supabase] HTTP ${res.status} ao atualizar evento ${id} em ${SUPABASE_TABLE_WEBHOOK_EVENTOS}`,
    );
  }
}

export interface EventoParaReprocesso {
  id: string;
  tipo: string;
  whatsapp_call_id: string | null;
  status: string;
  payload: any;
}

/**
 * Lê `webhook_eventos` pelos status pendentes/erro (FILA-06) — a fonte do CLI
 * de reprocesso (`scripts/reprocessar-eventos.mjs`, Fase 06 Plano 05). Segue o
 * MESMO molde de degradação de `registrarEventoWebhook`/`marcarEventoWebhook`:
 * sem Supabase configurado retorna `[]` (durabilidade indisponível — no-op,
 * NÃO lança). Com Supabase configurado, usa o índice
 * `idx_webhook_eventos_status (status, recebido_em)`; falha de rede/HTTP
 * LANÇA (WR-03, como as demais leituras deste módulo). Só loga contagem/ids —
 * nunca payload/telefone (LGPD).
 */
export async function listarEventosParaReprocesso(
  opts: { status?: string[]; limite?: number } = {},
): Promise<EventoParaReprocesso[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return [];
  const statusFiltro = opts.status && opts.status.length > 0 ? opts.status : ['recebido', 'erro'];
  const limite = opts.limite ?? 100;
  const params = new URLSearchParams({
    select: 'id,tipo,whatsapp_call_id,status,payload',
    status: `in.(${statusFiltro.join(',')})`,
    order: 'recebido_em.asc',
    limit: String(limite),
  });
  let res: Response;
  try {
    res = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_WEBHOOK_EVENTOS}?${params.toString()}`,
      { headers: headers() },
    );
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao listar eventos para reprocesso: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `[supabase] HTTP ${res.status} ao listar eventos para reprocesso em ${SUPABASE_TABLE_WEBHOOK_EVENTOS}`,
    );
  }
  const data = await res.json();
  const linhas: EventoParaReprocesso[] = Array.isArray(data) ? data : [];
  console.log(`[supabase] listarEventosParaReprocesso: ${linhas.length} evento(s) status=[${statusFiltro.join(',')}]`);
  return linhas;
}

export interface TabelaDescoberta {
  tabela: string;
  colunas: string[];
}

/**
 * Descobre o esquema real da base (D-P4-11) — GET na raiz do PostgREST, que
 * devolve o spec OpenAPI com `definitions`/`paths` (tabelas e colunas).
 * Usado por scripts/descobrir-supabase-ghl.mjs ANTES de qualquer mapeamento
 * de ingestao/dossie ser fixado no .env. Erro de config/rede/HTTP LANCA
 * (WR-03) — nunca retorna lista vazia mascarando falha.
 */
export async function descobrirEsquema(): Promise<TabelaDescoberta[]> {
  checarConfig();
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/`, { headers: headers() });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao descobrir o esquema: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] GET ${SUPABASE_REST_URL}/ falhou (${res.status})`);
  }
  const data = await res.json();
  const definitions: Record<string, { properties?: Record<string, unknown> }> = data?.definitions || {};
  return Object.entries(definitions).map(([tabela, def]) => ({
    tabela,
    colunas: Object.keys(def?.properties || {}),
  }));
}

export interface OpcoesListarTabela {
  limit?: number;
  offset?: number;
  select?: string;
  filtros?: Record<string, string>;
}

/**
 * Leitura paginada de uma tabela via PostgREST (`?limit=&offset=`, filtros
 * `coluna=eq.valor`). Erro de config/rede/HTTP LANCA (WR-03) — o caller
 * (ingestao/dossie) decide como reagir; nunca mascara falha como lista vazia.
 */
export async function listarTabela(
  tabela: string,
  opts: OpcoesListarTabela = {},
): Promise<Record<string, unknown>[]> {
  checarConfig();
  const params = new URLSearchParams({
    limit: String(opts.limit ?? 100),
    offset: String(opts.offset ?? 0),
  });
  params.set('select', opts.select || '*');
  for (const [coluna, valor] of Object.entries(opts.filtros ?? {})) {
    params.set(coluna, valor);
  }
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${tabela}?${params.toString()}`, { headers: headers() });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao listar a tabela ${tabela}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] GET /${tabela} falhou (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Lookup por eq-filter na tabela de militantes (SUPABASE_TABLE_MILITANTES,
 * cascata id -> cpf -> telefone, D-P4-08). `null` = nao encontrado (legitimo),
 * distinto de erro de infra/config (LANCA — WR-03).
 */
export async function buscarMilitante(
  opts: { idSupabase?: string; cpf?: string; telefone?: string },
): Promise<Record<string, unknown> | null> {
  checarConfig();
  if (!SUPABASE_TABLE_MILITANTES) {
    throw new Error('[supabase] SUPABASE_TABLE_MILITANTES ausente — nao da para buscar militante');
  }
  const filtros: Record<string, string> = {};
  if (opts.idSupabase) filtros[SUPABASE_COL_ID] = `eq.${opts.idSupabase}`;
  else if (opts.cpf) filtros[SUPABASE_COL_CPF] = `eq.${opts.cpf}`;
  else if (opts.telefone) filtros[SUPABASE_COL_TELEFONE] = `eq.${opts.telefone}`;
  else {
    throw new Error('[supabase] buscarMilitante chamado sem idSupabase/cpf/telefone');
  }
  const linhas = await listarTabela(SUPABASE_TABLE_MILITANTES, { limit: 1, filtros });
  return linhas[0] ?? null;
}

/**
 * Monta o filtro PostgREST da tabela de follow-ups a partir da FK dedicada
 * (SUPABASE_COL_FOLLOWUP_REF), NUNCA das colunas de identidade da tabela de
 * MILITANTES (SUPABASE_COL_ID/CPF/TELEFONE) — fecha CR-02 (04-VERIFICATION.md):
 * a tabela de follow-ups tem sua PRÓPRIA PK `id`, distinta da FK que aponta
 * pro militante dono do follow-up; filtrar pela coluna errada arrisca trazer
 * o follow-up de OUTRA PESSOA pro dossiê do lead (contaminação cruzada de
 * PII, violação LGPD). Função PURA (sem I/O) — testável por smoke sem rede.
 *
 * LANCA (nunca retorna filtro vazio/parcial):
 *  - `colFollowupRef` vazio -> "configuração de follow-ups ausente" (env não configurada).
 *  - `opts.refMilitante` vazio -> "referência do militante ausente" (sem chave, sem filtro).
 */
export function montarFiltroFollowUps(
  opts: { refMilitante?: string },
  colFollowupRef: string,
): Record<string, string> {
  if (!colFollowupRef) {
    throw new Error(
      '[supabase] configuração de follow-ups ausente — SUPABASE_COL_FOLLOWUP_REF não configurada ' +
        '(não dá para filtrar follow-ups por militante sem arriscar misturar identidade de outra ' +
        'pessoa — LGPD)',
    );
  }
  if (!opts.refMilitante) {
    throw new Error('[supabase] referência do militante ausente — montarFiltroFollowUps chamado sem refMilitante');
  }
  return { [colFollowupRef]: `eq.${opts.refMilitante}` };
}

/**
 * Le os follow-ups (SUPABASE_TABLE_FOLLOWUPS) filtrando pela FK dedicada do
 * militante (SUPABASE_COL_FOLLOWUP_REF via `montarFiltroFollowUps`) — NUNCA
 * pelas colunas de identidade da tabela de MILITANTES (SUPABASE_COL_ID/CPF/
 * TELEFONE, usadas só por `buscarMilitante` acima). Fecha CR-02
 * (04-VERIFICATION.md): a FK de follow-ups é uma coluna distinta da PK da
 * própria tabela de follow-ups e das colunas de identidade de militantes.
 * Erro de config/rede/HTTP LANCA (WR-03); lista vazia e resultado legitimo
 * (sem follow-up para aquele militante).
 */
export async function listarFollowUps(
  opts: { refMilitante?: string },
): Promise<Record<string, unknown>[]> {
  checarConfig();
  if (!SUPABASE_TABLE_FOLLOWUPS) {
    throw new Error('[supabase] SUPABASE_TABLE_FOLLOWUPS ausente — nao da para listar follow-ups');
  }
  const filtros = montarFiltroFollowUps(opts, SUPABASE_COL_FOLLOWUP_REF);
  return listarTabela(SUPABASE_TABLE_FOLLOWUPS, { filtros });
}

// ===== listarServicosPrestados — seção 5 do dossiê, leitura multi-tabela (quick 260811-l7k) =====

export interface ServicoPrestado {
  tabela: string;
  servico?: string;
  status?: string;
  fase?: string;
  criadoEm?: string;
  atualizadoEm?: string;
  observacao?: string;
  feedback?: string;
}

export interface TabelaComErro {
  tabela: string;
  erro: string;
}

/** Colunas selecionadas em cada tabela romero_db_* — as colunas extras de cada tabela NUNCA são lidas. */
const SELECT_SERVICOS_PRESTADOS =
  'servico,status,fase,criado_em,atualizado_em,observacao,feedback,telefone,id_contato';

function valorOuIndefinido(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : String(v);
}

/** Normaliza a linha crua (snake_case do PostgREST) para o shape que montarPromptDossie espera (camelCase) — normalização acontece aqui, na camada de I/O. */
function mapearLinhaServico(tabela: string, linha: Record<string, unknown>): ServicoPrestado {
  return {
    tabela,
    servico: valorOuIndefinido(linha.servico),
    status: valorOuIndefinido(linha.status),
    fase: valorOuIndefinido(linha.fase),
    criadoEm: valorOuIndefinido(linha.criado_em),
    atualizadoEm: valorOuIndefinido(linha.atualizado_em),
    observacao: valorOuIndefinido(linha.observacao),
    feedback: valorOuIndefinido(linha.feedback),
  };
}

/**
 * Lê UMA tabela de serviço por telefone (variantes, `filtroTelefoneIn`) e/ou
 * id_contato — GET separado por caminho (mesmo padrão de `buscarMilitante`,
 * cascata de filtros), sempre `order=criado_em.desc&limit=10` (T-L7K-03,
 * DoS). Faz merge dos dois caminhos e dedupe por chave estável do registro
 * (sem coluna `id` no `select` — usa id_contato+criado_em+servico+telefone,
 * D-P4 mesmo racional de resolverDedupe). Erro de rede/HTTP LANÇA — o
 * caller (`listarServicosPrestados`) captura por tabela.
 */
async function buscarLinhasServicoDaTabela(
  tabela: string,
  opts: { filtroTelefoneIn?: string; idContato?: string },
): Promise<Record<string, unknown>[]> {
  const linhasBrutas: Record<string, unknown>[] = [];

  if (opts.filtroTelefoneIn) {
    const params = new URLSearchParams({ select: SELECT_SERVICOS_PRESTADOS, order: 'criado_em.desc', limit: '10' });
    params.set('telefone', opts.filtroTelefoneIn);
    let res: Response;
    try {
      res = await fetchTimeout(`${SUPABASE_REST_URL}/${tabela}?${params.toString()}`, { headers: headers() });
    } catch (e) {
      throw new Error(
        `[supabase] falha de rede ao listar servicos em ${tabela} (telefone): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!res.ok) {
      throw new Error(`[supabase] GET /${tabela} (telefone) falhou (${res.status})`);
    }
    const data = await res.json();
    if (Array.isArray(data)) linhasBrutas.push(...data);
  }

  if (opts.idContato) {
    const params = new URLSearchParams({ select: SELECT_SERVICOS_PRESTADOS, order: 'criado_em.desc', limit: '10' });
    params.set('id_contato', `eq.${opts.idContato}`);
    let res: Response;
    try {
      res = await fetchTimeout(`${SUPABASE_REST_URL}/${tabela}?${params.toString()}`, { headers: headers() });
    } catch (e) {
      throw new Error(
        `[supabase] falha de rede ao listar servicos em ${tabela} (id_contato): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!res.ok) {
      throw new Error(`[supabase] GET /${tabela} (id_contato) falhou (${res.status})`);
    }
    const data = await res.json();
    if (Array.isArray(data)) linhasBrutas.push(...data);
  }

  const vistos = new Set<string>();
  const dedupe: Record<string, unknown>[] = [];
  for (const linha of linhasBrutas) {
    const chave = JSON.stringify([linha.id_contato ?? '', linha.criado_em ?? '', linha.servico ?? '', linha.telefone ?? '']);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    dedupe.push(linha);
  }
  return dedupe;
}

/**
 * Lê TODAS as tabelas de serviço `romero_db_*` (SUPABASE_TABLES_SERVICOS,
 * config.ts) por telefone do lead (variantes BR — `variantesTelefoneBr`,
 * dossie.ts) e/ou id_contato opcional, para montar a seção 5 do dossiê
 * (histórico real de serviços prestados: castração, cirurgias, consultas,
 * cesta básica, resgate etc.).
 *
 * Contrato de erro (WR-03, mesmo do client atual): `checarConfig()` no topo
 * — SUPABASE_URL/SUPABASE_SERVICE_KEY ausentes LANÇAM (nunca resultado vazio
 * silencioso). Já a falha HTTP/rede de UMA tabela NÃO aborta as demais — é
 * capturada e acumulada em `tabelasComErro` (degradação explícita por
 * tabela, T-L7K-03).
 *
 * Nunca loga telefone/CPF/chave (LGPD) — este módulo só compara dígitos.
 */
export async function listarServicosPrestados(
  opts: { telefone: string; idContato?: string },
): Promise<{ servicos: ServicoPrestado[]; tabelasComErro: TabelaComErro[] }> {
  checarConfig();

  const variantes = variantesTelefoneBr(opts.telefone);
  const filtroTelefoneIn = variantes.length > 0 ? `in.(${variantes.join(',')})` : undefined;

  const servicos: ServicoPrestado[] = [];
  const tabelasComErro: TabelaComErro[] = [];

  for (const tabela of SUPABASE_TABLES_SERVICOS) {
    if (!filtroTelefoneIn && !opts.idContato) continue; // sem telefone e sem id_contato: nada para filtrar nesta tabela.
    try {
      const linhasBrutas = await buscarLinhasServicoDaTabela(tabela, { filtroTelefoneIn, idContato: opts.idContato });
      for (const linha of linhasBrutas) {
        servicos.push(mapearLinhaServico(tabela, linha));
      }
    } catch (e) {
      tabelasComErro.push({ tabela, erro: e instanceof Error ? e.message : String(e) });
    }
  }

  return { servicos, tabelasComErro };
}

// ===== ESPELHO rápido dos leads da Lista 01 (u10) — read-model p/ a Base =====
//
// A Base do painel lê daqui (Postgres, ms) em vez do ClickUp ao vivo (~2,7s/página).
// ClickUp segue a fonte da verdade: `sincronizarEspelhoLeads` (espelho.ts) copia pra
// cá, e o voto é write-through. NUNCA loga telefone/cpf (LGPD). Degrada: sem Supabase
// ou tabela inexistente (404) devolve null/no-op pro caller cair no caminho ClickUp.

export interface LeadEspelhoRow {
  clickup_task_id: string;
  id_supabase?: string | null;
  nome: string;
  nome_lower: string;
  telefone: string;
  cpf: string;
  bairro: string;
  cidade: string;
  confirmou_romero: string | null;
  confirmou_andressa: string | null;
  militante: boolean;
  sem_contato: boolean;
  atualizado_em: string;
}

/**
 * Upsert (merge por `clickup_task_id`) de um LOTE de leads no espelho — usado pelo
 * sincronizador. Sem Supabase configurado -> no-op (0). Erro de rede/HTTP LANÇA
 * (WR-03). Devolve quantas linhas foram enviadas.
 */
export async function upsertLeadsEspelho(rows: LeadEspelhoRow[]): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return 0;
  if (rows.length === 0) return 0;
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_LEADS_ESPELHO}`, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao upsertar ${rows.length} leads no espelho: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] HTTP ${res.status} ao upsertar leads no espelho (${SUPABASE_TABLE_LEADS_ESPELHO})`);
  }
  return rows.length;
}

// ===== Fase 17-A — espelho de ligacoes/audios_envios/leads-full (só POPULA — u17) =====
//
// Mesmo molde EXATO de `upsertLeadsEspelho` acima: POST em lote com
// `Prefer: resolution=merge-duplicates,return=minimal` (upsert por
// `clickup_task_id`), no-op sem Supabase configurado, LANÇA em erro de
// rede/HTTP (WR-03) com o NOME da tabela no erro. `sincronizarEspelho*`
// (espelho.ts) é quem chama estas funções — nenhuma rota lê estas tabelas
// ainda (17-CONTEXT.md decisão 3). NUNCA loga telefone/CPF/transcrição.

/** Linha de `ligacoes` (materializa a Lista 02 LIGACOES — design §2.1). `lead_id`
 *  (FK numérica) fica `null` nesta fase — resolvido só quando a ESCRITA inverter
 *  (Phase 19); a junção por enquanto é via `lead_clickup_task_id`. */
export interface LigacaoEspelhoRow {
  clickup_task_id: string;
  lead_id: number | null;
  lead_clickup_task_id: string | null;
  operador: string | null;
  assignee_clickup_id: number | null;
  telefone_canonico: string | null;
  telefone_variantes: string[];
  script: string | null;
  status: 'aberta' | 'em_processamento' | 'fechada';
  resultado: string | null;
  inicio: string | null; // ISO
  fim: string | null; // ISO
  duracao_seg: number | null;
  atendeu: boolean | null;
  motivo_falha: string | null;
  url_gravacao: string | null;
  transcricao: string | null;
  analise_ia: Record<string, unknown> | null;
  necessita_revisao: boolean | null;
  lote_data: string | null; // date (YYYY-MM-DD)
  origem: string | null;
  atualizado_em: string; // ISO
}

/** Upsert (merge por `clickup_task_id`) de um LOTE de ligações no espelho. */
export async function upsertLigacoesEspelho(rows: LigacaoEspelhoRow[]): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return 0;
  if (rows.length === 0) return 0;
  let res: Response;
  try {
    // on_conflict=clickup_task_id: a PK desta tabela é `id` (identity); o merge
    // precisa resolver pela UNIQUE de clickup_task_id, senão re-runs INSEREM e
    // violam a unique (HTTP 409). (discador_leads_espelho não precisa: lá a PK
    // já É clickup_task_id.)
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_LIGACOES}?on_conflict=clickup_task_id`, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao upsertar ${rows.length} ligacoes no espelho: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] HTTP ${res.status} ao upsertar ligacoes no espelho (${SUPABASE_TABLE_LIGACOES})`);
  }
  return rows.length;
}

/** Linha de `audios_envios` (materializa a Lista 03 AUDIOS — design §2.2). `midia_ref`
 *  fica `null` nesta fase — a migração do binário pro Supabase Storage é o 17-05. */
export interface AudioEnvioRow {
  clickup_task_id: string;
  lead_id: number | null;
  lead_clickup_task_id: string | null;
  tipo: 'audio' | 'texto';
  corpo: string | null;
  transcricao_audio: string | null;
  midia_ref: string | null;
  selo_conversa: string | null;
  enviado_em: string | null; // ISO
}

/** Upsert (merge por `clickup_task_id`) de um LOTE de envios de áudio/texto no espelho. */
export async function upsertAudiosEnvios(rows: AudioEnvioRow[]): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return 0;
  if (rows.length === 0) return 0;
  let res: Response;
  try {
    // on_conflict=clickup_task_id: PK é `id` (identity); merge resolve pela
    // UNIQUE de clickup_task_id (senão re-run vira 409). Ver upsertLigacoesEspelho.
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_AUDIOS_ENVIOS}?on_conflict=clickup_task_id`, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao upsertar ${rows.length} audios no espelho: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] HTTP ${res.status} ao upsertar audios no espelho (${SUPABASE_TABLE_AUDIOS_ENVIOS})`);
  }
  return rows.length;
}

/** Linha COMPLETA da Lista 01 LEADS (`LeadEspelhoRow` + as colunas novas de §2.3 —
 *  score/tentativas/priorização, que faltavam pro espelho servir a geração do lote). */
export interface LeadFullEspelhoRow extends LeadEspelhoRow {
  score: number | null;
  tentativas: number | null;
  proximo_contato: string | null; // date (YYYY-MM-DD)
  retorno_necessario: boolean | null;
  observacao_consolidada: string | null;
  dossie: string | null;
  ultimo_contato: string | null; // ISO
  qtd_contatos: number | null;
  id_lead: string | null;
  tags: string[];
  elegivel: boolean | null;
}

/** Upsert (merge por `clickup_task_id`) de um LOTE de leads COMPLETOS no espelho —
 *  mesma tabela de `upsertLeadsEspelho` (discador_leads_espelho), colunas estendidas. */
export async function upsertLeadFullEspelho(rows: LeadFullEspelhoRow[]): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return 0;
  if (rows.length === 0) return 0;
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_LEADS_ESPELHO}`, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao upsertar ${rows.length} leads (full) no espelho: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] HTTP ${res.status} ao upsertar leads (full) no espelho (${SUPABASE_TABLE_LEADS_ESPELHO})`);
  }
  return rows.length;
}

export type RecorteEspelho = 'todos' | 'romero' | 'andressa' | 'militante' | 'sem-contato';

/** Resumo de lead servido da Base (mesma forma do LeadResumo do ClickUp). */
export interface LeadEspelhoResumo {
  leadTaskId: string;
  nome: string;
  telefone: string;
  cpf: string;
  bairro: string;
  cidade: string;
  confirmouRomero: string | null;
  confirmouAndressa: string | null;
  militante: boolean;
  semContato: boolean;
}

/**
 * Lê a Base do ESPELHO (rápido): busca por nome (`ilike`, índice trigram), recorte
 * (filtro server-side), paginação (`offset`/`limit`) e TOTAL exato (Content-Range) —
 * tudo no Postgres. Sem Supabase OU tabela inexistente (404) -> `null` (o caller cai
 * no caminho ClickUp). Erro de rede/HTTP LANÇA (WR-03).
 */
export async function listarLeadsEspelho(opts: {
  q?: string;
  recorte?: RecorteEspelho;
  offset?: number;
  limit?: number;
}): Promise<{ leads: LeadEspelhoResumo[]; total: number } | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const offset = Math.max(0, opts.offset ?? 0);
  const params = new URLSearchParams();
  params.set(
    'select',
    'clickup_task_id,nome,telefone,cpf,bairro,cidade,confirmou_romero,confirmou_andressa,militante,sem_contato',
  );
  params.set('order', 'nome_lower.asc');
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  const q = (opts.q ?? '').trim().toLowerCase();
  if (q) params.set('nome_lower', `ilike.*${q}*`);
  switch (opts.recorte) {
    case 'romero': params.set('confirmou_romero', 'eq.sim'); break;
    case 'andressa': params.set('confirmou_andressa', 'eq.sim'); break;
    case 'militante': params.set('militante', 'is.true'); break;
    case 'sem-contato': params.set('sem_contato', 'is.true'); break;
    default: break;
  }
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_LEADS_ESPELHO}?${params.toString()}`, {
      headers: { ...headers(), 'Prefer': 'count=exact' },
    });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao listar leads do espelho: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    if (res.status === 404) return null; // tabela ainda não aplicada -> fallback ClickUp
    throw new Error(`[supabase] HTTP ${res.status} ao listar leads do espelho`);
  }
  const cr = res.headers.get('content-range') || ''; // ex.: "0-49/100007"
  const m = cr.match(/\/(\d+)$/);
  const total = m ? Number(m[1]) : 0;
  const data = await res.json();
  const linhas: Record<string, unknown>[] = Array.isArray(data) ? data : [];
  const leads: LeadEspelhoResumo[] = linhas.map((r) => ({
    leadTaskId: String(r.clickup_task_id ?? ''),
    nome: String(r.nome ?? ''),
    telefone: String(r.telefone ?? ''),
    cpf: String(r.cpf ?? ''),
    bairro: String(r.bairro ?? ''),
    cidade: String(r.cidade ?? ''),
    confirmouRomero: (r.confirmou_romero as string) ?? null,
    confirmouAndressa: (r.confirmou_andressa as string) ?? null,
    militante: Boolean(r.militante),
    semContato: Boolean(r.sem_contato),
  }));
  return { leads, total };
}

/**
 * Contagem de votos/apoiadores no ESPELHO (u10) — números do dashboard do gestor.
 * Usa `count=exact` (Content-Range) por recorte: rápido no Postgres. `populado`
 * distingue "espelho vazio/ausente" (backfill/reload do PostgREST ainda pendente ->
 * mostrar "—", não zero enganoso) de "populado com 0 votos" (aí zero é verdade).
 * Sem Supabase/tabela -> populado:false. Erro de rede NÃO lança (dashboard degrada).
 */
export async function contarVotosEspelho(): Promise<{
  populado: boolean;
  romero: number;
  andressa: number;
  apoiadores: number;
}> {
  const vazio = { populado: false, romero: 0, andressa: 0, apoiadores: 0 };
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return vazio;

  const contar = async (filtro: string): Promise<number | null> => {
    try {
      const res = await fetchTimeout(
        `${SUPABASE_REST_URL}/${SUPABASE_TABLE_LEADS_ESPELHO}?select=clickup_task_id${filtro ? '&' + filtro : ''}`,
        { headers: { ...headers(), Prefer: 'count=exact', Range: '0-0' } },
      );
      if (!res.ok) return null; // 404 = tabela ainda fora do cache do PostgREST
      const cr = res.headers.get('content-range') || ''; // "0-0/1234" ou "*/0"
      const m = cr.match(/\/(\d+)$/);
      return m ? Number(m[1]) : 0;
    } catch {
      return null;
    }
  };

  const total = await contar('');
  if (total === null || total === 0) return vazio; // vazio/ausente -> não populado

  const [romero, andressa, apoiadores] = await Promise.all([
    contar('confirmou_romero=eq.sim'),
    contar('confirmou_andressa=eq.sim'),
    contar('or=(confirmou_romero.eq.sim,confirmou_andressa.eq.sim)'),
  ]);
  return {
    populado: true,
    romero: romero ?? 0,
    andressa: andressa ?? 0,
    apoiadores: apoiadores ?? 0,
  };
}

// ===== Fase B (19-05) — LEITURAS de `ligacoes` do Supabase (design §4) =====
//
// Fila, detalhe, timeline e correlação do webhook servidas do Postgres em vez
// da listagem geral da Lista 02 (que caiu no incidente que motivou a
// inversão) — `buscarFilaSupabase`/`lerLigacaoSupabase`/
// `buscarLigacaoAbertaPorTelefoneSupabase`/`resolverLeadDaLigacaoSupabase`/
// `buscarLigacoesDoLeadSupabase`. NENHUMA rota chama estas funções ainda — o
// wiring atrás da flag `FONTE_LIGACOES` é 19-07/19-09.
//
// CONTRATO DE ID: sob `FONTE_LIGACOES=supabase`, o `taskId` que a fila expõe
// e que as rotas de escrita repassam às RPCs do Caminho B (19-02,
// `p_ligacao_id bigint`) é o id LOCAL de `ligacoes` (bigint, aqui como
// string) — NÃO o `clickup_task_id` (nullable até o dreno do outbox).
//
// Guard anti-IDOR (CR-01): toda leitura por id valida `operador` NA PRÓPRIA
// LINHA (nunca no ClickUp) — mesma régua de clickup.ts::lerLigacao/
// buscarLigacoesDoLead. Mensagens de erro casam as strings que os catches das
// rotas já mapeiam (404/409) pra não mudar o tratamento de erro quando o
// wiring trocar a fonte.
//
// Erro de config/rede/HTTP LANÇA (WR-03, `checarConfig()`) — leitura crítica
// da fila/detalhe não pode degradar silenciosamente pra lista vazia (o
// operador ficaria sem Ligação pra trabalhar sem saber que é erro de infra).
// PostgREST puro (sem transação — a escrita transacional são as RPCs do
// 19-02). NUNCA loga telefone (LGPD).

/** Linha crua de `ligacoes` (colunas comuns às leituras de fila/detalhe). */
interface LinhaLigacaoBase {
  id: number;
  operador?: string | null;
  status?: string | null;
  script?: string | null;
  telefone_canonico?: string | null;
  lead_clickup_task_id?: string | null;
  inicio?: string | null; // timestamptz ISO
  criado_em?: string; // timestamptz ISO
}

/** Detalhe de uma Ligação lida do Supabase: item da fila + o script (mesmo shape de clickup.ts::DetalheLigacao). */
export interface DetalheLigacaoSupabase extends ItemFila {
  script: string;
}

/** Item da timeline de ligações de um lead (mesmo shape de clickup.ts::ItemTimeline). */
export interface ItemTimelineSupabase {
  data: string;
  atendeu: boolean;
  aderencia: string;
  resumoAnalise: string;
  motivoFalha: string;
  duracao: string;
}

/**
 * `ligacoes` não tem coluna "nome" própria (sql/escala/06_ligacoes.sql) — usa o
 * telefone como fallback, mesmo racional de clickup.ts::lerLigacao
 * (`item?.nome ?? task.name ?? telefone`). `idLead`/`leadTaskId` vêm de
 * `lead_clickup_task_id` (única referência ao lead disponível nesta fase —
 * `lead_id` numérico é resolvido à parte por `resolverLeadDaLigacaoSupabase`).
 */
function linhaParaItemFila(row: LinhaLigacaoBase): ItemFila {
  const telefone = String(row.telefone_canonico ?? '');
  const leadClickupTaskId = row.lead_clickup_task_id ? String(row.lead_clickup_task_id) : '';
  return {
    taskId: String(row.id),
    nome: telefone,
    telefone,
    idLead: leadClickupTaskId,
    leadTaskId: leadClickupTaskId || undefined,
  };
}

/**
 * Reproduz a ordenação EXATA de `clickup.ts::buscarFilaLigacoes` (D-P3-07,
 * quick-260815-w6h, quick-260821): nunca-tentados (`inicio` ausente) primeiro,
 * ordenados por `criado_em` ASC (prioridade — o lote nasce em ordem de
 * prioridade); tentados depois, ordenados por `inicio` ASC (o que falhou há
 * mais tempo primeiro). Sort estável, sobre CÓPIA (não muta `linhas`). Pura.
 */
function ordenarFilaLigacoes<T extends { inicio?: string | null; criado_em?: string }>(linhas: T[]): T[] {
  return [...linhas].sort((a, b) => {
    const tentadaA = !!a.inicio;
    const tentadaB = !!b.inicio;
    if (!tentadaA && !tentadaB) return (Date.parse(a.criado_em ?? '') || 0) - (Date.parse(b.criado_em ?? '') || 0);
    if (!tentadaA) return -1;
    if (!tentadaB) return 1;
    return (Date.parse(a.inicio ?? '') || 0) - (Date.parse(b.inicio ?? '') || 0);
  });
}

/**
 * Fila de Ligações ABERTAS do operador (LEITURA-01, design §4) — troca
 * `buscarFilaLigacoes` (listagem geral da Lista 02, D-01) por um SELECT
 * filtrado (`ix_ligacoes_fila`). `taskId` de cada item é o id LOCAL (CONTRATO
 * DE ID acima). Erro de config/rede/HTTP LANÇA (WR-03) — a fila vazia por
 * erro de infra não pode se disfarçar de "sem Ligação pra ligar".
 */
export async function buscarFilaSupabase(operador: string): Promise<ItemFila[]> {
  checarConfig();
  if (!operador) {
    throw new Error('[supabase] buscarFilaSupabase chamado sem operador');
  }
  const params = new URLSearchParams({
    operador: `eq.${operador}`,
    status: 'eq.aberta',
    select: 'id,script,telefone_canonico,lead_clickup_task_id,inicio,criado_em',
    order: 'inicio.asc.nullsfirst',
  });
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_LIGACOES}?${params.toString()}`, {
      headers: headers(),
    });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao buscar a fila em ${SUPABASE_TABLE_LIGACOES}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] HTTP ${res.status} ao buscar a fila em ${SUPABASE_TABLE_LIGACOES}`);
  }
  const data = (await res.json()) as LinhaLigacaoBase[];
  const linhas = Array.isArray(data) ? data : [];
  return ordenarFilaLigacoes(linhas).map(linhaParaItemFila);
}

/**
 * Detalhe de uma Ligação por id LOCAL (LEITURA-03, design §4) — troca
 * `lerLigacao` (`GET /task/{id}`) por um SELECT direto + os MESMOS 3 guards
 * CR-01 de `clickup.ts::lerLigacao`, agora contra a própria linha: não
 * encontrada, não pertence ao operador (IDOR), já concluída. Mensagens de
 * erro casam as strings que os catches das rotas já mapeiam (404/409) — não
 * muda o tratamento de erro quando o wiring (19-07/09) trocar a fonte.
 */
export async function lerLigacaoSupabase(id: number, operadorEsperado: string): Promise<DetalheLigacaoSupabase> {
  checarConfig();
  const params = new URLSearchParams({
    id: `eq.${id}`,
    select: 'id,operador,status,script,telefone_canonico,lead_clickup_task_id',
    limit: '1',
  });
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_LIGACOES}?${params.toString()}`, {
      headers: headers(),
    });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao ler a ligação ${id}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] HTTP ${res.status} ao ler a ligação ${id}`);
  }
  const data = (await res.json()) as LinhaLigacaoBase[];
  const row = Array.isArray(data) ? data[0] : undefined;
  if (!row) {
    throw new Error(`[supabase] lerLigacaoSupabase: ligacao ${id} nao encontrada`);
  }
  if (String(row.operador ?? '') !== operadorEsperado) {
    throw new Error(`[supabase] lerLigacaoSupabase: ligacao ${id} nao pertence ao operador`);
  }
  if (row.status === 'fechada') {
    throw new Error(`[supabase] lerLigacaoSupabase: ligacao ${id} ja foi concluida`);
  }
  return { ...linhaParaItemFila(row), script: row.script ?? '' };
}

/** Formata `inicio` (timestamptz ISO) em "DD/MM/AAAA HH:MM" Brasília — mesmo
 *  resultado visual de clickup.ts::formatarDataLigacao (fonte diferente: ISO
 *  aqui, epoch-ms lá). Entrada vazia/inválida devolve '' (nunca lança). */
function formatarDataLigacaoSupabase(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

/** Duração "humana" e curta ("33s" / "2min" / "2min 5s") — mesmo formato de
 *  clickup.ts::formatarDuracaoCurta (duplicada de propósito; par pequeno
 *  demais pra acoplar módulos, mesmo racional de telefone-canonico.ts). */
function formatarDuracaoCurtaSupabase(segundos: number | null | undefined): string {
  if (!Number.isFinite(segundos) || (segundos as number) <= 0) return '0s';
  const total = Math.round(segundos as number);
  if (total < 60) return `${total}s`;
  const minutos = Math.floor(total / 60);
  const restante = total % 60;
  return restante ? `${minutos}min ${restante}s` : `${minutos}min`;
}

/**
 * `analise_ia` (jsonb) hoje é gravado por `espelho.ts::paraAnaliseIa` como
 * `{ texto }` — texto livre, não estruturado (mesmo débito documentado lá).
 * Extrai `aderencia`/`resumoAnalise` de forma TOLERANTE: usa os campos
 * estruturados quando existirem (estruturação futura, fora do escopo desta
 * fase) e cai pro `texto` cru como `resumoAnalise` caso contrário. Nunca lança.
 */
function extrairAnaliseIa(raw: unknown): { aderencia: string; resumoAnalise: string } {
  if (!raw || typeof raw !== 'object') return { aderencia: '', resumoAnalise: '' };
  const obj = raw as Record<string, unknown>;
  const aderencia = typeof obj.aderencia === 'number' || typeof obj.aderencia === 'string' ? String(obj.aderencia) : '';
  const resumoAnalise =
    typeof obj.resumoAnalise === 'string' ? obj.resumoAnalise : typeof obj.texto === 'string' ? obj.texto : '';
  return { aderencia, resumoAnalise };
}

/** Linha crua de `ligacoes` usada pela timeline (colunas distintas da fila/detalhe). */
interface LinhaTimelineLigacao {
  operador?: string | null;
  inicio?: string | null;
  atendeu?: boolean | null;
  motivo_falha?: string | null;
  duracao_seg?: number | null;
  analise_ia?: unknown;
}

function linhaParaItemTimeline(row: LinhaTimelineLigacao): ItemTimelineSupabase {
  const { aderencia, resumoAnalise } = extrairAnaliseIa(row.analise_ia);
  return {
    data: formatarDataLigacaoSupabase(row.inicio),
    atendeu: Boolean(row.atendeu),
    aderencia,
    resumoAnalise,
    motivoFalha: row.motivo_falha ?? '',
    duracao: formatarDuracaoCurtaSupabase(row.duracao_seg),
  };
}

/**
 * Timeline de Ligações de um lead pelo id LOCAL do lead (LEITURA-03/`ix_ligacoes_lead`,
 * design §4) — troca as 2 listagens filtradas de `buscarLigacoesDoLead` por um
 * SELECT direto (`WHERE lead_id=$1 ORDER BY inicio DESC LIMIT 10`).
 *
 * Guard CR-01: só devolve a timeline se ALGUMA Ligação do lead pertence ao
 * `operadorEsperado` (prova que o operador já trabalhou este lead) — lead sem
 * NENHUMA ligação (`linhas.length === 0`) é resultado legítimo (timeline
 * vazia), não guard negado.
 */
export async function buscarLigacoesDoLeadSupabase(
  leadId: number,
  operadorEsperado: string,
): Promise<ItemTimelineSupabase[]> {
  checarConfig();
  const params = new URLSearchParams({
    lead_id: `eq.${leadId}`,
    select: 'operador,inicio,atendeu,motivo_falha,duracao_seg,analise_ia',
    order: 'inicio.desc',
    limit: '10',
  });
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_LIGACOES}?${params.toString()}`, {
      headers: headers(),
    });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao buscar as ligacoes do lead ${leadId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] HTTP ${res.status} ao buscar as ligacoes do lead ${leadId}`);
  }
  const data = (await res.json()) as LinhaTimelineLigacao[];
  const linhas = Array.isArray(data) ? data : [];
  if (linhas.length > 0 && !linhas.some((l) => String(l.operador ?? '') === operadorEsperado)) {
    throw new Error(`[supabase] buscarLigacoesDoLeadSupabase: lead ${leadId} nao pertence ao operador`);
  }
  return linhas.map(linhaParaItemTimeline);
}

/**
 * Monta o filtro PostgREST `or=(telefone_canonico.eq.$canon,telefone_variantes.ov.{...})`
 * da correlação multi-candidato (LEITURA-05, §5.3, Riscos R4) — PURA/sem I/O,
 * testável sem rede. `canonizarTelefone`/`variantesTelefone` (19-01) garantem
 * que 12 e 13 dígitos do MESMO número produzem o MESMO `telefone_canonico` e o
 * MESMO conjunto de candidatos — por isso o filtro casa a mesma linha
 * independente do formato de entrada. `null` quando o telefone não é
 * normalizável (nem canônico nem variante) — resultado legítimo, não erro.
 */
export function montarFiltroCorrelacaoTelefone(telefone: string): { or: string } | null {
  const canon = canonizarTelefone(telefone);
  const candidatos = variantesTelefone(telefone);
  const partes: string[] = [];
  if (canon) partes.push(`telefone_canonico.eq.${canon}`);
  if (candidatos.length > 0) partes.push(`telefone_variantes.ov.{${candidatos.join(',')}}`);
  if (partes.length === 0) return null;
  return { or: `(${partes.join(',')})` };
}

/**
 * Busca a Ligação ABERTA cujo telefone casa (LEITURA-05, design §4) — troca
 * `buscarLigacaoAbertaPorTelefone` (varredura da Lista 02) pelo filtro de
 * `montarFiltroCorrelacaoTelefone` (`telefone_canonico = $canon OR
 * telefone_variantes && $candidatos`), preservando o casamento multi-candidato
 * ±9º dígito (R4). Retorna o id LOCAL (CONTRATO DE ID) ou `null` — sem
 * Ligação aberta casando é resultado legítimo, não erro. NUNCA loga o
 * telefone completo.
 */
export async function buscarLigacaoAbertaPorTelefoneSupabase(telefone: string): Promise<string | null> {
  checarConfig();
  const filtro = montarFiltroCorrelacaoTelefone(telefone);
  if (!filtro) return null;
  const params = new URLSearchParams({
    status: 'eq.aberta',
    select: 'id',
    limit: '1',
  });
  params.set('or', filtro.or);
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_LIGACOES}?${params.toString()}`, {
      headers: headers(),
    });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao buscar ligacao aberta por telefone: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] HTTP ${res.status} ao buscar ligacao aberta por telefone`);
  }
  const data = (await res.json()) as Array<{ id?: number }>;
  const row = Array.isArray(data) ? data[0] : undefined;
  return row?.id !== undefined ? String(row.id) : null;
}

/**
 * Resolve o lead (id local + clickup_task_id) de uma Ligação por id LOCAL
 * (LEITURA-05, design §4) — troca `resolverLeadDaLigacao` (`GET /task` +
 * fallback de listagem de 100k) por um SELECT direto de `lead_id`/
 * `lead_clickup_task_id`. `null` quando a Ligação não existe ou não tem lead
 * vinculado (resultado legítimo).
 */
export async function resolverLeadDaLigacaoSupabase(
  id: number,
): Promise<{ leadId: number | null; leadClickupTaskId: string | null } | null> {
  checarConfig();
  const params = new URLSearchParams({
    id: `eq.${id}`,
    select: 'lead_id,lead_clickup_task_id',
    limit: '1',
  });
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_LIGACOES}?${params.toString()}`, {
      headers: headers(),
    });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao resolver o lead da ligacao ${id}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] HTTP ${res.status} ao resolver o lead da ligacao ${id}`);
  }
  const data = (await res.json()) as Array<{ lead_id?: number | null; lead_clickup_task_id?: string | null }>;
  const row = Array.isArray(data) ? data[0] : undefined;
  if (!row) return null;
  return { leadId: row.lead_id ?? null, leadClickupTaskId: row.lead_clickup_task_id ?? null };
}

// ===== Conversa WhatsApp por lead (Fase 13 — campanha de áudios, sql/escala/03) =====
//
// Read-model da conversa (dois lados) + durabilidade das mensagens do webhook
// Evolution: a UI lê daqui (ms, indexado) e nada se perde em restart do processo.
// ClickUp Lista 03 segue o REGISTRO operacional (task por envio + anexo). Mesmo
// molde de degradação do espelho: sem Supabase configurado -> no-op/null (a
// conversa degrada pro caminho ClickUp/memória de hoje); erro de rede/HTTP LANÇA
// (WR-03) e o caller loga-e-segue. NUNCA loga telefone/conteúdo/base64 (LGPD).

export interface MensagemWhatsappRow {
  id: string;
  lead_task_id?: string | null;
  telefone_canonico: string;
  de_nos: boolean;
  ts: string; // ISO
  tipo: 'audio' | 'texto' | 'outro';
  texto?: string | null;
  transcricao?: string | null;
  midia_base64?: string | null;
  midia_mime?: string | null;
  bruto?: unknown;
}

/** Upsert (merge por id) de UMA mensagem — chamado no envio (nosso) e na chegada
 *  (webhook). No-op sem Supabase; erro de rede/HTTP LANÇA (caller loga-e-segue). */
export async function salvarMensagemWhatsapp(row: MensagemWhatsappRow): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_MENSAGENS_WHATSAPP}`, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([row]),
    });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao salvar mensagem WhatsApp: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] HTTP ${res.status} ao salvar mensagem WhatsApp`);
  }
}

/** Patch de uma mensagem já salva (transcrição pronta, vínculo de lead). 404 é
 *  tolerado (linha ainda não existe — corrida benigna com o salvar). */
export async function atualizarMensagemWhatsapp(
  id: string,
  patch: { transcricao?: string | null; lead_task_id?: string | null },
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  let res: Response;
  try {
    res = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_MENSAGENS_WHATSAPP}?id=eq.${encodeURIComponent(id)}`,
      { method: 'PATCH', headers: { ...headers(), 'Prefer': 'return=minimal' }, body: JSON.stringify(patch) },
    );
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao atualizar mensagem WhatsApp: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok && res.status !== 404) {
    throw new Error(`[supabase] HTTP ${res.status} ao atualizar mensagem WhatsApp`);
  }
}

/**
 * Linha do tempo da conversa de um lead — casa por lead_task_id OU telefone
 * canônico (mensagens do webhook chegam antes do vínculo). SEM midia_base64
 * (pesada — a rota de mídia busca sob demanda via `buscarMidiaMensagemWhatsapp`).
 * `null` = Supabase não configurado ou tabela ausente (caller cai no caminho
 * atual); erro de rede/HTTP LANÇA (WR-03).
 */
export async function listarMensagensWhatsapp(opts: {
  leadTaskId?: string;
  telefoneCanonico?: string;
  limite?: number;
}): Promise<MensagemWhatsappRow[] | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const condicoes: string[] = [];
  if (opts.leadTaskId) condicoes.push(`lead_task_id.eq.${opts.leadTaskId}`);
  if (opts.telefoneCanonico) condicoes.push(`telefone_canonico.eq.${opts.telefoneCanonico}`);
  if (condicoes.length === 0) return [];
  const params = new URLSearchParams({
    select: 'id,lead_task_id,telefone_canonico,de_nos,ts,tipo,texto,transcricao,midia_mime',
    order: 'ts.asc',
    limit: String(opts.limite ?? 500),
  });
  params.set('or', `(${condicoes.join(',')})`);
  let res: Response;
  try {
    res = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_MENSAGENS_WHATSAPP}?${params.toString()}`,
      { headers: headers() },
    );
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao listar mensagens WhatsApp: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    if (res.status === 404) return null; // tabela ainda não aplicada -> fallback
    throw new Error(`[supabase] HTTP ${res.status} ao listar mensagens WhatsApp`);
  }
  const data = await res.json();
  return Array.isArray(data) ? (data as MensagemWhatsappRow[]) : [];
}

/** Timestamp (ms) da mensagem de WhatsApp mais RECENTE persistida — o sinal
 *  de NOVIDADE barato que o app sonda a cada ~4s (1 linha, ordenada por ts).
 *  0 = sem Supabase/sem linhas; erro de rede/HTTP LANÇA (WR-03). */
export async function ultimoTsMensagens(): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return 0;
  const params = new URLSearchParams({ select: 'ts', order: 'ts.desc', limit: '1' });
  let res: Response;
  try {
    res = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_MENSAGENS_WHATSAPP}?${params.toString()}`,
      { headers: headers() },
    );
  } catch (e) {
    throw new Error(`[supabase] falha de rede ao ler a última mensagem: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    if (res.status === 404) return 0; // tabela ainda não aplicada
    throw new Error(`[supabase] HTTP ${res.status} ao ler a última mensagem`);
  }
  const data = (await res.json().catch(() => [])) as Array<{ ts?: string }>;
  return Array.isArray(data) && data[0]?.ts ? Date.parse(data[0].ts) || 0 : 0;
}

/** Mídia (base64) de uma mensagem — playback instantâneo sem baixar do ClickUp/
 *  Evolution. `null` = sem Supabase, sem linha ou sem mídia na linha. */
export async function buscarMidiaMensagemWhatsapp(
  id: string,
): Promise<{ base64: string; mimetype: string } | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const params = new URLSearchParams({ select: 'midia_base64,midia_mime', id: `eq.${id}`, limit: '1' });
  let res: Response;
  try {
    res = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_MENSAGENS_WHATSAPP}?${params.toString()}`,
      { headers: headers() },
    );
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao buscar mídia de mensagem WhatsApp: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`[supabase] HTTP ${res.status} ao buscar mídia de mensagem WhatsApp`);
  }
  const data = (await res.json()) as Array<{ midia_base64?: string | null; midia_mime?: string | null }>;
  const linha = Array.isArray(data) ? data[0] : null;
  if (!linha?.midia_base64) return null;
  return { base64: linha.midia_base64, mimetype: linha.midia_mime || 'audio/ogg' };
}

/** Vincula ao lead as mensagens que chegaram pelo webhook ANTES do vínculo
 *  (lead_task_id nulo, casadas por telefone canônico). Best-effort do caller. */
export async function vincularLeadMensagensWhatsapp(
  telefoneCanonico: string,
  leadTaskId: string,
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  if (!telefoneCanonico || !leadTaskId) return;
  const params = new URLSearchParams({
    telefone_canonico: `eq.${telefoneCanonico}`,
    lead_task_id: 'is.null',
  });
  let res: Response;
  try {
    res = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_MENSAGENS_WHATSAPP}?${params.toString()}`,
      {
        method: 'PATCH',
        headers: { ...headers(), 'Prefer': 'return=minimal' },
        body: JSON.stringify({ lead_task_id: leadTaskId }),
      },
    );
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao vincular mensagens WhatsApp ao lead: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok && res.status !== 404) {
    throw new Error(`[supabase] HTTP ${res.status} ao vincular mensagens WhatsApp ao lead`);
  }
}

export interface UltimaMensagemLead {
  ts: number; // ms
  deNos: boolean;
  tipo: 'audio' | 'texto' | 'outro';
  preview: string;
  /** true quando a mensagem do lead já foi vista (lido_em preenchido) — a
   *  bolinha da lista só acende com mensagem do lead NÃO lida. */
  lida: boolean;
}

/**
 * Última mensagem por lead E por telefone canônico — ordena a lista de áudios
 * como WhatsApp (quem falou por último no topo) e alimenta a bolinha de
 * "lead esperando resposta" (última mensagem não é nossa). Uma consulta
 * indexada (últimas 800 linhas por ts) reduzida aqui a 1 por chave — volume da
 * campanha é baixo; quando crescer, vira VIEW distinct-on. `null` = sem
 * Supabase/tabela (caller segue sem ordenação).
 */
export async function ultimasMensagensWhatsapp(): Promise<{
  porLead: Map<string, UltimaMensagemLead>;
  porTelefone: Map<string, UltimaMensagemLead>;
} | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const params = new URLSearchParams({
    select: 'lead_task_id,telefone_canonico,de_nos,ts,tipo,texto,transcricao,lido_em',
    order: 'ts.desc',
    limit: '800',
  });
  let res: Response;
  try {
    res = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_MENSAGENS_WHATSAPP}?${params.toString()}`,
      { headers: headers() },
    );
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao ler últimas mensagens WhatsApp: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`[supabase] HTTP ${res.status} ao ler últimas mensagens WhatsApp`);
  }
  const data = (await res.json()) as MensagemWhatsappRow[];
  const porLead = new Map<string, UltimaMensagemLead>();
  const porTelefone = new Map<string, UltimaMensagemLead>();
  for (const r of Array.isArray(data) ? data : []) {
    // rótulos "Falante N:" saem do preview (pedido 2026-08-19 — só o texto)
    const cru = (r.texto ?? r.transcricao ?? '').replace(/Falante \d+:\s*/g, '').trim();
    const um: UltimaMensagemLead = {
      ts: Date.parse(r.ts) || 0,
      deNos: r.de_nos,
      tipo: r.tipo,
      preview: (cru || (r.tipo === 'audio' ? '🎤 Áudio' : '')).slice(0, 120),
      lida: !!(r as { lido_em?: string | null }).lido_em,
    };
    if (r.lead_task_id && !porLead.has(r.lead_task_id)) porLead.set(r.lead_task_id, um);
    if (r.telefone_canonico && !porTelefone.has(r.telefone_canonico)) porTelefone.set(r.telefone_canonico, um);
  }
  return { porLead, porTelefone };
}

/** Marca como LIDAS as mensagens do lead (de_nos=false, lido_em nulo) — chamado
 *  quando o operador ABRE a conversa (ver = ler, pedido 2026-08-19). Apaga a
 *  bolinha da lista no próximo refresh. Best-effort do caller; 404 tolerado
 *  (coluna/tabela ainda não migrada → bolinha segue sem estado de leitura). */
export async function marcarMensagensLidas(
  leadTaskId: string,
  telefoneCanonico: string,
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  const condicoes: string[] = [];
  if (leadTaskId) condicoes.push(`lead_task_id.eq.${leadTaskId}`);
  if (telefoneCanonico) condicoes.push(`telefone_canonico.eq.${telefoneCanonico}`);
  if (condicoes.length === 0) return;
  const params = new URLSearchParams({
    de_nos: 'is.false',
    lido_em: 'is.null',
  });
  params.set('or', `(${condicoes.join(',')})`);
  let res: Response;
  try {
    res = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_MENSAGENS_WHATSAPP}?${params.toString()}`,
      {
        method: 'PATCH',
        headers: { ...headers(), 'Prefer': 'return=minimal' },
        body: JSON.stringify({ lido_em: new Date().toISOString() }),
      },
    );
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao marcar mensagens como lidas: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok && res.status !== 404) {
    throw new Error(`[supabase] HTTP ${res.status} ao marcar mensagens como lidas`);
  }
}

/** Resolve o lead de um telefone pelas mensagens já vinculadas — deixa o
 *  webhook avaliar a conversa mesmo depois de restart (o índice em memória
 *  `leadPorTelefone` zera). `null` = desconhecido/sem Supabase. */
export async function buscarLeadPorTelefoneWhatsapp(
  telefoneCanonico: string,
): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  if (!telefoneCanonico) return null;
  const params = new URLSearchParams({
    select: 'lead_task_id',
    telefone_canonico: `eq.${telefoneCanonico}`,
    lead_task_id: 'not.is.null',
    limit: '1',
  });
  let res: Response;
  try {
    res = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_MENSAGENS_WHATSAPP}?${params.toString()}`,
      { headers: headers() },
    );
  } catch {
    return null; // consulta auxiliar do timer — falha silenciosa é aceitável aqui
  }
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ lead_task_id?: string | null }>;
  return data?.[0]?.lead_task_id ?? null;
}

/**
 * Write-through do voto no espelho: atualiza `confirmou_romero`/`confirmou_andressa`
 * da linha (por `clickup_task_id`) pra o voto aparecer NA HORA na Base. No-op sem
 * Supabase; 404 (linha/tabela ausente) é tolerado. Erro de rede/HTTP LANÇA (WR-03) —
 * o caller (rota de voto) loga-e-segue, pra nunca virar 500 por causa do espelho.
 */
export async function atualizarVotoEspelho(
  clickupTaskId: string,
  patch: { romero?: string | null; andressa?: string | null },
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  const corpo: Record<string, unknown> = { atualizado_em: new Date().toISOString() };
  if ('romero' in patch) corpo.confirmou_romero = patch.romero ?? null;
  if ('andressa' in patch) corpo.confirmou_andressa = patch.andressa ?? null;
  let res: Response;
  try {
    res = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_LEADS_ESPELHO}?clickup_task_id=eq.${encodeURIComponent(clickupTaskId)}`,
      { method: 'PATCH', headers: { ...headers(), 'Prefer': 'return=minimal' }, body: JSON.stringify(corpo) },
    );
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao atualizar voto no espelho: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok && res.status !== 404) {
    throw new Error(`[supabase] HTTP ${res.status} ao atualizar voto no espelho`);
  }
}

// ===== Atribuição da declaração de voto ao operador (sql/escala/05_votos_ligacao.sql) =====
//
// O ClickUp guarda o voto na task do LEAD, que não tem operador nem data — por isso o
// ranking publicava "0 votos" para todo mundo e o gráfico de acumulado ficava em branco.
// A informação existe no instante da marcação (a rota sabe quem é o closer e de qual
// ligação veio) e era descartada depois de autorizar. Estas duas funções a preservam.
//
// Mesma DIVERGÊNCIA CONSCIENTE do bloco de webhook acima: sem Supabase configurado é
// no-op / vazio, nunca lança — a gravação do voto no ClickUp não pode falhar porque a
// atribuição está indisponível. Erro de rede/HTTP com Supabase configurado LANÇA (WR-03),
// e o chamador loga-e-segue.

/** Uma declaração colhida: qual ligação, de quem, sobre qual candidato. */
export interface VotoDeLigacao {
  ligacaoTaskId: string;
  leadTaskId: string;
  /** login do closer que marcou (infraestrutura da campanha, não dado do lead) */
  operador: string;
  candidato: 'romero' | 'andressa';
  escolha: 'sim' | 'nao' | 'naoDeclarou';
  /** 'ligacao' = medido na hora; 'backfill' = reconstruído por regra (ver o script). */
  origem?: 'ligacao' | 'backfill';
}

/**
 * Grava (ou corrige) a atribuição de uma declaração de voto.
 *
 * UPSERT na chave (ligacao_task_id, candidato) via `resolution=merge-duplicates`: o closer
 * corrigir a marcação na MESMA ligação atualiza a linha em vez de criar uma segunda —
 * senão um lead com voto corrigido contaria duas vezes no ranking.
 *
 * LGPD: só login de operador e ids de task. Nenhum telefone, CPF ou nome sai daqui.
 */
export async function registrarVotoLigacao(v: VotoDeLigacao): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  const corpo = [{
    ligacao_task_id: v.ligacaoTaskId,
    lead_task_id: v.leadTaskId || '',
    operador: v.operador,
    candidato: v.candidato,
    escolha: v.escolha,
    origem: v.origem ?? 'ligacao',
    registrado_em: new Date().toISOString(),
  }];
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_VOTOS_LIGACAO}`, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(corpo),
    });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao registrar voto da ligacao: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] HTTP ${res.status} ao registrar voto em ${SUPABASE_TABLE_VOTOS_LIGACAO}`);
  }
}

/**
 * Votos conquistados por operador — PESSOAS distintas que declararam 'sim'.
 *
 * Duas decisões que mudam o número, escritas aqui porque a tela não tem como adivinhá-las:
 *
 *  1. Só `escolha = 'sim'` conta. A coluna se chama "Votos": 'nao' e 'naoDeclarou' são
 *     esforço de coleta, não voto conquistado. As três ficam gravadas — quem quiser medir
 *     coleta lê a tabela inteira.
 *
 *  2. Um lead vale UM voto, creditado à declaração MAIS RECENTE. Sem isso, um lead
 *     trabalhado por duas telefonistas somaria dois na tela e a coluna deixaria de fechar
 *     com o total de apoiadores. "Mais recente" é o mesmo critério da fonte da verdade: no
 *     ClickUp o voto atual do lead é o último gravado.
 *
 * Devolve mapa `operador (minúsculo) -> votos`. Vazio quando o Supabase não está
 * configurado ou a tabela ainda não foi criada — a tela cai em "sem dados", não em zero.
 */
export async function contarVotosPorOperador(): Promise<Map<string, number>> {
  const vazio = new Map<string, number>();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return vazio;
  const params = new URLSearchParams({
    escolha: 'eq.sim',
    select: 'lead_task_id,operador,registrado_em',
    order: 'registrado_em.desc',
  });
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_VOTOS_LIGACAO}?${params.toString()}`, {
      headers: { ...headers(), Range: '0-9999' },
    });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao contar votos por operador: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // 404 = migração 05 ainda não aplicada. Degrada para vazio: o painel mostra "sem dados"
  // na coluna em vez de derrubar a Central inteira por causa de uma tabela que falta.
  if (res.status === 404) return vazio;
  if (!res.ok) {
    throw new Error(`[supabase] HTTP ${res.status} ao contar votos em ${SUPABASE_TABLE_VOTOS_LIGACAO}`);
  }
  const linhas = (await res.json()) as Array<{ lead_task_id?: string; operador?: string }>;
  // `order=registrado_em.desc` + "primeiro que aparece vence" = a declaração mais recente
  // de cada lead. Lead sem id (backfill que não resolveu) cai numa chave própria por linha,
  // para não colapsar leads distintos num só.
  const vistos = new Set<string>();
  const contagem = new Map<string, number>();
  for (let i = 0; i < linhas.length; i += 1) {
    const lead = String(linhas[i].lead_task_id ?? '').trim() || `__sem_lead_${i}`;
    if (vistos.has(lead)) continue;
    vistos.add(lead);
    const op = String(linhas[i].operador ?? '').trim().toLowerCase();
    if (!op) continue;
    contagem.set(op, (contagem.get(op) ?? 0) + 1);
  }
  return contagem;
}

// ===== Anotações estruturadas da ligação (quick-260822-tdj) =====
//
// Escrita DUPLA best-effort ao lado dos marcadores ClickUp (quick-260822-rr6):
// dá ao gestor dados estruturados/queryáveis (não só texto em comentário)
// sobre cada ligação. Chaveada por `ligacao_task_id` (task_id do ClickUp da
// Ligação, Lista 02) — SEM FK para `ligacoes` (sql/escala/20). Mesmo padrão de
// erro do módulo (WR-03): LANÇA em falha de rede/HTTP — o CALLER na rota é
// quem faz try/catch e loga-e-segue (o retorno da ligação nunca quebra por
// causa do Supabase). NUNCA logar telefone/CPF.

export interface AnotacaoLigacaoRow {
  ligacao_task_id: string;
  lead_task_id?: string | null;
  operador?: string | null;
  classificacao?: string | null;
  demanda?: string | null;
  observacao?: string | null;
  canal?: string | null;
  apos_whatsapp?: boolean | null;
  super_fa?: boolean | null;
  resultado?: string | null;
}

/** Insere UMA linha de anotação estruturada. No-op sem Supabase configurado;
 *  erro de rede/HTTP LANÇA (o caller loga-e-segue). Normaliza `classificacao`
 *  para minúsculas antes de gravar — o mobile manda "Receptiva"/"Indecisa"/
 *  "Negativa" mas o CHECK da tabela é 'receptiva'/'indecisa'/'negativa'
 *  (evita drop silencioso do insert no best-effort, T-tdj-05). */
export async function inserirAnotacaoLigacao(row: AnotacaoLigacaoRow): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  const corpo = [{
    ...row,
    classificacao: row.classificacao ? row.classificacao.toLowerCase() : row.classificacao,
  }];
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_ANOTACOES_LIGACAO}`, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'return=minimal' },
      body: JSON.stringify(corpo),
    });
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao inserir anotacao da ligacao: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[supabase] HTTP ${res.status} ao inserir anotacao em ${SUPABASE_TABLE_ANOTACOES_LIGACAO}`);
  }
}

/** Marca `discador_leads_espelho.super_fa = true` para o lead (atributo
 *  PERMANENTE da pessoa, além da tag ClickUp no LEAD). No-op sem Supabase
 *  configurado; 404 TOLERADO (lead ainda não espelhado — corrida benigna,
 *  mesmo tratamento de `atualizarMensagemWhatsapp`); demais erro de
 *  rede/HTTP LANÇA (o caller loga-e-segue). */
export async function marcarSuperFaEspelho(leadTaskId: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  let res: Response;
  try {
    res = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_LEADS_ESPELHO}?clickup_task_id=eq.${encodeURIComponent(leadTaskId)}`,
      { method: 'PATCH', headers: { ...headers(), 'Prefer': 'return=minimal' }, body: JSON.stringify({ super_fa: true }) },
    );
  } catch (e) {
    throw new Error(
      `[supabase] falha de rede ao marcar super-fa no espelho: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok && res.status !== 404) {
    throw new Error(`[supabase] HTTP ${res.status} ao marcar super-fa em ${SUPABASE_TABLE_LEADS_ESPELHO}`);
  }
}
