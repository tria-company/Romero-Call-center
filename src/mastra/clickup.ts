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
  OPER_STATUS_EM_PROCESSAMENTO,
  OPER_STATUS_FECHADO,
} from './config.ts';
import { fetchTimeout } from './http.ts';
import { mapearFilaLigacao } from './lote.ts';
import type { ItemFila } from './lote.ts';

const CLICKUP_BASE_URL = 'https://api.clickup.com/api/v2';

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

export interface CustomFieldClickUp {
  id: string;
  name?: string;
  value?: unknown;
}

export interface TaskClickUp {
  id: string;
  name: string;
  status?: { status: string } | string;
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
  opts: { page?: number; includeClosed?: boolean; assignees?: string[] } = {},
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
  let res: Response;
  try {
    res = await fetchTimeout(`${CLICKUP_BASE_URL}/list/${listId}/task?${params.toString()}`, {
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

/** Le uma task por ID (com custom_fields). */
export async function lerTask(taskId: string): Promise<TaskClickUp | null> {
  // Token ausente e falha de infra/HTTP LANCAM (WR-03) — `null` fica reservado
  // a caminhos de sucesso, nunca a mascarar erro de rede/HTTP.
  if (!CLICKUP_API_TOKEN) {
    throw new Error('[clickup] CLICKUP_API_TOKEN ausente — nao da para ler task');
  }
  let res: Response;
  try {
    res = await fetchTimeout(`${CLICKUP_BASE_URL}/task/${taskId}`, { headers: headers() });
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
    res = await fetchTimeout(`${CLICKUP_BASE_URL}/list/${listId}/task`, {
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
    res = await fetchTimeout(`${CLICKUP_BASE_URL}/task/${taskId}`, {
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
    res = await fetchTimeout(`${CLICKUP_BASE_URL}/task/${taskId}/field/${fieldId}`, {
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
    res = await fetchTimeout(`${CLICKUP_BASE_URL}/list/${listId}`, { headers: headers() });
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

/**
 * Busca a fila de Ligações (Lista 02) do operador logado (LOTE-04 — o
 * discador substitui o GHL QUALIFICADO por esta fila). Filtra por assignee
 * no SERVIDOR (T-02-03-E — cada operador só vê a própria fila) e só tasks
 * abertas (`include_closed=false`). Erro de infra/HTTP PROPAGA (WR-03/
 * T-02-03-D — o caller/rota decide o 502, nunca mascara como fila vazia).
 */
export async function buscarFilaLigacoes(
  assigneeId: string,
  opts: { page?: number } = {},
): Promise<ItemFila[]> {
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
  return mapearFilaLigacao(abertas, CAMPOS_LIGACOES);
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
 */
export async function lerLigacao(taskId: string, assigneeIdEsperado: string): Promise<DetalheLigacao> {
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
  const [item] = mapearFilaLigacao([task], CAMPOS_LIGACOES);
  const telefone = String(task.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.TELEFONE)?.value ?? '');
  const idLead = String(task.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.ID_LEAD)?.value ?? '');
  return {
    taskId: task.id,
    nome: item?.nome ?? task.name ?? telefone,
    telefone: item?.telefone ?? telefone,
    idLead: item?.idLead ?? idLead,
    script: task.description ?? task.text_content ?? '',
  };
}

/**
 * Registra o início da ligação ao tocar "Ligar" no discador (OPER-01/02,
 * D-P3-01/02/07): grava INICIO + OPERADOR na task IMEDIATAMENTE (sobrevive a
 * restart — a correlação call↔task fica persistida no próprio ClickUp) e
 * move o status nativo para `OPER_STATUS_EM_PROCESSAMENTO`, tirando a task da
 * fila (`buscarFilaLigacoes`) enquanto ela é processada.
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
  // D-P3-02: grava INICIO + OPERADOR imediatamente (custom fields, D-07 — por
  // field_id). Falha de infra LANÇA (WR-03) — o caller decide o 502.
  await setCustomField(taskId, CAMPOS_LIGACOES.INICIO, Date.now());
  await setCustomField(taskId, CAMPOS_LIGACOES.OPERADOR, operadorLabel);
  // D-P3-07: move pro status intermediário nativo, se configurado (ver
  // OPER_STATUS_EM_PROCESSAMENTO em config.ts — vazio até a descoberta rodar).
  if (OPER_STATUS_EM_PROCESSAMENTO) {
    await atualizarTask(taskId, { status: OPER_STATUS_EM_PROCESSAMENTO });
  }
  const telefone = String(task.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.TELEFONE)?.value ?? '');
  return { telefone };
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
    res = await fetchTimeout(`${CLICKUP_BASE_URL}/task/${taskId}/comment`, {
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
  if (patch.duracao !== undefined) {
    await setCustomField(taskId, CAMPOS_LIGACOES.DURACAO, String(patch.duracao));
  }
  if (patch.urlGravacao !== undefined) {
    await setCustomField(taskId, CAMPOS_LIGACOES.URL_GRAVACAO, patch.urlGravacao);
  }
}

/** Compara dois telefones ignorando formatação (só dígitos). */
function telefonesIguais(a: unknown, b: string): boolean {
  if (a === undefined || a === null) return false;
  return String(a).replace(/\D/g, '') === b.replace(/\D/g, '');
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
 */
export async function criarLigacaoAvulsa(telefone: string): Promise<{ id: string }> {
  // O campo TELEFONE é tipo "phone" -> exige E.164 ('+'); o telefone cru do
  // Wavoip não tem '+' e causava 400. Se não normalizar, melhor criar a
  // avulsa SEM o campo (o `name` já carrega o número cru) do que perder o
  // registro da gravação em um 400 (D-P3-03).
  const e164 = normalizarTelefoneE164(telefone);
  const novaTask = await criarTask(CLICKUP_LIST_LIGACOES, {
    name: `Ligação avulsa — ${telefone}`,
    ...(e164 !== null ? { custom_fields: [{ id: CAMPOS_LIGACOES.TELEFONE, value: e164 }] } : {}),
  });
  if (!novaTask?.id) {
    throw new Error('[clickup] criarLigacaoAvulsa: criarTask retornou sem id');
  }
  if (e164 === null) {
    // LGPD: nunca logar o telefone completo — só os últimos 4 dígitos.
    const digitos = telefone.replace(/\D/g, '');
    const mascarado = digitos.length > 4 ? `${'*'.repeat(digitos.length - 4)}${digitos.slice(-4)}` : digitos;
    console.warn(
      `[clickup] Ligação avulsa (${novaTask.id}) criada SEM o campo TELEFONE — telefone não normalizável p/ E.164 (${mascarado})`,
    );
  }

  try {
    const { tasks: leads } = await listarTasks(CLICKUP_LIST_LEADS);
    const leadMatch = leads.find((t) =>
      telefonesIguais(t.custom_fields?.find((c) => c.id === CAMPOS_LEADS.TELEFONE)?.value, telefone),
    );
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
export async function resolverLeadDaLigacao(taskLigacaoId: string): Promise<string | null> {
  const task = await lerTask(taskLigacaoId);
  if (!task) return null;

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

// Re-exporta os IDs de lista do config para consumo conveniente por quem
// importa so `clickup.ts` (ex: fases 2/3/4).
export { CLICKUP_LIST_LEADS, CLICKUP_LIST_LIGACOES };
