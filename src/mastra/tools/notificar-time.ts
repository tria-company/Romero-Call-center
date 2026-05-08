import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getSessao } from '../sessao';
import { enviarAvisoAoSuporte } from '../notificacoes';

const MOTIVO_LABEL: Record<string, string> = {
  lead_homem: 'lead masculino (IA continua atendendo)',
  suspeita_fraude: 'suspeita de fraude / spam',
  lead_atipico: 'lead com comportamento atipico',
  outro: 'outro (ver resumo)',
};

function rotularMotivo(motivo: string): string {
  const chave = motivo.trim().toLowerCase().replace(/\s+/g, '_');
  return MOTIVO_LABEL[chave] || motivo;
}

export const notificarTime = createTool({
  id: 'notificar-time',
  description:
    'Envia aviso ao grupo SUPORTE CAMINHO DE RAINHA - IA, mas SEM pausar a IA. Use quando precisar avisar o time de algo importante (ex: lead homem conversando) enquanto continua o atendimento normal. NAO troca o agente — Sofia continua respondendo. Diferente de `handoff-humano` que pausa a IA.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    motivo: z
      .string()
      .describe(
        'Motivo do aviso. Categorias preferidas: lead_homem, suspeita_fraude, lead_atipico, outro.',
      ),
    resumo: z
      .string()
      .describe('Resumo curto (1 linha) do contexto pra orientar o time.'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
  }),
  execute: async ({ telefone, motivo, resumo }) => {
    const sessao = await getSessao(telefone);
    const nome = sessao?.nome && sessao.nome !== 'Não identificado' ? sessao.nome : '(sem nome)';
    const motivoLegivel = rotularMotivo(motivo);

    const linhas = [
      'ℹ️ *Aviso ao time (IA continua atendendo)*',
      `Lead: ${nome}`,
      `Telefone: ${telefone}`,
      `Motivo: ${motivoLegivel}`,
      `Resumo: ${resumo}`,
    ];

    const sucesso = await enviarAvisoAoSuporte(linhas);
    console.log(`[notificar-time] ${telefone} (${motivo}): ${sucesso ? 'OK' : 'falhou'}`);
    return { sucesso };
  },
});
