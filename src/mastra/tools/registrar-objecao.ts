import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getSessao } from '../sessao';
import { registrarObjecao } from '../supabase';

export const registrarObjecaoTool = createTool({
  id: 'registrar-objecao',
  description: 'Registra uma objecao do lead no banco para Roberth analisar depois (ex: preço, falta de tempo, duvida tecnica, esta avaliando concorrente). Chame ASSIM QUE detectar a objecao, antes de tentar contornar. Util mesmo se a venda fechar — vira insight de produto.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    categoria: z.enum(['preco', 'tempo', 'duvida', 'concorrente', 'momento', 'outro']).describe('Categoria da objecao'),
    textoOriginal: z.string().describe('Trecho exato (ou parafraseado) do que o lead disse'),
    contornada: z.boolean().default(false).describe('Marque true apenas se voce ja conseguiu contornar a objecao na mesma resposta'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
  }),
  execute: async ({ telefone, categoria, textoOriginal, contornada }) => {
    const sessao = await getSessao(telefone);
    await registrarObjecao({
      conversation_id: sessao?.conversaId || '',
      customer_id: sessao?.customerId || '',
      telefone,
      categoria,
      texto_original: textoOriginal,
      contornada,
    });
    console.log(`[objecao] ${telefone} → ${categoria}: ${textoOriginal.slice(0, 60)}`);
    return { sucesso: true };
  },
});
