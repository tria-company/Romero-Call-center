// Guardas FAIL-CLOSED do backfill inicial do espelho (17-04, RECON-03/R9).
//
// POR QUE EXISTE: o backfill pagina as Listas 02/03/01 COMPLETAS
// (include_closed=true) — é a MESMA varredura que causou o incidente
// 2026-08-20 (endpoint frágil sob listagem grande). Rodar essa varredura de
// novo sem trava é repetir o incidente. Este módulo é o conjunto de guardas
// que decide SE o backfill pode rodar — nunca o próprio I/O de rede/banco
// (isso fica no runner, scripts/backfill-espelho.mjs).
//
// FAIL-CLOSED de verdade (o oposto do rate-limiter fail-open que agravou o
// incidente — 3.2 do design): qualquer dúvida (janela fechada, lock não
// adquirido, página que falhou após o retry) faz o backfill LANÇAR/PARAR —
// nunca "deixa passar" nem grava parcial silencioso.
//
// PURO E TESTÁVEL OFFLINE: nenhuma das duas funções abaixo faz I/O — `agora`,
// `janela` e `lockAdquirido` são injetados pelo caller (o runner é quem lê o
// relógio real e adquire o lock real). `executarBackfillFailClosed` também
// não conhece ClickUp/Supabase: recebe `sync` como função (uma "página" =
// uma unidade de trabalho que o runner define — no runner real, cada alvo
// leads/ligacoes/audios é UMA página, já que `sincronizarEspelho*` do 17-02
// já pagina/pausa/retenta internamente; o "entre páginas" aqui pausa/aborta
// ENTRE ALVOS, dando o teto de page-rate + abort-não-parcial também nesse
// nível). Ver scripts/backfill-espelho.smoke.mjs para os 4 casos provados.

/** Janela de manutenção configurada — hora LOCAL (0-23), sem minutos (granularidade
 *  de hora é suficiente pra uma operação que roda de madrugada por horas). */
export interface JanelaManutencao {
  inicioHora: number;
  fimHora: number;
}

/** PURO. `true` só quando `agora` cai dentro da janela [inicioHora, fimHora).
 *  Suporta janela que cruza a meia-noite (ex.: inicioHora=1, fimHora=5 não cruza;
 *  inicioHora=23, fimHora=5 cruza — aberta às 23h, 0h, ..., 4h59). Fora da janela
 *  (inclusive com config inválida) o backfill NUNCA roda — é o fail-closed no
 *  nível mais simples desta guarda. */
export function janelaDeManutencaoAberta(agora: Date, janela: JanelaManutencao): boolean {
  const { inicioHora, fimHora } = janela;
  if (
    !Number.isInteger(inicioHora) ||
    !Number.isInteger(fimHora) ||
    inicioHora < 0 ||
    inicioHora > 23 ||
    fimHora < 0 ||
    fimHora > 23
  ) {
    return false; // config inválida -> fail-closed, nunca assume janela aberta
  }
  const hora = agora.getHours();
  if (inicioHora === fimHora) return false; // janela de duração zero -> nunca aberta
  if (inicioHora < fimHora) return hora >= inicioHora && hora < fimHora;
  return hora >= inicioHora || hora < fimHora; // janela cruza a meia-noite
}

/** Resultado de UMA "página" (unidade de trabalho) processada por `sync`. */
export interface ResultadoPaginaBackfill {
  /** `true` quando não há mais trabalho a fazer (encerra o laço). */
  ultimaPagina: boolean;
  /** Contagem de registros desta página — só contagem, nunca payload (LGPD). */
  registros: number;
}

export interface DepsBackfillFailClosed {
  /** Processa a página `numeroPagina` (0-based) e devolve o resultado, ou lança em falha
   *  (o caller já deve ter aplicado o retry dele — ver 4x/90s do runner); qualquer erro
   *  que escape daqui ABORTA o backfill inteiro (nunca segue pra próxima página). */
  sync: (numeroPagina: number) => Promise<ResultadoPaginaBackfill>;
  /** Relógio injetado (o runner passa `new Date()`; o smoke passa datas fixas). */
  agora: Date;
  janela: JanelaManutencao;
  /** `true` só quando o runner conseguiu adquirir o lock real de exclusão mútua
   *  (nenhum outro backfill/sync concorrente em curso). */
  lockAdquirido: boolean;
  /** Teto de page-rate DURO: pausa mínima entre páginas, em ms. */
  minIntervaloPaginaMs?: number;
  /** Teto de páginas — proteção extra contra laço infinito por bug de paginação. */
  maxPaginas?: number;
  /** Log de progresso — só contagem/página (LGPD), nunca payload. */
  onPagina?: (pagina: number, registrosAcumulados: number) => void;
}

export interface ResultadoBackfillFailClosed {
  paginas: number;
  registros: number;
}

/**
 * Orquestrador fail-closed do backfill. LANÇA (aborta, nada gravado a mais) quando:
 *  - a janela de manutenção está fechada (`janelaDeManutencaoAberta` false);
 *  - o lock de concorrência não foi adquirido (`lockAdquirido` false);
 *  - uma página falha (o `sync` injetado lança) — mesmo após o retry que o CALLER
 *    já deve ter aplicado a essa página; este orquestrador não segue varrendo nem
 *    tenta "recuperar" silenciosamente.
 * Entre páginas, respeita `minIntervaloPaginaMs` (teto de page-rate duro) antes de
 * seguir pra próxima. Nunca comita/segue parcial: o erro sobe pro caller decidir.
 */
export async function executarBackfillFailClosed(
  deps: DepsBackfillFailClosed,
): Promise<ResultadoBackfillFailClosed> {
  if (!janelaDeManutencaoAberta(deps.agora, deps.janela)) {
    throw new Error(
      'backfill recusado: fora da janela de manutenção (fail-closed — nunca roda fora do horário configurado)',
    );
  }
  if (!deps.lockAdquirido) {
    throw new Error(
      'backfill recusado: lock de concorrência não adquirido (outra operação/backfill em curso — fail-closed, sem concorrência)',
    );
  }

  let pagina = 0;
  let registrosTotal = 0;
  const limite = deps.maxPaginas && deps.maxPaginas > 0 ? deps.maxPaginas : Infinity;

  while (pagina < limite) {
    let resultado: ResultadoPaginaBackfill;
    try {
      resultado = await deps.sync(pagina);
    } catch (e) {
      const motivo = e instanceof Error ? e.message : String(e);
      throw new Error(
        `backfill ABORTADO na página ${pagina} (${registrosTotal} registro(s) já processado(s) antes desta): ${motivo}`,
      );
    }
    pagina += 1;
    registrosTotal += resultado.registros;
    deps.onPagina?.(pagina, registrosTotal);
    if (resultado.ultimaPagina) break;
    if (deps.minIntervaloPaginaMs) {
      await new Promise((resolve) => setTimeout(resolve, deps.minIntervaloPaginaMs));
    }
  }

  return { paginas: pagina, registros: registrosTotal };
}
