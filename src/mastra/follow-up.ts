// Scheduler de buffer-recovery e cleanups periodicos.
//
// CLEAN-01: o caminho de follow-up automatico (1h/3h/5h) e handoff por
// silencio de 24h gerado pela Sofia (agente vendedor/Closer) foi REMOVIDO —
// dependia do agente Mastra do Closer (ja deletado, ver agents/vendedor.ts
// no historico). Para o SDR AUTON, os toques pos-agendamento (lembretes
// D-1/H-1/5min e o loop de no-show) ja vivem em lembretes.ts/no-show.ts
// (Fase 2); o re-engajamento de um lead PRE-call que simplesmente para de
// responder a Camila fica como item DEFERIDO (fora do escopo desta limpeza
// — ver SUMMARY do plano 04-01).
//
// O que este modulo ainda faz:
//   - A cada 30s, recupera mensagens do buffer persistente que ficaram orfas
//     (container caiu antes do debounce de 10s disparar) e as reprocessa via
//     o callback `processarMensagem` (mesma assinatura do handler em
//     index.ts).
//   - A cada 30min, roda cleanups periodicos (DELETE de dedup/buffer antigos).
//
// Como tem 1 replica Docker Swarm, sem risco de duplicacao por concorrencia.
// State no Supabase sobrevive reinicio (proximo tick recupera).

import type { Mastra } from '@mastra/core/mastra';
import {
  buscarTelefonesComBufferOrfao,
  consumirBufferPendente,
  limparBufferAntigo,
  limparWebhookDedupAntigos,
} from './supabase';

const INTERVALO_BUFFER_RECOVERY = 30 * 1000; // 30s — pega buffer orfao rapido
const INTERVALO_CLEANUP = 30 * 60 * 1000;    // 30min — DELETE rows antigas

// Callback que processa uma mensagem (mesma assinatura do processarMensagem
// em index.ts). O worker de recovery do buffer chama isso quando encontra
// mensagens orfas (container que recebeu o webhook morreu antes do timer).
type ProcessarMensagemFn = (numero: string, texto: string, nome: string) => Promise<void> | void;

/**
 * Worker de recovery do buffer (Fix #2 do review de prod).
 * Pega telefones com mensagens nao processadas ha > 30s — provavelmente
 * orfas de container que caiu antes do setTimeout disparar. Para cada,
 * consome (PATCH atomico) e chama o handler.
 *
 * Roda a cada 30s (INTERVALO_BUFFER_RECOVERY).
 */
async function processarBufferOrfao(processar: ProcessarMensagemFn): Promise<void> {
  const telefones = await buscarTelefonesComBufferOrfao(30);
  if (telefones.length === 0) return;

  console.log(`[buffer-recovery] ${telefones.length} telefone(s) com buffer orfao, processando...`);

  for (const telefone of telefones) {
    try {
      const result = await consumirBufferPendente(telefone);
      if (!result || result.quantidade === 0) continue; // outro container ja pegou
      console.log(`[buffer-recovery] ${telefone}: ${result.quantidade} msg(s) recuperadas`);
      await processar(telefone, result.textoConcatenado, result.nome || '');
    } catch (e) {
      console.error(`[buffer-recovery] Erro processando ${telefone}:`, e);
    }
  }
}

/**
 * Cleanup periodico — DELETEs em tabelas que crescem (dedup, buffer processado).
 * Roda a cada 30min pra nao deixar lixo acumular.
 */
async function executarCleanups(): Promise<void> {
  await Promise.all([
    limparWebhookDedupAntigos().catch((e) => console.error('[cleanup] dedup:', e)),
    limparBufferAntigo().catch((e) => console.error('[cleanup] buffer:', e)),
  ]);
}

// `mastra` (_mastra): parametro mantido por compatibilidade de assinatura com
// o call site em index.ts (iniciarFollowUpScheduler(mastra, processarMensagem))
// — sem uso apos a remocao do FUP-Sofia (que precisava de mastra.getAgent).
export function iniciarFollowUpScheduler(
  _mastra: Mastra,
  processarMensagem?: ProcessarMensagemFn,
): void {
  if (processarMensagem) {
    setInterval(() => {
      processarBufferOrfao(processarMensagem).catch((e) =>
        console.error('[buffer-recovery] Erro na varredura:', e),
      );
    }, INTERVALO_BUFFER_RECOVERY);
    console.log(`[buffer-recovery] Worker ativo (scan a cada ${INTERVALO_BUFFER_RECOVERY / 1000}s)`);
  }

  setInterval(() => {
    executarCleanups().catch((e) => console.error('[cleanup] Erro:', e));
  }, INTERVALO_CLEANUP);

  console.log(
    `[follow-up] Scheduler ativo (buffer-recovery + cleanup a cada ${INTERVALO_CLEANUP / 60000}min; FUP-Sofia removido — CLEAN-01)`,
  );
}
