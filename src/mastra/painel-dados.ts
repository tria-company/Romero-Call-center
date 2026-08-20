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
import { CAMPOS_LEADS, OPCOES_LEADS, CAMPOS_LIGACOES, listarTasks, lerAtendeu, contarTasksDaLista, type TaskClickUp } from './clickup.ts';
import { contarVotosPorOperador } from './supabase.ts';
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

/** Distribuição da pergunta de voto de UM candidato. `base` = quem de fato respondeu. */
export interface IntencaoCandidato {
  rotulo: string;
  sim: number;
  nao: number;
  naoDeclarou: number;
  /** sim + nao + naoDeclarou. NÃO é a base inteira — ver nota em `contarVotosClickUp`. */
  base: number;
}

export interface VotosAoVivo {
  romero: number;
  andressa: number;
  apoiadores: number;
  intencao: IntencaoCandidato[];
  /** Apoiadores distintos por cidade. Quem não tem cidade entra como "sem cidade". */
  votosPorCidade: { rotulo: string; n: number }[];
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
 * Devolve id E CIDADE de cada task, não só a contagem. O id é necessário porque
 * `apoiadores` é a UNIÃO dos dois conjuntos (quem confirma nos dois candidatos é UMA
 * pessoa, e somar contaria duas vezes). A cidade sai de graça: a resposta do ClickUp já
 * traz a task inteira, com todos os custom fields — descartá-la era jogar fora dado já
 * pago para depois precisar dele.
 */
async function contarPorCustomField(
  fieldId: string,
  valor: string,
): Promise<{ tasks: { id: string; cidade: string }[]; parcial: boolean }> {
  if (!CLICKUP_API_TOKEN) throw new Error('[painel] CLICKUP_API_TOKEN ausente — nao da para contar votos');
  const filtro = encodeURIComponent(JSON.stringify([{ field_id: fieldId, operator: '=', value: valor }]));
  let page = 0;
  const tasks: { id: string; cidade: string }[] = [];
  let ultima = false;
  while (!ultima && page < PAINEL_MAX_PAGINAS) {
    const url = `${CLICKUP_BASE_URL}/list/${CLICKUP_LIST_LEADS}/task?page=${page}&include_closed=true&custom_fields=${filtro}`;
    // Mesmo teto e mesmo retry das varreduras: medido em 20/08, ESTA consulta também
    // abortava nos 15s do default e deixava o card "Intenção de voto" vazio — a Lista 01
    // tem 100 mil tasks e o filtro por custom field passa dos 15s com o ClickUp lento.
    let data: { tasks?: unknown[]; last_page?: boolean } | null = null;
    let ultimoErro: unknown = null;
    for (let tentativa = 1; tentativa <= 3 && !data; tentativa += 1) {
      try {
        const res = await fetchTimeout(url, { headers: { Authorization: CLICKUP_API_TOKEN } }, PAINEL_TIMEOUT_PAGINA_MS);
        if (!res.ok) throw new Error(`[painel] HTTP ${res.status} ao contar custom field na Lista 01`);
        data = await res.json();
      } catch (e) {
        ultimoErro = e;
        if (tentativa < 3) await new Promise((s) => setTimeout(s, 2000 * tentativa));
      }
    }
    if (!data) throw ultimoErro instanceof Error ? ultimoErro : new Error(String(ultimoErro));
    for (const t of data?.tasks || []) {
      if (!t?.id) continue;
      const cidade = String(
        (t.custom_fields || []).find((c: { id?: string }) => c?.id === CAMPOS_LEADS.CIDADE)?.value ?? '',
      ).trim();
      tasks.push({ id: String(t.id), cidade });
    }
    ultima = Boolean(data?.last_page);
    page += 1;
  }
  return { tasks, parcial: !ultima };
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

  // 6 consultas (3 opções × 2 candidatos) em PARALELO. Sequencial seriam ~12s de cache
  // frio, porque cada filtro por custom field custa ~2s; em paralelo fica no tempo da
  // mais lenta. O `nao`/`naoDeclarou` não é enfeite: sem eles não há denominador, e uma
  // barra de intenção sem base é só um número solto.
  const [rSim, rNao, rNd, aSim, aNao, aNd] = await Promise.all([
    contarPorCustomField(idR, OPCOES_LEADS[idR].sim),
    contarPorCustomField(idR, OPCOES_LEADS[idR].nao),
    contarPorCustomField(idR, OPCOES_LEADS[idR].naoDeclarou),
    contarPorCustomField(idA, OPCOES_LEADS[idA].sim),
    contarPorCustomField(idA, OPCOES_LEADS[idA].nao),
    contarPorCustomField(idA, OPCOES_LEADS[idA].naoDeclarou),
  ]);

  // Apoiadores = UNIÃO dos dois conjuntos de "sim": quem confirma nos dois é uma pessoa.
  const uniao = new Map<string, string>(); // taskId -> cidade
  for (const t of [...rSim.tasks, ...aSim.tasks]) if (!uniao.has(t.id)) uniao.set(t.id, t.cidade);

  // Cidade do APOIADOR distinto, não do voto — senão quem confirma nos dois candidatos
  // conta duas vezes na mesma cidade. Sem cidade vira rótulo próprio: o total do gráfico
  // continua batendo com o número de apoiadores, em vez de encolher em silêncio.
  const porCidade = new Map<string, number>();
  for (const cidade of uniao.values()) {
    const k = cidade || 'sem cidade';
    porCidade.set(k, (porCidade.get(k) ?? 0) + 1);
  }
  const votosPorCidade = [...porCidade.entries()]
    .map(([rotulo, n]) => ({ rotulo, n }))
    .sort((a, b) => b.n - a.n);

  // `base` é quem RESPONDEU a pergunta, não a base de cadastros. Uma taxa de intenção
  // sobre 224 mil cadastros seria sempre 0% — mediria cobertura da pesquisa, não
  // intenção. O rótulo do card já mostra "base N", então a amostra fica visível na tela
  // e ninguém lê "100%" sem ver que o N é pequeno.
  const intencao: IntencaoCandidato[] = [
    {
      rotulo: 'Romero',
      sim: rSim.tasks.length,
      nao: rNao.tasks.length,
      naoDeclarou: rNd.tasks.length,
      base: rSim.tasks.length + rNao.tasks.length + rNd.tasks.length,
    },
    {
      rotulo: 'Andreza',
      sim: aSim.tasks.length,
      nao: aNao.tasks.length,
      naoDeclarou: aNd.tasks.length,
      base: aSim.tasks.length + aNao.tasks.length + aNd.tasks.length,
    },
  ];

  return {
    romero: rSim.tasks.length,
    andressa: aSim.tasks.length,
    apoiadores: uniao.size,
    intencao,
    votosPorCidade,
    parcial: [rSim, rNao, rNd, aSim, aNao, aNd].some((x) => x.parcial),
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
 * A task foi DISCADA, ou só está na fila esperando?
 *
 * Esta é a distinção que faltava e que fazia o painel publicar 4,4x o número real. Task da
 * Lista 02 NÃO é ligação: ela nasce quando o lead entra na fila do dia, já com o campo
 * OPERADOR preenchido pelo processo que cria o lote — e o painel contava cada uma como uma
 * ligação feita. Medido em 20/08: 1.449 tasks, das quais só 328 tinham INICIO. O caso
 * extremo era uma telefonista com 80 tasks e ZERO discagens, publicada como "80 ligações".
 *
 * `INICIO` é o carimbo que `iniciarLigacao` grava no clique em "Ligar" (clickup.ts) — a
 * prova de discagem. Aceitamos TAMBÉM desfecho ou duração porque existe chamada que não
 * passou por essa rota (a inbound do WhatsApp nasce já atendida): medido, 25 das 89
 * atendidas não têm INICIO. Sem esses dois, a conta perderia atendimento real e
 * `contatos` passaria de `ligacoes`.
 *
 * MORA NO MÓDULO, não dentro de uma das funções, porque o Início e a Central precisam da
 * MESMA definição — foi exatamente por terem contas diferentes com o mesmo nome que as
 * duas telas publicaram "taxa de atendimento" a 23x de distância.
 */
function ligacaoDiscada(t: TaskClickUp): boolean {
  return (
    preenchido(t, CAMPOS_LIGACOES.INICIO) ||
    preenchido(t, CAMPOS_LIGACOES.ATENDEU) ||
    preenchido(t, CAMPOS_LIGACOES.DURACAO)
  );
}

/**
 * Só as DISCADAS, filtradas NO SERVIDOR do ClickUp.
 *
 * A varredura completa da Lista 02 deixou de ser viável: 2.710 tasks em 28 páginas, e o
 * gateway do ClickUp devolvendo 500 (timeout interno dele) em ~55s por página — medido em
 * 20/08, uma varredura inteira levaria ~23 minutos. Com os 15s do `fetchTimeout` toda
 * tentativa abortava e a Central ficava EM BRANCO, sem distinguir erro de "sem dados".
 *
 * `INICIO IS NOT NULL` é a mesma prova de discagem que `ligacaoDiscada` usa, só que
 * aplicada antes de os dados saírem do ClickUp: 326 tasks em 4 páginas em vez de 2.710 em
 * 28. Verificado que o filtro é REAL (nenhuma task voltou sem INICIO), não ignorado.
 *
 * O que se perde: a task que nunca foi discada não vem, então a fila não sai desta
 * varredura — ela vem do `task_count` da lista, por subtração.
 */
const FILTRO_DISCADAS = [{ field_id: CAMPOS_LIGACOES.INICIO, operator: 'IS NOT NULL' }];

/** Teto por página para as varreduras do painel. Não confundir com o default de 15s do
 *  `fetchTimeout`, que existe para o webhook do GHL e continua intocado. */
const PAINEL_TIMEOUT_PAGINA_MS = Number(process.env.PAINEL_TIMEOUT_PAGINA_MS) || 90000;

/**
 * Varre as ligações DISCADAS com retry por página.
 *
 * O 500 do ClickUp aqui é transitório e do lado DELES (o corpo é o proxy interno deles
 * dizendo "timeout awaiting response headers"): medido em 19/08, três páginas seguidas
 * falharam e as MESMAS três voltaram 200 nas 9 tentativas seguintes. Sem retry, uma página
 * ruim mata a varredura inteira — que era o que fazia o painel apagar.
 */
async function varrerDiscadas(): Promise<{ tasks: TaskClickUp[]; parcial: boolean }> {
  const todas: TaskClickUp[] = [];
  let page = 0;
  let ultima = false;
  while (!ultima && page < PAINEL_MAX_PAGINAS) {
    let r: { tasks: TaskClickUp[]; lastPage: boolean } | null = null;
    let ultimoErro: unknown = null;
    for (let tentativa = 1; tentativa <= 3 && !r; tentativa += 1) {
      try {
        r = await listarTasks(CLICKUP_LIST_LIGACOES, {
          page,
          includeClosed: true,
          customFields: FILTRO_DISCADAS,
          timeoutMs: PAINEL_TIMEOUT_PAGINA_MS,
        });
      } catch (e) {
        ultimoErro = e;
        if (tentativa < 3) await new Promise((s) => setTimeout(s, 2000 * tentativa));
      }
    }
    // Esgotadas as tentativas, PROPAGA (WR-03) — o cache mantém o valor anterior e a rota
    // devolve 502. Devolver o que já veio seria publicar um total pela metade sem aviso.
    if (!r) throw ultimoErro instanceof Error ? ultimoErro : new Error(String(ultimoErro));
    todas.push(...r.tasks);
    ultima = r.lastPage;
    page += 1;
  }
  return { tasks: todas, parcial: !ultima };
}

/**
 * Dia da ligação = dia em que foi DISCADA (INICIO), não em que a task foi criada. O lote do
 * dia seguinte nasce de madrugada; usar `date_created` jogava a produção para o dia da
 * criação do lote, não para o dia em que a telefonista trabalhou. Sem INICIO (inbound),
 * cai no `date_created`, que ali é o instante da chamada.
 */
function diaDaLigacao(t: TaskClickUp): string {
  return diaDaTask(valorCampo(t, CAMPOS_LIGACOES.INICIO) ?? t.date_created) || diaDaTask(t.date_created);
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
  // Só as DISCADAS, filtradas no servidor: este bloco só publica número de chamada, e a
  // task nunca discada não entra em nenhum deles.
  const { tasks: todas, parcial } = await varrerDiscadas();

  // DISCADAS, e pelo dia da DISCAGEM — mesma definição que a Central usa (`ligacaoDiscada`).
  // Antes contava toda task criada no dia: o lote nasce de madrugada já com o nome da
  // telefonista no campo Operador, então "Ligações hoje" publicava o TAMANHO DA FILA, não
  // a produção. Medido em 20/08: 94 tasks criadas contra um punhado de fato discado.
  const deHoje = todas.filter((t) => ligacaoDiscada(t) && diaDaLigacao(t) === hoje);
  const temDesfecho = (t: TaskClickUp) => preenchido(t, CAMPOS_LIGACOES.ATENDEU);
  const atendeuSim = (t: TaskClickUp) => temDesfecho(t) && lerAtendeu(t);

  // "última às HH:MM" é a última DISCAGEM, não a última task criada pelo lote — senão o
  // horário mostrado é o da geração do lote de madrugada.
  let ultimaEm: string | null = null;
  for (const t of todas) {
    if (!ligacaoDiscada(t)) continue;
    const n = Number(valorCampo(t, CAMPOS_LIGACOES.INICIO) ?? t.date_created);
    if (n && (!ultimaEm || n > Number(ultimaEm))) ultimaEm = String(n);
  }

  return {
    total: todas.filter(ligacaoDiscada).length,
    hoje: deHoje.length,
    atendidasHoje: deHoje.filter(atendeuSim).length,
    naoAtendidasHoje: deHoje.filter((t) => temDesfecho(t) && !lerAtendeu(t)).length,
    semDesfechoHoje: deHoje.filter((t) => !temDesfecho(t)).length,
    atendidasTotal: todas.filter(atendeuSim).length,
    comGravacao: todas.filter((t) => preenchido(t, CAMPOS_LIGACOES.URL_GRAVACAO)).length,
    comTranscricao: todas.filter((t) => preenchido(t, CAMPOS_LIGACOES.TRANSCRICAO)).length,
    comAnaliseIa: todas.filter((t) => preenchido(t, CAMPOS_LIGACOES.ANALISE_IA)).length,
    ultimaEm: ultimaEm ? new Date(Number(ultimaEm)).toISOString() : null,
    parcial,
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
  /** Ligações DISCADAS (com prova de chamada). NÃO é o total de tasks do operador. */
  lig: number;
  /** Leads atribuídos e ainda não discados. `lig + fila` = tudo que caiu na mão dele. */
  fila: number;
  cont: number;
  conv: number;   // % de conversão = contatos / ligações DISCADAS
  /** Aderência ao script em PERCENTUAL (0–100), convertida da nota 0–10 do Agente de
   *  Análise. Vale 0 tanto para "avaliada com nota 0" quanto para "nunca avaliada" —
   *  quem separa os dois casos é `aderAmostra`, e a tela precisa olhar os dois. */
  ader: number;
  /** Quantas ligações do operador têm nota de aderência. 0 = nunca avaliada: a tela mostra
   *  "—" em vez de 0%, senão quem nunca foi ouvido aparece como o pior da equipe. Medido
   *  em 19/08: só 52 das 1.345 ligações tinham nota, e 15 dos 28 operadores tinham zero. */
  aderAmostra: number;
  tsec: number;   // tempo MEDIANO em segundos (mesma conta do card "tempo médio geral")
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
  /** Ligações DISCADAS — com prova de chamada (INICIO, desfecho ou duração). */
  totalLigacoes: number;
  /** Leads atribuídos e ainda NÃO discados. `totalLigacoes + totalNaFila` = tasks da Lista 02. */
  totalNaFila: number;
  totalContatos: number;
  /** Sem desfecho gravado, entre as DISCADAS: o denominador honesto da taxa depende disto. */
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
 * Teto da nota de aderência ao script. NÃO é escolha deste módulo: é o contrato do Agente
 * de Análise, que pede à IA "um numero de 0 a 10" (analise.ts) e trava o resultado nessa
 * faixa antes de gravar no ClickUp. O dossiê imprime a mesma nota como "N/10".
 */
const NOTA_ADERENCIA_MAX = 10;

/**
 * Média das notas de aderência convertida em PERCENTUAL.
 *
 * O painel sempre desenhou este número com um `%` colado e o comparou contra 80/70 (verde/
 * âmbar/vermelho) — mas o que chegava aqui era a nota 0–10 crua. O efeito, medido em
 * 19/08 sobre as 52 notas existentes (min 0, max 8): uma ligação avaliada com 8 de 10
 * aparecia como "8%" e levava a bolinha VERMELHA de "treino", e o limiar de 80% era
 * inalcançável por construção — o teto da escala é 10.
 *
 * A conversão é feita aqui, e não na tela, porque `ader` é publicado como percentual no
 * contrato da rota: quem consumir a API recebe a mesma unidade que o painel desenha.
 *
 * O `clamp` protege contra nota digitada à mão no ClickUp fora da escala do agente (um
 * "85" viraria 850%). Sem amostra devolve 0, e `aderAmostra` é quem diz à tela que isso é
 * ausência de avaliação, não desempenho ruim.
 */
function aderenciaEmPct(notas: number[]): number {
  if (notas.length === 0) return 0;
  const media = notas.reduce((s, n) => s + n, 0) / notas.length;
  return Math.max(0, Math.min(100, Math.round((media / NOTA_ADERENCIA_MAX) * 100)));
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
  const { tasks: todas, parcial } = await varrerDiscadas();

  // Total da lista pelo `task_count` — UMA requisição, em vez das 24 páginas que a fila
  // custaria para ser varrida. `fila = total − discadas`. Se falhar, a fila fica em 0 e a
  // tela simplesmente não mostra a linha (ela é condicional): melhor omitir do que
  // publicar um tamanho de fila errado ao lado de números certos.
  let totalNaLista = 0;
  try {
    totalNaLista = await contarTasksDaLista(CLICKUP_LIST_LIGACOES);
  } catch (e) {
    console.error('[painel] task_count da Lista 02 indisponivel (fila fica em 0):', e instanceof Error ? e.message : String(e));
  }

  const temDesfecho = (t: TaskClickUp) => preenchido(t, CAMPOS_LIGACOES.ATENDEU);
  const contato = (t: TaskClickUp) => temDesfecho(t) && lerAtendeu(t);
  const comOperador = (t: TaskClickUp) => preenchido(t, CAMPOS_LIGACOES.OPERADOR);

  const discada = ligacaoDiscada; // fonte única, compartilhada com o Início

  // --- série diária (só o que foi discado) ---
  const porDia = new Map<string, { ligacoes: number; contatos: number }>();
  for (const t of todas) {
    if (!discada(t)) continue;
    const d = diaDaLigacao(t);
    if (!d) continue;
    const e = porDia.get(d) ?? { ligacoes: 0, contatos: 0 };
    e.ligacoes += 1;
    if (contato(t)) e.contatos += 1;
    porDia.set(d, e);
  }
  const serie: DiaCampanha[] = [...porDia.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dia, v]) => ({ dia, ligacoes: v.ligacoes, contatos: v.contatos }));

  // --- votos atribuídos ao operador que os colheu (Supabase, votos_ligacao) ---
  //
  // Fora do try/catch da varredura DE PROPÓSITO: voto fora do ar não pode derrubar a
  // Central inteira, que é majoritariamente feita de ligação. Falhou (ou a migração 05
  // ainda não foi aplicada) → mapa vazio → a coluna mostra 0 e o resto da tela vive.
  let votosPorOperador = new Map<string, number>();
  try {
    votosPorOperador = await contarVotosPorOperador();
  } catch (e) {
    console.error('[painel] votos por operador indisponiveis (coluna fica zerada):', e instanceof Error ? e.message : String(e));
  }

  // --- ranking por telefonista ---
  //
  // A chave do grupo é o login em MINÚSCULA, não o texto cru: medido em 19/08, o campo
  // trazia `kalinebrito288` (67 ligações) e `Kalinebrito288` (8) — a MESMA pessoa em duas
  // linhas do ranking, competindo consigo mesma com metade do volume cada. O rótulo
  // exibido é a grafia mais frequente do próprio grupo (mesmo critério de `agruparMotivos`),
  // então a tela mostra como a operação escreve, sem inventar caixa.
  const SEM_OP = 'sem operador';
  interface Acc {
    /** DISCADAS — as que têm prova de chamada. É isto que a tela chama de "ligações". */
    lig: number;
    /** atribuídas e ainda NÃO discadas: o que sobrou da fila do dia. */
    fila: number;
    cont: number;
    segs: number[];
    aders: number[];
    /** grafias vistas deste mesmo login -> quantas vezes; a mais comum vira o rótulo */
    variantes: Map<string, number>;
    ini: number;
    fim: number;
  }
  const porOp = new Map<string, Acc>();
  for (const t of todas) {
    const bruto = String(valorCampo(t, CAMPOS_LIGACOES.OPERADOR) ?? '').trim();
    const chave = bruto.toLowerCase() || SEM_OP;
    const a = porOp.get(chave) ?? { lig: 0, fila: 0, cont: 0, segs: [], aders: [], variantes: new Map<string, number>(), ini: Infinity, fim: 0 };
    if (bruto) a.variantes.set(bruto, (a.variantes.get(bruto) ?? 0) + 1);
    // Os dois contadores são exclusivos e somam o total de tasks do operador — quem
    // conferir a conta consegue reconstruir o número antigo somando as duas colunas.
    a.lig += 1; // a varredura ja vem filtrada por INICIO — tudo aqui foi discado
    if (contato(t)) a.cont += 1;
    const seg = duracaoEmSegundos(valorCampo(t, CAMPOS_LIGACOES.DURACAO));
    if (seg) a.segs.push(seg);
    // `preenchido` antes de `Number`: o campo AUSENTE vira NaN (filtrado pelo isFinite),
    // mas o campo VAZIO ('') vira 0 — e um 0 falso baixaria a média de quem nunca foi
    // avaliado. A nota 0 REAL entra: ela é a pior avaliação possível, não a ausência de
    // avaliação, e o `> 0` de antes a descartava — medido em 19/08, 19 das 52 notas eram
    // 0, todas jogadas fora, e a média saía só dos sobreviventes.
    if (preenchido(t, CAMPOS_LIGACOES.ADERENCIA_SCRIPT)) {
      const nota = Number(valorCampo(t, CAMPOS_LIGACOES.ADERENCIA_SCRIPT));
      if (Number.isFinite(nota)) a.aders.push(nota);
    }
    // Janela de trabalho para `ligh`: só as DISCADAS, e pelo instante da DISCAGEM.
    // Com `date_created` de todas, a janela virava o instante de criação do lote — as ~80
    // tasks do dia nascem no mesmo segundo — e "ligações por hora" saía absurdo (medido:
    // 23/h para quem tinha zero discagens).
    if (discada(t)) {
      const ts = Number(valorCampo(t, CAMPOS_LIGACOES.INICIO) ?? t.date_created);
      if (ts) { a.ini = Math.min(a.ini, ts); a.fim = Math.max(a.fim, ts); }
    }
    porOp.set(chave, a);
  }
  const balde = porOp.get(SEM_OP);
  const semOperador = { lig: balde?.lig ?? 0, cont: balde?.cont ?? 0 };
  const telefonistas: TelefonistaCampanha[] = [...porOp.entries()]
    .filter(([chave]) => chave !== SEM_OP)
    .map(([chave, a], i) => {
      const horas = Math.max(1, (a.fim - a.ini) / 3600000);
      const grafia = [...a.variantes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? chave;
      return {
        id: i + 1,
        nome: nomeDeOperador(grafia),
        turno: '',
        lig: a.lig,
        fila: a.fila,
        cont: a.cont,
        conv: a.lig ? Math.round((a.cont / a.lig) * 100) : 0,
        ader: aderenciaEmPct(a.aders),
        aderAmostra: a.aders.length,
        // MEDIANA, igual ao card "tempo médio geral" — e não a média, que era o que estava
        // aqui. Os dois carregam o rótulo "médio" na tela e precisam ser a MESMA conta,
        // senão não fecham: medido em 19/08, mediana=83s contra média=204s no mesmo
        // conjunto. A média ainda leva o outlier de 12.217s (3h23, ligação que nunca gravou
        // FIM) e publicava 47min de "tempo médio" para quem fez 9 ligações.
        tsec: mediana([...a.segs].sort((x, y) => x - y)),
        // Votos ATRIBUÍDOS (votos_ligacao): pessoas distintas que declararam "sim" na
        // ligação deste operador. Antes era 0 fixo, com a nota "o ClickUp não guarda quem
        // registrou" — verdade só para leitura direta: a rota /api/discador/voto SEMPRE
        // soube quem marcou (sessão) e de qual ligação veio, e descartava os dois depois de
        // autorizar. Agora grava, e o número vira medição em vez de lacuna.
        // Zero aqui = "ninguém confirmou voto com este operador", não "não dá para saber".
        votos: votosPorOperador.get(chave) ?? 0,
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
    // DISCADAS, não tasks. Era `todas.length` sobre a lista inteira e publicava 4,4x o
    // real (2.710 contra 355) — hoje a varredura já chega filtrada.
    totalLigacoes: todas.length,
    // Por subtração: o `task_count` da lista menos o que foi discado. Zero quando o
    // task_count falhou — a tela omite a linha em vez de mostrar fila errada.
    totalNaFila: totalNaLista > 0 ? Math.max(0, totalNaLista - todas.length) : 0,
    totalContatos: todas.filter(contato).length,
    // Sobre as DISCADAS — e agora todas são, por construção da varredura.
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
    parcial,
  };
}

export const CHAVE_CAMPANHA = 'campanha';

/** Resumo da Central de Campanha, com cache (varre a Lista 02, mesmo custo do resumo). */
export function campanhaComCache(): Promise<ResumoCampanha> {
  return comCache(CHAVE_CAMPANHA, PAINEL_TTL_CLICKUP_MS, resumoCampanhaAoVivo);
}
