import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { atualizarSessao, criarSessao, getSessao } from '../sessao';

export const salvarDadosSessao = createTool({
  id: 'salvar-dados-sessao',
  description: 'Salva dados de identificacao do lead na sessao. Chame assim que o lead se apresentar (nome) ou confirmar interesse no curso.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    nome: z.string().optional().describe('Nome do lead, se informado'),
    email: z.string().optional().describe('Email do lead, se informado'),
    interesse: z.string().optional().describe('Curso/oferta que o lead demonstrou interesse'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
  }),
  execute: async ({ telefone, nome, email, interesse }) => {
    const sessao = await getSessao(telefone);
    const dados = { nome: nome || '', email: email || '', interesse: interesse || '' };
    if (sessao) {
      await atualizarSessao(telefone, dados);
    } else {
      await criarSessao(telefone, { agenteAtual: 'vendedor', ...dados });
    }
    console.log(`[sessao] Dados salvos: ${telefone} → ${nome || '(sem nome)'}`);
    return { sucesso: true };
  },
});
