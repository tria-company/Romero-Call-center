// Scheduler dos toques temporizados de lembrete de call (FUN-02 toques 2/3/4:
// D-1, H-1, 5min antes). O toque 1 (confirmacao imediata) e disparado por
// tools/schedule-reminder.ts no momento do agendamento (Task 1 deste plano).
//
// Comportamento:
//   - A cada 60s, varre auton_sdr_call_reminders onde status='agendada'
//     (migration 07_call_reminders.sql).
//   - Pra cada row, calcula qual toque (d1/h1/m5) e devido AGORA com base em
//     call_start_at e nos flags *_sent_at ja enviados (proximoLembreteDevido,
//     funcao pura — prova por scripts/smoke-lembretes.mjs).
//   - ANTES de enviar, relê a sessao do lead — se estiver em atendimento
//     humano ('humano'), com conversa aberta 'aguardando_humano' (sinal
//     DURAVEL, CR-05) ou bloqueado (crise/pausa), PULA o toque (T-02-02,
//     compliance: lead em crise nao recebe lembrete automatico).
//   - Envia o toque (mensagem TEMPLADA, deterministica — sem LLM) e SO marca
//     o flag *_sent_at correspondente quando o envio foi CONFIRMADO pelo GHL
//     (CR-03 — sem confirmacao, retenta na proxima varredura; o gate
//     anti-reenvio so vale pra toque de fato entregue).
//   - NAO reseta call_start_at nem o "relogio" (mesma nota de follow-up.ts) —
//     quem reseta os flags e um reschedule via upsertLembreteCall.
//
// status permanece 'agendada' apos o toque de 5min — a call comecou e a
// responsabilidade passa pro loop de no-show (plano 02-02), que transiciona
// o status pra 'realizada' (lead respondeu depois da call) ou 'no_show'
// (terminal) — CR-06: rows encerradas saem das varreduras.

import type { Mastra } from '@mastra/core/mastra';
import { buscarLembretesPendentes, marcarLembreteEnviado } from './supabase';
import { enviarMensagem } from './ghl';
import { formatarDataHoraPtBr } from './tools/schedule-reminder';
// leadEmPausaDuravel (CR-05): guarda de crise DURAVEL compartilhada — vive em
// no-show.ts pra nao criar ciclo novo (lembretes ja importa processarNoShows
// de la; a volta no-show -> lembretes nao existe).
import { processarNoShows, leadEmPausaDuravel } from './no-show';
// GRAV-03 (plano 03-02): resgate durável de 48h pra leads com sinal de
// desistencia sem fechamento — mesmo tick deste scheduler (ver
// iniciarLembretesScheduler abaixo).
import { processarResgates } from './resgates';

const INTERVALO_SCAN_LEMBRETES = 60 * 1000; // 60s — granularidade fina o suficiente pro toque de 5min

// Tipo em interface SEPARADA (nao inline) pro smoke script conseguir extrair
// o CORPO REAL de `proximoLembreteDevido` via regex sem colidir com chaves
// da anotacao de tipo — mesmo padrao de EscolhaCloser (tools/create-calendar-event.ts)
// e PrioridadeResultado (tools/create-task.ts).
export interface TocantesEnviados {
  d1: boolean;
  h1: boolean;
  m5: boolean;
}

/**
 * FUN-02 (toques 2/3/4) — funcao PURA que decide qual toque temporizado esta
 * devido AGORA. Regra: D1 = callStart-24h, H1 = callStart-1h, M5 = callStart-5min.
 * Um toque e devido quando `nowMs` ja passou do ponto de disparo E a call
 * ainda nao comecou (`nowMs < callStartMs` — depois disso vira assunto do
 * loop de no-show, plano 02-02) E o toque ainda nao foi marcado como enviado.
 * Retorna o MAIS URGENTE devido/nao-enviado (m5 > h1 > d1) — se a row foi
 * criada tarde e varios pontos ja passaram, dispara so o mais proximo (evita
 * toque stale/spam). `NaN` em qualquer lado -> null.
 *
 * Sem I/O, sem dependencia de modulo — prova por scripts/smoke-lembretes.mjs
 * (extrai o CORPO via regex e roda via `new Function`, mesmo padrao de
 * `slotContemHorario`/`escolherCloser`/scripts/smoke-starttime-validacao.mjs).
 */
export function proximoLembreteDevido(
  callStartMs: number,
  nowMs: number,
  sent: TocantesEnviados,
): 'd1' | 'h1' | 'm5' | null {
  if (Number.isNaN(callStartMs) || Number.isNaN(nowMs)) return null;
  if (nowMs >= callStartMs) return null; // call ja comecou — loop de no-show (02-02)

  // Constantes inline (nao referencia const de modulo, ex: D1_MS) — o smoke
  // script (scripts/smoke-lembretes.mjs) extrai o CORPO desta funcao via
  // regex e executa via `new Function`, que nao teria acesso ao escopo do
  // modulo. Mesma restricao documentada em smoke-starttime-validacao.mjs.
  const pontoM5 = callStartMs - 5 * 60 * 1000;
  const pontoH1 = callStartMs - 60 * 60 * 1000;
  const pontoD1 = callStartMs - 24 * 60 * 60 * 1000;

  if (nowMs >= pontoM5 && !sent.m5) return 'm5';
  if (nowMs >= pontoH1 && !sent.h1) return 'h1';
  if (nowMs >= pontoD1 && !sent.d1) return 'd1';
  return null;
}

/**
 * WR-05 — funcao PURA que classifica o dia da call em relacao a AGORA no
 * fuso America/Sao_Paulo: 'hoje' | 'amanha' | 'outro'. Usada pra escolher o
 * texto do toque D-1 a partir de DADOS (nao do offset nominal de 24h — uma
 * call marcada pra daqui a 8h dispara o d1 no mesmo dia, e dizer "amanhã"
 * estaria errado). Sem dependencia de modulo — prova comportamental em
 * scripts/smoke-lembretes.mjs (extraida via regex + `new Function`).
 */
export function diaRelativoSaoPaulo(callStartMs: number, nowMs: number): 'hoje' | 'amanha' | 'outro' {
  // Corpo SEM anotacoes de tipo — o smoke extrai o CORPO via regex e roda em
  // `new Function` (JS puro), mesma restricao de proximoLembreteDevido.
  const opcoesDia = { timeZone: 'America/Sao_Paulo' };
  const diaCall = new Date(callStartMs).toLocaleDateString('pt-BR', opcoesDia);
  if (diaCall === new Date(nowMs).toLocaleDateString('pt-BR', opcoesDia)) return 'hoje';
  if (diaCall === new Date(nowMs + 24 * 60 * 60 * 1000).toLocaleDateString('pt-BR', opcoesDia)) return 'amanha';
  return 'outro';
}

/**
 * WR-05: os textos derivam do TEMPO REAL restante (callStartMs vs nowMs), nao
 * do offset nominal do toque — o d1 pode disparar pra call de HOJE (call
 * criada com <24h de antecedencia) e o h1 pode disparar a 20min da call
 * (apos downtime do scheduler). "amanhã"/"daqui a 1h" so quando for verdade.
 */
function mensagemToque(
  campo: 'd1' | 'h1' | 'm5',
  nome: string | undefined,
  dataHoraFmt: string,
  callStartMs: number,
  nowMs: number,
): string {
  const quemNome = nome ? `${nome}, ` : '';
  if (campo === 'd1') {
    const dia = diaRelativoSaoPaulo(callStartMs, nowMs);
    const quando = dia === 'hoje' ? 'é hoje' : dia === 'amanha' ? 'é amanhã' : 'é';
    return `${quemNome}lembrete: sua call ${quando}, ${dataHoraFmt} (horário de Brasília). Confirma presença por aqui?`;
  }
  if (campo === 'h1') {
    const minRestantes = Math.max(1, Math.round((callStartMs - nowMs) / (60 * 1000)));
    const emQuanto = minRestantes >= 55 ? 'daqui a 1h' : `daqui a ${minRestantes}min`;
    return `${quemNome}sua call é ${emQuanto}, ${dataHoraFmt} (horário de Brasília). Já vai deixando tudo pronto por aí.`;
  }
  return `${quemNome}sua call começa em 5 minutos! Entra na sala combinada — te espero por lá.`;
}

/**
 * Tick do scheduler: varre os lembretes pendentes, calcula o toque devido de
 * cada um e envia (respeitando a pausa de compliance/crise). `mastra` fica no
 * parametro por paridade com processarFollowUps(mastra) — os toques hoje sao
 * 100% determinísticos (sem LLM), mas mantem a assinatura extensivel.
 */
export async function processarLembretes(mastra: Mastra): Promise<void> {
  void mastra;
  const pendentes = await buscarLembretesPendentes();
  if (pendentes.length === 0) return;

  const agora = Date.now();

  for (const row of pendentes) {
    const callStartMs = new Date(row.call_start_at).getTime();
    const campo = proximoLembreteDevido(callStartMs, agora, {
      d1: Boolean(row.d1_sent_at),
      h1: Boolean(row.h1_sent_at),
      m5: Boolean(row.m5_sent_at),
    });
    if (!campo) continue;

    const telefone = row.telefone;
    if (!telefone) {
      console.warn(`[lembretes] row ${row.id} sem telefone, pulando`);
      continue;
    }

    try {
      // T-02-02 + CR-05: lead em atendimento humano (sessao OU conversa
      // aberta 'aguardando_humano' — sinal duravel) ou bloqueado (crise/
      // pausa) NAO recebe lembrete automatico — checagem SEMPRE antes de
      // qualquer envio.
      const { emAtendimentoHumano, bloqueado } = await leadEmPausaDuravel(telefone, row.customer_id);
      if (emAtendimentoHumano || bloqueado) {
        console.log(`[lembretes] ${telefone}: pulando toque ${campo} (humano=${emAtendimentoHumano}, bloqueado=${bloqueado})`);
        continue;
      }

      // CR-03: so marca *_sent_at quando o envio foi CONFIRMADO (GHL aceitou
      // o POST). Sem confirmacao, NAO marca — a proxima varredura retenta.
      const dataHoraFmt = formatarDataHoraPtBr(row.call_start_at);
      const entregue = await enviarMensagem(telefone, mensagemToque(campo, row.nome, dataHoraFmt, callStartMs, agora));
      if (!entregue) {
        console.error(`[lembretes] ${telefone}: toque ${campo} NAO entregue (envio sem confirmacao) — retry na proxima varredura (lembrete ${row.id})`);
        continue;
      }

      const campoDb = `${campo}_sent_at` as 'd1_sent_at' | 'h1_sent_at' | 'm5_sent_at';
      const marcado = await marcarLembreteEnviado(row.id, campoDb);
      if (!marcado) {
        // WR-01: toque entregue mas gate nao persistiu — a proxima varredura
        // REENVIARIA. Log alto pra investigacao (o helper ja logou o HTTP).
        console.error(`[lembretes] ${telefone}: toque ${campo} entregue mas ${campoDb} NAO persistiu — risco de reenvio no proximo tick (lembrete ${row.id})`);
        continue;
      }
      console.log(`[lembretes] ${telefone}: toque ${campo} enviado (lembrete ${row.id})`);
    } catch (e) {
      console.error(`[lembretes] erro processando toque ${campo} pra ${telefone} (lembrete ${row.id}):`, e);
    }
  }
}

export function iniciarLembretesScheduler(mastra: Mastra): void {
  // CR-04: mutex de reentrancia — um tick pode levar minutos (recuperacao de
  // no-show roda Camila com retry 3x60s + delays de humanizacao por
  // mensagem), e um setInterval de 60s SEM guarda dispararia ticks
  // sobrepostos lendo estado ainda nao persistido (recuperacoes/toques
  // duplicados pro lead). Um tick novo so comeca quando o anterior terminou.
  let tickEmExecucao = false;
  setInterval(async () => {
    if (tickEmExecucao) return;
    tickEmExecucao = true;
    try {
      await processarLembretes(mastra).catch((e) =>
        console.error('[lembretes] Erro na varredura:', e),
      );
      // FUN-03/FUN-04 (plano 02-02): mesmo tick varre o loop de no-show —
      // reaproveita o scheduler ja existente (mesma granularidade de 60s e
      // suficiente pro gatilho de 15min) em vez de criar um setInterval
      // paralelo. processarNoShows decide a transicao de status daqui pra
      // frente (realizada/no_show/PERDIDO), sem tocar nos 4 toques acima.
      await processarNoShows(mastra).catch((e) =>
        console.error('[no-show] Erro na varredura:', e),
      );
      // GRAV-03 (plano 03-02): mesmo tick varre os resgates de 48h — reusa
      // o scheduler ja existente (granularidade de 60s e suficiente pro
      // gatilho de 48h) em vez de criar um setInterval paralelo.
      await processarResgates(mastra).catch((e) =>
        console.error('[resgates] Erro na varredura:', e),
      );
    } finally {
      tickEmExecucao = false;
    }
  }, INTERVALO_SCAN_LEMBRETES);

  console.log(
    `[lembretes] Scheduler de lembretes de call ativo (scan a cada ${INTERVALO_SCAN_LEMBRETES / 1000}s)`,
  );
}
