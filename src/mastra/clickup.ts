// Integracao com ClickUp — store operacional do RomeroCall (Listas 01 LEADS /
// 02 LIGACOES). Substitui o GHL como fonte da verdade operacional (FUND-01/02).
//
// Autenticacao: Personal API Token via REST v2 (D-01), header `Authorization`
// RAW (SEM "Bearer") com o token de `config.ts`. NAO usar o MCP do ClickUp em
// runtime (D-01/D-02 — o MCP desta sessao nao enxerga a workspace do usuario).
//
// Os custom fields das duas listas JA EXISTEM (D-05) — este modulo nunca cria
// lista/campo, so le/escreve. Escrita de custom field e SEMPRE por field_id
// (nunca por nome — D-07), usando os mapas CAMPOS_LEADS/CAMPOS_LIGACOES abaixo.

import {
  CLICKUP_API_TOKEN,
  CLICKUP_LIST_LEADS,
  CLICKUP_LIST_LIGACOES,
  CLICKUP_LIST_AUDIOS,
  CLICKUP_TEAM_ID,
  CLICKUP_TIMEOUT_MS,
  CLICKUP_ESCRITA_HABILITADA,
  OPER_STATUS_EM_PROCESSAMENTO,
  OPER_STATUS_FECHADO,
} from './config.ts';
import { fetchTimeout } from './http.ts';
import { adquirirToken } from './rate-limiter-clickup.ts';
import { obterFilaCache, guardarFilaCache, obterLigacaoCache, guardarLigacaoCache } from './cache-fila.ts';
import { mapearFilaLigacao, parseLeadDaTask } from './lote.ts';
import type { ItemFila } from './lote.ts';
import { mascararTelefone, scrubPii } from './mascarar.ts';
import { registrar429ClickUp } from './metricas.ts';

const CLICKUP_BASE_URL = 'https://api.clickup.com/api/v2';

/**
 * Choke point ÚNICO de saída HTTP ao ClickUp (CACHE-02, D-05): toda chamada
 * passa por `adquirirToken()` (rate-limiter-clickup.ts) IMEDIATAMENTE ANTES
 * do `fetchTimeout()` — garante que NENHUMA saída escapa do rate limiter
 * global, sem depender de cada caller lembrar. `adquirirToken()` nunca
 * lança (bounded-wait/fail-open); o comportamento de erro de rede/HTTP
 * (WR-03: lança, nunca mascara) fica intacto nos callers, que continuam
 * envolvendo esta função com o mesmo try/catch de sempre.
 */
async function fetchClickUp(url: string, options?: RequestInit, timeoutMs?: number): Promise<Response> {
  // Trava de escrita (homolog aponta pro ClickUp de produção só-leitura): se
  // CLICKUP_ESCRITA_HABILITADA=false, bloqueia todo verbo mutante ANTES de
  // qualquer efeito — nenhum voto/desfecho/task de homolog toca uma task real.
  // Fail-closed e barato: default de produção (true) nem entra aqui. LGPD: não
  // loga URL (pode conter ids); só o método.
  const metodo = (options?.method ?? 'GET').toUpperCase();
  if (!CLICKUP_ESCRITA_HABILITADA && metodo !== 'GET' && metodo !== 'HEAD') {
    throw new Error(`[clickup] escrita bloqueada (CLICKUP_ESCRITA_HABILITADA=false): ${metodo} não permitido neste ambiente`);
  }
  await adquirirToken();
  // CLICKUP_TIMEOUT_MS (60s) e não o default global de 15s do fetchTimeout:
  // as consultas de tasks degradam a ~45s no ClickUp (incidente 2026-08-20)
  // e com 15s TODAS abortam — caller com timeout explícito segue mandando.
  const res = await fetchTimeout(url, options, timeoutMs ?? CLICKUP_TIMEOUT_MS);
  // D-06: conta o 429 REAL que ainda escapou do rate limiter proativo — so o
  // incremento do contador (metricas.ts nunca lanca), sem alterar o fluxo de
  // retorno nem logar URL/corpo (LGPD, ja evitado neste choke point).
  if (res.status === 429) registrar429ClickUp();
  return res;
}

// Mapa nome logico -> field_id na Lista 01 LEADS (1000320000002833). IDs
// copiados de 01-CONTEXT.md (D-05). NUNCA resolver por nome em runtime (D-07).
export const CAMPOS_LEADS = {
  NOME: '8fdbb2ca-b3e7-4b51-999d-8aa802d5bc4f',
  TELEFONE: 'e29b4882-bbb9-402e-8ba9-dda2d8418b4b',
  CPF: '3f460797-b9c1-4d47-9f5d-bdf4d3fc54fb',
  ID_SUPABASE: '0852f523-07bd-47e8-a53b-55ac88b1e7f6',
  ID_LEAD_GHL: 'f9efe4d9-bfbd-452d-85c1-d88462b28462',
  ORIGEM: '94a1b44b-3f11-46dd-821c-e79eee903615',
  SCORE: 'b7052e83-626a-4c74-8062-583a0a18d429',
  MILITANTE: 'de5ba650-caf1-4f17-8ec7-4dfa5ee128e9',
  QTD_TENTATIVAS: '037da11d-c6ca-438f-aa22-74f24cd9d985',
  QTD_ATENDIMENTOS: 'e00ef795-e256-4337-84a4-5f3994fc2bce',
  QTD_NAO_ATENDIMENTOS: '2aa46fdb-4539-4adc-ab85-1fc952879e83',
  PROXIMO_CONTATO: '49a81d89-6ae3-43bd-926b-4fef1ac07ea8',
  ULTIMO_CONTATO: '91f3a8cc-5549-41a5-820a-8a6125abf3eb',
  ULTIMO_ATENDIMENTO: '745ae39c-e1b5-41ea-a4ec-f05304343cdc',
  ULTIMO_RESULTADO: 'f516c0ef-109a-4117-a36d-49deda865a4f',
  OBSERVACAO_CONSOLIDADA: 'd2993d89-c700-4315-a2cf-f7258eb3c504',
  UF: '4a8dc202-2e7e-4c78-9c74-bfb81f9abf45',
  CIDADE: 'fad71df5-26c2-442d-bd3c-d8b280b17bb6',
  BAIRRO: '482d4d68-5006-410f-8042-77306981e5f9',
  LOGRADOURO: 'e632730d-3927-4108-95c2-e5e7138fc941',
  NUMERO: '6fd9fd47-5312-469e-bb2a-7e8f7d1809f3',
  COMPLEMENTO: '01e22870-7d41-49f8-b190-ee177153acbf',
  CEP: 'db8d704e-0b6a-4397-b4bc-60a5f0eb1f61',
  CONFIRMOU_VOTO_ROMERO: 'e2b6558f-7d6e-4af6-93b7-d0adde65b79b',
  CONFIRMOU_VOTO_ANDRESSA: '0e6bf825-be20-4bf4-a967-986c2e46ea26',
} as const;

// Mapa nome logico -> field_id na Lista 02 LIGACOES (1000320000002834). D-05/D-07.
// SCRIPT_LIGACAO e ADERENCIA_SCRIPT ainda NAO EXISTEM — criados no plano 01-03.
export const CAMPOS_LIGACOES = {
  LEAD_REL: '381d4565-aeae-4abb-a4f7-38322a1c71f8',
  TELEFONE: 'e29b4882-bbb9-402e-8ba9-dda2d8418b4b',
  ID_LEAD: 'f9efe4d9-bfbd-452d-85c1-d88462b28462',
  OPERADOR: '7fe613d6-8170-43e9-a422-7b5f9dd45a99',
  ATENDEU: '68daf21b-6420-4ceb-9c8c-bc67d6f7a2ef',
  INICIO: 'c5eadc11-bd39-4b5c-b46c-3b3fddf49e89',
  FIM: '3b3882f0-42d0-4f21-9e4d-5d7ec8eadfeb',
  DURACAO: '8e1279d2-5095-41d7-a071-8d9c58e4e137',
  MOTIVO_FALHA: 'a64b2318-2640-4d15-9f1f-57861ad32b6a',
  URL_GRAVACAO: '8554090f-5966-4853-b39d-d492cccc00a3',
  TRANSCRICAO: '82392243-3ef9-46a8-abf6-3dfcefd7c16c',
  ANALISE_IA: 'dfb8e194-b453-4501-91fe-0e214aaca14e',
  OBSERVACOES_EXTRAIDAS: '6dbddd74-0df0-4e2b-9f50-5d1abf78cf0f',
  NECESSITA_REVISAO: 'a666fb85-e76d-43e5-91a2-62a2a005cfbb',
  RETORNO_NECESSARIO: '1b27b754-0cc3-4500-a0ae-a57de2d07243',
  DATA_RETORNO: '1202faf9-13ff-492d-b3d4-fb9ff78bd827',
  // SCRIPT_LIGACAO: não é custom field — o script é a DESCRIÇÃO da task de Ligações (D-06 revisado),
  // escrita pelo Agente Script na Fase 2. Por isso não há field_id aqui.
  ADERENCIA_SCRIPT: 'cb84cac6-4b30-488d-a4a8-1ecce9508a79', // "Aderência ao script" (number) — D-06 revisado
} as const;

// Opcoes (UUID) dos 3 custom fields drop_down da Lista 02 LIGACOES. A API v2
// do ClickUp exige o UUID da opcao pra campos drop_down (nao aceita
// boolean/nome) — setCustomField usa este mapa pra traduzir na escrita. IDs
// fixos verificados via GET /list/1000320000002834/field (D-07 — nunca
// resolver por nome em runtime; mesmo racional do mapeamento
// markdown_description em criarTask/atualizarTask: centralizar a traducao no
// choke point pra nao espalhar pelos callers).
export const OPCOES_LIGACOES = {
  [CAMPOS_LIGACOES.ATENDEU]: {
    sim: '84ee8d4b-a924-4ed2-bcf5-fb4dc7f82ce5',
    nao: 'b7dd48cc-c950-495a-b8ff-b7f0501ad7f0',
  },
  [CAMPOS_LIGACOES.NECESSITA_REVISAO]: {
    sim: '5765cd98-4c34-441a-92a6-5f0f6bdec8a0',
    nao: '0ff8679f-b60f-42bb-8749-967370149d2e',
  },
  [CAMPOS_LIGACOES.RETORNO_NECESSARIO]: {
    sim: '5b24f7a6-b442-49fe-9768-2fcaa38746cf',
    nao: '61c32634-9a29-46f3-b5be-add30388113c',
  },
} as const;

// Opcoes (UUID) dos 2 custom fields drop_down de VOTO da Lista 01 LEADS
// ("Confirmou voto no Romero" / "na Andressa"). Cada um tem 3 opcoes: Sim /
// Nao / Nao declarou. UUIDs verificados via GET /list/1000320000002833/field
// (scripts/descobrir-campos-leads.mjs) — mesmo racional de OPCOES_LIGACOES
// (D-07: nunca resolver opcao por nome em runtime; drop_down exige o UUID).
export const OPCOES_LEADS = {
  [CAMPOS_LEADS.CONFIRMOU_VOTO_ROMERO]: {
    sim: 'af4e0629-1abf-4dbc-b362-acca1fb7e879',
    nao: '7ced7b75-743f-4047-bb6b-5c4e575bca3b',
    naoDeclarou: 'ca798bf8-03dc-4cf6-981b-8fc90df80904',
  },
  [CAMPOS_LEADS.CONFIRMOU_VOTO_ANDRESSA]: {
    sim: '6a96d622-13ec-4afb-a98e-f9331ae43397',
    nao: '74fdf62a-4393-4ab9-828d-926625063c53',
    naoDeclarou: '229a7f1f-42a7-4b7d-8622-89e105cc3ff7',
  },
} as const;

// Mapa nome logico -> field_id na Lista 03 AUDIOS (1000320000003180, Fase 12
// ENVIO-06). Os 19 campos JA EXISTEM (investigacao previa, PROJECT.md) — este
// modulo so MAPEIA, nunca cria campo (D-07). IDs lidos AO VIVO via
// `GET /list/1000320000003180/field` (mesmo racional de
// scripts/descobrir-campos-leads.mjs) em 2026-08-18 — NUNCA resolver por nome
// em runtime. Alguns ids colidem de proposito com CAMPOS_LEADS/CAMPOS_LIGACOES
// (TELEFONE, ANALISE_IA) — o ClickUp reusa o MESMO custom field quando ele foi
// adicionado a mais de uma lista da workspace; nao e coincidencia nem bug.
export const CAMPOS_AUDIOS = {
  ID_SUPABASE: '0852f523-07bd-47e8-a53b-55ac88b1e7f6',
  CONFIANCA_ANALISE: '08ee30dd-7352-454a-b0bb-cd11e9b6f63e',
  DATA_DA_RESPOSTA: '1a78a64c-5e86-4659-a9d6-0db883fc8c55',
  NECESSITA_REVISAO: '21624bf9-1b0d-4a1d-9427-7ff36cb4abed',
  INTENCAO_DETECTADA: '2e2c52be-47f3-4696-ac81-473882b0c09a',
  AUDIO: '3317c6bd-7ad9-4c43-b76b-161f24470241',
  CLASSIFICACAO: '38d735b2-b870-4ff2-a185-2b3a8ed9982c',
  TIPO_RESPOSTA: '4e9a7515-c395-4c2c-b027-31ec9978fa68',
  TRANSCRICAO_AUDIO: '5f820815-7275-4d72-b2b5-65a8521011cb',
  ENVIADO_POR: '69902a90-84d5-44c1-8c37-65f55d9e20c0',
  DATA_DO_ENVIO: 'b3ac9494-ec28-4d84-8103-753b39a0250d',
  TEMA_OBJETIVO: 'd3b12b13-7fd9-4b84-882d-c74757705db5',
  TRANSCRICAO_RESPOSTA: 'dcb792e6-8507-4161-ac6f-e691f598f544',
  ANALISE_IA: 'dfb8e194-b453-4501-91fe-0e214aaca14e',
  OPT_OUT_SOLICITADO: 'dfc5c2d7-c7c5-48d0-b7f1-05ea45667fdb',
  TELEFONE: 'e29b4882-bbb9-402e-8ba9-dda2d8418b4b',
  MENSAGENS_NA_RESPOSTA: 'e71d2bbb-03e3-4303-a6c8-25ec74333a25',
  LIGACAO_GERADA: 'e898ac0c-ba1e-4f9b-a00c-867dea3e4fa9',
  LEAD: 'fbfb2ba6-9e5c-4673-9da8-e6861b797357',
} as const;

// Opcoes (UUID) dos 4 custom fields drop_down da Lista 03 AUDIOS. Mesmo
// racional de OPCOES_LIGACOES/OPCOES_LEADS (D-07: drop_down exige o UUID da
// opcao, nao boolean/nome). NECESSITA_REVISAO/OPT_OUT_SOLICITADO seguem o
// shape {sim,nao} (2 opcoes, consumivel por setCustomField se algum dia
// precisar traduzir boolean como OPCOES_LIGACOES ja faz); CLASSIFICACAO (3
// opcoes) e TIPO_RESPOSTA (4 opcoes) NAO sao binarios — ficam num mapa por
// rotulo (lowercase) pra tradução bespoke no call-site (Fases 13-14).
export const OPCOES_AUDIOS = {
  [CAMPOS_AUDIOS.NECESSITA_REVISAO]: {
    sim: '2c92286c-3e64-4b37-9fce-6f18baa34fa4',
    nao: '6430aa28-8c6e-4273-9cd7-2fcf416b5b23',
  },
  [CAMPOS_AUDIOS.OPT_OUT_SOLICITADO]: {
    sim: '96fc0c6e-c5ea-4463-b612-fca087f500e4',
    nao: '6912ad4c-b9a0-45f1-9198-ab8d30366a98',
  },
  [CAMPOS_AUDIOS.CLASSIFICACAO]: {
    positiva: 'ed388a5d-adc0-4670-8686-b6b1c28f7b53',
    neutra: '60102b94-b999-4a7b-81e5-e16b6e5b9a50',
    negativa: '1a7e9f54-3f38-411a-84fb-90ad42a133b9',
  },
  [CAMPOS_AUDIOS.TIPO_RESPOSTA]: {
    texto: '8d52f4b0-117c-4ae7-b42e-c756ca408863',
    audio: '3dc597e4-53be-48aa-a333-a73894dd157b',
    figurinha: '27e6e991-afad-4c3c-afe0-ec77c9f53d57',
    nenhuma: 'abb2e3f2-7d49-4d00-b6d3-2b0a88dc3136',
  },
} as const;

export interface CustomFieldClickUp {
  id: string;
  name?: string;
  value?: unknown;
  /**
   * Config do campo (drop_down): opções `{ id, orderindex, name }` — presente
   * no GET da task. Usado por `lerAtendeu` para traduzir o valor lido de um
   * drop_down (que a API devolve como orderindex/id da opção) em boolean.
   */
  type_config?: { options?: Array<{ id?: string; orderindex?: number; name?: string }> };
}

export interface TaskClickUp {
  id: string;
  name: string;
  status?: { status: string; type?: string } | string;
  custom_fields?: CustomFieldClickUp[];
  // Nativos usados pela fila do discador (LOTE-04/05, Fase 02 Plano 03): o
  // script da Ligação é a DESCRIÇÃO da task (D-06 revisado), não custom
  // field; `text_content` é o fallback em texto puro que a API às vezes
  // retorna quando a descrição é rich text.
  description?: string;
  text_content?: string;
  assignees?: Array<{ id: number }>;
  // Lista a que a task pertence — usado por `lerLigacao` para provar que a
  // task lida por ID e realmente uma Ligacao da Lista 02 (CR-01, T-02-03-E).
  list?: { id: string };
  // Epoch ms (string) de criação da task. A API v2 sempre devolve; usado para
  // ordenar a fila dos nunca-tentados por prioridade (quick-260821): o lote de
  // áudio foi criado em ordem de prioridade (mais atendimentos primeiro), então
  // date_created ASC = prioridade desc.
  date_created?: string;
}

/** Item da fila de ligações do operador (ver `ItemFila` em lote.ts — módulo puro). */
export type { ItemFila };

/** Detalhe de uma Ligação: item da fila + o script (descrição da task — D-06 revisado). */
export interface DetalheLigacao extends ItemFila {
  script: string;
}

function headers(): Record<string, string> {
  return {
    'Authorization': CLICKUP_API_TOKEN,
    'Content-Type': 'application/json',
  };
}

/** Extrai o nome do status nativo de uma task — `{status} | string | undefined` (TaskClickUp.status). */
function nomeDoStatus(status: TaskClickUp['status']): string {
  if (!status) return '';
  return typeof status === 'string' ? status : status.status;
}

/**
 * Lista as tasks de uma lista (D-01). Suporta paginacao por `page` (0-based,
 * padrao da API ClickUp). Retorna tasks com custom_fields inclusos.
 */
export async function listarTasks(
  listId: string,
  opts: {
    page?: number;
    includeClosed?: boolean;
    assignees?: string[];
    /** Filtro de custom fields NO SERVIDOR (2026-08-19) — ex. timeline por
     *  LEAD_REL: 1 request em vez de paginar a lista inteira. Shape da API v2:
     *  [{ field_id, operator, value }]. */
    customFields?: Array<{ field_id: string; operator: string; value: unknown }>;
  } = {},
): Promise<{ tasks: TaskClickUp[]; lastPage: boolean }> {
  // Token ausente e falha de infra/HTTP LANCAM (WR-03): o caller decide
  // retry/abort. Retorno vazio fica reservado a respostas 2xx genuinamente
  // vazias — nunca colapsa erro no mesmo shape de sucesso (o loop diario
  // precisa DETECTAR a falha, nao produzir um lote vazio silencioso).
  if (!CLICKUP_API_TOKEN) {
    throw new Error('[clickup] CLICKUP_API_TOKEN ausente — nao da para listar tasks');
  }
  const params = new URLSearchParams({
    page: String(opts.page ?? 0),
    include_closed: String(opts.includeClosed ?? true),
  });
  // Filtro por assignee no SERVIDOR (nao no cliente — T-02-03-E): a fila do
  // discador so pode ver as tasks do operador logado. `assignees[]` repetido
  // e o formato que a API REST v2 do ClickUp espera para multiplos valores.
  for (const assigneeId of opts.assignees ?? []) {
    if (assigneeId) params.append('assignees[]', assigneeId);
  }
  if (opts.customFields?.length) {
    params.set('custom_fields', JSON.stringify(opts.customFields));
  }
  let res: Response;
  try {
    res = await fetchClickUp(`${CLICKUP_BASE_URL}/list/${listId}/task?${params.toString()}`, {
      headers: headers(),
    });
  } catch (e) {
    throw new Error(
      `[clickup] falha de rede ao listar tasks da lista ${listId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[clickup] GET /list/${listId}/task falhou (${res.status})`);
  }
  const data = await res.json();
  return { tasks: data?.tasks || [], lastPage: Boolean(data?.last_page) };
}

/**
 * `listarTasks` com retry curto — pensada para as consultas de VERIFICAÇÃO
 * (dedup do inbound, match de lead da avulsa) que precisam distinguir "não
 * achou" de "não consegui verificar" quando o ClickUp está instável
 * ("This operation was aborted" em horário de operação). Tenta `tentativas+1`
 * vezes com backoff linear; se TODAS falharem, RE-LANÇA o último erro (WR-03)
 * — o caller decide se adia/cria. Não engole falha (diferente de degradar
 * para lista vazia, que faria um abort parecer "não existe" e criar duplicata).
 */
export async function listarTasksComRetry(
  listId: string,
  opts: Parameters<typeof listarTasks>[1] = {},
  tentativas = 2,
  esperaMs = 1500,
): Promise<{ tasks: TaskClickUp[]; lastPage: boolean }> {
  let ultimoErro: unknown;
  for (let i = 0; i <= tentativas; i++) {
    try {
      return await listarTasks(listId, opts);
    } catch (e) {
      ultimoErro = e;
      if (i < tentativas) await new Promise((r) => setTimeout(r, esperaMs * (i + 1)));
    }
  }
  throw ultimoErro instanceof Error ? ultimoErro : new Error(String(ultimoErro));
}

/** Le uma task por ID (com custom_fields). */
export async function lerTask(taskId: string): Promise<TaskClickUp | null> {
  // Token ausente e falha de infra/HTTP LANCAM (WR-03) — `null` fica reservado
  // a caminhos de sucesso, nunca a mascarar erro de rede/HTTP.
  if (!CLICKUP_API_TOKEN) {
    throw new Error('[clickup] CLICKUP_API_TOKEN ausente — nao da para ler task');
  }
  let res: Response;
  try {
    res = await fetchClickUp(`${CLICKUP_BASE_URL}/task/${taskId}`, { headers: headers() });
  } catch (e) {
    throw new Error(
      `[clickup] falha de rede ao ler task ${taskId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[clickup] GET /task/${taskId} falhou (${res.status})`);
  }
  return await res.json();
}

/**
 * Cria uma task numa lista (D-05 — a lista ja existe, nao cria lista/campo).
 * `custom_fields` aceita `{ id, value }` — o caller deve resolver o id via
 * CAMPOS_LEADS/CAMPOS_LIGACOES (D-07). `description`/`assignees` sao campos
 * nativos do ClickUp aceitos na criacao (Fase 2, D-P2-06 — script na
 * descricao da task de Ligacoes + assignee do operador).
 */
export async function criarTask(
  listId: string,
  payload: {
    name: string;
    description?: string;
    assignees?: number[];
    custom_fields?: Array<{ id: string; value: unknown }>;
  },
): Promise<TaskClickUp | null> {
  // Token ausente e falha de infra/HTTP LANCAM (WR-03) — nunca retorna `null`
  // para mascarar erro de rede/HTTP.
  if (!CLICKUP_API_TOKEN) {
    throw new Error('[clickup] CLICKUP_API_TOKEN ausente — nao da para criar task');
  }
  // A API v2 NAO renderiza markdown no campo nativo `description` (mostra
  // `##`/`**` literais) — só renderiza em `markdown_description`. O mapeamento
  // fica aqui, no choke point (D-07), para nao se espalhar pelos callers.
  // A LEITURA nao muda: o GET devolve o conteudo em `description`/`text_content`
  // (lerLigacao L~375, index.ts L~637, marcador "já tem dossiê" em montar-dossies).
  const { description, ...camposNativos } = payload;
  const body: Record<string, unknown> = { ...camposNativos };
  if (description !== undefined) {
    body.markdown_description = description;
  }
  let res: Response;
  try {
    res = await fetchClickUp(`${CLICKUP_BASE_URL}/list/${listId}/task`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(
      `[clickup] falha de rede ao criar task na lista ${listId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[clickup] POST /list/${listId}/task falhou (${res.status})`);
  }
  return await res.json();
}

/** Atualiza campos "nativos" da task (name, status, etc — nao custom fields). */
export async function atualizarTask(
  taskId: string,
  patch: Record<string, unknown>,
): Promise<TaskClickUp | null> {
  // Token ausente e falha de infra/HTTP LANCAM (WR-03) — nunca retorna `null`
  // para mascarar erro de rede/HTTP.
  if (!CLICKUP_API_TOKEN) {
    throw new Error('[clickup] CLICKUP_API_TOKEN ausente — nao da para atualizar task');
  }
  // Mesmo mapeamento de criarTask (D-07): `description` cru nao renderiza
  // markdown na API v2 — vira `markdown_description`. `status` e demais chaves
  // (iniciarLigacao/fecharLigacao) passam intactos via `...resto`.
  const { description, ...resto } = patch;
  const body: Record<string, unknown> = { ...resto };
  if (description !== undefined) {
    body.markdown_description = description;
  }
  let res: Response;
  try {
    res = await fetchClickUp(`${CLICKUP_BASE_URL}/task/${taskId}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(
      `[clickup] falha de rede ao atualizar task ${taskId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[clickup] PUT /task/${taskId} falhou (${res.status})`);
  }
  return await res.json();
}

/**
 * Seta um custom field por ID numa task (D-07 — sempre por ID, nunca por
 * nome). `fieldId` deve vir de CAMPOS_LEADS/CAMPOS_LIGACOES.
 */
export async function setCustomField(taskId: string, fieldId: string, value: unknown): Promise<boolean> {
  // Token/fieldId ausentes e falha de infra/HTTP LANCAM (WR-03) — `false` fica
  // reservado a caminhos legitimos, nunca a mascarar erro de rede/HTTP.
  if (!CLICKUP_API_TOKEN) {
    throw new Error('[clickup] CLICKUP_API_TOKEN ausente — nao da para setar custom field');
  }
  if (!fieldId) {
    throw new Error(`[clickup] setCustomField chamado sem fieldId para a task ${taskId}`);
  }
  // drop_down exige o UUID da opcao, nao boolean — traduz aqui (choke point)
  // quando o fieldId e um dos 3 drop_down da Lista 02 e o value e boolean;
  // qualquer outro caso passa `value` intacto.
  const opcoes = (OPCOES_LIGACOES as Record<string, { sim: string; nao: string }>)[fieldId];
  const valorFinal = opcoes && typeof value === 'boolean' ? (value ? opcoes.sim : opcoes.nao) : value;
  // A API v2 do ClickUp trunca campos date para meia-noite do fuso do
  // workspace quando o POST nao inclui `value_options: { time: true }`.
  // INICIO/FIM (Lista 02) precisam da hora exata da ligacao; DATA_RETORNO
  // e os demais campos ficam de fora (retorno e por dia, date-only correto).
  // Centralizado aqui (choke point unico de escrita), mesmo racional dos
  // fixes OPCOES_LIGACOES/markdown_description — nao espalhar pelos callers (D-07).
  const body: Record<string, unknown> = { value: valorFinal };
  if (fieldId === CAMPOS_LIGACOES.INICIO || fieldId === CAMPOS_LIGACOES.FIM) {
    body.value_options = { time: true };
  }
  let res: Response;
  try {
    res = await fetchClickUp(`${CLICKUP_BASE_URL}/task/${taskId}/field/${fieldId}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(
      `[clickup] falha de rede ao setar custom field ${fieldId} na task ${taskId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[clickup] POST /task/${taskId}/field/${fieldId} falhou (${res.status})`);
  }
  return true;
}

/**
 * Lista os nomes dos statuses reais de uma lista (D-P3-07 — nunca adivinhar
 * status no código: `scripts/descobrir-status-ligacoes.mjs` usa esta função
 * pra descobrir os statuses da Lista 02 antes de fixar
 * OPER_STATUS_EM_PROCESSAMENTO no .env). Thin wrapper sobre `GET /list/:id`.
 * Token ausente e falha de infra/HTTP LANÇAM (WR-03) — nunca retorna array
 * vazio pra mascarar erro.
 */
export async function listarStatusLista(listId: string): Promise<string[]> {
  if (!CLICKUP_API_TOKEN) {
    throw new Error('[clickup] CLICKUP_API_TOKEN ausente — nao da para listar statuses da lista');
  }
  let res: Response;
  try {
    res = await fetchClickUp(`${CLICKUP_BASE_URL}/list/${listId}`, { headers: headers() });
  } catch (e) {
    throw new Error(
      `[clickup] falha de rede ao ler a lista ${listId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[clickup] GET /list/${listId} falhou (${res.status})`);
  }
  const data = await res.json();
  const statuses: Array<{ status?: string }> = data?.statuses || [];
  return statuses.map((s) => String(s?.status || '')).filter(Boolean);
}

/** Definicao de um custom field devolvida por `GET /list/:id/field` — shape util
 *  pra validacao (17-03/MODELO-06): id+name+type + as opcoes de dropdown com
 *  id+name (necessarias pra detectar UUID de opcao desconhecido, R8). */
export interface CampoClickUpDefinicao {
  id: string;
  name: string;
  type: string;
  type_config?: { options?: Array<{ id?: string; name?: string }> };
}

/**
 * Lista as DEFINICOES de custom field de uma lista (`GET /list/:id/field`) —
 * usada pelo boot pra VALIDAR os mapas hardcoded CAMPOS_ e OPCOES_ (clickup.ts)
 * contra o ClickUp real: uma unica autoridade validada (MODELO-06/D-07), nao
 * duas copias que podem divergir. Mesmo molde EXATO de `listarStatusLista`
 * (thin wrapper GET por lista via `fetchClickUp`): token ausente/HTTP falho
 * LANÇAM (WR-03), nunca mascara com array vazio. NUNCA loga token/valor de
 * campo — so estrutura (id/name/type/opcoes), que nao e PII.
 */
export async function getCustomFields(listId: string): Promise<CampoClickUpDefinicao[]> {
  if (!CLICKUP_API_TOKEN) {
    throw new Error('[clickup] CLICKUP_API_TOKEN ausente — nao da para listar custom fields da lista');
  }
  let res: Response;
  try {
    res = await fetchClickUp(`${CLICKUP_BASE_URL}/list/${listId}/field`, { headers: headers() });
  } catch (e) {
    throw new Error(
      `[clickup] falha de rede ao listar custom fields da lista ${listId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[clickup] GET /list/${listId}/field falhou (${res.status})`);
  }
  const data = await res.json();
  const fields: Array<{
    id?: string;
    name?: string;
    type?: string;
    type_config?: { options?: Array<{ id?: string; name?: string }> };
  }> = data?.fields || [];
  return fields
    .filter((f) => f && f.id)
    .map((f) => ({
      id: String(f.id),
      name: String(f.name || ''),
      type: String(f.type || ''),
      type_config: f.type_config,
    }));
}

/** Membro da workspace ClickUp (D-03) — id sempre String (a API devolve numero). */
export interface MembroClickUp {
  id: string;
  nome: string;
  email: string;
}

/**
 * PURA (sem I/O): achata `GET /team` (`{ teams: [{ members: [{ user: {
 * id, username, email } }] }] }`) em uma lista de membros, mapeando
 * `user.id`->id (String), `user.username`->nome, `user.email`->email, e
 * dedupa por `id`. Entrada ausente/malformada -> `[]` (NUNCA lança — molde
 * "PURA, nunca lança" para funções de mapeamento, D-03).
 */
export function mapearMembrosTeam(data: unknown, teamIdFiltro?: string): MembroClickUp[] {
  const teams = (data as { teams?: unknown })?.teams;
  if (!Array.isArray(teams)) return [];
  const vistos = new Map<string, MembroClickUp>();
  for (const team of teams) {
    // Filtro por workspace (Gabinete 509): o token enxerga várias workspaces —
    // com `teamIdFiltro` setado, só os membros DAQUELA entram. Vazio = todas.
    if (teamIdFiltro && String((team as { id?: unknown })?.id) !== teamIdFiltro) continue;
    const members = (team as { members?: unknown })?.members;
    if (!Array.isArray(members)) continue;
    for (const membro of members) {
      const user = (membro as { user?: unknown })?.user as
        | { id?: unknown; username?: unknown; email?: unknown }
        | undefined;
      if (!user || user.id === undefined || user.id === null) continue;
      const id = String(user.id);
      if (vistos.has(id)) continue;
      vistos.set(id, {
        id,
        nome: typeof user.username === 'string' ? user.username : '',
        email: typeof user.email === 'string' ? user.email : '',
      });
    }
  }
  return [...vistos.values()];
}

/**
 * Lista os membros da workspace ClickUp (D-03, fonte do dropdown de
 * vínculo `clickup_member_id` na tela de gestão de operadores). Thin
 * wrapper sobre `GET /team` — mesmo molde de `listarStatusLista` (single
 * GET, sem paginação). Token ausente e falha de rede/HTTP LANÇAM (WR-03)
 * — nunca retorna lista vazia pra mascarar erro. LGPD: loga só a
 * CONTAGEM de membros, nunca email/nome em massa.
 */
export async function listarMembrosWorkspace(): Promise<MembroClickUp[]> {
  if (!CLICKUP_API_TOKEN) {
    throw new Error('[clickup] CLICKUP_API_TOKEN ausente — nao da para listar membros da workspace');
  }
  let res: Response;
  try {
    res = await fetchClickUp(`${CLICKUP_BASE_URL}/team`, { headers: headers() });
  } catch (e) {
    throw new Error(`[clickup] falha de rede ao listar membros da workspace: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[clickup] GET /team falhou (${res.status})`);
  }
  const membros = mapearMembrosTeam(await res.json(), CLICKUP_TEAM_ID);
  console.log(`[clickup] listarMembrosWorkspace: ${membros.length} membro(s)${CLICKUP_TEAM_ID ? ` (team ${CLICKUP_TEAM_ID})` : ''}`);
  return membros;
}

/**
 * Busca a fila de Ligações (Lista 02) do operador logado (LOTE-04 — o
 * discador substitui o GHL QUALIFICADO por esta fila). Filtra por assignee
 * no SERVIDOR (T-02-03-E — cada operador só vê a própria fila) e só tasks
 * abertas (`include_closed=false`). Erro de infra/HTTP PROPAGA (WR-03/
 * T-02-03-D — o caller/rota decide o 502, nunca mascara como fila vazia).
 *
 * Ordenação (quick-260815-w6h): a fila devolvida vem ordenada por INICIO
 * ascendente (sort estável) — leads nunca tentados primeiro, já-tentados
 * (via desfecho 'nao_atendida') afundam pro fim, o que falhou há mais tempo
 * antes do que acabou de falhar. Isso faz o "próximo lead" (itens[0] na UI)
 * avançar em vez de repetir o mesmo card não-atendido.
 *
 * Read-through (CACHE-01, D-01/D-02): só a fila PADRÃO (sem `opts.page`) é
 * cacheada — páginas seguintes não passam pelo cache-aside, mantendo o
 * comportamento atual. No hit, retorna direto do cache (não bate no
 * ClickUp); no miss, roda o corpo normal e aquece o cache antes de
 * retornar. `guardarFilaCache` é no-op sem Redis (`obterFilaCache` sempre
 * `null`), preservando 100% o comportamento de 1 instância (SC5) — e a
 * semântica de erro de `listarTasks` (WR-03, que LANÇA) fica intacta: o
 * cache só serve leitura de SUCESSO, nunca mascara uma falha.
 */
export async function buscarFilaLigacoes(
  assigneeId: string,
  opts: { page?: number } = {},
): Promise<ItemFila[]> {
  const cacheavel = !opts.page;
  if (cacheavel) {
    const cached = await obterFilaCache(assigneeId);
    if (cached) return cached;
  }
  const { tasks } = await listarTasks(CLICKUP_LIST_LIGACOES, {
    page: opts.page,
    includeClosed: false,
    assignees: [assigneeId],
  });
  // D-P3-07: a task que acabou de receber "Ligar" fica num status
  // intermediário "em processamento" — exclui aqui pra não re-entregar ao
  // operador uma Ligação que já está sendo processada (webhook/analise em
  // andamento). Sem OPER_STATUS_EM_PROCESSAMENTO configurado, nenhuma task é
  // filtrada (comportamento anterior, D-P3-07 ainda não fixado no .env).
  const abertas = OPER_STATUS_EM_PROCESSAMENTO
    ? tasks.filter((t) => nomeDoStatus(t.status) !== OPER_STATUS_EM_PROCESSAMENTO)
    : tasks;
  // quick-260815-w6h: ordena por INICIO ascendente (sort ESTÁVEL, sobre cópia
  // pra não mutar `abertas`) — never-tried (sem INICIO válido) vem PRIMEIRO;
  // já-tentados afundam pro fim, o que falhou há mais tempo primeiro, o que
  // acabou de falhar (INICIO mais recente) por último. Isso é o que faz o
  // lead 'nao_atendida' sumir do topo — a UI renderiza só itens[0].
  // quick-260821: entre os nunca-tentados, PRIORIDADE = date_created ASC — o
  // lote de áudio foi criado em ordem de prioridade (mais atendimentos primeiro),
  // então o mais antigo é o mais prioritário. FIFO sensato p/ os demais casos.
  const ordenadas = [...abertas].sort((a, b) => {
    const inicioA = Number(a.custom_fields?.find((cf) => cf.id === CAMPOS_LIGACOES.INICIO)?.value);
    const inicioB = Number(b.custom_fields?.find((cf) => cf.id === CAMPOS_LIGACOES.INICIO)?.value);
    const tentadaA = Number.isFinite(inicioA);
    const tentadaB = Number.isFinite(inicioB);
    if (!tentadaA && !tentadaB) return Number(a.date_created ?? 0) - Number(b.date_created ?? 0);
    if (!tentadaA) return -1;
    if (!tentadaB) return 1;
    return inicioA - inicioB;
  });
  const fila = mapearFilaLigacao(ordenadas, CAMPOS_LIGACOES);
  if (cacheavel) {
    await guardarFilaCache(assigneeId, fila);
  }
  return fila;
}

/**
 * Lê o detalhe de uma Ligação (script + campos da fila) por ID (LOTE-05).
 * O script é a DESCRIÇÃO nativa da task (D-06 revisado), com `text_content`
 * como fallback quando a API devolve o texto plano em vez da descrição rica.
 * Erro de infra/HTTP ou task inexistente PROPAGA (WR-03).
 *
 * `assigneeIdEsperado` (memberId do ClickUp do operador logado, resolvido
 * via `assigneeDoOperador`) e OBRIGATORIO: sem ele, a rota de detalhe
 * repassaria qualquer `taskId` direto pra API do ClickUp, permitindo que um
 * operador autenticado lesse a Ligacao de outro operador ou qualquer task
 * da workspace (Lista 01 LEADS inclusive, telefone sem mascara) — quebrando
 * a garantia T-02-03-E (CR-01, IDOR/LGPD).
 *
 * Read-through (CACHE-01, D-04/anti-IDOR): a chave do cache leva
 * `assigneeIdEsperado` — um operador diferente SEMPRE dá miss e cai no corpo
 * completo abaixo, que re-roda as 3 checagens de autorização. Nada de outro
 * operador é servido do cache. No miss, monta `DetalheLigacao` normalmente e
 * só então aquece o cache (`guardarLigacaoCache`, no-op sem Redis).
 */
/**
 * Uma Ligação concluída (status de tipo closed/done) não pode ser reaberta
 * pelo discador: o deep-link com `auto=1` guardado num overlay antigo
 * rediscava task já processada (discagem-fantasma real em 2026-08-19 17:43,
 * 0,4s de CALLING→CANCELLED). `type` ausente (payload antigo) degrada pra
 * false — comportamento de hoje.
 */
export function tarefaConcluida(task: TaskClickUp): boolean {
  const st = typeof task.status === 'string' ? undefined : task.status;
  return st?.type === 'closed' || st?.type === 'done';
}

export async function lerLigacao(taskId: string, assigneeIdEsperado: string): Promise<DetalheLigacao> {
  const cached = await obterLigacaoCache(assigneeIdEsperado, taskId);
  if (cached) return cached;
  const task = await lerTask(taskId);
  if (!task) {
    throw new Error(`[clickup] lerLigacao: task ${taskId} nao encontrada`);
  }
  // A task tem que ser uma Ligacao da Lista 02 (nao uma task de outra lista,
  // ex.: Lista 01 LEADS, cujo field-id de TELEFONE colide com o da Lista 02).
  if (task.list?.id !== CLICKUP_LIST_LIGACOES) {
    throw new Error(`[clickup] lerLigacao: task ${taskId} nao e uma Ligacao da Lista 02`);
  }
  // E tem que estar atribuida ao operador logado — cada operador so pode ler
  // a propria Ligacao (T-02-03-E), igual ao filtro server-side de /fila.
  if (!task.assignees?.some((a) => String(a.id) === assigneeIdEsperado)) {
    throw new Error(`[clickup] lerLigacao: task ${taskId} nao pertence ao operador`);
  }
  if (tarefaConcluida(task)) {
    throw new Error(`[clickup] lerLigacao: task ${taskId} ja foi concluida`);
  }
  const [item] = mapearFilaLigacao([task], CAMPOS_LIGACOES);
  const telefone = String(task.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.TELEFONE)?.value ?? '');
  const idLead = String(task.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.ID_LEAD)?.value ?? '');
  const detalhe: DetalheLigacao = {
    taskId: task.id,
    nome: item?.nome ?? task.name ?? telefone,
    telefone: item?.telefone ?? telefone,
    idLead: item?.idLead ?? idLead,
    script: task.description ?? task.text_content ?? '',
  };
  await guardarLigacaoCache(assigneeIdEsperado, taskId, detalhe);
  return detalhe;
}

/**
 * Registra o início da ligação ao tocar "Ligar" no discador (OPER-01/02,
 * D-P3-01/02): grava INICIO + OPERADOR na task IMEDIATAMENTE (sobrevive a
 * restart — a correlação call↔task fica persistida no próprio ClickUp).
 *
 * TELEMETRIA PURA (quick-260813-lf7 / RETENTION-BY-OUTCOME): NÃO muda mais o
 * status nem tira a task da fila. A saída da fila passou a ser decidida pelo
 * DESFECHO da chamada (`registrarDesfecho`), não pelo clique em "Ligar" —
 * uma chamada não atendida / desligada antes de atender deixa a task na fila
 * (reaparece no próximo poll). A transição para `OPER_STATUS_EM_PROCESSAMENTO`
 * migrou para `registrarDesfecho('atendida')`.
 *
 * `assigneeIdEsperado` é OBRIGATÓRIO: mesma validação CR-01 de `lerLigacao`
 * (task tem que ser da Lista 02 e pertencer ao operador logado) — sem isso,
 * um `taskId` arbitrário no body do POST permitiria gravar INICIO/OPERADOR
 * em Ligação de outro operador (IDOR, T-03-01-01).
 *
 * Retorna o telefone da task (lido de CAMPOS_LIGACOES.TELEFONE) pro caller
 * correlacionar em memória (D-P3-01 — otimização; o fallback confiável é a
 * correlação persistida aqui). Erros de infra/HTTP ou de autorização LANÇAM
 * (WR-03) — nunca mascarados como sucesso.
 */
export async function iniciarLigacao(
  taskId: string,
  assigneeIdEsperado: string,
  operadorLabel: string,
): Promise<{ telefone: string }> {
  const task = await lerTask(taskId);
  if (!task) {
    throw new Error(`[clickup] iniciarLigacao: task ${taskId} nao encontrada`);
  }
  if (task.list?.id !== CLICKUP_LIST_LIGACOES) {
    throw new Error(`[clickup] iniciarLigacao: task ${taskId} nao e uma Ligacao da Lista 02`);
  }
  if (!task.assignees?.some((a) => String(a.id) === assigneeIdEsperado)) {
    throw new Error(`[clickup] iniciarLigacao: task ${taskId} nao pertence ao operador`);
  }
  // Guard ANTES do carimbo: rediscagem numa Ligação já concluída não pode
  // recarimbar INICIO (gera INICIO>FIM em task processada) nem discar de novo.
  if (tarefaConcluida(task)) {
    throw new Error(`[clickup] iniciarLigacao: task ${taskId} ja foi concluida`);
  }
  // D-P3-02: grava INICIO + OPERADOR imediatamente (custom fields, D-07 — por
  // field_id). Falha de infra LANÇA (WR-03) — o caller decide o 502. A task
  // PERMANECE na fila; a saída é decidida pelo desfecho (registrarDesfecho).
  await setCustomField(taskId, CAMPOS_LIGACOES.INICIO, Date.now());
  await setCustomField(taskId, CAMPOS_LIGACOES.OPERADOR, operadorLabel);
  const telefone = String(task.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.TELEFONE)?.value ?? '');
  return { telefone };
}

/**
 * Desfecho de uma chamada (RETENTION-BY-OUTCOME). 'atendida'/'recusou' são
 * TERMINAIS — tiram a Ligação da fila. 'nao_atendida' (quick-260815-w6h) NÃO
 * é terminal: a task fica na fila (não fecha, não muda status), só carimba
 * INICIO como marca de "última tentativa" — a fila reordena por INICIO
 * ascendente e o lead afunda pro fim, reaparecendo mais tarde no mesmo dia.
 */
export type ResultadoDesfecho = 'atendida' | 'recusou' | 'nao_atendida';

/**
 * Registra o DESFECHO terminal de uma chamada (quick-260813-lf7 /
 * RETENTION-BY-OUTCOME) — é o ÚNICO ponto que tira a Ligação da fila, migrado
 * do clique em "Ligar" (`iniciarLigacao`) para o resultado da chamada:
 *
 * - `'atendida'` (peerAccept): move a task para `OPER_STATUS_EM_PROCESSAMENTO`
 *   (exatamente a transição que saiu de `iniciarLigacao` — o pipeline de
 *   gravação/análise depende dela para não re-entregar a task). Degradação
 *   graciosa se o status não estiver configurado (mesmo comportamento de hoje).
 * - `'recusou'` (peerReject): grava `ATENDEU=false` + `MOTIVO_FALHA` (campos
 *   existentes, D-07 por field_id) e FECHA a task via `fecharLigacao`
 *   (`OPER_STATUS_FECHADO='complete'`), removendo-a da fila
 *   (`includeClosed:false`). Fecha direto — e NÃO reusa em_processamento —
 *   porque uma recusa não tem gravação a analisar: em_processamento criaria um
 *   zumbi preso em limbo (nada avançaria a task pra 'complete'), poluindo
 *   métricas/fila. Fechar em 'complete' usa o mesmo mecanismo já provado pelo
 *   pipeline das atendidas.
 *
 * - `'nao_atendida'` (quick-260815-w6h): NÃO fecha e NÃO move de status —
 *   apenas carimba `CAMPOS_LIGACOES.INICIO` de novo (marca "última tentativa")
 *   e retorna. A task PERMANECE na fila; `buscarFilaLigacoes` a devolve
 *   re-ordenada (afunda pro fim, ordenado por INICIO ascendente), então o
 *   próximo lead vira `itens[0]` e este reaparece mais tarde no mesmo dia.
 *
 * `assigneeIdEsperado` é OBRIGATÓRIO — `validarLigacaoDoOperador` roda PRIMEIRO
 * (CR-01/IDOR, mesma garantia de /ligando e /voto): o `taskId` do body nunca
 * pode desfechar a Ligação de outro operador. Erros de infra/HTTP ou de
 * autorização LANÇAM (WR-03) — nunca mascarados como sucesso.
 */
/** Motivo do não-atendimento anotado pelo operador (u13). Presente só quando o
 * operador preenche a telinha de motivo ao desligar sem o lead atender. */
export interface MotivoNaoAtendida {
  /** Categoria fixa (contável em relatório): "Não atende", "Sem WhatsApp"… */
  categoria: string;
  /** Frase livre opcional do operador. */
  observacao?: string;
  /** Segundos que o operador ficou tentando (discagem → desligar). */
  duracao?: number;
  /** u26: login do atendente que fez a tentativa — rastreabilidade no comentário. */
  usuario?: string;
  /** u26: número/linha da campanha usada na tentativa (não é dado do lead). */
  numero?: string;
}

/**
 * RECONCILIAÇÃO DE DUPLICATAS (2026-08-20, ordem do gestor: "se ligou, é para
 * sair da lista e concluir a task"): quando uma Ligação ganha desfecho
 * TERMINAL, as OUTRAS Ligações ABERTAS da mesma pessoa (mesmo lead via
 * LEAD_REL e/ou mesmo telefone ±nono) são FECHADAS com comentário — senão o
 * lead já contatado continua aparecendo na fila por uma task duplicada
 * (avulsa de inbound, resto de lote etc.). Só fecha task VIRGEM (sem INICIO):
 * uma aberta com INICIO tem história própria de tentativa e não é engolida.
 * Best-effort: NUNCA lança (a conclusão da principal não pode falhar por
 * causa da limpeza). Retorna quantas fechou. LGPD: nada de telefone em log.
 */
export async function fecharLigacoesDuplicadas(
  taskIdPrincipal: string,
  leadId: string | null,
  telefone: string,
): Promise<number> {
  try {
    const candidatos = new Map<string, TaskClickUp>();
    const consultas: Array<Promise<TaskClickUp[]>> = [];
    if (leadId) {
      consultas.push(
        listarTasksComRetry(CLICKUP_LIST_LIGACOES, {
          includeClosed: false,
          customFields: [{ field_id: CAMPOS_LIGACOES.LEAD_REL, operator: 'ANY', value: [leadId] }],
        })
          .then((r) => r.tasks)
          .catch(() => [] as TaskClickUp[]),
      );
    }
    const d = telefone.replace(/\D/g, '');
    if (d.length >= 10) {
      const comPais = d.length >= 12 ? d : `55${d}`;
      const tels = new Set<string>([`+${comPais}`]);
      if (comPais.length === 12) tels.add(`+${comPais.slice(0, 4)}9${comPais.slice(4)}`);
      if (comPais.length === 13 && comPais[4] === '9') tels.add(`+${comPais.slice(0, 4)}${comPais.slice(5)}`);
      for (const v of tels) {
        consultas.push(
          listarTasksComRetry(CLICKUP_LIST_LIGACOES, {
            includeClosed: false,
            customFields: [{ field_id: CAMPOS_LIGACOES.TELEFONE, operator: '=', value: v }],
          })
            .then((r) => r.tasks)
            .catch(() => [] as TaskClickUp[]),
        );
      }
    }
    for (const lista of await Promise.all(consultas)) {
      for (const t of lista) candidatos.set(t.id, t);
    }
    let fechadas = 0;
    for (const t of candidatos.values()) {
      if (t.id === taskIdPrincipal) continue;
      if (tarefaConcluida(t)) continue;
      const inicio = Number(t.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.INICIO)?.value);
      if (Number.isFinite(inicio) && inicio > 0) continue; // tentativa própria — não engole
      try {
        await comentarTask(
          t.id,
          `🧹 Concluída automaticamente — o contato desta pessoa já foi realizado (Ligação ${taskIdPrincipal}). Duplicata sai da fila.`,
        ).catch(() => {});
        await fecharLigacao(t.id);
        fechadas++;
      } catch (e) {
        console.warn(
          `[clickup] reconciliação: não consegui fechar a duplicata ${t.id}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    if (fechadas > 0) console.log(`[clickup] reconciliação: ${fechadas} Ligação(ões) duplicada(s) fechada(s) (principal ${taskIdPrincipal})`);
    return fechadas;
  } catch (e) {
    console.warn('[clickup] reconciliação de duplicatas falhou (segue):', e instanceof Error ? e.message : String(e));
    return 0;
  }
}

/** Lê lead (LEAD_REL) e telefone de uma task de Ligação já carregada. */
export function identidadeDaLigacao(task: TaskClickUp): { leadId: string | null; telefone: string } {
  const rel = task.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.LEAD_REL)?.value;
  const leadId = Array.isArray(rel) && rel[0] ? String((rel[0] as { id?: unknown })?.id ?? rel[0]) : null;
  const telefone = String(task.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.TELEFONE)?.value ?? '');
  return { leadId, telefone };
}

export async function registrarDesfecho(
  taskId: string,
  assigneeIdEsperado: string,
  resultado: ResultadoDesfecho,
  motivo?: MotivoNaoAtendida,
): Promise<void> {
  const taskValidada = await validarLigacaoDoOperador(taskId, assigneeIdEsperado);
  if (resultado === 'atendida') {
    if (OPER_STATUS_EM_PROCESSAMENTO) {
      await atualizarTask(taskId, { status: OPER_STATUS_EM_PROCESSAMENTO });
    }
    return;
  }
  if (resultado === 'nao_atendida') {
    // u13: com motivo do operador → CONCLUI (grava categoria em MOTIVO_FALHA,
    // o tempo de tentativa em DURACAO, comenta e fecha — sai da fila). Sem
    // motivo (cliente legado) → comportamento antigo: só carimba a última
    // tentativa e a task PERMANECE na fila (buscarFilaLigacoes a reordena).
    if (motivo?.categoria) {
      await gravarMetadadosLigacao(taskId, {
        atendeu: false,
        motivoFalha: motivo.categoria,
        duracao: motivo.duracao,
      });
      // Comentário é best-effort: não pode impedir a conclusão da Ligação.
      // LGPD: só a categoria + a frase do operador — nunca telefone/CPF.
      // Multi-linha, legível no ClickUp (u13b): classificação no cabeçalho, a
      // frase do operador e o tempo de tentativa, cada um em sua linha.
      const linhas = [`📵 Não atendida — ${motivo.categoria}`];
      if (motivo.observacao) linhas.push(`📝 ${motivo.observacao}`);
      if (motivo.duracao && motivo.duracao > 0) {
        linhas.push(`⏱️ Tentou por ${formatarDuracaoCurta(motivo.duracao)}`);
      }
      // u26: rastreabilidade — quem ligou e por qual linha (não é dado do
      // lead, sem restrição de LGPD). "Preencher todas as informações
      // possíveis" pedido pelo usuário para o caso "Número errado" — mesma
      // linha de código serve TODAS as categorias (comportamento uniforme).
      if (motivo.usuario) linhas.push(`👤 ${motivo.usuario}`);
      if (motivo.numero) linhas.push(`☎️ Linha: ${motivo.numero}`);
      try {
        await comentarTask(taskId, linhas.join('\n'));
      } catch (e) {
        console.warn(
          '[clickup] desfecho não-atendida: comentário falhou (segue concluindo):',
          e instanceof Error ? e.message : String(e),
        );
      }
      await fecharLigacao(taskId);
      {
        const { leadId, telefone } = identidadeDaLigacao(taskValidada);
        void fecharLigacoesDuplicadas(taskId, leadId, telefone);
      }
      return;
    }
    await setCustomField(taskId, CAMPOS_LIGACOES.INICIO, Date.now());
    return;
  }
  // resultado === 'recusou'
  await gravarMetadadosLigacao(taskId, { atendeu: false, motivoFalha: 'Recusada pelo lead' });
  await fecharLigacao(taskId);
  {
    const { leadId, telefone } = identidadeDaLigacao(taskValidada);
    void fecharLigacoesDuplicadas(taskId, leadId, telefone);
  }
}

/**
 * Adiciona um comentário numa task (D-P3-04 — redundância field+comentário
 * da transcrição). Thin wrapper sobre `POST /task/:id/comment`. Token ausente
 * e falha de infra/HTTP LANÇAM (WR-03) — nunca mascarados como sucesso.
 */
export async function comentarTask(taskId: string, texto: string): Promise<boolean> {
  if (!CLICKUP_API_TOKEN) {
    throw new Error('[clickup] CLICKUP_API_TOKEN ausente — nao da para comentar na task');
  }
  let res: Response;
  try {
    res = await fetchClickUp(`${CLICKUP_BASE_URL}/task/${taskId}/comment`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ comment_text: texto }),
    });
  } catch (e) {
    throw new Error(
      `[clickup] falha de rede ao comentar na task ${taskId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[clickup] POST /task/${taskId}/comment falhou (${res.status})`);
  }
  return true;
}

/**
 * Grava a transcrição da ligação na Ligação (OPER-01, D-P3-04): custom field
 * TRANSCRICAO E como comentário na task — redundância intencional (o field é
 * filtrável/lido pela Análise, o comentário é pra leitura humana no ClickUp).
 * Substitui `registrarNotaObservacao` (nota no GHL) no webhook RECORD. Erros
 * de infra/HTTP de qualquer uma das duas escritas LANÇAM (WR-03) — o caller
 * decide como reagir a uma falha parcial.
 */
export async function gravarTranscricao(taskId: string, transcricao: string): Promise<void> {
  await setCustomField(taskId, CAMPOS_LIGACOES.TRANSCRICAO, transcricao);
  await comentarTask(taskId, `📞 Transcrição da ligação (Wavoip)\n\n${transcricao}`);
}

/** Patch de metadados da Ligação derivados do payload Wavoip (D-P3-05, OPER-02, ver analise.ts). */
export interface PatchMetadadosLigacao {
  atendeu?: boolean;
  motivoFalha?: string;
  fim?: number;
  duracao?: number;
  urlGravacao?: string;
}

/**
 * Grava os metadados derivados do payload Wavoip na Ligação (D-P3-05,
 * OPER-02) — só os campos presentes no `patch` são escritos, cada um por
 * field-id de CAMPOS_LIGACOES (D-07). Preenchimento 100% automático: o
 * operador nunca digita nada disso. Erro de infra/HTTP em qualquer campo
 * LANÇA (WR-03) — o caller decide como reagir a uma falha parcial.
 */
export async function gravarMetadadosLigacao(taskId: string, patch: PatchMetadadosLigacao): Promise<void> {
  if (patch.atendeu !== undefined) {
    await setCustomField(taskId, CAMPOS_LIGACOES.ATENDEU, patch.atendeu);
  }
  if (patch.motivoFalha !== undefined) {
    await setCustomField(taskId, CAMPOS_LIGACOES.MOTIVO_FALHA, patch.motivoFalha);
  }
  if (patch.fim !== undefined) {
    await setCustomField(taskId, CAMPOS_LIGACOES.FIM, patch.fim);
  }
  // O payload CALL do Wavoip às vezes vem com duration=0/ausente (caso real:
  // Ligação de teste wdt4k4efhk gravou "0" mesmo numa chamada de ~3min23s).
  // Quando isso acontece mas o patch trouxe FIM, recalcula a duração de
  // (FIM - INICIO)/1000 usando o INICIO já persistido por iniciarLigacao —
  // sempre grava formatado em minutos (fix quick-260812-f77), nunca o número
  // cru. Sem duração utilizável (sem fim, INICIO inválido, ou fim<=inicio),
  // pula a escrita — mesmo comportamento de hoje.
  let duracaoSegundos: number | null = null;
  if (patch.duracao !== undefined && patch.duracao > 0) {
    duracaoSegundos = patch.duracao;
  } else if (patch.fim !== undefined) {
    const task = await lerTask(taskId);
    const inicioRaw = task?.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.INICIO)?.value;
    const inicio = Number(inicioRaw);
    if (Number.isFinite(inicio) && inicio > 0 && patch.fim > inicio) {
      duracaoSegundos = (patch.fim - inicio) / 1000;
    }
  }
  if (duracaoSegundos !== null && duracaoSegundos > 0) {
    await setCustomField(taskId, CAMPOS_LIGACOES.DURACAO, formatarDuracaoMinutos(duracaoSegundos));
  }
  if (patch.urlGravacao !== undefined) {
    await setCustomField(taskId, CAMPOS_LIGACOES.URL_GRAVACAO, patch.urlGravacao);
  }
}

/**
 * Remove o nono digito (prefixo movel BR) quando presente — mesma logica de
 * estado-webhook.ts (chaveTelefone/semNonoDigito), duplicada de proposito
 * (par pequeno demais pra justificar modulo compartilhado). Sem isso,
 * `telefonesIguais` nunca casava o telefone de 12 digitos que o webhook do
 * Wavoip reporta (sem o 9) com o de 13 que fica gravado na Ligacao (com o 9)
 * — quick-260818-u25.
 */
function semNonoDigito(digitos: string): string {
  if (digitos.length === 13 && digitos.startsWith('55') && digitos[4] === '9') {
    return digitos.slice(0, 4) + digitos.slice(5);
  }
  if (digitos.length === 11 && digitos[2] === '9') {
    return digitos.slice(0, 2) + digitos.slice(3);
  }
  return digitos;
}

/** Compara dois telefones ignorando formatação (só dígitos) e o nono dígito. */
function telefonesIguais(a: unknown, b: string): boolean {
  if (a === undefined || a === null) return false;
  return semNonoDigito(String(a).replace(/\D/g, '')) === semNonoDigito(b.replace(/\D/g, ''));
}

/**
 * Normaliza um telefone cru para E.164 (`+<pais><ddd><numero>`), formato
 * exigido pelo custom field TELEFONE (tipo "phone") da Lista 02 LIGACOES no
 * ClickUp. O Wavoip entrega o telefone só em dígitos (às vezes com sufixo
 * `@c.us`), sem `+` — mandar isso cru pro campo phone causa 400 na API.
 * Função PURA (sem I/O, sem log) — testável isoladamente. Retorna `null`
 * quando o resultado não é um E.164 plausível (12–15 dígitos); o caller deve
 * tratar `null` como "não dá pra normalizar" (fallback sem o campo).
 */
export function normalizarTelefoneE164(raw: string): string | null {
  if (!raw) return null;
  const semSufixo = raw.split('@')[0];
  const digitos = semSufixo.replace(/\D/g, '');
  // BR local (10 ou 11 dígitos, sem DDI) -> prefixa '55'. Se já vier
  // country-coded (12+ dígitos, ex os 13 de '5581984048278'), NÃO re-prefixa.
  const comDDI = digitos.length === 10 || digitos.length === 11 ? `55${digitos}` : digitos;
  if (comDDI.length < 12 || comDDI.length > 15) return null;
  return `+${comDDI}`;
}

/**
 * Formata uma duração em segundos como "Xmin Ys", pro campo DURACAO
 * (short_text) da Lista 02 LIGACOES ficar legível — nunca mais um número cru
 * tipo "0" ou "203.2" (fix quick-260812-f77). Função PURA (sem I/O, sem log —
 * duração não é PII/dado sensível, LGPD). Arredonda o TOTAL de segundos pra
 * inteiro PRIMEIRO (Math.round) e só depois deriva minutos/restante — evita o
 * bug de "1min 60s" que apareceria arredondando os segundos residuais depois
 * da divisão (ex.: 119.7s deve virar "2min 0s", não "1min 60s"). Entrada
 * não-finita ou <= 0 é defensiva (o caller normalmente não chama com <=0) e
 * retorna "0min 0s" em vez de lançar.
 */
export function formatarDuracaoMinutos(segundos: number): string {
  if (!Number.isFinite(segundos) || segundos <= 0) return '0min 0s';
  const totalSegundos = Math.round(segundos);
  const minutos = Math.floor(totalSegundos / 60);
  const restante = totalSegundos % 60;
  return `${minutos}min ${restante}s`;
}

/**
 * Duração "humana" e curta pra LEITURA (comentário do ClickUp): abaixo de 1min
 * mostra só "33s" (sem o "0min " que polui); a partir de 1min mostra "2min" ou
 * "2min 5s" (omite os segundos quando são 0). Função PURA. Entrada não-finita
 * ou <= 0 retorna "0s". Distinta de formatarDuracaoMinutos (essa é o formato
 * FIXO "Xmin Ys" do campo DURACAO, que outros consumidores esperam).
 */
export function formatarDuracaoCurta(segundos: number): string {
  if (!Number.isFinite(segundos) || segundos <= 0) return '0s';
  const total = Math.round(segundos);
  if (total < 60) return `${total}s`;
  const minutos = Math.floor(total / 60);
  const restante = total % 60;
  return restante ? `${minutos}min ${restante}s` : `${minutos}min`;
}

/**
 * Busca a Ligação ABERTA (Lista 02) cujo TELEFONE (field-id, D-07) casa com
 * `telefone` — fallback de correlação persistida (D-P3-01) usado quando o map
 * in-memory `taskAtivaPorTelefone` do webhook não tem a entrada (restart/TTL
 * expirado). Retorna `null` se nenhuma Ligação aberta casar — resultado
 * legítimo, distinto de erro de infra (LANÇA via `listarTasks`, WR-03).
 */
export async function buscarLigacaoAbertaPorTelefone(telefone: string): Promise<string | null> {
  const { tasks } = await listarTasks(CLICKUP_LIST_LIGACOES, { includeClosed: false });
  const match = tasks.find((t) =>
    telefonesIguais(t.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.TELEFONE)?.value, telefone),
  );
  return match?.id ?? null;
}

/**
 * Cria uma Ligação AVULSA (D-P3-03) quando uma gravação do webhook chega sem
 * task correspondente na Lista 02 (nem via correlação in-memory, nem via
 * `buscarLigacaoAbertaPorTelefone`) — nenhuma ligação real fica sem registro.
 * Sem script/descrição, gravando `CAMPOS_LIGACOES.TELEFONE`. Se um lead da
 * Lista 01 casar o mesmo telefone, vincula via ID_LEAD/LEAD_REL best-effort
 * (mesmo padrão de `scripts/gerar-lote.mjs`: se o relationship falhar,
 * segue — ID_LEAD já foi gravado). Erro de infra/HTTP na CRIAÇÃO da task
 * LANÇA (WR-03); o vínculo opcional ao lead NÃO aborta a criação. Nada de
 * PII em log dentro desta função.
 *
 * `assigneeId` (quick-260815-r3): quando presente e numérico, ATRIBUI a
 * Ligação avulsa ao operador (campo nativo `assignees`) — obrigatório quando
 * a avulsa nasce de "Ligar" na ficha/fila do app, senão o deep-link
 * `GET /ligacao/:taskId` (validação de ownership por assignee, CR-01) daria
 * 404. Backward-compatible: o caller do webhook (D-P3-03) não passa assignee
 * e a avulsa continua sem dono, como hoje.
 */
export async function criarLigacaoAvulsa(telefone: string, assigneeId?: string): Promise<{ id: string }> {
  // O campo TELEFONE é tipo "phone" -> exige E.164 ('+'); o telefone cru do
  // Wavoip não tem '+' e causava 400. Se não normalizar, melhor criar a
  // avulsa SEM o campo (o `name` já carrega o número cru) do que perder o
  // registro da gravação em um 400 (D-P3-03).
  const e164 = normalizarTelefoneE164(telefone);
  const assigneeNum = assigneeId !== undefined ? Number(assigneeId) : NaN;
  const novaTask = await criarTask(CLICKUP_LIST_LIGACOES, {
    name: `Ligação avulsa — ${telefone}`,
    ...(Number.isFinite(assigneeNum) ? { assignees: [assigneeNum] } : {}),
    ...(e164 !== null ? { custom_fields: [{ id: CAMPOS_LIGACOES.TELEFONE, value: e164 }] } : {}),
  });
  if (!novaTask?.id) {
    throw new Error('[clickup] criarLigacaoAvulsa: criarTask retornou sem id');
  }
  if (e164 === null) {
    // LGPD: nunca logar o telefone completo — só os últimos 4 dígitos.
    const mascarado = mascararTelefone(telefone);
    console.warn(
      `[clickup] Ligação avulsa (${novaTask.id}) criada SEM o campo TELEFONE — telefone não normalizável p/ E.164 (${mascarado})`,
    );
  }

  try {
    // 2026-08-19: o vínculo ao lead passou a buscar por FILTRO SERVER-SIDE do
    // ClickUp (campo TELEFONE da Lista 01), com e sem o nono dígito — antes a
    // varredura era só a PÁGINA 0 (100 de ~100k leads) e quase nunca achava
    // (era por isso que avulsas ficavam sem vínculo/dossiê). Cada query ~2-3s;
    // telefonesIguais revalida o match (o filtro do servidor é tolerante).
    const d = telefone.replace(/\D/g, '');
    const comPais = d.length >= 12 ? d : `55${d}`;
    const candidatos = new Set<string>([`+${comPais}`]);
    if (comPais.length === 12) candidatos.add(`+${comPais.slice(0, 4)}9${comPais.slice(4)}`);
    if (comPais.length === 13 && comPais[4] === '9') candidatos.add(`+${comPais.slice(0, 4)}${comPais.slice(5)}`);
    // Retry curto por candidato (listarTasksComRetry): sob carga o ClickUp
    // aborta e a query voltava vazia, deixando a avulsa SEM lead (o "Sem lead
    // vinculado" observado). O retry recupera a maioria dos aborts transitórios;
    // se ainda assim falhar, degrada p/ [] (best-effort — a task já existe).
    const resultados = await Promise.all(
      [...candidatos].map((v) =>
        listarTasksComRetry(CLICKUP_LIST_LEADS, {
          customFields: [{ field_id: CAMPOS_LEADS.TELEFONE, operator: '=', value: v }],
        })
          .then((r) => r.tasks)
          .catch(() => [] as TaskClickUp[]),
      ),
    );
    const leadMatch = resultados
      .flat()
      .find((t) => telefonesIguais(t.custom_fields?.find((c) => c.id === CAMPOS_LEADS.TELEFONE)?.value, telefone));
    if (leadMatch) {
      const idLead = String(
        leadMatch.custom_fields?.find((c) => c.id === CAMPOS_LEADS.ID_LEAD_GHL)?.value ?? leadMatch.id,
      );
      await setCustomField(novaTask.id, CAMPOS_LIGACOES.ID_LEAD, idLead);
      try {
        await setCustomField(novaTask.id, CAMPOS_LIGACOES.LEAD_REL, { add: [leadMatch.id] });
      } catch (e) {
        // D-P2-06/mesmo racional de gerar-lote.mjs: se o shape do relationship
        // falhar, segue — ID_LEAD já foi gravado, o vínculo textual não se perde.
        console.warn(
          `[clickup] Ligação avulsa (${novaTask.id}) criada mas LEAD_REL não foi setado: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } catch (e) {
    // Vínculo ao lead é best-effort — a Ligação avulsa já existe (D-P3-03),
    // uma falha aqui não pode fazer parecer que a gravação ficou sem registro.
    console.warn(
      `[clickup] Ligação avulsa (${novaTask.id}) criada mas vínculo ao lead falhou: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return { id: novaTask.id };
}

/** Um lead da Lista 01 que ainda NUNCA teve uma Ligação criada (ENVIO-03). */
export interface LeadNuncaLigado {
  leadTaskId: string;
  nome: string;
  telefone: string;
  /** CAMPOS_LEADS.ORIGEM cru (pode ser ''); alimenta os chips dinâmicos (ENVIO-04). */
  origem: string;
}

/**
 * Busca os leads da Lista 01 que NUNCA tiveram uma Ligação criada na Lista 02
 * (coração da tela `/audios`, ENVIO-03). Definição de "tem Ligação" = existe
 * QUALQUER task na Lista 02 (aberta OU fechada — pagina com
 * `includeClosed: true`) vinculada ao lead por `CAMPOS_LIGACOES.ID_LEAD`
 * (casa contra `CAMPOS_LEADS.ID_LEAD_GHL` OU o `leadTaskId` bruto — mesmo
 * fallback de `criarLigacaoAvulsa`) OU por telefone (`telefonesIguais`,
 * reuso de `semNonoDigito` — NÃO reimplementa comparação de telefone).
 *
 * ESTA É A MESMA DEFINIÇÃO QUE A FASE 15 USARÁ ao decidir remover um lead da
 * lista de Áudios: o lead sai no momento em que a Ligação é CRIADA (mesmo sem
 * INICIO/atendimento ainda), não quando ela é atendida ou fechada — por isso
 * o `includeClosed: true` e a ausência de qualquer filtro de status aqui.
 * Manter esta função como a ÚNICA fonte da verdade do filtro evita
 * incoerência entre as duas fases (ENVIO-03 / Fase 15).
 *
 * Retorna também `origens` = os valores DISTINTOS de `CAMPOS_LEADS.ORIGEM`
 * entre os leads nunca-ligados (ENVIO-04) — dinâmico, sem hardcode de rótulo
 * (D-04/D-05); a UI soma "Todos" por cima.
 *
 * Erro de infra/HTTP em qualquer uma das duas listas PROPAGA (`listarTasks`,
 * WR-03) — nunca retorna lista vazia pra mascarar falha. ESCALA (fix quick
 * 260818): a Lista 01 tem 100k+ leads — varrê-la inteira estourava o tempo
 * (~11min → timeout). Agora devolve um LOTE limitado: as Ligações (Lista 02,
 * minúscula) continuam paginadas por inteiro pra exclusão exata, mas os leads
 * são varridos só até juntar o lote (ou teto de páginas). O CRITÉRIO de
 * exclusão é IDÊNTICO ao de antes (lead com Ligação sai) — só o RESULTADO é
 * limitado; a "fonte da verdade do filtro" acima segue valendo. LGPD: sem log
 * nesta função (nenhum telefone/CPF impresso).
 */
export async function buscarLeadsNuncaLigados(): Promise<{ leads: LeadNuncaLigado[]; origens: string[] }> {
  // LOTE LIMITADO (fix quick 260818, base 100k+): varrer a Lista 01 inteira a
  // cada carregamento estourava o tempo (~1001 páginas ≈ 11min → timeout). A
  // Lista 02 é minúscula e o operador envia EM LOTE (throttle Evolution ~15/min),
  // então basta um lote pronto: paginamos os leads até juntar LIMITE_LOTE
  // nunca-ligados, ou acabar a base, ou bater o teto de segurança de páginas.
  // Pool do lote — a tela revela +10 por rolagem (scroll infinito, 2026-08-19).
  // 200 custa o MESMO wall-time que 50: a janela paralela de 5 páginas já varre
  // ~500 leads de uma vez, e com ~1,1k Ligações pra 100k leads quase todo lead
  // é nunca-ligado (o lote enche na 1ª janela).
  const LIMITE_LOTE = 200;
  const MAX_PAGINAS_SCAN = 20; // teto de segurança — nunca varre mais que isso
  // Janela de paginação PARALELA (fix quick 260818-perf): página a página o
  // ClickUp cobra ~2-3s CADA — as Ligações (includeClosed = histórico todo,
  // ~12 páginas) sozinhas custavam ~27s. A janela busca 5 de uma vez e
  // PROCESSA EM ORDEM — dados e ordem idênticos ao sequencial; páginas além
  // do fim voltam vazias com last_page e são descartadas (custo desprezível).
  // 5→3 (2026-08-19): rajadas de 5 conexões paralelas somadas aos pollers
  // derrubaram a VPS no WAF do ClickUp em produção — 3 mantém o ganho de
  // paralelismo com perfil de tráfego bem mais manso.
  const JANELA_PAGINAS = 3;

  // Ligações (Lista 02) COMPLETAS — a exclusão precisa de TODAS (erro de
  // infra PROPAGA — WR-03), então pagina até o fim, em janelas paralelas.
  const ligacoesTasks: TaskClickUp[] = [];
  let pageLig = 0;
  let lastPageLig = false;
  while (!lastPageLig) {
    const paginas: number[] = [];
    for (let i = 0; i < JANELA_PAGINAS; i += 1) paginas.push(pageLig + i);
    const resultados = await Promise.all(
      paginas.map((p) => listarTasks(CLICKUP_LIST_LIGACOES, { page: p, includeClosed: true })),
    );
    for (const resultado of resultados) {
      ligacoesTasks.push(...resultado.tasks);
      if (resultado.lastPage) {
        lastPageLig = true;
        break; // páginas seguintes da janela estão além do fim — descarta
      }
    }
    pageLig += paginas.length;
  }

  // Set de ID_LEAD (GHL ou taskId bruto — mesmo fallback de criarLigacaoAvulsa)
  // já vinculados a alguma Ligação; lookup O(1) por lead.
  const idsComLigacao = new Set<string>();
  // Telefones (crus, como gravados na Ligação) com Ligação — comparados via
  // telefonesIguais (reuso de semNonoDigito) por lead abaixo.
  const telefonesComLigacao: string[] = [];
  for (const t of ligacoesTasks) {
    const idLead = t.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.ID_LEAD)?.value;
    if (idLead !== undefined && idLead !== null && idLead !== '') idsComLigacao.add(String(idLead));
    const tel = t.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.TELEFONE)?.value;
    if (tel !== undefined && tel !== null && tel !== '') telefonesComLigacao.push(String(tel));
  }

  // Leads (Lista 01) PAGINADOS sob demanda — filtro inline (MESMO critério de
  // antes: lead com Ligação por id OU telefone sai), parando quando o lote
  // enche, a base acaba, ou o teto de páginas é atingido. Janela paralela +
  // processamento em ordem de página = mesmo resultado do sequencial.
  const nuncaLigados: LeadNuncaLigado[] = [];
  const origensVistas = new Set<string>();
  let pageLeads = 0;
  let lastPageLeads = false;
  while (!lastPageLeads && nuncaLigados.length < LIMITE_LOTE && pageLeads < MAX_PAGINAS_SCAN) {
    const paginas: number[] = [];
    for (let i = 0; i < JANELA_PAGINAS && pageLeads + i < MAX_PAGINAS_SCAN; i += 1) paginas.push(pageLeads + i);
    const resultados = await Promise.all(paginas.map((p) => listarTasks(CLICKUP_LIST_LEADS, { page: p })));
    for (const resultado of resultados) {
      for (const task of resultado.tasks) {
        // Mesmo parser usado por gerar-lote/fila (nome/telefone/idLead — DRY, D-07).
        const parsed = parseLeadDaTask(task, CAMPOS_LEADS);
        const temPorId =
          (parsed.idLead !== '' && idsComLigacao.has(parsed.idLead)) || idsComLigacao.has(task.id);
        const temPorTelefone =
          parsed.telefone !== '' && telefonesComLigacao.some((tl) => telefonesIguais(tl, parsed.telefone));
        if (temPorId || temPorTelefone) continue;
        const origem = valorCampoLead(task, CAMPOS_LEADS.ORIGEM);
        if (origem) origensVistas.add(origem);
        nuncaLigados.push({
          leadTaskId: task.id,
          nome: parsed.nome,
          telefone: parsed.telefone,
          origem,
        });
        if (nuncaLigados.length >= LIMITE_LOTE) break;
      }
      if (resultado.lastPage) lastPageLeads = true;
      if (lastPageLeads || nuncaLigados.length >= LIMITE_LOTE) break;
    }
    pageLeads += paginas.length;
  }

  return { leads: nuncaLigados, origens: [...origensVistas] };
}

/* ── Cache do lote nunca-ligados (memória, 1 instância) ─────────────────────
   A varredura custa ~8-30s (ClickUp) e o painel consulta a cada 30s (poll do
   hook) — sem cache, CADA poll re-varria o ClickUp inteiro. TTL curto +
   stale-while-revalidate: fresco responde na hora; velho responde na hora E
   dispara a atualização em fundo; vazio (boot) espera a varredura. Um envio /
   sem-whatsapp continua tirando o lead da lista pela MESMA regra de sempre
   (Ligação criada), só que o sumiço aparece no refresh seguinte (≤ TTL + poll
   — antes já dependia do próximo GET, então a semântica operacional se mantém).
   Falha do refresh em fundo NUNCA derruba a resposta (WR-03: quem tem dado
   serve dado; erro só propaga quando não há nada pra servir). */
// 60s→5min (2026-08-19): cada refresh é uma varredura FULL da Lista 02 (~13
// páginas) — a cada minuto isso vira tráfego contínuo no ClickUp (produção
// levou tarpit). O lote de nunca-ligados muda devagar; 5min de staleness é ok.
const TTL_LOTE_AUDIOS_MS = 300_000;
let cacheLoteAudios: { dados: { leads: LeadNuncaLigado[]; origens: string[] }; em: number } | null = null;
let refreshLoteAudiosEmVoo: Promise<{ leads: LeadNuncaLigado[]; origens: string[] }> | null = null;

function dispararRefreshLoteAudios(): Promise<{ leads: LeadNuncaLigado[]; origens: string[] }> {
  if (!refreshLoteAudiosEmVoo) {
    refreshLoteAudiosEmVoo = buscarLeadsNuncaLigados()
      .then((dados) => {
        cacheLoteAudios = { dados, em: Date.now() };
        return dados;
      })
      .finally(() => {
        refreshLoteAudiosEmVoo = null;
      });
  }
  return refreshLoteAudiosEmVoo;
}

/** Versão cacheada de `buscarLeadsNuncaLigados` — a rota GET /audios usa esta. */
export async function buscarLeadsNuncaLigadosCacheado(): Promise<{ leads: LeadNuncaLigado[]; origens: string[] }> {
  if (cacheLoteAudios && Date.now() - cacheLoteAudios.em < TTL_LOTE_AUDIOS_MS) return cacheLoteAudios.dados;
  const refresh = dispararRefreshLoteAudios();
  if (cacheLoteAudios) {
    // stale: serve o que tem AGORA; o refresh segue em fundo (erro só avisa).
    refresh.catch((e) =>
      console.warn('[audios] refresh do lote falhou; servindo cache anterior:', e instanceof Error ? e.message : String(e)),
    );
    return cacheLoteAudios.dados;
  }
  return refresh; // frio (boot): espera a varredura; erro PROPAGA (WR-03)
}

/**
 * Grava a task de registro de um envio de áudio na Lista 03 AUDIOS após o
 * envio já ter sido CONFIRMADO pelo `evolution.ts` (ENVIO-06) — escrita
 * SECUNDÁRIA best-effort (WR-03, molde `criarLigacaoAvulsa` linhas 993-1009):
 * o envio (efeito primário) já aconteceu ANTES desta função ser chamada; uma
 * falha aqui NUNCA desfaz nem mascara o envio já realizado — só
 * `console.warn`, nunca `throw`. Sempre CRIA uma nova task (uma por envio —
 * histórico auditável), escrevendo por field-id (D-07): DATA_DO_ENVIO,
 * ENVIADO_POR, AUDIO e, quando o telefone normaliza pra E.164, TELEFONE
 * também (mesmo fallback "sem o campo" de `criarLigacaoAvulsa` quando não
 * normaliza). Vínculo opcional ao lead (`CAMPOS_AUDIOS.LEAD`) é best-effort
 * dentro do best-effort — nunca derruba o registro já criado. LGPD: loga só
 * telefone MASCARADO (`mascararTelefone`), nunca o áudio, nunca em claro.
 */
export async function registrarEnvioAudio(args: {
  telefone: string;
  enviadoPor: string;
  audioRef: string;
  leadTaskId?: string;
  /** Base64 do áudio enviado (sem prefixo data:) — vira ANEXO na task (o campo
   *  "Áudio" da Lista 03 é type=attachment). Opcional: sem ele o registro é
   *  criado sem anexo (metadados continuam valendo). */
  audioBase64?: string;
  mimetype?: string;
}): Promise<{ id: string } | null> {
  const e164 = normalizarTelefoneE164(args.telefone);
  // O campo AUDIO NÃO entra aqui: ele é type=attachment no ClickUp — string em
  // custom_fields devolvia 400 e DERRUBAVA o registro inteiro (bug pego por
  // probe A/B em 2026-08-18; era por isso que a Lista 03 ficava vazia). O
  // áudio em si sobe como ANEXO depois da criação (abaixo, best-effort).
  const custom_fields: Array<{ id: string; value: unknown }> = [
    { id: CAMPOS_AUDIOS.DATA_DO_ENVIO, value: Date.now() },
    { id: CAMPOS_AUDIOS.ENVIADO_POR, value: args.enviadoPor },
  ];
  if (e164 !== null) {
    custom_fields.push({ id: CAMPOS_AUDIOS.TELEFONE, value: e164 });
  }
  try {
    const novaTask = await criarTask(CLICKUP_LIST_AUDIOS, {
      // IN-01/LGPD: título com telefone MASCARADO — o número em claro fica só
      // no campo dedicado TELEFONE (custom_fields), não duplicado no título
      // humano-legível (reduz a superfície de PII).
      name: `Áudio enviado — ${mascararTelefone(args.telefone)}`,
      custom_fields,
    });
    if (!novaTask?.id) {
      console.warn(
        '[clickup] registrarEnvioAudio: criarTask retornou sem id — envio já feito, registro NÃO persistido',
      );
      return null;
    }
    if (args.leadTaskId) {
      try {
        await setCustomField(novaTask.id, CAMPOS_AUDIOS.LEAD, { add: [args.leadTaskId] });
      } catch (e) {
        console.warn(
          `[clickup] registrarEnvioAudio (${novaTask.id}): vínculo ao lead falhou: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (args.audioBase64) {
      // Anexa o ÁUDIO REAL na task (campo "Áudio" da Lista 03 é attachment;
      // o anexo fica no corpo da task e vira insumo da transcrição na Fase 13).
      // Best-effort: falha aqui não derruba o registro já criado. Multipart:
      // SEM Content-Type manual (o fetch põe o boundary sozinho).
      try {
        const buf = Buffer.from(args.audioBase64, 'base64');
        const form = new FormData();
        form.append('attachment', new Blob([buf], { type: args.mimetype || 'audio/webm' }), args.audioRef);
        const resAnexo = await fetchClickUp(`${CLICKUP_BASE_URL}/task/${novaTask.id}/attachment`, {
          method: 'POST',
          headers: { Authorization: CLICKUP_API_TOKEN },
          body: form,
        });
        if (!resAnexo.ok) {
          console.warn(`[clickup] registrarEnvioAudio (${novaTask.id}): anexo do áudio falhou (${resAnexo.status})`);
        }
      } catch (e) {
        console.warn(
          `[clickup] registrarEnvioAudio (${novaTask.id}): anexo do áudio falhou: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return { id: novaTask.id };
  } catch (e) {
    // WR-03: o envio (efeito primário, evolution.ts) já aconteceu — uma falha
    // aqui é best-effort, nunca deve mascarar/desfazer o envio já realizado.
    const mascarado = mascararTelefone(args.telefone);
    console.warn(
      `[clickup] registrarEnvioAudio: envio já foi feito mas o registro na lista Audios falhou (tel ${mascarado}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/** Um envio (áudio OU texto) já registrado na Lista 03, na visão da conversa. */
export interface EnvioAudioHistorico {
  /** id da task de registro na Lista 03 (alvo das escritas de resposta/análise). */
  taskId: string;
  /** DATA_DO_ENVIO em ms (0 quando o registro antigo não tem a data). */
  em: number;
  /** ENVIADO_POR (usuário do token que enviou). */
  por: string;
  /** 'texto' quando o registro é de mensagem de texto (Fase 13 fatia 2). */
  tipo: 'audio' | 'texto';
  /** corpo da mensagem de texto (description da task) — null pra áudio. */
  texto: string | null;
  /** URL assinada do ANEXO de áudio na task (null se o registro não tem anexo). */
  audioUrl: string | null;
  /** TRANSCRICAO_AUDIO (Deepgram no envio, Fase 13) — null se ainda não transcrito. */
  transcricao: string | null;
}

/**
 * Histórico de envios de áudio de UM lead (Lista 03) — alimenta as bolhas da
 * conversa no painel (persistência entre sessões). A Lista 03 é pequena (um
 * registro por envio), então a paginação completa é barata; só as tasks que
 * batem no lead pagam o GET individual (necessário: a listagem não devolve
 * `attachments`). Erro de infra PROPAGA (WR-03) — a rota decide o 502.
 * LGPD: nenhum telefone logado aqui.
 */
export async function listarEnviosAudioDoLead(leadTaskId: string): Promise<EnvioAudioHistorico[]> {
  // 2026-08-19: filtro SERVER-SIDE (relação LEAD) no lugar da varredura da
  // Lista 03 inteira — o backfill da conversa paginava TUDO a cada abertura
  // de lead sem envio persistido (com o inbound, todo estranho novo caía
  // aqui) e segurava a conversa por segundos. Mesmo padrão provado na
  // timeline (buscarLigacoesDoLead).
  const { tasks } = await listarTasks(CLICKUP_LIST_AUDIOS, {
    includeClosed: true,
    customFields: [{ field_id: CAMPOS_AUDIOS.LEAD, operator: 'ANY', value: [leadTaskId] }],
  });
  const envios: EnvioAudioHistorico[] = [];
  for (const t of tasks) {
    const rel = t.custom_fields?.find((c) => c.id === CAMPOS_AUDIOS.LEAD)?.value;
    const ids = Array.isArray(rel) ? rel.map((v) => String((v as { id?: unknown })?.id ?? v)) : [];
    if (!ids.includes(leadTaskId)) continue;
    const em = Number(t.custom_fields?.find((c) => c.id === CAMPOS_AUDIOS.DATA_DO_ENVIO)?.value ?? NaN);
    const por = String(t.custom_fields?.find((c) => c.id === CAMPOS_AUDIOS.ENVIADO_POR)?.value ?? '');
    const transBruta = t.custom_fields?.find((c) => c.id === CAMPOS_AUDIOS.TRANSCRICAO_AUDIO)?.value;
    const transcricao = transBruta !== undefined && transBruta !== null && String(transBruta) !== '' ? String(transBruta) : null;
    // Tipo pelo TÍTULO do registro (contrato de escrita deste módulo):
    // "Mensagem enviada — ..." = texto; "Áudio enviado — ..." = áudio.
    const ehTexto = String(t.name ?? '').startsWith('Mensagem enviada');
    let audioUrl: string | null = null;
    let texto: string | null = null;
    try {
      // GET individual: anexo (áudio) ou corpo do texto (description).
      const det = (await lerTask(t.id)) as (TaskClickUp & { attachments?: Array<{ url?: string }> }) | null;
      if (ehTexto) texto = det?.text_content ?? det?.description ?? null;
      else audioUrl = det?.attachments?.[0]?.url ?? null;
    } catch {
      /* sem detalhe legível: a bolha aparece sem player/corpo (best-effort) */
    }
    envios.push({ taskId: t.id, em: Number.isFinite(em) ? em : 0, por, tipo: ehTexto ? 'texto' : 'audio', texto, audioUrl, transcricao });
  }
  envios.sort((a, b) => a.em - b.em);
  return envios;
}

/**
 * Registra uma mensagem de TEXTO enviada (Fase 13 fatia 2 — chat de verdade).
 * Mesmo molde best-effort do `registrarEnvioAudio` (WR-03: o envio primário já
 * aconteceu; falha aqui só avisa). O corpo do texto vai na DESCRIPTION da task
 * (é o "banco" da mensagem); título com telefone MASCARADO (IN-01/LGPD) e o
 * prefixo "Mensagem enviada" é o CONTRATO que `listarEnviosAudioDoLead` usa
 * pra distinguir texto de áudio.
 */
export async function registrarMensagemTexto(args: {
  telefone: string;
  enviadoPor: string;
  texto: string;
  leadTaskId?: string;
}): Promise<{ id: string } | null> {
  const e164 = normalizarTelefoneE164(args.telefone);
  const custom_fields: Array<{ id: string; value: unknown }> = [
    { id: CAMPOS_AUDIOS.DATA_DO_ENVIO, value: Date.now() },
    { id: CAMPOS_AUDIOS.ENVIADO_POR, value: args.enviadoPor },
  ];
  if (e164 !== null) {
    custom_fields.push({ id: CAMPOS_AUDIOS.TELEFONE, value: e164 });
  }
  try {
    const novaTask = await criarTask(CLICKUP_LIST_AUDIOS, {
      name: `Mensagem enviada — ${mascararTelefone(args.telefone)}`,
      description: args.texto,
      custom_fields,
    });
    if (!novaTask?.id) {
      console.warn('[clickup] registrarMensagemTexto: criarTask retornou sem id — envio já feito, registro NÃO persistido');
      return null;
    }
    if (args.leadTaskId) {
      try {
        await setCustomField(novaTask.id, CAMPOS_AUDIOS.LEAD, { add: [args.leadTaskId] });
      } catch (e) {
        console.warn(
          `[clickup] registrarMensagemTexto (${novaTask.id}): vínculo ao lead falhou: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return { id: novaTask.id };
  } catch (e) {
    const mascarado = mascararTelefone(args.telefone);
    console.warn(
      `[clickup] registrarMensagemTexto: envio já foi feito mas o registro falhou (tel ${mascarado}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/** Resumo da conversa de UM lead, agregado da Lista 03 (pro selo da lista). */
export interface ResumoConversaLead {
  envios: number;
  temResposta: boolean;
  /** TRANSCRICAO_RESPOSTA do registro mais recente com resposta (null sem). */
  respostaTexto: string | null;
  /** ANALISE_IA persistida ("LIGAR — ..." / "NÃO LIGAR — ...") — null sem análise. */
  analise: string | null;
}

/**
 * UMA passada na Lista 03 → resumo de conversa POR lead (Fase 13 fatia 2):
 * alimenta o selo "Ligar / Não ligar / Sem conversa" da lista. Erro PROPAGA
 * (WR-03) — o handler decide cache/fallback.
 */
export async function mapaConversaPorLead(): Promise<Map<string, ResumoConversaLead>> {
  const tasks: TaskClickUp[] = [];
  let page = 0;
  let last = false;
  while (!last) {
    const r = await listarTasks(CLICKUP_LIST_AUDIOS, { page, includeClosed: true });
    tasks.push(...r.tasks);
    last = r.lastPage;
    page += 1;
  }
  const mapa = new Map<string, ResumoConversaLead>();
  for (const t of tasks) {
    const rel = t.custom_fields?.find((c) => c.id === CAMPOS_AUDIOS.LEAD)?.value;
    const ids = Array.isArray(rel) ? rel.map((v) => String((v as { id?: unknown })?.id ?? v)) : [];
    if (ids.length === 0) continue;
    const dataResposta = Number(t.custom_fields?.find((c) => c.id === CAMPOS_AUDIOS.DATA_DA_RESPOSTA)?.value ?? NaN);
    const respBruta = t.custom_fields?.find((c) => c.id === CAMPOS_AUDIOS.TRANSCRICAO_RESPOSTA)?.value;
    const respostaTexto = respBruta !== undefined && respBruta !== null && String(respBruta) !== '' ? String(respBruta) : null;
    const analiseBruta = t.custom_fields?.find((c) => c.id === CAMPOS_AUDIOS.ANALISE_IA)?.value;
    const analise = analiseBruta !== undefined && analiseBruta !== null && String(analiseBruta) !== '' ? String(analiseBruta) : null;
    for (const leadId of ids) {
      const atual = mapa.get(leadId) ?? { envios: 0, temResposta: false, respostaTexto: null, analise: null };
      atual.envios += 1;
      if (Number.isFinite(dataResposta) && dataResposta > 0) atual.temResposta = true;
      if (respostaTexto) atual.respostaTexto = respostaTexto;
      if (analise) atual.analise = analise;
      mapa.set(leadId, atual);
    }
  }
  return mapa;
}

/**
 * Marca um lead como "sem WhatsApp" após o pré-check (evolution.ts,
 * `numeroExisteNoWhatsapp`) AFIRMAR `exists === false` (quick 260818-mv2).
 * Best-effort (WR-03, mesmo molde de `registrarEnvioAudio`) — NUNCA lança: o
 * handler já se comprometeu com a resposta `sem_whatsapp`, uma falha aqui só
 * faz o lead reaparecer no próximo lote (degradação aceitável). Duas
 * escritas independentes, cada uma no seu try/catch:
 * (a) comenta na task do LEAD;
 * (b) cria uma Ligação (Lista 02) "Sem WhatsApp" FECHADA vinculada ao lead —
 *     o MESMO mecanismo que `buscarLeadsNuncaLigados` usa pra excluir um lead
 *     do lote (ÚNICA fonte-de-verdade, não reimplementado aqui). Reusa a
 *     string literal EXATA `'Sem WhatsApp'` (já é categoria de MOTIVO_FALHA).
 * LGPD: telefone SEMPRE mascarado via `mascararTelefone` nos warns — nunca em
 * claro; nenhum CPF/áudio/apikey nesta função.
 */
export async function marcarLeadSemWhatsapp(args: {
  leadTaskId: string;
  idLeadGhl: string;
  telefone: string;
  usuario: string;
}): Promise<void> {
  try {
    const linhas = [`📵 Sem WhatsApp — número não encontrado no envio de áudio`, `👤 ${args.usuario}`];
    await comentarTask(args.leadTaskId, linhas.join('\n'));
  } catch (e) {
    const mascarado = mascararTelefone(args.telefone);
    console.warn(
      `[clickup] marcarLeadSemWhatsapp: comentário na task do lead falhou (tel ${mascarado}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  try {
    const e164 = normalizarTelefoneE164(args.telefone);
    const idLead = args.idLeadGhl || args.leadTaskId;
    const novaTask = await criarTask(CLICKUP_LIST_LIGACOES, {
      name: 'Sem WhatsApp — pulado',
      custom_fields: [
        { id: CAMPOS_LIGACOES.ID_LEAD, value: idLead },
        { id: CAMPOS_LIGACOES.MOTIVO_FALHA, value: 'Sem WhatsApp' },
        { id: CAMPOS_LIGACOES.ATENDEU, value: false },
        ...(e164 ? [{ id: CAMPOS_LIGACOES.TELEFONE, value: e164 }] : []),
      ],
    });
    if (!novaTask?.id) {
      console.warn('[clickup] marcarLeadSemWhatsapp: criarTask retornou sem id — lead pode reaparecer no lote');
      return;
    }
    try {
      await setCustomField(novaTask.id, CAMPOS_LIGACOES.LEAD_REL, { add: [args.leadTaskId] });
    } catch (e) {
      console.warn(
        `[clickup] marcarLeadSemWhatsapp (${novaTask.id}): LEAD_REL não foi setado (ID_LEAD já garante a exclusão): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    await fecharLigacao(novaTask.id);
  } catch (e) {
    const mascarado = mascararTelefone(args.telefone);
    console.warn(
      `[clickup] marcarLeadSemWhatsapp: criação da Ligação "Sem WhatsApp" falhou (tel ${mascarado}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Resolve o `taskId` do lead (Lista 01 LEADS) a partir de uma task de
 * Ligação (Lista 02) — OPER-05, Claude's Discretion (03-CONTEXT.md): tenta
 * primeiro `CAMPOS_LIGACOES.LEAD_REL` (relationship nativo, valor = array de
 * tasks linkadas); se ausente/vazio, cai no fallback por match de TELEFONE
 * contra a Lista 01 (mesmo padrão de `criarLigacaoAvulsa`/`telefonesIguais`).
 * Retorna `null` quando nenhuma das duas estratégias resolve — resultado
 * legítimo (lead não encontrado), distinto de erro de infra (LANÇA via
 * `lerTask`/`listarTasks`, WR-03).
 */
/**
 * Resolve o lead (Lista 01) a partir de uma task de Ligação JÁ LIDA — extraído
 * de `resolverLeadDaLigacao` pra reaproveitar a task quando o caller já a leu
 * (evita reler o mesmo taskId). Mesma estratégia: `LEAD_REL` (relationship) →
 * fallback por match de TELEFONE contra a Lista 01. `null` = lead não encontrado.
 */
async function resolverLeadPelaTask(task: TaskClickUp): Promise<string | null> {
  const leadRel = task.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.LEAD_REL)?.value;
  if (Array.isArray(leadRel) && leadRel.length > 0) {
    const primeiro = leadRel[0] as unknown;
    const id = primeiro && typeof primeiro === 'object' ? (primeiro as { id?: string }).id : primeiro;
    if (id) return String(id);
  }

  const telefone = String(task.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.TELEFONE)?.value ?? '');
  if (!telefone) return null;
  const { tasks: leads } = await listarTasks(CLICKUP_LIST_LEADS);
  const leadMatch = leads.find((t) =>
    telefonesIguais(t.custom_fields?.find((c) => c.id === CAMPOS_LEADS.TELEFONE)?.value, telefone),
  );
  return leadMatch?.id ?? null;
}

export async function resolverLeadDaLigacao(taskLigacaoId: string): Promise<string | null> {
  const task = await lerTask(taskLigacaoId);
  if (!task) return null;
  return resolverLeadPelaTask(task);
}

/**
 * Traduz o valor do drop_down ATENDEU (Lista 02) em boolean, de forma
 * TOLERANTE ao formato de leitura: hoje o campo só é ESCRITO (setCustomField
 * grava o UUID da opção via OPCOES_LIGACOES), nunca lido — e o GET da task
 * pode devolver drop_down como o `orderindex` (inteiro), o `id` da opção
 * (UUID) ou o `name`. Resolve nesta ordem: UUID direto contra
 * OPCOES_LIGACOES.ATENDEU.sim/.nao → senão casa contra `type_config.options`
 * (por orderindex/id/name) e mapeia a opção casada. Indeterminado/ausente →
 * `false` (nunca lança). Sem PII/log (LGPD).
 */
export function lerAtendeu(task: TaskClickUp): boolean {
  const cf = task.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.ATENDEU);
  const raw = cf?.value;
  if (raw === null || raw === undefined || raw === '') return false;
  const opcoes = OPCOES_LIGACOES[CAMPOS_LIGACOES.ATENDEU];
  const rawStr = String(raw);
  // Caso 1: veio o UUID da opção diretamente (formato que setCustomField grava).
  if (rawStr === opcoes.sim) return true;
  if (rawStr === opcoes.nao) return false;
  // Caso 2: veio orderindex (inteiro), id ou name — resolve via type_config.options.
  const opcao = cf?.type_config?.options?.find(
    (o) => String(o.orderindex) === rawStr || o.id === rawStr || o.name === rawStr,
  );
  if (opcao) {
    if (opcao.id === opcoes.sim) return true;
    if (opcao.id === opcoes.nao) return false;
    const nome = String(opcao.name ?? '').trim().toLowerCase();
    if (nome === 'sim') return true;
    if (nome === 'não' || nome === 'nao') return false;
  }
  return false;
}

/**
 * Lista as Ligações da Lista 02 vinculadas a UM lead (direção lead→ligações,
 * inversa de `resolverLeadPelaTask`) — alimenta a Seção 4 "Histórico de
 * chamados" do dossiê (quick 260813-pfm, consistente com o board do Miro).
 *
 * Estratégia: pagina TODA a Lista 02 com `includeClosed: true` (o histórico
 * de ligações está em tasks FECHADAS, espalhadas por várias páginas — não
 * basta a página 0, diferente de `buscarLigacaoAbertaPorTelefone`).
 * `listarTasks` LANÇA em falha de infra (WR-03) — deixamos propagar (o caller
 * degrada por fonte). Casa a Ligação ao lead quando `LEAD_REL` (array; item
 * `{ id }` ou id direto) contém `leadTaskId`, OU (fallback) `telefonesIguais`
 * no TELEFONE. Ordena por data (INICIO, epoch ms) DESC — ausentes por último
 * — e limita a `CAP` itens. LGPD/WR-01: NUNCA loga telefone/CPF/transcrição.
 */
/**
 * Formata o epoch (ms, string) da Ligação para uma data legível em horário de
 * Brasília ("DD/MM/AAAA HH:MM") — o dossiê injeta esse campo via JSON.stringify,
 * então guardar o epoch cru fazia o LLM escrever timestamps numéricos ilegíveis
 * na Seção 4. Epoch vazio/não-numérico vira '' (preserva o "ausente" que o sort
 * e o dossiê já tratam). Puro: sem I/O, sem log (LGPD — não há PII aqui).
 */
function formatarDataLigacao(epochMs: string): string {
  const n = Number(epochMs);
  if (epochMs === '' || !Number.isFinite(n)) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(n));
}

/**
 * Um item da timeline de ligações de um lead — shape EXATO que
 * `buscarLigacoesDoLead` já produzia (Seção 4 do dossiê). Só nomeia o tipo pra
 * reuso pelas rotas do app do Romero (B1); NÃO muda o comportamento em runtime.
 * `data` já vem formatada em Brasília; `atendeu` é boolean; os demais são
 * string possivelmente vazia. NÃO carrega CPF/telefone como campos próprios;
 * os campos de texto livre (`resumoAnalise`/`motivoFalha`, vindos de
 * ANALISE_IA/MOTIVO_FALHA, gerados por IA sobre a transcrição) são expostos
 * CRUS ao gestor (quick 260815-r12 — visão total do dono autenticado). LGPD:
 * exibir ao dono ≠ logar; nenhum PII vai pra log.
 */
export type ItemTimeline = {
  data: string;
  atendeu: boolean;
  aderencia: string;
  resumoAnalise: string;
  motivoFalha: string;
  /** DURACAO já formatada ("Xmin Ys"). Atendida = tempo de conversa; não
   * atendida = tempo que o operador ficou tentando (u13). '' quando ausente. */
  duracao: string;
};

export async function buscarLigacoesDoLead(
  leadTaskId: string,
  telefone: string,
  opts?: { ligacoesPreBuscadas?: TaskClickUp[] },
): Promise<ItemTimeline[]> {
  const CAP = 10;

  // 2026-08-19: filtro SERVER-SIDE no lugar da varredura sequencial da Lista
  // 02 inteira (12+ páginas ≈ 50s com o limiter manso — estourava o timeout da
  // ponte e a ficha nem carregava). Duas queries paralelas: por LEAD_REL (o
  // lote e as avulsas criadas pelo app gravam o vínculo) e por TELEFONE exato
  // (manuais sem vínculo), merge por id — ~2-3s no total. Trade-off aceito:
  // Ligação SEM rel e com telefone digitado em formato divergente escapa do
  // "=" do servidor; o scan antigo "pegava", mas nunca chegava ao usuário
  // (timeout) — completude efetiva era zero. O caminho `ligacoesPreBuscadas`
  // (backfill em lote, que já tem a lista inteira em mãos) segue igual.
  let todas: TaskClickUp[];
  if (opts?.ligacoesPreBuscadas) {
    todas = opts.ligacoesPreBuscadas;
  } else {
    const [porRel, porTelefone] = await Promise.all([
      // Query principal (estrita, WR-03: erro de infra PROPAGA — não vira []).
      listarTasks(CLICKUP_LIST_LIGACOES, {
        includeClosed: true,
        customFields: [{ field_id: CAMPOS_LIGACOES.LEAD_REL, operator: 'ANY', value: [leadTaskId] }],
      }).then((r) => r.tasks),
      // Complemento best-effort: falha aqui só reduz o alcance do fallback
      // por telefone, nunca derruba a ficha inteira.
      telefone
        ? listarTasks(CLICKUP_LIST_LIGACOES, {
            includeClosed: true,
            customFields: [{ field_id: CAMPOS_LIGACOES.TELEFONE, operator: '=', value: telefone }],
          })
            .then((r) => r.tasks)
            .catch((e) => {
              console.warn('[clickup] timeline: query por telefone falhou (segue só com o vínculo):', e instanceof Error ? e.message : String(e));
              return [] as TaskClickUp[];
            })
        : Promise.resolve([] as TaskClickUp[]),
    ]);
    const vistos = new Set<string>();
    todas = [...porRel, ...porTelefone].filter((t) => {
      if (vistos.has(t.id)) return false;
      vistos.add(t.id);
      return true;
    });
  }

  const campo = (task: TaskClickUp, id: string): unknown =>
    task.custom_fields?.find((c) => c.id === id)?.value;

  const casaLead = (task: TaskClickUp): boolean => {
    const leadRel = campo(task, CAMPOS_LIGACOES.LEAD_REL);
    if (Array.isArray(leadRel)) {
      const casa = leadRel.some((item) => {
        const id = item && typeof item === 'object' ? (item as { id?: string }).id : item;
        return id !== undefined && id !== null && String(id) === leadTaskId;
      });
      if (casa) return true;
    }
    // Fallback por telefone — só quando temos um telefone não-vazio para
    // comparar (evita casar tasks de TELEFONE vazio contra um telefone vazio).
    return telefone ? telefonesIguais(campo(task, CAMPOS_LIGACOES.TELEFONE), telefone) : false;
  };

  const paraString = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

  const ligacoes = todas.filter(casaLead).map((task) => ({
    data: paraString(campo(task, CAMPOS_LIGACOES.INICIO)),
    atendeu: lerAtendeu(task),
    aderencia: paraString(campo(task, CAMPOS_LIGACOES.ADERENCIA_SCRIPT)),
    resumoAnalise: paraString(campo(task, CAMPOS_LIGACOES.ANALISE_IA)),
    motivoFalha: paraString(campo(task, CAMPOS_LIGACOES.MOTIVO_FALHA)),
    duracao: paraString(campo(task, CAMPOS_LIGACOES.DURACAO)),
  }));

  // Ordena por data (INICIO, epoch ms) DESC — mais recente primeiro; ausentes
  // (data vazia / não-numérica) por último. O sort roda sobre o epoch CRU;
  // só DEPOIS formatamos `data` para horário de Brasília (não antes, senão a
  // ordenação por Number() quebraria).
  ligacoes.sort((a, b) => {
    const na = a.data !== '' && Number.isFinite(Number(a.data)) ? Number(a.data) : -Infinity;
    const nb = b.data !== '' && Number.isFinite(Number(b.data)) ? Number(b.data) : -Infinity;
    return nb - na;
  });

  return ligacoes.slice(0, CAP).map((l) => ({ ...l, data: formatarDataLigacao(l.data) }));
}

/**
 * Valida (CR-01) que `taskId` é uma Ligação da Lista 02 atribuída ao operador
 * logado — mesma regra de `lerLigacao`/`iniciarLigacao`, fecha IDOR: sem isso
 * um `taskId` arbitrário deixaria um operador ler/gravar voto no lead de outro
 * operador (ou em qualquer task da workspace). Retorna a task já lida pra
 * reaproveitar na resolução do lead. LANÇA quando a task não existe / não é da
 * Lista 02 / não pertence ao operador (o caller mapeia pra 404).
 *
 * Exportada (Fase 08 Plano 04, follow-up de verificação): POST /voto agora
 * enfileira o voto (D-07a, async) em vez de gravar sincrono — sem uma
 * checagem síncrona antes do enqueue, um `taskId` inválido/de outro operador
 * responderia 200 na hora e só falharia (silenciosamente, via DLQ) depois,
 * dentro do worker. `index.ts` chama esta MESMA função antes de enfileirar
 * pra manter o 404 imediato de sempre; `salvarVotoLead` (chamada dentro do
 * job) valida de novo por segurança — o custo é uma leitura a mais via
 * `fetchClickUp` (já rate-limitada), não uma segunda fonte de verdade.
 */
export async function validarLigacaoDoOperador(taskId: string, assigneeIdEsperado: string): Promise<TaskClickUp> {
  const task = await lerTask(taskId);
  if (!task) {
    throw new Error(`[clickup] task ${taskId} nao encontrada`);
  }
  if (task.list?.id !== CLICKUP_LIST_LIGACOES) {
    throw new Error(`[clickup] task ${taskId} nao e uma Ligacao da Lista 02`);
  }
  if (!task.assignees?.some((a) => String(a.id) === assigneeIdEsperado)) {
    throw new Error(`[clickup] task ${taskId} nao pertence ao operador`);
  }
  return task;
}

/** Escolha de voto por candidato — chave de `OPCOES_LEADS` (traduz pra UUID da opção). */
export type EscolhaVoto = 'sim' | 'nao' | 'naoDeclarou';

/** Status de voto do lead ligado a uma Ligação — decide o que perguntar no pós-ligação. */
export interface StatusVotoLead {
  /** false = nenhum lead resolvido pela Ligação (nada a atualizar → não mostra a tela). */
  temLead: boolean;
  /** true = "Confirmou voto no Romero" já tem valor (não perguntar de novo). */
  romeroDefinido: boolean;
  /** true = "Confirmou voto na Andressa" já tem valor. */
  andressaDefinido: boolean;
}

/** Um drop_down do ClickUp está "definido" quando tem qualquer valor (0 é opção válida — orderindex). */
function campoDefinido(v: unknown): boolean {
  return v !== null && v !== undefined && v !== '';
}

/**
 * Lê o status de voto (Romero/Andressa) do lead ligado à Ligação `taskId` do
 * operador. Resolve o lead (LEAD_REL → fallback telefone) e checa se cada campo
 * drop_down JÁ tem valor — o pós-ligação só pergunta os ainda vazios ("se já
 * confirmou não precisa mostrar"). Erros de infra/autorização LANÇAM (WR-03).
 */
export async function lerStatusVotoLead(taskId: string, assigneeIdEsperado: string): Promise<StatusVotoLead> {
  const task = await validarLigacaoDoOperador(taskId, assigneeIdEsperado);
  const leadId = await resolverLeadPelaTask(task);
  if (!leadId) return { temLead: false, romeroDefinido: false, andressaDefinido: false };
  const lead = await lerTask(leadId);
  const valor = (fid: string) => lead?.custom_fields?.find((c) => c.id === fid)?.value;
  return {
    temLead: true,
    romeroDefinido: campoDefinido(valor(CAMPOS_LEADS.CONFIRMOU_VOTO_ROMERO)),
    andressaDefinido: campoDefinido(valor(CAMPOS_LEADS.CONFIRMOU_VOTO_ANDRESSA)),
  };
}

/**
 * Contexto (dossiê) do lead ligado a uma Ligação — leitura, sem mutação.
 *
 * `contexto` é a DESCRIÇÃO NATIVA da task do lead (Dossiê 360°, escrito por
 * `scripts/montar-dossies.mjs` via `atualizarTask(lead.taskId, { description:
 * dossieMarkdown })`) — NUNCA o campo custom OBSERVACAO_CONSOLIDADA.
 */
export interface ContextoLead {
  /** false = nenhum lead resolvido pela Ligação (nada a mostrar). */
  temLead: boolean;
  /** Descrição nativa (markdown) da task do lead na Lista 01, ou '' se ausente/sem lead. */
  contexto: string;
}

/**
 * Lê o contexto (dossiê 360°) do lead ligado à Ligação `taskId` do operador.
 * Resolve o lead (LEAD_REL → fallback telefone) igual a `lerStatusVotoLead` e
 * devolve a DESCRIÇÃO nativa da task do lead — mesmo fallback description/
 * text_content de `lerLigacao` (a API às vezes devolve o texto plano em vez da
 * descrição rica). Read-only: nenhuma escrita, nenhuma presença registrada.
 * Erros de infra/autorização LANÇAM (WR-03) — o caller (index.ts) mapeia.
 */
export async function lerContextoLead(taskId: string, assigneeIdEsperado: string): Promise<ContextoLead> {
  const task = await validarLigacaoDoOperador(taskId, assigneeIdEsperado);
  const leadId = await resolverLeadPelaTask(task);
  if (!leadId) return { temLead: false, contexto: '' };
  const lead = await lerTask(leadId);
  return { temLead: true, contexto: lead?.description ?? lead?.text_content ?? '' };
}

/**
 * Grava o(s) voto(s) confirmado(s) no lead ligado à Ligação `taskId` do
 * operador (Lista 01 LEADS, drop_down por UUID via `OPCOES_LEADS`). Só escreve
 * os candidatos presentes em `voto`. `{ temLead:false }` quando nenhum lead foi
 * resolvido (nada gravado). Erros de infra/autorização LANÇAM (WR-03).
 */
export async function salvarVotoLead(
  taskId: string,
  assigneeIdEsperado: string,
  voto: { romero?: EscolhaVoto; andressa?: EscolhaVoto },
): Promise<{ temLead: boolean; leadId?: string }> {
  const task = await validarLigacaoDoOperador(taskId, assigneeIdEsperado);
  const leadId = await resolverLeadPelaTask(task);
  if (!leadId) return { temLead: false };
  if (voto.romero) {
    await setCustomField(leadId, CAMPOS_LEADS.CONFIRMOU_VOTO_ROMERO, OPCOES_LEADS[CAMPOS_LEADS.CONFIRMOU_VOTO_ROMERO][voto.romero]);
  }
  if (voto.andressa) {
    await setCustomField(leadId, CAMPOS_LEADS.CONFIRMOU_VOTO_ANDRESSA, OPCOES_LEADS[CAMPOS_LEADS.CONFIRMOU_VOTO_ANDRESSA][voto.andressa]);
  }
  // `leadId` sai junto para o chamador poder ATRIBUIR a declaração a quem a colheu
  // (sync-clickup.ts → votos_ligacao). Aqui ele já foi resolvido e pago; devolvê-lo evita
  // uma segunda resolução do mesmo lead só para registrar o crédito.
  return { temLead: true, leadId };
}

/** Voto atual (manual) do lead por candidato — alimenta a validação humano×IA no processador (OPER-04b). */
export interface VotoAtualLead {
  romero: { definido: boolean; escolha: EscolhaVoto | null };
  andressa: { definido: boolean; escolha: EscolhaVoto | null };
}

/**
 * Traduz o valor lido de um drop_down de voto (Lista 01) de volta para
 * `EscolhaVoto`. Tolerante ao formato do GET (mesmo racional de `lerAtendeu`):
 * casa o UUID da opção direto contra `OPCOES_LEADS[campo]` (formato que
 * `setCustomField`/`salvarVotoLead` gravam); senão resolve via
 * `type_config.options` por orderindex/id/name e casa o id. Indeterminado/
 * ausente → null (nunca lança). Sem PII/log.
 */
function resolverEscolhaVoto(lead: TaskClickUp | null, campoId: string): EscolhaVoto | null {
  const cf = lead?.custom_fields?.find((c) => c.id === campoId);
  const raw = cf?.value;
  if (raw === null || raw === undefined || raw === '') return null;
  const opcoes = (OPCOES_LEADS as Record<string, Record<EscolhaVoto, string>>)[campoId];
  const rawStr = String(raw);
  const entradas = Object.entries(opcoes) as [EscolhaVoto, string][];
  // Caso 1: UUID da opção direto.
  const porUuid = entradas.find(([, uuid]) => uuid === rawStr);
  if (porUuid) return porUuid[0];
  // Caso 2: orderindex/id/name — resolve via type_config.options e casa o id.
  const opcao = cf?.type_config?.options?.find(
    (o) => String(o.orderindex) === rawStr || o.id === rawStr || o.name === rawStr,
  );
  if (opcao) {
    const porId = entradas.find(([, uuid]) => uuid === opcao.id);
    if (porId) return porId[0];
  }
  return null;
}

/**
 * Lê o voto atual (manual) do lead JÁ CARREGADO — sem novo fetch (o processador
 * já leu o lead na consolidação). `definido` = o drop_down tem qualquer valor
 * (mesma checagem de `lerStatusVotoLead`); `escolha` = o valor traduzido, ou
 * null quando vazio/irressolúvel. Puro/sync, sem I/O.
 */
export function resolverVotoAtualLead(lead: TaskClickUp | null): VotoAtualLead {
  const ler = (campoId: string) => {
    const raw = lead?.custom_fields?.find((c) => c.id === campoId)?.value;
    return { definido: campoDefinido(raw), escolha: resolverEscolhaVoto(lead, campoId) };
  };
  return {
    romero: ler(CAMPOS_LEADS.CONFIRMOU_VOTO_ROMERO),
    andressa: ler(CAMPOS_LEADS.CONFIRMOU_VOTO_ANDRESSA),
  };
}

/**
 * Grava UM candidato de voto no lead (Lista 01, drop_down por UUID via
 * `OPCOES_LEADS`) — usado pelo Agente Análise quando PREENCHE um campo vazio.
 * Diferente de `salvarVotoLead`, escreve direto por `leadTaskId` (o processador
 * roda no worker/webhook, sem operador logado pra `validarLigacaoDoOperador`).
 * Erros de infra LANÇAM (WR-03) — o caller loga-e-segue.
 */
export async function definirVotoLeadCampo(
  leadTaskId: string,
  candidato: 'romero' | 'andressa',
  valor: EscolhaVoto,
): Promise<void> {
  const campoId =
    candidato === 'romero' ? CAMPOS_LEADS.CONFIRMOU_VOTO_ROMERO : CAMPOS_LEADS.CONFIRMOU_VOTO_ANDRESSA;
  await setCustomField(leadTaskId, campoId, OPCOES_LEADS[campoId][valor]);
}

/** Patch de contadores mecânicos do lead — mesmo shape de `ContadoresLead` (contexto.ts), injetado pelo caller. */
export interface PatchContadoresLead {
  tentativas: number;
  atendimentos: number;
  naoAtendimentos: number;
  ultimoContato: number;
  ultimoAtendimento: number | null;
  ultimoResultado: string;
}

/** Patch de consolidação do lead (OPER-05, D-P3-12/13/14): campos calculados pelo caller (contexto.ts), gravados por field-id (D-07). */
export interface PatchConsolidarLead {
  observacaoConsolidada?: string;
  /** Epoch ms — PROXIMO_CONTATO (D-P3-14). */
  proximoContato?: number;
  contadores?: PatchContadoresLead;
}

/**
 * Consolida o resultado da ligação no lead (Lista 01, OPER-05): reescreve
 * OBSERVACAO_CONSOLIDADA (resumo vivo, D-P3-13), grava PROXIMO_CONTATO
 * (D-P3-14) e os contadores mecânicos (QTD_TENTATIVAS/QTD_ATENDIMENTOS/
 * QTD_NAO_ATENDIMENTOS/ULTIMO_CONTATO/ULTIMO_ATENDIMENTO/ULTIMO_RESULTADO) —
 * só os campos presentes em `patch` são escritos, cada um por field-id de
 * `CAMPOS_LEADS` (D-07). Erro de infra/HTTP em qualquer campo LANÇA (WR-03) —
 * o caller (webhook) decide como reagir a uma falha parcial (log-e-segue).
 */
export async function consolidarLead(leadTaskId: string, patch: PatchConsolidarLead): Promise<void> {
  if (patch.observacaoConsolidada !== undefined) {
    await setCustomField(leadTaskId, CAMPOS_LEADS.OBSERVACAO_CONSOLIDADA, patch.observacaoConsolidada);
  }
  if (patch.proximoContato !== undefined) {
    await setCustomField(leadTaskId, CAMPOS_LEADS.PROXIMO_CONTATO, patch.proximoContato);
  }
  if (patch.contadores) {
    const c = patch.contadores;
    await setCustomField(leadTaskId, CAMPOS_LEADS.QTD_TENTATIVAS, c.tentativas);
    await setCustomField(leadTaskId, CAMPOS_LEADS.QTD_ATENDIMENTOS, c.atendimentos);
    await setCustomField(leadTaskId, CAMPOS_LEADS.QTD_NAO_ATENDIMENTOS, c.naoAtendimentos);
    await setCustomField(leadTaskId, CAMPOS_LEADS.ULTIMO_CONTATO, c.ultimoContato);
    if (c.ultimoAtendimento !== null) {
      await setCustomField(leadTaskId, CAMPOS_LEADS.ULTIMO_ATENDIMENTO, c.ultimoAtendimento);
    }
    await setCustomField(leadTaskId, CAMPOS_LEADS.ULTIMO_RESULTADO, c.ultimoResultado);
  }
}

/**
 * Fecha a task de Ligação sozinha no pós-processamento (D-P3-06) — a task
 * fica fechada assim que a cadeia (transcrição/análise/consolidação) termina;
 * "Próxima" no discador só avança a UI, nunca fecha a task diretamente.
 * Thin wrapper sobre `atualizarTask` com `OPER_STATUS_FECHADO` (config.ts).
 * Erro de infra/HTTP LANÇA (WR-03) — o caller decide como reagir.
 */
export async function fecharLigacao(taskId: string): Promise<void> {
  await atualizarTask(taskId, { status: OPER_STATUS_FECHADO });
}

// ===== Lista 01 LEADS — rotas do app do Romero (B1, quick 260815-b1) =====
//
// Choke point (D-07/D-09) das rotas de leitura/escrita da Lista 01 pelo app
// mobile do Romero: validação de lista (anti-IDOR de escrita) e resolução de
// lead vivem AQUI — `index.ts` só faz o wiring HTTP. Visão do GESTOR (quick
// 260815-r12): telefone e CPF saem EM CLARO no resumo e no detalhe — o dono
// autenticado (gate de papel gestor na rota) pode ver a visão total; a operação
// é single-tenant. LGPD: exibir ao dono ≠ logar — NUNCA loga telefone/CPF.

/** Lê um custom field da Lista 01 por field-id (D-07), sempre como string ('' se ausente). */
export function valorCampoLead(task: TaskClickUp, fieldId: string): string {
  const v = task.custom_fields?.find((c) => c.id === fieldId)?.value;
  return v === null || v === undefined ? '' : String(v);
}

/**
 * Lê um custom field CHECKBOX da Lista 01 como boolean de verdade. O ClickUp
 * devolve `true/false` para checkbox (MILITANTE não está em `OPCOES_LEADS`), e
 * `valorCampoLead` transformaria em `"true"`/`"false"` — string não-vazia que
 * vira truthy no cliente e marcaria "Militante" errado. Retorna true SÓ para
 * valores afirmativos; `false`/`null`/`undefined`/`""`/`"false"`/`"nao"`/`"0"` → false.
 */
function campoLeadBooleano(task: TaskClickUp, fieldId: string): boolean {
  const v = task.custom_fields?.find((c) => c.id === fieldId)?.value;
  if (v === true) return true;
  return ['true', 'sim', '1', 'yes'].includes(String(v).toLowerCase().trim());
}

/**
 * Valida (anti-IDOR de escrita/leitura de detalhe) que `leadTaskId` é uma task
 * da Lista 01 LEADS — espelho de `validarLigacaoDoOperador` para a Lista 01.
 * Sem assignee (a Lista 01 não é por-operador; a autorização single-tenant do
 * Romero vive na ponte Next `exigirRomero`, B2, + no kill-switch
 * `DISCADOR_LEAD_BROWSE` do backend). Sem este guard, `definirVotoLeadCampo`/
 * `comentarTask` gravariam voto/comentário em QUALQUER task da workspace só
 * trocando o `:leadTaskId` da URL. LANÇA quando a task não existe / não é da
 * Lista 01 (o caller mapeia pra 404). Retorna a task já lida pra reaproveitar.
 */
export async function validarLeadDaLista01(leadTaskId: string): Promise<TaskClickUp> {
  const task = await lerTask(leadTaskId);
  if (!task) {
    throw new Error(`[clickup] lead ${leadTaskId} nao encontrada`);
  }
  if (task.list?.id !== CLICKUP_LIST_LEADS) {
    throw new Error(`[clickup] task ${leadTaskId} nao e um Lead da Lista 01`);
  }
  return task;
}

/** Resumo de um lead da Lista 01 para a listagem do app (visão do gestor: telefone e CPF em claro). */
export interface LeadResumo {
  leadTaskId: string;
  nome: string;
  telefone: string;
  cpf: string;
  bairro: string;
  cidade: string;
  confirmouRomero: EscolhaVoto | null;
  confirmouAndressa: EscolhaVoto | null;
  militante: boolean;
  /** true = nunca atendido (QTD_ATENDIMENTOS vazio/0). */
  semContato: boolean;
}

/**
 * Lista os leads da Lista 01 (resumo) para o app do Romero — visão do gestor
 * (quick 260815-r12): telefone EM CLARO e CPF inclusos (o gate de papel gestor
 * na rota autoriza a visão total; a operação é single-tenant do dono). Filtra
 * por `q` (substring case-insensitive no NOME) via filtro IN-PROCESS (em
 * memória) após listar a página do ClickUp — nunca devolve não-casados.
 * Paginação por page opaca (`cursor = String(page+1)` a menos que `lastPage`);
 * corta em `limit` (default 30, teto 100). `listarTasks` LANÇA em falha de infra
 * (WR-03) — o caller mapeia pro 502. Sem log de PII (D-09/D-10).
 */
export async function listarLeadsResumo(
  opts: { page?: number; q?: string; limit?: number } = {},
): Promise<{ leads: LeadResumo[]; cursor?: string }> {
  const page = opts.page ?? 0;
  // O cursor avanca UMA pagina do ClickUp por vez (~100 tasks). Se o limit for
  // menor que a pagina do ClickUp, os leads acima do limit sao PULADOS (o cursor
  // ja pulou pra proxima pagina). Por isso o default = 100 (tamanho da pagina do
  // ClickUp), pra nao perder nenhum lead. (u9)
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 100);
  const q = (opts.q ?? '').trim().toLowerCase();
  const { tasks, lastPage } = await listarTasks(CLICKUP_LIST_LEADS, { page });
  const leads: LeadResumo[] = [];
  for (const task of tasks) {
    const parsed = parseLeadDaTask(task, CAMPOS_LEADS);
    if (q && !parsed.nome.toLowerCase().includes(q)) continue;
    const voto = resolverVotoAtualLead(task);
    leads.push({
      leadTaskId: task.id,
      nome: parsed.nome,
      telefone: parsed.telefone,
      cpf: valorCampoLead(task, CAMPOS_LEADS.CPF),
      bairro: valorCampoLead(task, CAMPOS_LEADS.BAIRRO),
      cidade: valorCampoLead(task, CAMPOS_LEADS.CIDADE),
      confirmouRomero: voto.romero.escolha,
      confirmouAndressa: voto.andressa.escolha,
      militante: campoLeadBooleano(task, CAMPOS_LEADS.MILITANTE),
      semContato: !(Number(valorCampoLead(task, CAMPOS_LEADS.QTD_ATENDIMENTOS)) > 0),
    });
    if (leads.length >= limit) break;
  }
  return { leads, cursor: lastPage ? undefined : String(page + 1) };
}

/**
 * Conta o total REAL de leads da Lista 01 (u9): o `task_count` que o ClickUp já
 * mantém na lista — UMA chamada barata (GET /list/:id), sem paginar milhares de
 * páginas. Usado só pro cabeçalho da Base mostrar o valor real (não o "100+").
 * LANÇA em infra/HTTP (WR-03) — o caller trata como opcional.
 */
export async function contarLeadsDaLista(): Promise<number> {
  if (!CLICKUP_API_TOKEN) {
    throw new Error('[clickup] CLICKUP_API_TOKEN ausente — nao da para contar leads');
  }
  const res = await fetchClickUp(`${CLICKUP_BASE_URL}/list/${CLICKUP_LIST_LEADS}`, {
    headers: headers(),
  });
  if (!res.ok) {
    throw new Error(`[clickup] GET /list/${CLICKUP_LIST_LEADS} falhou (${res.status})`);
  }
  const data = await res.json();
  return Number(data?.task_count) || 0;
}

/** Detalhe de um lead da Lista 01 para o app (visão do gestor: telefone e CPF em claro). */
export interface LeadDetalhe {
  leadTaskId: string;
  nome: string;
  telefone: string;
  cpf: string;
  bairro: string;
  cidade: string;
  uf: string;
  confirmouRomero: EscolhaVoto | null;
  confirmouAndressa: EscolhaVoto | null;
  militante: boolean;
  observacao: string;
  ultimoContato: string;
  proximoContato: string;
}

/**
 * Lê o detalhe completo de um lead da Lista 01 para o app do Romero: valida a
 * lista (`validarLeadDaLista01`, anti-IDOR), monta `LeadDetalhe` (visão do
 * gestor, quick 260815-r12: telefone e CPF EM CLARO; datas legíveis em
 * Brasília), o dossiê (descrição nativa da task — igual `lerContextoLead`, cru)
 * e a timeline de ligações (crua). O gate de papel gestor na rota autoriza a
 * visão total — a operação é single-tenant do dono. LANÇA em infra/autz
 * (WR-03) — o caller mapeia 404/502.
 */
export async function lerLeadDetalhe(
  leadTaskId: string,
  opts: { comTimeline?: boolean } = {},
): Promise<{ lead: LeadDetalhe; dossie: string; timeline: ItemTimeline[] }> {
  const task = await validarLeadDaLista01(leadTaskId);
  const parsed = parseLeadDaTask(task, CAMPOS_LEADS);
  const voto = resolverVotoAtualLead(task);
  const lead: LeadDetalhe = {
    leadTaskId: task.id,
    nome: parsed.nome,
    telefone: parsed.telefone,
    cpf: valorCampoLead(task, CAMPOS_LEADS.CPF),
    bairro: valorCampoLead(task, CAMPOS_LEADS.BAIRRO),
    cidade: valorCampoLead(task, CAMPOS_LEADS.CIDADE),
    uf: valorCampoLead(task, CAMPOS_LEADS.UF),
    confirmouRomero: voto.romero.escolha,
    confirmouAndressa: voto.andressa.escolha,
    militante: campoLeadBooleano(task, CAMPOS_LEADS.MILITANTE),
    observacao: valorCampoLead(task, CAMPOS_LEADS.OBSERVACAO_CONSOLIDADA),
    ultimoContato: formatarDataLigacao(valorCampoLead(task, CAMPOS_LEADS.ULTIMO_CONTATO)),
    proximoContato: formatarDataLigacao(valorCampoLead(task, CAMPOS_LEADS.PROXIMO_CONTATO)),
  };
  // Visão do gestor (quick 260815-r12): dossiê e timeline CRUS — o dono
  // autenticado pode ver tudo (o gate de papel gestor na rota autoriza). LGPD:
  // exibir ao dono ≠ logar; nenhum PII vai pra log aqui.
  const dossie = task.description ?? task.text_content ?? '';
  // comTimeline:false (variante LEVE, 2026-08-20): pula a timeline — ela é
  // quase todo o custo da ficha (queries filtradas no ClickUp, 10s+ no pico)
  // e o card da conversa/modo fast só renderizam o dossiê (a description, que
  // já veio de graça na leitura da task acima).
  const timeline = opts.comTimeline === false ? [] : await buscarLigacoesDoLead(leadTaskId, parsed.telefone);
  return { lead, dossie, timeline };
}

/**
 * Lê a timeline de ligações do lead ligado a uma Ligação (Lista 02) do operador
 * logado — espelho de `lerContextoLead`, IDOR-safe: `validarLigacaoDoOperador`
 * garante que a Ligação é da Lista 02 E do próprio operador (`assigneeIdEsperado`,
 * resolvido de `sess.usuario` via `assigneeDoOperador`), depois resolve o lead
 * (LEAD_REL → fallback telefone) e devolve a timeline. Lead não resolvido → `[]`.
 * LANÇA em infra/autz (WR-03) — o caller mapeia 404/502. Sem log de PII.
 */
export async function lerTimelineDaLigacao(
  taskId: string,
  assigneeIdEsperado: string,
): Promise<ItemTimeline[]> {
  const task = await validarLigacaoDoOperador(taskId, assigneeIdEsperado);
  const leadId = await resolverLeadPelaTask(task);
  if (!leadId) return [];
  const telefone = String(task.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.TELEFONE)?.value ?? '');
  // Rota gated por DONO (path-fila, não-gestor): re-scrubar PII (quick 260815-rev3).
  // Diferente da ficha do gestor (`lerLeadDetalhe`, CRUA), aqui um atendente comum
  // pode consumir a timeline — `resumoAnalise`/`motivoFalha` são texto livre de IA
  // e podem conter CPF/telefone. Mascarar os dois campos antes de devolver.
  const timeline = await buscarLigacoesDoLead(leadId, telefone);
  return timeline.map((item) => ({
    ...item,
    resumoAnalise: scrubPii(item.resumoAnalise),
    motivoFalha: scrubPii(item.motivoFalha),
  }));
}

// Re-exporta os IDs de lista do config para consumo conveniente por quem
// importa so `clickup.ts` (ex: fases 2/3/4, e a Fase 12 pra CLICKUP_LIST_AUDIOS).
export { CLICKUP_LIST_LEADS, CLICKUP_LIST_LIGACOES, CLICKUP_LIST_AUDIOS };
