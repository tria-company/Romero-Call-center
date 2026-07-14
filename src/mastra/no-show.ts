// Loop de no-show (FUN-03/FUN-04) do SDR AUTON.
//
// Decisao de design (Claude's Discretion, sem CONTEXT.md nesta fase):
// "no-show" e definido como 15min apos o call_start_at SEM MENSAGEM do lead
// no WhatsApp (proxy) — este canal nao tem sinal real de presenca na call do
// Google Meet (fora do alcance do agente). Risco aceito (T-02-10): um falso
// no-show e recuperavel sem custo alto — a 1a recuperacao reengaja com tom
// LEVE, entao se o lead na verdade compareceu e so nao escreveu no WhatsApp,
// a pior consequencia e uma mensagem de checagem desnecessaria.
//
// Maquina de estados (decidirNoShow, PURA — sem I/O, sem dependencia de
// modulo, prova em scripts/smoke-no-show.mjs):
//   terminal===true                  -> 'nada' (loop encerrado, nunca reabre)
//   leadRespondeuAposCall===true     -> 'nada' (lead engajou, nao e no-show)
//   tentativas>=1 && silencio >= 48h desde ultima_recuperacao -> 'perdido_48h'
//   call passou do ponto de no-show (nowMs >= callStart + 15min) e o lead
//   nao respondeu:
//     tentativas===0 -> 'recuperar' (1o no-show: Camila natural + task)
//     tentativas>=1  -> 'perdido_2o_noshow' (2o no-show: teto de 2 atingido)
//   caso contrario (ainda dentro dos 15min, ou sem gatilho) -> 'nada'
//   NaN em callStart/now -> 'nada' (fail-safe — nunca move card por engano)
//
// dispararRecuperacaoNoShow (acao real do 1o no-show: move NO_SHOW + Camila
// natural + task pro SDR humano) e processarNoShows (tick do loop, chamado
// pelo MESMO scheduler de lembretes.ts) ficam neste arquivo tambem — prova
// comportamental/de fonte em scripts/smoke-no-show.mjs.

import type { Mastra } from '@mastra/core/mastra';
import {
  buscarCallsParaNoShow,
  registrarNoShowRecuperacao,
  marcarCallTerminal,
  marcarCallRealizada,
  buscarUltimaMsgLeadDoCustomer,
  buscarCustomerPorTelefone,
  buscarConversaAguardandoHumano,
} from './supabase';
import { getSessao } from './sessao';
import { estaBloqueado } from './bloqueio';
import { movePipelineStage } from './tools/move-pipeline-stage';
import { createTask } from './tools/create-task';
import { camilaAgent } from './agents/camila';

// Import circular DELIBERADO de ./index — mesmo padrao/justificativa de
// dupla-acao.ts: despacharSaidaCamila/comTimeout/comRetry/TIMEOUT_AGENTE sao
// function declarations/consts acessados so em CALL-TIME (dentro do corpo de
// funcoes async), nunca no top-level deste modulo — o bundler da
// mastra/esbuild resolve o ciclo normalmente.
import {
  despacharSaidaCamila,
  comTimeout,
  comRetry,
  TIMEOUT_AGENTE,
  MAX_TENTATIVAS as MAX_TENTATIVAS_GERAIS,
} from './index';

// Constantes do loop (documentacao/uso externo). O CORPO de `decidirNoShow`
// abaixo NAO referencia estas constantes diretamente — usa os valores em ms
// INLINE, porque scripts/smoke-no-show.mjs extrai o corpo real da funcao via
// regex e executa via `new Function`, que nao tem acesso ao escopo do modulo
// (mesma restricao/solucao documentada em lembretes.ts#proximoLembreteDevido).
export const ATRASO_NO_SHOW_MS = 15 * 60 * 1000;
export const TIMEOUT_SILENCIO_MS = 48 * 60 * 60 * 1000;
export const TETO_NO_SHOWS = 2; // total de no-shows permitidos antes de Perdido

export type AcaoNoShow = 'nada' | 'recuperar' | 'perdido_2o_noshow' | 'perdido_48h';

// Tipos em interfaces SEPARADAS (nao inline) pro smoke extrair o CORPO de
// decidirNoShow via regex sem colidir com chaves da anotacao de tipo — mesmo
// padrao de TocantesEnviados (lembretes.ts) / EscolhaCloser (create-calendar-event.ts).
export interface DecidirNoShowArgs {
  callStartMs: number;
  nowMs: number;
  leadRespondeuAposCall: boolean;
  tentativas: number;
  ultimaRecuperacaoMs: number | null;
  terminal: boolean;
}

export interface DecisaoNoShow {
  acao: AcaoNoShow;
  motivo?: string;
}

/**
 * FUN-03/FUN-04 — funcao PURA (sem I/O) que decide a proxima acao do loop de
 * no-show. Ver comentario de topo do arquivo pra regra completa. Prova por
 * scripts/smoke-no-show.mjs (extrai o CORPO via regex e roda via
 * `new Function`, mesmo padrao de proximoLembreteDevido/slotContemHorario).
 */
export function decidirNoShow(args: DecidirNoShowArgs): DecisaoNoShow {
  const { callStartMs, nowMs, leadRespondeuAposCall, tentativas, ultimaRecuperacaoMs, terminal } = args;

  if (Number.isNaN(callStartMs) || Number.isNaN(nowMs)) return { acao: 'nada' };
  if (terminal) return { acao: 'nada' };
  if (leadRespondeuAposCall) return { acao: 'nada' };

  // Constantes inline (nao referencia ATRASO_NO_SHOW_MS/TIMEOUT_SILENCIO_MS
  // de modulo) — ver nota no topo do arquivo.
  const atrasoNoShowMs = 15 * 60 * 1000;
  const timeoutSilencioMs = 48 * 60 * 60 * 1000;

  // Ja houve pelo menos 1 recuperacao. Se ela aconteceu DEPOIS (ou no mesmo
  // instante) do inicio DESTA call, ainda estamos esperando a resposta da
  // recuperacao pra ESTA MESMA call — o relogio que vale aqui e o de 48h de
  // silencio (nao o de 15min, que ja passou faz tempo desde a deteccao do
  // 1o no-show). Se a ultima recuperacao aconteceu ANTES do inicio desta
  // call, esta call e uma NOVA (reagendada apos a recuperacao) — cai pro
  // caminho normal de 15min abaixo, que decide o 2o no-show.
  if (
    tentativas >= 1 &&
    ultimaRecuperacaoMs !== null &&
    !Number.isNaN(ultimaRecuperacaoMs) &&
    ultimaRecuperacaoMs >= callStartMs
  ) {
    if (nowMs - ultimaRecuperacaoMs >= timeoutSilencioMs) {
      return { acao: 'perdido_48h', motivo: '48h sem resposta' };
    }
    return { acao: 'nada' };
  }

  if (nowMs >= callStartMs + atrasoNoShowMs) {
    if (tentativas === 0) return { acao: 'recuperar' };
    return { acao: 'perdido_2o_noshow', motivo: '2º no-show' };
  }

  return { acao: 'nada' };
}

// ==================== Guarda de crise duravel (CR-05) ====================

/**
 * CR-05: guarda de crise DURAVEL, compartilhada por lembretes.ts e por este
 * loop (vive aqui pra nao criar ciclo novo de import — lembretes ja importa
 * deste modulo). getSessao so reconstroi sessao de conversa com
 * data_ultima_mensagem < 24h (buscarConversaAtiva) e estaBloqueado depende
 * de bloqueado_ate (<= 3 dias): um lead escalado pra humano que silencia
 * >24h "some" das duas checagens apos restart (cold cache) — e as janelas de
 * lembrete/no-show sao inerentemente multi-dia (D-1, 48h). Por isso consulta
 * TAMBEM a conversa aberta 'aguardando_humano' SEM janela de tempo (mesmo
 * padrao do guard do webhook do formulario em index.ts, WR-01 3a rodada): a
 * pausa vale ate um humano encerrar/desbloquear, nao ate o relogio girar.
 * Retorna tambem o customerId resolvido (row.customer_id ou lookup por
 * telefone) pro caller reutilizar sem round-trip extra.
 */
export async function leadEmPausaDuravel(
  telefone: string,
  customerIdRow: string | null | undefined,
): Promise<{ emAtendimentoHumano: boolean; bloqueado: boolean; customerId: string | null }> {
  const sessao = await getSessao(telefone);
  let emAtendimentoHumano = sessao?.agenteAtual === 'humano';

  let customerId: string | null = customerIdRow || null;
  if (!customerId) {
    try {
      const customer = await buscarCustomerPorTelefone(telefone);
      customerId = customer?.id || null;
    } catch {
      customerId = null;
    }
  }
  if (!emAtendimentoHumano && customerId) {
    emAtendimentoHumano = !!(await buscarConversaAguardandoHumano(customerId));
  }

  const bloqueado = await estaBloqueado(telefone);
  return { emAtendimentoHumano, bloqueado, customerId };
}

// ==================== Acoes reais do loop ====================

/**
 * Acao real do 1o no-show (chamado quando decidirNoShow retorna 'recuperar'):
 * (a) move o card pra NO_SHOW; (b) gera uma mensagem NATURAL de recuperacao
 * via Camila (escalada pela tentativa — tom leve na 1a, mais direto se for a
 * ultima antes de virar Perdido); (c) cria task pro SDR humano acompanhar.
 * Retorno HONESTO {moveOk, taskOk, camilaOk} — captura o resultado real de
 * cada canal (nenhuma das tools reusadas lanca excecao, elas retornam
 * {sucesso:false} em falha). Falha total loga [no-show][SEM-SINAL] (mesmo
 * padrao de escalate-to-human.ts#acionarHumanoGarantido, T-02-07).
 */
export async function dispararRecuperacaoNoShow(
  mastra: Mastra,
  linha: any,
  tentativa: number,
): Promise<{ moveOk: boolean; taskOk: boolean; camilaOk: boolean }> {
  void mastra;
  const telefone: string = linha?.telefone;
  const nome: string | undefined = linha?.nome;

  // (a) Move o card pra NO_SHOW.
  let moveOk = false;
  try {
    const r = (await movePipelineStage.execute!({ telefone, stage: 'NO_SHOW' } as any, {} as any)) as { sucesso: boolean };
    moveOk = !!r?.sucesso;
    if (!moveOk) {
      console.error(`[no-show] falha ao mover ${telefone} pra NO_SHOW (tentativa ${tentativa})`);
    }
  } catch (e) {
    console.error(`[no-show] erro ao mover ${telefone} pra NO_SHOW:`, e);
  }

  // (b) Recuperacao NATURAL da Camila — semeia um prompt (molde de
  // dupla-acao.ts#dispararAberturaProativaCamila) descrevendo o no-show,
  // escalando levemente o tom pela tentativa. Compliance clinico (CLAUDE.md):
  // NUNCA promete cura/opiniao clinica — reforcado explicitamente no prompt.
  let camilaOk = false;
  try {
    const seedPrompt = [
      `[telefone: ${telefone}] O lead FALTOU a call comercial agendada (tentativa ${tentativa} de ${TETO_NO_SHOWS}).`,
      `Nome do lead: ${nome || '(nao identificado)'}`,
      tentativa >= TETO_NO_SHOWS
        ? 'Este e o ULTIMO reengajamento antes do lead virar Perdido — seja direta, mas ainda assim gentil e natural.'
        : 'Reengaje com tom NATURAL e leve, sem soar como cobranca robotica; pergunte o que aconteceu e ofereca reagendar.',
      'NUNCA prometa cura, resultado clinico ou de negocio, nem de opiniao clinica (Safety Envelope). Responda no formato JSON estrito do Output Schema, com acao="responder".',
    ].join('\n');

    const resposta = await comRetry(
      () => comTimeout(
        camilaAgent.generate(seedPrompt, {
          memory: { thread: telefone, resource: telefone },
          threadId: telefone,
          resourceId: telefone,
        } as any),
        TIMEOUT_AGENTE,
        'camila-recuperacao-no-show',
      ),
      MAX_TENTATIVAS_GERAIS,
      'camila-recuperacao-no-show',
    );
    camilaOk = await despacharSaidaCamila(telefone, resposta.text || '');
  } catch (e) {
    console.error(`[no-show] erro na recuperacao natural da Camila para ${telefone}:`, e);
  }

  // (c) Task pro SDR humano acompanhar a recuperacao.
  let taskOk = false;
  try {
    const titulo = `Recuperar no-show (tentativa ${tentativa})`;
    const corpo = [
      `Lead faltou a call comercial agendada (tentativa ${tentativa} de ${TETO_NO_SHOWS}).`,
      'A Camila ja disparou uma mensagem natural de reengajamento no WhatsApp.',
      'Se nao houver resposta, o lead vira Perdido automaticamente (2o no-show ou 48h de silencio).',
    ].join('\n');
    // BANT sintetico alto (Filtro 3) — recuperar um no-show e, por definicao,
    // prioridade alta pro SDR humano (mesmo padrao de bantTotal:12 usado por
    // acionarHumanoGarantido em escalate-to-human.ts).
    const r = (await createTask.execute!({ telefone, titulo, corpo, bantTotal: 10 } as any, {} as any)) as { sucesso: boolean };
    taskOk = !!r?.sucesso;
  } catch (e) {
    console.error(`[no-show] erro ao criar task de recuperacao para ${telefone}:`, e);
  }

  if (!moveOk && !taskOk && !camilaOk) {
    console.error(`[no-show][SEM-SINAL] ${telefone}: recuperacao de no-show falhou em TODOS os canais (move, task, Camila) — investigar manualmente.`);
  }

  return { moveOk, taskOk, camilaOk };
}

// CR-02 (retry cap): backoff in-memory por row — quando a recuperacao NAO e
// confirmada (camilaOk=false) ou o registro no banco falha, a row NAO ganha
// ultima_recuperacao_em e continuaria elegivel A CADA tick de 60s. Sem
// backoff, uma Camila permanentemente quebrada re-dispararia move + task +
// generate a cada minuto (tasks duplicadas pro SDR, custo de LLM). O mapa
// segura a proxima tentativa por 15min; e limpo no sucesso e morre com o
// processo (restart recomeça limpo — comportamento aceitavel: no pior caso
// uma tentativa extra apos restart).
const RETRY_BACKOFF_RECUPERACAO_MS = 15 * 60 * 1000;
const proximaTentativaRecuperacao = new Map<string, number>();

/**
 * Tick do loop de no-show: varre as calls elegiveis (buscarCallsParaNoShow),
 * decide a acao de cada uma (decidirNoShow) e despacha. Chamado pelo MESMO
 * scheduler de lembretes.ts (iniciarLembretesScheduler) — reaproveita a
 * varredura periodica ja existente em vez de criar um setInterval paralelo
 * (e herda o mutex de reentrancia de la, CR-04).
 */
export async function processarNoShows(mastra: Mastra): Promise<void> {
  const pendentes = await buscarCallsParaNoShow();
  if (pendentes.length === 0) return;

  const agora = Date.now();

  for (const row of pendentes) {
    const telefone = row.telefone;
    if (!telefone) {
      console.warn(`[no-show] row ${row.id} sem telefone, pulando`);
      continue;
    }

    try {
      // T-02-06 + CR-05: lead em atendimento humano (sessao OU conversa
      // aberta 'aguardando_humano' — sinal duravel que sobrevive a restart e
      // a >24h de silencio) ou bloqueado (crise/pausa) NAO e recuperado nem
      // movido — checagem SEMPRE antes de qualquer move/mensagem (nao reabre
      // crise, mesma guarda de lembretes.ts).
      const { emAtendimentoHumano, bloqueado, customerId } = await leadEmPausaDuravel(telefone, row.customer_id);
      if (emAtendimentoHumano || bloqueado) {
        console.log(`[no-show] ${telefone}: pulando (humano=${emAtendimentoHumano}, bloqueado=${bloqueado})`);
        continue;
      }

      const callStartMs = new Date(row.call_start_at).getTime();

      // WR-02: o sinal "lead respondeu depois da call" vem do CUSTOMER (max
      // last_lead_message_at entre todas as conversas dele), NAO so da
      // conversa congelada em row.conversation_id — um lead que respondeu ao
      // toque D-1 dias depois do agendamento cria conversa NOVA e seria
      // falso-no-show olhando so a antiga. O embed fica como fallback (ex:
      // customer nao resolvido).
      let ultimaMsgLead: string | null = null;
      if (customerId) {
        ultimaMsgLead = await buscarUltimaMsgLeadDoCustomer(customerId);
      }
      if (!ultimaMsgLead) {
        ultimaMsgLead = row.auton_sdr_conversations?.last_lead_message_at || null;
      }
      const leadRespondeuAposCall = ultimaMsgLead
        ? new Date(ultimaMsgLead).getTime() > callStartMs
        : false;
      const ultimaRecuperacaoMs = row.ultima_recuperacao_em
        ? new Date(row.ultima_recuperacao_em).getTime()
        : null;

      // CR-06: lead engajou DEPOIS do inicio da call e a janela de decisao
      // de no-show (15min) ja passou -> fecha a row como 'realizada' (proxy
      // de comparecimento/engajamento). Sem isso a row ficava zumbi com
      // status='agendada' pra sempre, re-escaneada a cada 60s e entupindo a
      // janela de 200 rows ate as varreduras morrerem em silencio.
      if (leadRespondeuAposCall && agora >= callStartMs + ATRASO_NO_SHOW_MS) {
        const fechou = await marcarCallRealizada(row.id);
        if (fechou) {
          console.log(`[no-show] ${telefone}: lead respondeu apos a call — row ${row.id} fechada como 'realizada'`);
        }
        continue;
      }

      const decisao = decidirNoShow({
        callStartMs,
        nowMs: agora,
        leadRespondeuAposCall,
        tentativas: row.no_show_tentativas || 0,
        ultimaRecuperacaoMs,
        terminal: !!row.terminal,
      });

      if (decisao.acao === 'recuperar') {
        // CR-02 (retry cap): respeita o backoff de tentativa falhada anterior.
        const proximaEm = proximaTentativaRecuperacao.get(row.id) || 0;
        if (agora < proximaEm) {
          continue;
        }

        const novaTentativa = (row.no_show_tentativas || 0) + 1;
        const resultado = await dispararRecuperacaoNoShow(mastra, row, novaTentativa);

        // CR-02: so registra a tentativa (e inicia o relogio de 48h de
        // silencio) quando o canal VISIVEL AO LEAD confirmou — camilaOk e a
        // mensagem de recuperacao no WhatsApp. Registrar com falha total
        // queimaria a unica recuperacao permitida e mediria "48h de
        // silencio" contra uma mensagem que nunca chegou (lead viraria
        // PERDIDO sem nunca ter sido contatado).
        if (resultado.camilaOk) {
          const registrado = await registrarNoShowRecuperacao(row.id, novaTentativa, new Date(agora).toISOString());
          if (registrado) {
            proximaTentativaRecuperacao.delete(row.id);
            console.log(`[no-show] ${telefone}: recuperacao disparada (tentativa ${novaTentativa})`);
          } else {
            // WR-01: mensagem entregue mas estado nao persistiu — sem
            // backoff a recuperacao INTEIRA re-dispararia no proximo tick.
            proximaTentativaRecuperacao.set(row.id, agora + RETRY_BACKOFF_RECUPERACAO_MS);
            console.error(`[no-show] ${telefone}: recuperacao entregue mas registrarNoShowRecuperacao FALHOU — backoff de ${RETRY_BACKOFF_RECUPERACAO_MS / 60000}min antes de retentar (row ${row.id})`);
          }
        } else {
          proximaTentativaRecuperacao.set(row.id, agora + RETRY_BACKOFF_RECUPERACAO_MS);
          console.error(`[no-show] ${telefone}: recuperacao NAO confirmada (camilaOk=false; moveOk=${resultado.moveOk}, taskOk=${resultado.taskOk}) — tentativa NAO registrada, retry em ${RETRY_BACKOFF_RECUPERACAO_MS / 60000}min`);
        }
        continue;
      }

      if (decisao.acao === 'perdido_2o_noshow' || decisao.acao === 'perdido_48h') {
        // T-02-07: so marca terminal se o move pra PERDIDO for CONFIRMADO —
        // nao trava o loop, mas tambem nao mente que o CRM refletiu o
        // encerramento sem confirmacao real (retenta na proxima varredura).
        const moveResult = (await movePipelineStage.execute!({ telefone, stage: 'PERDIDO' } as any, {} as any)) as { sucesso: boolean };
        if (moveResult?.sucesso) {
          // WR-03: o gatilho e um PROXY fraco (15min sem mensagem no
          // WhatsApp) e este encerramento e IRREVERSIVEL (terminal=true) e
          // silencioso pro lead — um lead que COMPARECEU a call reagendada
          // mas nao digitou nada seria descartado sem ninguem saber. Task
          // pro SDR humano validar o Perdido antes de descartar de verdade.
          try {
            const tituloValidacao = 'Validar Perdido automatico (no-show)';
            const corpoValidacao = [
              `Lead movido pra PERDIDO automaticamente (motivo: ${decisao.motivo}).`,
              'O gatilho e um proxy (sem mensagem no WhatsApp apos a call) — o lead pode ter comparecido sem escrever.',
              'Confirmar com o lead/closer antes de descartar definitivamente.',
            ].join('\n');
            const taskValidacao = (await createTask.execute!({ telefone, titulo: tituloValidacao, corpo: corpoValidacao, bantTotal: 8 } as any, {} as any)) as { sucesso: boolean };
            if (!taskValidacao?.sucesso) {
              console.error(`[no-show] ${telefone}: falha ao criar task de validacao do Perdido (seguindo com terminal — o move ja foi confirmado)`);
            }
          } catch (e) {
            console.error(`[no-show] ${telefone}: erro ao criar task de validacao do Perdido:`, e);
          }

          const terminou = await marcarCallTerminal(row.id, decisao.motivo!);
          if (terminou) {
            console.log(`[no-show] ${telefone}: movido pra PERDIDO e marcado terminal (motivo: ${decisao.motivo})`);
          } else {
            // WR-01: card movido mas estado nao persistiu — proximo tick vai
            // re-mover (idempotente no GHL) e retentar o PATCH.
            console.error(`[no-show] ${telefone}: movido pra PERDIDO mas marcarCallTerminal FALHOU — retry na proxima varredura (row ${row.id})`);
          }
        } else {
          console.error(`[no-show][SEM-SINAL] ${telefone}: falha ao mover pra PERDIDO — NAO marcando terminal (retry na proxima varredura)`);
        }
        continue;
      }
      // 'nada' -> no-op
    } catch (e) {
      console.error(`[no-show] erro processando lembrete ${row.id} (${telefone}):`, e);
    }
  }
}
