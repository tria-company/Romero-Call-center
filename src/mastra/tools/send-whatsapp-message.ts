import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { enviarMensagem } from '../ghl';

export const sendWhatsappMessage = createTool({
  id: 'send-whatsapp-message',
  description:
    'Envia mensagem de texto pro lead via WhatsApp (GHL). Delega a enviarMensagem ja validada em producao (quebra de mensagem, filtro de URL, lookup de contactId, delay humano) — NAO reimplementa o POST.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    mensagem: z.string().describe('Texto a enviar'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
  }),
  execute: async ({ telefone, mensagem }) => {
    // permitirUrl NAO e passado aqui — mantem o filtro de URL de ghl.ts ativo
    // pra este agente (URL crua so sai pela tool dedicada de checkout, que
    // este projeto nao usa mais no SDR).
    await enviarMensagem(telefone, mensagem);
    console.log(`[send-whatsapp-message] ${telefone} <- "${mensagem.slice(0, 60)}${mensagem.length > 60 ? '...' : ''}"`);
    return { sucesso: true };
  },
});
