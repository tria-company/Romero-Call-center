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

// ===== 4. Central de Campanha — produção diária, ranking e taxa de atendimento =====
//
// A Central estava vazia desde 15/08 por decisão (commit 93c0a31 trocou a leitura de um
// `reais.json` estático por `const real = VAZIO`, com a nota "sem telemetria ao vivo").
// Estes agregados são a telemetria que faltava, montada da Lista 02 LIGAÇÕES.
//
// O que NÃO dá pra montar, e por quê:
//   • série de votos ao longo do tempo — o ClickUp não guarda QUANDO o voto foi confirmado;
//   • comparativo semana vs anterior — só existem 6 dias de operação (12 a 18/08).
// A tela já trata os dois casos com o texto certo; não inventamos série aqui.

export interface DiaCampanha {
  dia: string;        // YYYY-MM-DD (dia BRT)
  ligacoes: number;
  contatos: number;   // atendidas de verdade (ATENDEU = Sim)
}

export interface TelefonistaCampanha {
  id: number;
  nome: string;
  turno: string;
  lig: number;
  cont: number;
  conv: number;   // % de conversão = contatos / ligações
  ader: number;   // aderência ao script (0 quando não avaliada)
  tsec: number;   // tempo médio em segundos
  votos: number;
  ligh: number;   // ligações por hora
}

export interface MotivoNaoContato {
  rotulo: string;
  n: number;
  /** % sobre as ligações que TÊM motivo — não sobre o total (ver nota em `agruparMotivos`). */
  pctTotal: number;
}

export interface ResumoCampanha {
  serie: DiaCampanha[];
  telefonistas: TelefonistaCampanha[];
  motivosNaoContato: MotivoNaoContato[];
  /**
   * Falhas do NOSSO lado, separadas dos motivos do eleitor. "Transcrição não obtida" é
   * ligação que FOI atendida e que só não conseguimos transcrever — deixá-la no gráfico
   * contaria um problema nosso como recusa de quem atendeu. Fica exposto aqui para o
   * número não sumir sem registro.
   */
  falhasTecnicas: { rotulo: string; n: number }[];
  totalLigacoes: number;
  totalContatos: number;
  /** Sem desfecho gravado: o denominador honesto da taxa depende disto. */
  semDesfecho: number;
  /** Ligações sem OPERADOR — fora do ranking, mas dentro dos totais (ver nota). */
  semOperador: { lig: number; cont: number };
  /**
   * Por que a coluna de contatos do ranking fica quase zerada: das ligações FEITAS PELO
   * APP (as que gravam OPERADOR), a imensa maioria nunca grava desfecho — medido em
   * 18/08: 144 com operador, das quais só 3 atendidas e 104 sem desfecho nenhum. O
   * ranking mede VOLUME com confiança; conversão só volta a valer quando o desfecho for
   * gravado de forma confiável. Exposto aqui pra tela poder dizer isso em vez de exibir
   * um zero sem explicação.
   */
  desfechoDeApp: { comOperador: number; atendidas: number; semDesfecho: number };
  tempoMedio: { atual: number; min: number; mediana: number; max: number; amostra: number };
  parcial: boolean;
}

/**
 * Converte a DURAÇÃO da Ligação em segundos. O campo é TEXTO no formato "5min 32s"
 * (verificado em 18/08: 38 valores preenchidos, todos nesse molde) — `Number()` nele
 * devolve NaN, que foi o motivo de a primeira medição achar "0 com duração".
 * Aceita também "45s" e "2min". Devolve null quando não dá pra ler.
 */
export function duracaoEmSegundos(valor: unknown): number | null {
  const txt = String(valor ?? '').trim().toLowerCase();
  if (!txt) return null;
  const m = txt.match(/(?:(\d+)\s*min)?\s*(?:(\d+)\s*s)?/);
  if (!m) return null;
  const min = Number(m[1] || 0);
  const seg = Number(m[2] || 0);
  const total = min * 60 + seg;
  return total > 0 ? total : null;
}

/**
 * Motivos que descrevem uma FALHA NOSSA, não uma reação do eleitor. Medido em 18/08: das
 * 42 ligações com motivo, 4 eram "Transcrição não obtida após 3 tentativas" — a chamada
 * foi atendida e a transcrição é que falhou. Contá-la como motivo de não-contato inverte
 * a leitura do gráfico.
 */
const PADROES_FALHA_TECNICA = [/transcri/i];

/**
 * Sinônimos do campo MOTIVO, que é TEXTO LIVRE. Normalizar caixa e acento NÃO resolve: os
 * valores reais divergem na PALAVRA, não na grafia — "Não atende" (32) e "não atendida"
 * (4) viram "nao atende" e "nao atendida", que continuam sendo strings diferentes. Só um
 * mapa explícito junta.
 *
 * É decisão de produto, não regra técnica: cada linha afirma "estes dois textos são o
 * mesmo motivo". Mantido aqui, curto e visível, para ser revisado quando a operação
 * inventar uma redação nova — e não escondido numa heurística de similaridade, que
 * juntaria motivos distintos sem ninguém perceber.
 *
 * Chave: forma normalizada. Valor: rótulo canônico exibido no gráfico.
 */
const SINONIMOS_MOTIVO: Record<string, string> = {
  'nao atende': 'Não atende',
  'nao atendida': 'Não atende',
  'nao atendeu': 'Não atende',
  'recusada': 'Recusada pelo lead',
  'recusada pelo lead': 'Recusada pelo lead',
  'recusou': 'Recusada pelo lead',
  'ocupado': 'Ocupado',
  'chamou e caiu': 'Chamou e caiu',
};

/** Chave de agrupamento: sem acento, minúscula, espaços colapsados. */
function chaveMotivo(bruto: string): string {
  return bruto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // faixa de diacriticos combinantes
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Agrupa os motivos por forma canônica. O campo é TEXTO livre e a mesma coisa aparece
 * escrita de dois jeitos — medido em 18/08: "Não atende" (25) e "não atendida" (3) são o
 * mesmo motivo, assim como "Recusada pelo lead" (5) e "recusada" (2). Sem agrupar, o
 * gráfico desenha a mesma barra duas vezes e nenhuma das duas tem o número certo.
 *
 * O rótulo vem de SINONIMOS_MOTIVO quando o texto é conhecido; quando não é, exibe a
 * grafia mais frequente do próprio grupo — motivo novo aparece no gráfico com o texto que
 * a operação escreveu, em vez de ser engolido por um "outros".
 *
 * `pctTotal` é sobre as ligações COM motivo, não sobre todas. Motivo só existe quando há
 * desfecho, e 105 das 167 não têm — usar o total faria toda barra parecer minúscula por
 * causa do que não foi registrado, e não do que aconteceu.
 */
export function agruparMotivos(
  brutos: string[],
): { motivos: MotivoNaoContato[]; tecnicas: { rotulo: string; n: number }[] } {
  const grupos = new Map<string, Map<string, number>>();
  const tecnicasMap = new Map<string, number>();

  for (const bruto of brutos) {
    const txt = String(bruto ?? '').trim();
    if (!txt) continue;
    if (PADROES_FALHA_TECNICA.some((re) => re.test(txt))) {
      tecnicasMap.set(txt, (tecnicasMap.get(txt) ?? 0) + 1);
      continue;
    }
    const norm = chaveMotivo(txt);
    // O sinônimo decide o grupo E o rótulo. Texto desconhecido vira grupo próprio com a
    // grafia original — motivo novo APARECE no gráfico em vez de sumir num "outros".
    const canonico = SINONIMOS_MOTIVO[norm];
    const k = canonico ? chaveMotivo(canonico) : norm;
    const variantes = grupos.get(k) ?? new Map<string, number>();
    const rotulo = canonico ?? txt;
    variantes.set(rotulo, (variantes.get(rotulo) ?? 0) + 1);
    grupos.set(k, variantes);
  }

  const total = [...grupos.values()].reduce(
    (soma, variantes) => soma + [...variantes.values()].reduce((a, b) => a + b, 0),
    0,
  );

  const motivos = [...grupos.values()]
    .map((variantes) => {
      const n = [...variantes.values()].reduce((a, b) => a + b, 0);
      const rotulo = [...variantes.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { rotulo, n, pctTotal: total ? Math.round((n / total) * 100) : 0 };
    })
    .sort((a, b) => b.n - a.n);

  const tecnicas = [...tecnicasMap.entries()]
    .map(([rotulo, n]) => ({ rotulo, n }))
    .sort((a, b) => b.n - a.n);

  return { motivos, tecnicas };
}

/**
 * Rótulo legível do telefonista. `OPERADOR` guarda o login, que em 124 das 144 ligações
 * é um e-mail — num ranking, "wenellyhsc@gmail.com" ocupa a linha inteira e não diz nome.
 * Corta o domínio e troca separadores por espaço; o que não é e-mail passa intacto
 * ("Romero Albuquerque", "admin"). Não inventa nome: se só há o local-part, é ele que vai.
 */
export function nomeDeOperador(bruto: string): string {
  const t = String(bruto ?? '').trim();
  if (!t) return 'sem operador';
  const local = t.includes('@') ? t.slice(0, t.indexOf('@')) : t;
  return local.replace(/[._-]+/g, ' ').trim() || t;
}

function mediana(ordenados: number[]): number {
  if (ordenados.length === 0) return 0;
  const meio = Math.floor(ordenados.length / 2);
  return ordenados.length % 2 ? ordenados[meio] : Math.round((ordenados[meio - 1] + ordenados[meio]) / 2);
}

/**
 * Agrega a Lista 02 por DIA e por OPERADOR. Uma varredura só alimenta os três cards —
 * produção diária, ranking de telefonistas e taxa de atendimento — e o cache absorve o
 * custo (~3,8s hoje, 167 ligações em 2 páginas).
 *
 * `contatos` usa `lerAtendeu` (ATENDEU = Sim), nunca "campo preenchido".
 *
 * `OPERADOR` é campo de TEXTO livre gravado por `registrarDesfecho`. Ligação SEM operador
 * fica FORA do ranking e vai para `semOperador` — medido em 18/08, esse balde tinha 23
 * ligações e 21 dos 24 contatos totais, e apareceria no topo da lista como se fosse a
 * melhor telefonista da equipe. Continua somando nos totais: é dado real, só não é pessoa.
 *
 * `ligh` sai da janela real daquele operador (primeira à última ligação), com piso de 1h
 * pra não inflar quem fez 2 ligações em 10 minutos.
 *
 * TEMPO: `atual` é a MEDIANA, não a média. O campo DURAÇÃO tem outliers grosseiros
 * (medido: máximo de 12.217s = 3h23, contra mediana de 50s) — provavelmente ligação que
 * nunca gravou FIM. A média vira 717s e mente; a mediana aguenta o outlier.
 *
 * LGPD: nome de operador é infraestrutura da campanha, não dado do lead (mesmo racional do
 * commit u26). Nenhum telefone/CPF sai daqui.
 */
export async function resumoCampanhaAoVivo(): Promise<ResumoCampanha> {
  let page = 0;
  let ultima = false;
  const todas: TaskClickUp[] = [];
  while (!ultima && page < PAINEL_MAX_PAGINAS) {
    const r = await listarTasks(CLICKUP_LIST_LIGACOES, { page, includeClosed: true });
    todas.push(...r.tasks);
    ultima = r.lastPage;
    page += 1;
  }

  const temDesfecho = (t: TaskClickUp) => preenchido(t, CAMPOS_LIGACOES.ATENDEU);
  const contato = (t: TaskClickUp) => temDesfecho(t) && lerAtendeu(t);
  const comOperador = (t: TaskClickUp) => preenchido(t, CAMPOS_LIGACOES.OPERADOR);

  // --- série diária ---
  const porDia = new Map<string, { ligacoes: number; contatos: number }>();
  for (const t of todas) {
    const d = diaDaTask(t.date_created);
    if (!d) continue;
    const e = porDia.get(d) ?? { ligacoes: 0, contatos: 0 };
    e.ligacoes += 1;
    if (contato(t)) e.contatos += 1;
    porDia.set(d, e);
  }
  const serie: DiaCampanha[] = [...porDia.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dia, v]) => ({ dia, ligacoes: v.ligacoes, contatos: v.contatos }));

  // --- ranking por telefonista ---
  interface Acc { lig: number; cont: number; segs: number[]; aders: number[]; ini: number; fim: number }
  const porOp = new Map<string, Acc>();
  for (const t of todas) {
    const nome = String(valorCampo(t, CAMPOS_LIGACOES.OPERADOR) ?? '').trim() || 'sem operador';
    const a = porOp.get(nome) ?? { lig: 0, cont: 0, segs: [], aders: [], ini: Infinity, fim: 0 };
    a.lig += 1;
    if (contato(t)) a.cont += 1;
    const seg = duracaoEmSegundos(valorCampo(t, CAMPOS_LIGACOES.DURACAO));
    if (seg) a.segs.push(seg);
    const ader = Number(valorCampo(t, CAMPOS_LIGACOES.ADERENCIA_SCRIPT));
    if (Number.isFinite(ader) && ader > 0) a.aders.push(ader);
    const ts = Number(t.date_created);
    if (ts) { a.ini = Math.min(a.ini, ts); a.fim = Math.max(a.fim, ts); }
    porOp.set(nome, a);
  }
  const media = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);
  const SEM_OP = 'sem operador';
  const balde = porOp.get(SEM_OP);
  const semOperador = { lig: balde?.lig ?? 0, cont: balde?.cont ?? 0 };
  const telefonistas: TelefonistaCampanha[] = [...porOp.entries()]
    .filter(([nome]) => nome !== SEM_OP)
    .map(([nome, a], i) => {
      const horas = Math.max(1, (a.fim - a.ini) / 3600000);
      return {
        id: i + 1,
        nome: nomeDeOperador(nome),
        turno: '',
        lig: a.lig,
        cont: a.cont,
        conv: a.lig ? Math.round((a.cont / a.lig) * 100) : 0,
        ader: media(a.aders),
        tsec: media(a.segs),
        votos: 0, // voto não é atribuível ao operador: o ClickUp não guarda quem o registrou
        ligh: Math.round((a.lig / horas) * 10) / 10,
      };
    })
    .sort((x, y) => y.lig - x.lig);

  // --- motivos de nao-contato ---
  const { motivos, tecnicas } = agruparMotivos(
    todas.map((t) => String(valorCampo(t, CAMPOS_LIGACOES.MOTIVO_FALHA) ?? '')),
  );

  const segs = todas
    .map((t) => duracaoEmSegundos(valorCampo(t, CAMPOS_LIGACOES.DURACAO)))
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);

  return {
    serie,
    telefonistas,
    motivosNaoContato: motivos,
    falhasTecnicas: tecnicas,
    totalLigacoes: todas.length,
    totalContatos: todas.filter(contato).length,
    semDesfecho: todas.filter((t) => !temDesfecho(t)).length,
    semOperador,
    desfechoDeApp: {
      comOperador: todas.filter(comOperador).length,
      atendidas: todas.filter((t) => comOperador(t) && contato(t)).length,
      semDesfecho: todas.filter((t) => comOperador(t) && !temDesfecho(t)).length,
    },
    tempoMedio: {
      atual: mediana(segs),
      min: segs[0] ?? 0,
      mediana: mediana(segs),
      max: segs[segs.length - 1] ?? 0,
      amostra: segs.length,
    },
    parcial: !ultima,
  };
}

export const CHAVE_CAMPANHA = 'campanha';

/** Resumo da Central de Campanha, com cache (varre a Lista 02, mesmo custo do resumo). */
export function campanhaComCache(): Promise<ResumoCampanha> {
  return comCache(CHAVE_CAMPANHA, PAINEL_TTL_CLICKUP_MS, resumoCampanhaAoVivo);
}
