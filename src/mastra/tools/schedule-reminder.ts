import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { upsertLembreteCall, marcarLembreteEnviado } from '../supabase';
import { enviarMensagem } from '../ghl';
import { getSessao } from '../sessao';

// TOOL-08/FUN-02 (toque 1 de 4) — quando a call comercial e agendada com
// sucesso, persiste a call em auton_sdr_call_reminders e dispara a
// CONFIRMACAO IMEDIATA ao lead. Os outros 3 toques (D-1/H-1/5min) sao
// disparados pelo scheduler em lembretes.ts (Task 2 deste plano),
// varrendo a mesma tabela.
//
// Determinístico — o texto da confirmacao NAO e gerado por LLM (evita custo
// e mantem o contrato de executor unico ja estabelecido pro projeto: esta
// tool e chamada diretamente por tools/create-calendar-event.ts no caminho
// de sucesso, nunca declarada como tool nativa de nenhum agente).

/** Formata um ISO 8601 em "dd/mm às HH:mm" no fuso de Brasilia (sem libs externas). */
export function formatarDataHoraPtBr(iso: string): string {
  const data = new Date(iso);
  const dataFmt = data.toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
  });
  const horaFmt = data.toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${dataFmt} às ${horaFmt}`;
}

function mensagemConfirmacao(nome: string | undefined, dataHoraFmt: string): string {
  const abertura = nome ? `${nome}, sua` : 'Sua';
  return (
    `${abertura} call foi confirmada para ${dataHoraFmt} (horário de Brasília). ` +
    'Você vai receber mais lembretes perto da hora — qualquer imprevisto, me avisa por aqui.'
  );
}

export const scheduleReminder = createTool({
  id: 'schedule-reminder',
  description:
    'TOOL-08 — persiste a call agendada (auton_sdr_call_reminders) e dispara a confirmacao imediata ao lead (FUN-02 toque 1). Os toques D-1/H-1/5min sao disparados depois pelo scheduler (lembretes.ts). Chamado no caminho de sucesso de create-calendar-event, nunca diretamente por um agente.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    callStartTime: z.string().describe('Horario ISO 8601 da call (mesmo startTime usado em create-calendar-event)'),
    nome: z.string().optional().describe('Nome do lead, se disponivel, pra personalizar a confirmacao'),
    closer: z.string().optional().describe('Closer designado (sidnei|petriv) — armazenado pra contexto'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
    motivo: z.string().optional(),
  }),
  execute: async ({ telefone, callStartTime, nome, closer }) => {
    const callStartMs = new Date(callStartTime).getTime();
    if (Number.isNaN(callStartMs)) {
      console.error(`[schedule-reminder] callStartTime invalido para ${telefone}: "${callStartTime}"`);
      return { sucesso: false, motivo: 'callStartTime invalido' };
    }

    // Resolve customerId/conversationId best-effort — nao bloqueia a
    // persistencia do lembrete se a sessao nao existir/nao resolver. O
    // telefone (chave confiavel do processo, T-02-01) e suficiente pro
    // upsert e pro scheduler encontrar a row depois.
    let customerId: string | undefined;
    let conversationId: string | undefined;
    try {
      const sessao = await getSessao(telefone);
      customerId = sessao?.customerId || undefined;
      conversationId = sessao?.conversaId || undefined;
    } catch (e) {
      console.error(`[schedule-reminder] erro ao resolver sessao de ${telefone} (seguindo sem customerId/conversationId):`, e);
    }

    const callStartIso = new Date(callStartMs).toISOString();
    const lembrete = await upsertLembreteCall({
      telefone,
      callStartAt: callStartIso,
      nome,
      closer,
      customerId,
      conversationId,
    });
    if (!lembrete?.id) {
      console.error(`[schedule-reminder] falha ao persistir lembrete pra ${telefone}`);
      return { sucesso: false, motivo: 'falha ao persistir lembrete' };
    }

    try {
      const dataHoraFmt = formatarDataHoraPtBr(callStartIso);
      // CR-03: enviarMensagem retorna boolean HONESTO (GHL aceitou o POST).
      // So marca confirmacao_sent_at e retorna sucesso quando a entrega foi
      // CONFIRMADA — antes, um GHL fora do ar produzia row "verde"
      // (confirmacao_sent_at preenchido + sucesso:true) com o lead tendo
      // recebido zero mensagens.
      const entregue = await enviarMensagem(telefone, mensagemConfirmacao(nome, dataHoraFmt));
      if (!entregue) {
        console.error(`[schedule-reminder] confirmacao imediata NAO entregue pra ${telefone} (lembrete persistido, id=${lembrete.id})`);
        return { sucesso: false, motivo: 'lembrete persistido mas confirmacao nao entregue' };
      }
      const marcado = await marcarLembreteEnviado(lembrete.id, 'confirmacao_sent_at');
      if (!marcado) {
        // WR-01: mensagem entregue mas o gate nao persistiu — nao ha
        // reenvio automatico da confirmacao (so a tool a dispara), entao o
        // lead nao sera spammado; loga alto pra investigacao e segue.
        console.error(`[schedule-reminder] confirmacao entregue mas confirmacao_sent_at NAO persistiu (lembrete ${lembrete.id})`);
      }
    } catch (e) {
      console.error(`[schedule-reminder] erro ao enviar confirmacao imediata pra ${telefone} (lembrete persistido, id=${lembrete.id}):`, e);
      return { sucesso: false, motivo: 'lembrete persistido mas confirmacao falhou' };
    }

    console.log(`[schedule-reminder] ${telefone}: lembrete persistido (id=${lembrete.id}) + confirmacao enviada para ${callStartIso}`);
    return { sucesso: true };
  },
});
