// src/mastra/classificar-erro.ts
//
// Classificador PURO de erro (Fase 19.1 Plano 01, DUR-01/DUR-02) — decide, de
// forma determinística e sem I/O, se um erro de terceiro (ClickUp/Deepgram/
// storage/Supabase/rede) é TRANSITÓRIO (re-tenta PARA SEMPRE, decisão travada
// do dono da operação) ou PERMANENTE (estaciona com alarme para decisão
// humana). Origem/status desconhecidos NUNCA viram "permanente" por engano —
// o default é sempre conservador (transitório): "nada descartado sem humano".
//
// Módulo PURO: zero import de projeto/bullmq/config — roda isolado via
// `node --experimental-strip-types` (mesmo espírito de senha.ts). Quem
// PARQUEIA de fato (UnrecoverableError no worker) é o consumidor (19.1-04);
// este módulo só CLASSIFICA.

export type TipoErro = 'transitorio' | 'permanente';

export type OrigemErro = 'rede' | 'clickup' | 'deepgram' | 'storage' | 'supabase' | 'desconhecido';

export interface ErroClassificado {
  tipo: TipoErro;
  origem: OrigemErro;
  status?: number;
  /**
   * Rótulo curto LGPD-safe (classe/status/origem) — NUNCA a mensagem crua do
   * erro de entrada (que pode carregar telefone/URL/token). Ver T-19.1-01-I.
   */
  motivo: string;
}

// Marcadores de timeout/rede — checados ANTES de qualquer status HTTP: uma
// falha de rede pode carregar um número de 3 dígitos coincidente no texto
// (ex.: parte de um telefone/host); rede sempre vence nessa disputa.
const MARCADORES_REDE = ['aborterror', 'aborted', 'econnreset', 'etimedout', 'eai_again', 'fetch failed'];

// Marcadores de origem por substring (case-insensitive), checados em ORDEM de
// prioridade — ClickUp primeiro porque os marcadores de degradação conhecidos
// (publicapi-tasks/cluster.local) descrevem infra do ClickUp especificamente.
const MARCADORES_ORIGEM: Array<[OrigemErro, string[]]> = [
  ['clickup', ['clickup', 'publicapi-tasks', 'cluster.local']],
  ['deepgram', ['deepgram']],
  ['storage', ['storage.wavoip', 'storage']],
  ['supabase', ['supabase']],
];

// Status conhecidos — a matriz do <behavior> do plano. 411 é o
// sem-content-length do storage Wavoip (transitório: some com a cópia própria
// da gravação, C4). 5xx é um range aberto, checado à parte via ehStatus5xx.
const STATUS_TRANSITORIO = new Set([429, 408, 411, 425]);
const STATUS_PERMANENTE = new Set([404, 400, 401, 403, 422]);

// Regex tolerante: primeiro token de 3 dígitos começando em 1-5 (classe HTTP
// válida 1xx-5xx), cercado por não-dígito ou borda de string — cobre
// "HTTP 500", "(411)", "429" solto, "(404) task not found" etc. sem exigir
// formato exato de status code.
const STATUS_REGEX = /(?:^|[^0-9])([1-5]\d{2})(?:[^0-9]|$)/;

function derivarMensagem(erro: unknown): string {
  if (erro instanceof Error) {
    return `${erro.message || ''} ${erro.name || ''}`.trim();
  }
  if (typeof erro === 'string') return erro;
  try {
    return String(erro);
  } catch {
    return 'erro nao serializavel';
  }
}

function ehMarcadorDeRede(msgMinuscula: string): boolean {
  return MARCADORES_REDE.some((marcador) => msgMinuscula.includes(marcador));
}

function detectarOrigemPorMarcador(msgMinuscula: string): OrigemErro | null {
  for (const [origem, marcadores] of MARCADORES_ORIGEM) {
    if (marcadores.some((marcador) => msgMinuscula.includes(marcador))) return origem;
  }
  return null;
}

function extrairStatus(msgMinuscula: string): number | undefined {
  const match = msgMinuscula.match(STATUS_REGEX);
  return match ? Number(match[1]) : undefined;
}

function ehStatus5xx(status: number): boolean {
  return status >= 500 && status <= 599;
}

// Marcador da Fase 19.1 Plano 08 (DUR-02/06) — mensagem ESTÁVEL lançada por
// processarRecordJob (processador.ts) quando um RECORD não tem correlação
// resolvível (nem dados.taskId do enqueue, nem Redis, nem ClickUp por
// telefone). Checado ANTES de qualquer status HTTP/marcador de origem: é uma
// decisão de NEGÓCIO (park-para-humano), não uma falha de infra — vence
// mesmo se a mensagem coincidir com algum marcador/status por acaso.
const MARCADOR_SEM_CORRELACAO = 'sem correlacao call';

/**
 * Classifica um erro de terceiro em transitório (re-tenta pra sempre) ou
 * permanente (estaciona com alarme). Aceita `Error` OU `string` (failedReason
 * cru do BullMQ). Ordem de decisão: 0) marcador estável de correlação
 * ausente (Fase 19.1 Plano 08 — permanente sempre), 1) rede/timeout, 2)
 * status HTTP conhecido, 3) marcador de origem (ClickUp) sem status
 * extraível, 4) default conservador — origem/status desconhecidos caem
 * SEMPRE em transitório (decisão travada "nada descartado sem humano").
 */
export function classificarErro(erro: unknown): ErroClassificado {
  const mensagem = derivarMensagem(erro);
  const msg = mensagem.toLowerCase();
  const status = extrairStatus(msg);

  // 0) RECORD sem correlação resolvível (Fase 19.1 Plano 08, DUR-02/06):
  // sempre PERMANENTE — estaciona para decisão humana, nunca re-tenta pra
  // sempre uma correlação que não vai aparecer sozinha.
  if (msg.includes(MARCADOR_SEM_CORRELACAO)) {
    return { tipo: 'permanente', origem: 'desconhecido', status, motivo: 'correlacao-ausente' };
  }

  // 1) rede/timeout sempre vence, mesmo com um 3-dígitos coincidente no texto.
  if (ehMarcadorDeRede(msg)) {
    return { tipo: 'transitorio', origem: 'rede', status, motivo: 'timeout/rede' };
  }

  const origemPorMarcador = detectarOrigemPorMarcador(msg);

  // 2) status HTTP conhecido decide o tipo; origem vem do marcador (se achar).
  if (status !== undefined) {
    if (STATUS_TRANSITORIO.has(status) || ehStatus5xx(status)) {
      return {
        tipo: 'transitorio',
        origem: origemPorMarcador ?? 'desconhecido',
        status,
        motivo: `http ${status} transitorio`,
      };
    }
    if (STATUS_PERMANENTE.has(status)) {
      return {
        tipo: 'permanente',
        origem: origemPorMarcador ?? 'desconhecido',
        status,
        motivo: `http ${status} permanente`,
      };
    }
  }

  // 3) sem status conhecido: degradação do ClickUp ainda classifica transitório
  // via marcador puro (ex.: "cluster.local" sem nenhum 3-dígitos no texto).
  if (origemPorMarcador === 'clickup') {
    return { tipo: 'transitorio', origem: 'clickup', status, motivo: 'degradacao clickup' };
  }

  // 4) default conservador — origem/status desconhecidos NUNCA são
  // descartados sem humano (decisão travada do dono da operação).
  return {
    tipo: 'transitorio',
    origem: origemPorMarcador ?? 'desconhecido',
    status,
    motivo: 'origem/status desconhecido',
  };
}
