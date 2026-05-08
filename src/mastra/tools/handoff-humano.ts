import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getSessao, trocarAgente } from '../sessao';
import { enviarMensagem } from '../evolution';
import { SUPORTE_GRUPO_JID } from '../config';

// Categorias de motivo aceitas. O LLM pode mandar texto livre, mas a gente
// normaliza pra um label legivel pro time.
const MOTIVO_LABEL: Record<string, string> = {
  problema_pagamento_efetuado: 'problema de pagamento ja efetuado',
  problema_no_checkout: 'problema no checkout',
  publico_fora_perfil: 'publico fora do perfil (homem)',
  comportamento_inadequado: 'comportamento inadequado / xingamento',
  pediu_pessoa: 'lead pediu falar com pessoa',
  irritacao: 'lead demonstrou irritacao',
  factual_desconhecida: 'pergunta factual fora do escopo',
  fora_do_escopo: 'assunto fora do escopo',
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
  if (!SUPORTE_GRUPO_JID) {
    console.log('[handoff-humano] SUPORTE_GRUPO_JID nao configurado, pulando notificacao do grupo');
    return;
  }

  const sessao = await getSessao(telefone);
  const nome = sessao?.nome && sessao.nome !== 'Não identificado' ? sessao.nome : '(sem nome)';
  const motivoLegivel = rotularMotivo(motivo);

  const linhas = [
    '🚨 *Handoff IA → Humano*',
    `Lead: ${nome}`,
    `Telefone: ${telefone}`,
    `Motivo: ${motivoLegivel}`,
  ];
  if (resumo) linhas.push(`Resumo: ${resumo}`);
  linhas.push('', 'A IA esta em silencio neste numero. Alguem do time precisa assumir.');

  try {
    await enviarMensagem(SUPORTE_GRUPO_JID, linhas.join('\n'));
    console.log(`[handoff-humano] Grupo de suporte notificado para ${telefone}`);
  } catch (e) {
    console.error('[handoff-humano] Falha ao notificar grupo de suporte:', e);
  }
}

export const handoffHumano = createTool({
  id: 'handoff-humano',
  description:
    'Transfere a conversa para um atendente humano. Use quando o lead pedir explicitamente para falar com pessoa, demonstrar irritacao, fizer pergunta factual fora do escopo, ou quando a duvida fugir do roteiro de vendas (ex: suporte tecnico, problema de pagamento ja efetuado, juridico). APOS chamar esta tool, NAO escreva mais nenhuma mensagem ao lead — a IA fica em silencio absoluto e o time humano assume.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    motivo: z
      .string()
      .describe(
        'Motivo da transferencia. Categorias preferidas: problema_pagamento_efetuado, problema_no_checkout, publico_fora_perfil, comportamento_inadequado, pediu_pessoa, irritacao, factual_desconhecida, fora_do_escopo.',
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
    console.log(`[handoff-humano] ${telefone} → humano (${motivo})`);
    await trocarAgente(telefone, 'humano');
    await notificarGrupoSuporte(telefone, motivo, resumo);
    return {
      sucesso: true,
      mensagem:
        'Lead encaminhado para atendente humano. A IA pausou as respostas para esse numero e o grupo de suporte foi notificado.',
    };
  },
});
