import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getSessao, trocarAgente } from '../sessao';
import { enviarAvisoAoSuporte, jaNotificouRecentemente } from '../notificacoes';

// Motivos AUTON (playbook §15 "Bandeiras vermelhas" + §4 protocolo de
// escalacao tripla). O LLM pode mandar texto livre, mas normalizamos pra
// um label legivel pro time. Clone de handoff-humano.ts (Projeto Roberth),
// trocando as categorias de vendas pelas categorias clinicas/juridicas do
// SDR AUTON.
const MOTIVO_LABEL: Record<string, string> = {
  sofrimento_agudo: 'sofrimento psicologico agudo (protocolo CVV 188)',
  lexico_incompativel: 'lexico incompativel com o perfil profissional de saude',
  processo_etico_judicial: 'mencao a processo etico/regulador/judicial',
  pedido_info_clinica: 'pedido de informacao clinica pessoal',
  lead_reclama_bot: 'lead reclama de estar falando com bot',
  menor_como_paciente: 'menor de idade mencionado como paciente',
  reembolso_cancelamento: 'pedido de reembolso/cancelamento',
};

function rotularMotivo(motivo: string): string {
  const chave = motivo.trim().toLowerCase().replace(/\s+/g, '_');
  return MOTIVO_LABEL[chave] || motivo;
}

async function notificarGrupoSuporte(
  telefone: string,
  motivo: string,
  resumo: string | undefined,
): Promise<void> {
  // Idempotencia: 1 notificacao por contato+motivo (janela de 1h).
  // Evita spam no grupo se o LLM chamar escalate 2x na mesma sessao.
  if (jaNotificouRecentemente(telefone, `escalate:${motivo}`)) {
    console.log(`[escalate-to-human] ${telefone} (${motivo}): grupo ja notificado, ignorando`);
    return;
  }

  const sessao = await getSessao(telefone);
  const nome = sessao?.nome && sessao.nome !== 'Não identificado' ? sessao.nome : '(sem nome)';
  const motivoLegivel = rotularMotivo(motivo);

  const linhas = [
    '🚨 *Escalacao IA → Humano (SDR AUTON)*',
    `Lead: ${nome}`,
    `Telefone: ${telefone}`,
    `Motivo: ${motivoLegivel}`,
  ];
  if (resumo) linhas.push(`Resumo: ${resumo}`);
  linhas.push('', 'A IA esta em silencio neste numero. Alguem do time precisa assumir.');

  const ok = await enviarAvisoAoSuporte(linhas);
  if (ok) {
    console.log(`[escalate-to-human] Grupo de suporte notificado para ${telefone}`);
  }
}

export const escalateToHuman = createTool({
  id: 'escalate-to-human',
  description:
    'Transfere a conversa para um atendente humano e PAUSA a IA. Use nas bandeiras vermelhas do playbook: sofrimento psicologico agudo (protocolo CVV 188), mencao a processo etico/regulador/judicial, pedido de informacao clinica pessoal, lead reclama do bot, menor de idade como paciente, ou pedido de reembolso/cancelamento. APOS chamar esta tool, NAO escreva mais nenhuma mensagem ao lead — a IA fica em silencio absoluto e o time humano assume.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    motivo: z
      .string()
      .describe(
        'Motivo da escalacao. Categorias preferidas: sofrimento_agudo, lexico_incompativel, processo_etico_judicial, pedido_info_clinica, lead_reclama_bot, menor_como_paciente, reembolso_cancelamento.',
      ),
    resumo: z
      .string()
      .optional()
      .describe('Resumo curto (1 linha) do que o lead pediu/precisa, pra orientar o humano que assumir.'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
    mensagem: z.string(),
  }),
  execute: async ({ telefone, motivo, resumo }) => {
    console.log(`[escalate-to-human] ${telefone} → humano (${motivo})`);
    await trocarAgente(telefone, 'humano');
    await notificarGrupoSuporte(telefone, motivo, resumo);
    return {
      sucesso: true,
      mensagem:
        'Lead encaminhado para atendente humano. A IA pausou as respostas para esse numero e o grupo de suporte foi notificado.',
    };
  },
});
