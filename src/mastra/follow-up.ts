// Scheduler de follow-ups e handoff por silencio.
//
// Comportamento:
//   - A cada 5min, varre conversations_roberth onde a Sofia foi a ultima a
//     falar e o lead silenciou >= 1h, 3h, 5h ou 24h.
//   - 1h/3h/5h: gera mensagem de FUP via LLM (com historico via Memory) e
//     envia ao lead. Marca fup_N_sent_at pra nao duplicar no proximo tick.
//   - 24h: dispara handoff pro humano (mesma rotina do tool handoff-humano).
//
// State persistido em conversations_roberth (migration 02_follow_up.sql):
//   last_assistant_message_at, last_lead_message_at,
//   fup_1_sent_at, fup_3_sent_at, fup_5_sent_at, handoff_silencio_em.
//
// Quando o lead responde, processarMensagem() em index.ts chama marcarMsgLead()
// que zera os marcadores fup_*_sent_at — proximo silencio comeca do zero.
//
// Como tem 1 replica Docker Swarm, sem risco de duplicacao por concorrencia.
// State no Supabase sobrevive reinicio (proximo tick recupera).

import type { Mastra } from '@mastra/core/mastra';
import {
  atualizarConversa,
  salvarMensagem,
  buscarConversasParaFollowUp,
  buscarTelefonesComBufferOrfao,
  consumirBufferPendente,
  limparBufferAntigo,
  limparWebhookDedupAntigos,
} from './supabase';
import { trocarAgente } from './sessao';
import { enviarMensagem } from './ghl';
import { enviarAvisoAoSuporte } from './notificacoes';

const INTERVALO_SCAN = 5 * 60 * 1000;
const INTERVALO_BUFFER_RECOVERY = 30 * 1000; // 30s — pega buffer orfao rapido
const INTERVALO_CLEANUP = 30 * 60 * 1000;    // 30min — DELETE rows antigas
const FUP_1H = 60 * 60 * 1000;
const FUP_3H = 3 * FUP_1H;
const FUP_5H = 5 * FUP_1H;
const HANDOFF_24H = 24 * FUP_1H;

function promptFup(horas: number): string {
  return [
    '[SISTEMA - FOLLOW-UP AUTOMATICO]',
    `O lead silenciou ha ${horas}h apos sua ultima mensagem. Mande UMA mensagem`,
    'curta (1-2 linhas) reabrindo a conversa, espelhando o tom do historico ate aqui.',
    '',
    'Regras desta mensagem de fup:',
    '- NAO comece com saudacao ("oi", "ola", "tudo bem?") — voces ja se cumprimentaram.',
    '- NAO repita oferta inteira nem lista de Pilares.',
    '- NAO chame `enviar-checkout` aqui (a menos que ela ja tenha demonstrado',
    '  intencao explicita ANTES e voce nunca tenha chamado a tool nesta conversa).',
    '- Foco: re-engajar com leveza OU dar um angulo NOVO de quebra da ultima objecao.',
    '- Maximo 1 emoji.',
    '- Acentuacao correta SEMPRE (voce, nao, esta, ja, etc).',
    '- 1-2 linhas. Curto. Sem rodeio. Sem "ainda esta ai?" generico.',
  ].join('\n');
}

async function enviarFollowUp(
  mastra: Mastra,
  conv: any,
  horas: 1 | 3 | 5,
): Promise<void> {
  const customer = conv.customers_roberth;
  const telefone = customer?.telefone;
  if (!telefone) {
    console.warn(`[follow-up] conversa ${conv.id} sem telefone, pulando`);
    return;
  }

  console.log(
    `[follow-up] enviando FUP ${horas}h para ${telefone} (conv ${conv.id})`,
  );

  try {
    const agent = mastra.getAgent('vendedorAgent');
    const resposta = await agent.generate(promptFup(horas), {
      memory: { thread: telefone, resource: telefone },
      threadId: telefone,
      resourceId: telefone,
    } as any);

    const texto = (resposta as any)?.text?.trim();
    if (!texto) {
      console.warn(`[follow-up] LLM retornou texto vazio pra ${telefone}, pulando`);
      // Mesmo assim marca o fup como enviado pra nao ficar tentando indefinidamente.
      const campo = `fup_${horas}_sent_at`;
      await atualizarConversa(conv.id, { [campo]: new Date().toISOString() });
      return;
    }

    await enviarMensagem(telefone, texto);

    salvarMensagem({
      conversation_id: conv.id,
      role: 'assistant',
      content: texto,
      agent_table: 'vendedor',
      tool_name: `follow-up-${horas}h`,
    });

    // IMPORTANTE: NAO atualizar last_assistant_message_at aqui — senao o
    // relogio de silencio reseta e os FUPs seguintes (3h, 5h) nunca disparam.
    const campo = `fup_${horas}_sent_at`;
    await atualizarConversa(conv.id, { [campo]: new Date().toISOString() });
  } catch (e) {
    console.error(`[follow-up] Erro ao enviar FUP ${horas}h pra ${telefone}:`, e);
  }
}

async function dispararHandoffPorSilencio(conv: any): Promise<void> {
  const customer = conv.customers_roberth;
  const telefone = customer?.telefone;
  if (!telefone) {
    console.warn(`[follow-up] conversa ${conv.id} sem telefone pra handoff, pulando`);
    return;
  }

  console.log(
    `[follow-up] HANDOFF por 24h de silencio: ${telefone} (conv ${conv.id})`,
  );

  try {
    await trocarAgente(telefone, 'humano');
    const nome = customer?.nome || '(sem nome)';
    await enviarAvisoAoSuporte([
      '🚨 *Handoff por silencio de 24h*',
      `Lead: ${nome}`,
      `Telefone: ${telefone}`,
      'Motivo: lead silenciou apos 3 follow-ups automaticos (1h/3h/5h).',
      '',
      'A IA esta em silencio neste numero. Alguem do time precisa retomar.',
    ]);
    await atualizarConversa(conv.id, {
      handoff_silencio_em: new Date().toISOString(),
    });
  } catch (e) {
    console.error(
      `[follow-up] Erro no handoff por silencio pra ${telefone}:`,
      e,
    );
  }
}

async function processarFollowUps(mastra: Mastra): Promise<void> {
  const elegiveis = await buscarConversasParaFollowUp();
  if (elegiveis.length === 0) return;

  console.log(
    `[follow-up] ${elegiveis.length} conversa(s) elegivel(is) na varredura`,
  );

  for (const conv of elegiveis) {
    const ts = new Date(conv.last_assistant_message_at).getTime();
    const silencio = Date.now() - ts;

    if (silencio >= HANDOFF_24H && !conv.handoff_silencio_em) {
      await dispararHandoffPorSilencio(conv);
    } else if (silencio >= FUP_5H && !conv.fup_5_sent_at) {
      await enviarFollowUp(mastra, conv, 5);
    } else if (silencio >= FUP_3H && !conv.fup_3_sent_at) {
      await enviarFollowUp(mastra, conv, 3);
    } else if (silencio >= FUP_1H && !conv.fup_1_sent_at) {
      await enviarFollowUp(mastra, conv, 1);
    }
  }
}

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

export function iniciarFollowUpScheduler(
  mastra: Mastra,
  processarMensagem?: ProcessarMensagemFn,
): void {
  setInterval(() => {
    processarFollowUps(mastra).catch((e) =>
      console.error('[follow-up] Erro na varredura:', e),
    );
  }, INTERVALO_SCAN);

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
    `[follow-up] Scheduler ativo (scan FUP a cada ${INTERVALO_SCAN / 60000}min, cleanup a cada ${INTERVALO_CLEANUP / 60000}min)`,
  );
}
