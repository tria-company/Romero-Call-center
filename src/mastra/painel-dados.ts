// Números do dashboard lidos AO VIVO das fontes reais — só leitura, nunca escreve.
//
// Motivo (diagnóstico de 18/08/2026): o painel mostrava três números errados, cada um
// por um motivo diferente:
//   • "cadastros na base" = task_count da Lista 01 do ClickUp (100.007) — nunca olhou o
//     banco, onde há 224.542 pessoas. 124.535 pessoas invisíveis no painel.
//   • votos/apoiadores = contagem no espelho `discador_leads_espelho`, que é um snapshot
//     único de 17/08 15:30 (TODAS as linhas com o mesmo `atualizado_em`). Voto registrado
//     depois disso não aparece — medido: ClickUp tinha Romero=1, o painel mostrava 0.
//   • ligações = NÃO EXISTIA. `CLICKUP_LIST_LIGACOES` não era lido por nenhuma rota do
//     painel, embora a Lista 02 tivesse 167 ligações (141 no dia BRT, 43 atendidas,
//     29 gravadas/transcritas, 25 analisadas). O dado era capturado e nunca exibido.
//
// Este módulo troca a FONTE de cada número pela origem correta. Nada aqui grava — nem no
// Postgres, nem no ClickUp (restrição explícita do dono do produto).
//
// CACHE (stale-while-revalidate): as leituras do ClickUp custam segundos (2,1s a consulta
// de voto por custom field; ~3,8s a varredura da Lista 02). Um dashboard que atualiza a
// cada poucos segundos não pode pagar isso a cada request nem queimar o balde de 90
// req/min. Então: devolve o valor em cache NA HORA e dispara a atualização em segundo
// plano. A tela responde instantânea e o número fica no máximo TTL atrás da realidade.
//
// LGPD: só contagens. Nenhum telefone, CPF ou nome sai daqui, nem em log.

import {
  CLICKUP_API_TOKEN,
  CLICKUP_LIST_LEADS,
  CLICKUP_LIST_LIGACOES,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUPABASE_TABLE_MILITANTES,
  PAINEL_TTL_BANCO_MS,
  PAINEL_TTL_CLICKUP_MS,
  PAINEL_MAX_PAGINAS,
} from './config.ts';
import { CAMPOS_LEADS, OPCOES_LEADS, CAMPOS_LIGACOES, listarTasks, lerAtendeu, type TaskClickUp } from './clickup.ts';
import { fetchTimeout } from './http.ts';

const CLICKUP_BASE_URL = 'https://api.clickup.com/api/v2';

// ===== Cache stale-while-revalidate =====
//
// Em memória por processo, de propósito: é cache de LEITURA descartável, não estado. Duas
// réplicas mantêm dois caches e ambos convergem para a mesma fonte — diferente das
// métricas de operação (metricas.ts), onde memória por processo é bug, não escolha.

interface Entrada<T> {
  valor: T;
  em: number;
  atualizando: boolean;
}

const cache = new Map<string, Entrada<unknown>>();

// Leituras EM VOO, para deduplicar o cache frio. Sem isto, no boot (ou logo após um
// deploy) o poll de 8s do /admin, o de 20s do Início e cada gestor com a tela aberta
// disparariam varreduras SIMULTÂNEAS da Lista 02 — várias chamadas de ~4s ao ClickUp
// pelo mesmo número, todas disputando o balde de 90 req/min com a fila dos closers.
// Com o Map abaixo, a primeira leitura ganha a corrida e as demais aguardam a mesma
// Promise.
const emVoo = new Map<string, Promise<unknown>>();

/**
 * Devolve o valor em cache imediatamente e revalida em segundo plano quando vencido.
 * Na PRIMEIRA chamada (cache vazio) espera a leitura — não há valor velho para servir.
 * Falha na revalidação NUNCA propaga: mantém o valor anterior e loga só a mensagem
 * (o painel prefere um número levemente velho a um erro na tela).
 */
async function comCache<T>(chave: string, ttlMs: number, ler: () => Promise<T>): Promise<T> {
  const agora = Date.now();
  const atual = cache.get(chave) as Entrada<T> | undefined;

  if (!atual) {
    // Cache frio: uma única leitura serve todos os chamadores concorrentes.
    const jaEmVoo = emVoo.get(chave) as Promise<T> | undefined;
    if (jaEmVoo) return jaEmVoo;
    const p = ler()
      .then((valor) => {
        cache.set(chave, { valor, em: Date.now(), atualizando: false });
        return valor;
      })
      .finally(() => {
        emVoo.delete(chave);
      });
    emVoo.set(chave, p);
    return p;
  }

  const vencido = agora - atual.em > ttlMs;
  if (vencido && !atual.atualizando) {
    atual.atualizando = true;
    void ler()
      .then((valor) => {
        cache.set(chave, { valor, em: Date.now(), atualizando: false });
      })
      .catch((e) => {
        atual.atualizando = false;
        console.error(`[painel] revalidacao de "${chave}" falhou (mantendo valor anterior):`, e instanceof Error ? e.message : String(e));
      });
  }
  return atual.valor;
}

/** Idade em segundos do número servido — a UI mostra "atualizado há Xs". */
export function idadeCacheSegundos(chave: string): number | null {
  const e = cache.get(chave);
  return e ? Math.round((Date.now() - e.em) / 1000) : null;
}

// ===== 1. Cadastros na base — vem do POSTGRES, não do ClickUp =====

function headersSupabase(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    Prefer: 'count=exact',
    Range: '0-0',
  };
}

/**
 * Conta as pessoas da base (`users_romero`) via `count=exact` no cabeçalho Content-Range —
 * uma requisição barata (~150ms medidos), sem trazer linha nenhuma (`Range: 0-0`).
 * Devolve `null` quando o Supabase não está configurado ou a leitura falha: o caller
 * decide o fallback, e a UI mostra "—" em vez de um zero enganoso.
 */
export async function contarCadastrosBanco(): Promise<number | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SUPABASE_TABLE_MILITANTES) return null;
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE_MILITANTES}?select=id`;
  const res = await fetchTimeout(url, { headers: headersSupabase() });
  if (!res.ok) throw new Error(`[painel] HTTP ${res.status} ao contar cadastros na base`);
  const m = (res.headers.get('content-range') || '').match(/\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

// ===== 2. Votos — do CLICKUP ao vivo, não do espelho congelado =====

export interface VotosAoVivo {
  romero: number;
  andressa: number;
  apoiadores: number;
  /** true = algum contador bateu no teto de páginas; o número é um piso, não o total. */
  parcial: boolean;
}

/**
 * Conta tasks da Lista 01 que casam um valor de custom field, usando o filtro
 * `custom_fields` da API v2 do ClickUp — o servidor filtra, não nós.
 *
 * Verificado em 18/08/2026: o operador `=` acha 1 task exata entre 100.007 numa chamada
 * (2,1s). A API não devolve total, então paginamos até `last_page`; `PAINEL_MAX_PAGINAS`
 * limita o custo (o retorno marca `parcial` quando o teto é atingido, para a UI poder
 * rotular "1.200+" em vez de mentir um total exato).
 *
 * Devolve os IDs, não só a contagem: `apoiadores` precisa da UNIÃO dos dois conjuntos
 * (quem confirmou nos dois candidatos é UMA pessoa). Sem os ids sobrava estimar, e
 * qualquer estimativa aqui erra — soma conta duas vezes, máximo subestima.
 */
async function contarPorCustomField(fieldId: string, valor: string): Promise<{ ids: string[]; parcial: boolean }> {
  if (!CLICKUP_API_TOKEN) throw new Error('[painel] CLICKUP_API_TOKEN ausente — nao da para contar votos');
  const filtro = encodeURIComponent(JSON.stringify([{ field_id: fieldId, operator: '=', value: valor }]));
  let page = 0;
  const ids: string[] = [];
  let ultima = false;
  while (!ultima && page < PAINEL_MAX_PAGINAS) {
    const url = `${CLICKUP_BASE_URL}/list/${CLICKUP_LIST_LEADS}/task?page=${page}&include_closed=true&custom_fields=${filtro}`;
    const res = await fetchTimeout(url, { headers: { Authorization: CLICKUP_API_TOKEN } });
    if (!res.ok) throw new Error(`[painel] HTTP ${res.status} ao contar custom field na Lista 01`);
    const data = await res.json();
    for (const t of data?.tasks || []) if (t?.id) ids.push(String(t.id));
    ultima = Boolean(data?.last_page);
    page += 1;
  }
  return { ids, parcial: !ultima };
}

/**
 * Votos confirmados lidos do ClickUp (fonte da verdade), substituindo `contarVotosEspelho`
 * — que lia um snapshot congelado de 17/08 15:30.
 *
 * `apoiadores` é a UNIÃO dos dois conjuntos de task, não uma estimativa: quem confirmou
 * voto nos DOIS candidatos é uma pessoa só. Somar contaria essa pessoa duas vezes; usar o
 * maior dos dois a esconderia. A API do ClickUp não faz OR entre dois custom fields numa
 * consulta, então a união é feita aqui, com os ids que as duas consultas já trouxeram —
 * custo zero a mais.
 */
export async function contarVotosClickUp(): Promise<VotosAoVivo> {
  const idR = CAMPOS_LEADS.CONFIRMOU_VOTO_ROMERO;
  const idA = CAMPOS_LEADS.CONFIRMOU_VOTO_ANDRESSA;
  const [r, a] = await Promise.all([
    contarPorCustomField(idR, OPCOES_LEADS[idR].sim),
    contarPorCustomField(idA, OPCOES_LEADS[idA].sim),
  ]);
  const uniao = new Set<string>([...r.ids, ...a.ids]);
  return {
    romero: r.ids.length,
    andressa: a.ids.length,
    apoiadores: uniao.size,
    parcial: r.parcial || a.parcial,
  };
}

// ===== 3. Ligações — o bloco que simplesmente não existia =====

export interface ResumoLigacoes {
  total: number;
  hoje: number;
  atendidasHoje: number;
  naoAtendidasHoje: number;
  /** Ligações de hoje que ainda não têm desfecho gravado (ATENDEU vazio). */
  semDesfechoHoje: number;
  atendidasTotal: number;
  comGravacao: number;
  comTranscricao: number;
  comAnaliseIa: number;
  ultimaEm: string | null;
  /** true = bateu o teto de páginas; os números são piso, não total. */
  parcial: boolean;
}

/** Dia operacional em horário de Brasília — mesma convenção de metricas.ts:83. */
function diaOperacionalStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function diaDaTask(ms: unknown): string {
  const n = Number(ms);
  if (!n) return '';
  return new Date(n).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function valorCampo(task: TaskClickUp, fieldId: string): unknown {
  return task.custom_fields?.find((c) => c.id === fieldId)?.value;
}

function preenchido(task: TaskClickUp, fieldId: string): boolean {
  const v = valorCampo(task, fieldId);
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/**
 * Lê a Lista 02 LIGAÇÕES inteira e resume. Hoje são 167 tasks = 2 páginas (~3,8s medidos),
 * então varrer é barato — e o cache absorve o custo. `PAINEL_MAX_PAGINAS` protege o dia em
 * que a lista crescer: acima do teto o retorno vem marcado `parcial`.
 *
 * "hoje" usa o dia de Brasília (não UTC) — senão o dia vira às 21h BRT e as ligações da
 * noite caem no dia seguinte, exatamente o bug que metricas.ts:77 já documenta.
 *
 * ATENDEU é drop_down (Sim/Não), então "preenchido" NÃO significa "atendida" — significa
 * "tem desfecho". A decodificação correta mora em `lerAtendeu` (clickup.ts), e é ela que
 * este módulo usa. Medido em 18/08: das 141 ligações do dia, 17 eram Sim, 26 eram Não e
 * 98 estavam sem desfecho — contar "preenchido" publicava 43 atendidas, 2,5x o real.
 *
 * Os três contadores do dia (atendidas / naoAtendidas / semDesfecho) somam `hoje`.
 */
export async function resumoLigacoesAoVivo(): Promise<ResumoLigacoes> {
  const hoje = diaOperacionalStr();
  let page = 0;
  let ultima = false;
  const todas: TaskClickUp[] = [];
  while (!ultima && page < PAINEL_MAX_PAGINAS) {
    const r = await listarTasks(CLICKUP_LIST_LIGACOES, { page, includeClosed: true });
    todas.push(...r.tasks);
    ultima = r.lastPage;
    page += 1;
  }

  const deHoje = todas.filter((t) => diaDaTask(t.date_created) === hoje);
  const temDesfecho = (t: TaskClickUp) => preenchido(t, CAMPOS_LIGACOES.ATENDEU);
  const atendeuSim = (t: TaskClickUp) => temDesfecho(t) && lerAtendeu(t);

  let ultimaEm: string | null = null;
  for (const t of todas) {
    const n = Number(t.date_created);
    if (n && (!ultimaEm || n > Number(ultimaEm))) ultimaEm = String(n);
  }

  return {
    total: todas.length,
    hoje: deHoje.length,
    atendidasHoje: deHoje.filter(atendeuSim).length,
    naoAtendidasHoje: deHoje.filter((t) => temDesfecho(t) && !lerAtendeu(t)).length,
    semDesfechoHoje: deHoje.filter((t) => !temDesfecho(t)).length,
    atendidasTotal: todas.filter(atendeuSim).length,
    comGravacao: todas.filter((t) => preenchido(t, CAMPOS_LIGACOES.URL_GRAVACAO)).length,
    comTranscricao: todas.filter((t) => preenchido(t, CAMPOS_LIGACOES.TRANSCRICAO)).length,
    comAnaliseIa: todas.filter((t) => preenchido(t, CAMPOS_LIGACOES.ANALISE_IA)).length,
    ultimaEm: ultimaEm ? new Date(Number(ultimaEm)).toISOString() : null,
    parcial: !ultima,
  };
}

// ===== Fachada usada pela rota =====

export const CHAVE_CADASTROS = 'cadastros';
export const CHAVE_VOTOS = 'votos';
export const CHAVE_LIGACOES = 'ligacoes';

/** Cadastros com cache curto (leitura barata no Postgres). */
export function cadastrosComCache(): Promise<number | null> {
  return comCache(CHAVE_CADASTROS, PAINEL_TTL_BANCO_MS, contarCadastrosBanco);
}

/** Votos ao vivo do ClickUp, com cache (a consulta custa segundos). */
export function votosComCache(): Promise<VotosAoVivo> {
  return comCache(CHAVE_VOTOS, PAINEL_TTL_CLICKUP_MS, contarVotosClickUp);
}

/** Resumo das ligações, com cache (varre a Lista 02). */
export function ligacoesComCache(): Promise<ResumoLigacoes> {
  return comCache(CHAVE_LIGACOES, PAINEL_TTL_CLICKUP_MS, resumoLigacoesAoVivo);
}
