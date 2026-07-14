// Resgate durável de leads com sinal de desistencia SEM fechamento (GRAV-03).
//
// Quando a extracao de sinais (src/mastra/extracao-sinais.ts, Task 2 deste
// plano) detecta sinais_desistencia.presente=true numa transcricao e o lead
// ainda nao esta GANHO no pipeline COMERCIAL USI, agenda um resgate de 48h
// (agendarResgate48h — o CONTRATO que a Task 2 consome). O disparo em si
// (48h depois) roda no MESMO tick do scheduler durável ja existente
// (lembretes.ts#iniciarLembretesScheduler, junto de
// processarLembretes/processarNoShows) — nenhum setInterval novo.
//
// Maquina de decisao (decidirResgate, PURA — sem I/O, sem dependencia de
// modulo, prova em scripts/smoke-resgates.mjs, mesmo padrao de
// decidirNoShow em no-show.ts):
//   nowMs < resgatarEmMs           -> 'nada'   (ainda dentro da janela de 48h)
//   nowMs >= resgatarEmMs e leadGanho -> 'cancelar' (fechou nesse meio-tempo)
//   nowMs >= resgatarEmMs e !leadGanho -> 'resgatar' (task pro SDR humano)
//   NaN em qualquer lado -> 'nada' (fail-safe, nunca dispara task por engano)
//
// processarResgates (tick real) re-checa, no MOMENTO do disparo (nao no
// momento em que o sinal foi detectado): (i) pausa duravel — humano/
// bloqueado (T-03-10, reusa leadEmPausaDuravel de no-show.ts, sem ciclo
// novo de import); (ii) se o lead esta GANHO (leadEstaGanho, tambem reusada
// por extracao-sinais.ts pro proprio gatilho inicial).

import type { Mastra } from '@mastra/core/mastra';
import {
  upsertResgate,
  buscarResgatesPendentes,
  marcarResgateFeito,
} from './supabase';
import { createTask } from './tools/create-task';
import { leadEmPausaDuravel } from './no-show';
import { buscarContactIdPorTelefone } from './ghl';
import { fetchTimeout } from './http';
import { GHL_PIT_TOKEN, GHL_API_VERSION_V2, GHL_PIPELINE_ID, GHL_STAGES } from './config';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';

// Tipos em interfaces SEPARADAS (nao inline) pro smoke script extrair o
// CORPO de decidirResgate via regex sem colidir com chaves da anotacao de
// tipo — mesmo padrao de DecidirNoShowArgs/DecisaoNoShow (no-show.ts).
export interface DecidirResgateArgs {
  resgatarEmMs: number;
  nowMs: number;
  leadGanho: boolean;
}

export type AcaoResgate = 'nada' | 'resgatar' | 'cancelar';

export interface DecisaoResgate {
  acao: AcaoResgate;
}

/**
 * GRAV-03 — funcao PURA (sem I/O) que decide a proxima acao do resgate de
 * 48h. Ver comentario de topo do arquivo pra regra completa. Prova por
 * scripts/smoke-resgates.mjs (extrai o CORPO via regex e roda via
 * `new Function`, mesmo padrao de decidirNoShow/no-show.ts).
 */
export function decidirResgate(args: DecidirResgateArgs): DecisaoResgate {
  const { resgatarEmMs, nowMs, leadGanho } = args;

  if (Number.isNaN(resgatarEmMs) || Number.isNaN(nowMs)) return { acao: 'nada' };
  if (nowMs < resgatarEmMs) return { acao: 'nada' };
  if (leadGanho) return { acao: 'cancelar' };
  return { acao: 'resgatar' };
}

/**
 * Contrato consumido pela extracao de sinais (Task 2, extracao-sinais.ts):
 * calcula resgatar_em = agora + 48h e faz upsert (on_conflict=telefone) na
 * tabela auton_sdr_resgates via supabase.ts#upsertResgate. Idempotente por
 * telefone — um novo sinal pro mesmo lead reabre/reagenda em vez de criar
 * um resgate duplicado (T-03-09).
 */
export async function agendarResgate48h(
  telefone: string,
  customerId: string | null | undefined,
  nome: string | undefined,
  motivo: string,
): Promise<boolean> {
  const resgatarEm = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const resultado = await upsertResgate({
    telefone,
    customerId: customerId || undefined,
    nome,
    motivo,
    resgatarEm,
  });
  if (resultado) {
    console.log(`[resgates] ${telefone}: resgate de 48h agendado pra ${resgatarEm} (motivo: ${motivo})`);
  } else {
    console.error(`[resgates] ${telefone}: falha ao agendar resgate de 48h`);
  }
  return !!resultado;
}

/**
 * Re-checa se o lead esta GANHO no pipeline COMERCIAL USI — mesma leitura
 * (GET /opportunities/search) usada por tools/move-pipeline-stage.ts,
 * reexposta aqui pra processarResgates E reusada por extracao-sinais.ts (o
 * gatilho inicial de GRAV-03), sem duplicar a chamada GHL nem depender de
 * um `buscarStageAtual` que nao existe no codigo. Fail-safe: qualquer
 * erro/ausencia de opportunity retorna false — na pior hipotese o resgate
 * roda (ou o gatilho dispara) uma vez a mais; nunca deixa de rodar por um
 * lead que na verdade ja fechou, sem antes um humano ver a task.
 */
export async function leadEstaGanho(telefone: string): Promise<boolean> {
  if (!GHL_PIT_TOKEN) return false;
  try {
    const contactId = await buscarContactIdPorTelefone(telefone);
    if (!contactId) return false;

    const url = `${GHL_BASE_URL}/opportunities/search?contact_id=${encodeURIComponent(contactId)}&pipeline_id=${encodeURIComponent(GHL_PIPELINE_ID)}`;
    const res = await fetchTimeout(url, {
      headers: {
        'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
        'Version': GHL_API_VERSION_V2,
        'Accept': 'application/json',
      },
    });
    if (!res.ok) {
      console.error(`[resgates] leadEstaGanho: GET /opportunities/search falhou (${res.status}) para ${telefone}`);
      return false;
    }
    const data = await res.json();
    // WR-04: varre TODAS as opportunities do contato no pipeline (nao so a
    // [0], cuja ordenacao a API nao garante). Semantica de fechamento
    // deliberada: QUALQUER opportunity em GANHO conta como lead fechado —
    // um GANHO historico significa que o lead ja e cliente, e o resgate de
    // desistencia nao se aplica. So cancela resgate com GANHO CONFIRMADO em
    // alguma opportunity; ausencia/erro continua retornando false (fail-safe:
    // na duvida, o resgate roda e um humano ve a task).
    const opps: any[] = Array.isArray(data?.opportunities) ? data.opportunities : [];
    return opps.some((o) => o?.pipelineStageId === GHL_STAGES.GANHO);
  } catch (e) {
    console.error(`[resgates] leadEstaGanho: erro ao verificar stage de ${telefone}:`, e);
    return false;
  }
}

/**
 * Tick do resgate de 48h: varre buscarResgatesPendentes (ja filtra
 * status='pendente' & resgatar_em<=now), decide e despacha pra cada row.
 * Chamado pelo MESMO scheduler de lembretes.ts (iniciarLembretesScheduler),
 * ao lado de processarLembretes/processarNoShows — reusa a granularidade de
 * 60s e o mutex de reentrancia (CR-04), sem setInterval novo.
 */
export async function processarResgates(mastra: Mastra): Promise<void> {
  void mastra;
  const pendentes = await buscarResgatesPendentes();
  if (pendentes.length === 0) return;

  const agora = Date.now();

  for (const row of pendentes) {
    const telefone = row.telefone;
    if (!telefone) {
      console.warn(`[resgates] row ${row.id} sem telefone, pulando`);
      continue;
    }

    try {
      // T-03-10: guarda de crise/atendimento humano SEMPRE ANTES de
      // qualquer decisao/acao — reusa a MESMA guarda duravel do loop de
      // no-show (leadEmPausaDuravel) pra nao resgatar um lead em crise ou
      // ja em atendimento humano.
      const { emAtendimentoHumano, bloqueado } = await leadEmPausaDuravel(telefone, row.customer_id);
      if (emAtendimentoHumano || bloqueado) {
        console.log(`[resgates] ${telefone}: pulando (humano=${emAtendimentoHumano}, bloqueado=${bloqueado})`);
        continue;
      }

      // Re-check "sem fechamento" NO MOMENTO do disparo (nao no momento em
      // que o sinal foi detectado, la em extracao-sinais.ts) — o lead pode
      // ter fechado com o closer humano durante as 48h de espera.
      const leadGanho = await leadEstaGanho(telefone);
      const resgatarEmMs = new Date(row.resgatar_em).getTime();
      const decisao = decidirResgate({ resgatarEmMs, nowMs: agora, leadGanho });

      if (decisao.acao === 'cancelar') {
        const cancelado = await marcarResgateFeito(row.id, 'cancelado');
        if (cancelado) {
          console.log(`[resgates] ${telefone}: resgate cancelado (lead ja GANHO)`);
        } else {
          console.error(`[resgates] ${telefone}: falha ao marcar resgate cancelado (row ${row.id}) — retry na proxima varredura`);
        }
        continue;
      }

      if (decisao.acao === 'resgatar') {
        const titulo = 'Resgatar lead (sinal de desistencia)';
        const corpo = [
          `Motivo: ${row.motivo || 'sinal de desistencia identificado na call/ligacao'}.`,
          'Sinal de desistencia sem fechamento ha 48h — reengajar o lead antes de descartar.',
        ].join('\n');
        // Prioridade sintetica alta (Filtro 3) — resgatar um sinal de
        // desistencia e, por definicao, prioridade alta pro SDR humano
        // (mesmo padrao de bantTotal:10 usado por dispararRecuperacaoNoShow
        // em no-show.ts).
        const r = (await createTask.execute!({ telefone, titulo, corpo, bantTotal: 10 } as any, {} as any)) as { sucesso: boolean };
        if (r?.sucesso) {
          const marcado = await marcarResgateFeito(row.id, 'feito');
          if (!marcado) {
            console.error(`[resgates] ${telefone}: task de resgate criada mas marcarResgateFeito FALHOU — retry na proxima varredura (row ${row.id})`);
          } else {
            console.log(`[resgates] ${telefone}: resgate disparado (task criada)`);
          }
        } else {
          console.error(`[resgates][SEM-SINAL] ${telefone}: falha ao criar task de resgate — NAO marcando feito (retry na proxima varredura)`);
        }
        continue;
      }
      // 'nada' -> no-op (defensivo; buscarResgatesPendentes ja filtra
      // resgatar_em<=now, entao este ramo nao deveria ocorrer em producao).
    } catch (e) {
      console.error(`[resgates] erro processando resgate ${row.id} (${telefone}):`, e);
    }
  }
}
