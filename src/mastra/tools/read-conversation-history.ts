import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GHL_PIT_TOKEN, GHL_API_VERSION } from '../config';
import { fetchTimeout } from '../http';
import { buscarContactIdPorTelefone } from '../ghl';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const LIMITE_PADRAO = 20;

export const readConversationHistory = createTool({
  id: 'read-conversation-history',
  description:
    'Le as ultimas mensagens da conversa do lead no GHL (WhatsApp). Use pra recuperar contexto antes de responder, principalmente apos reinicio ou troca de agente (Qualificador -> Camila).',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    contactId: z.string().optional().describe('contactId do GHL, se ja conhecido (evita lookup)'),
    limit: z.number().int().positive().max(50).optional().describe('Quantidade de mensagens a buscar (default 20)'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
    contactId: z.string().optional(),
    mensagens: z.array(z.object({ role: z.enum(['user', 'assistant']), body: z.string() })).optional(),
  }),
  execute: async ({ telefone, contactId: contactIdInformado, limit }) => {
    const limite = limit || LIMITE_PADRAO;

    if (!GHL_PIT_TOKEN) {
      console.error('[read-conversation-history] GHL_PIT_TOKEN nao configurado');
      return { sucesso: false };
    }

    const contactId = contactIdInformado || (await buscarContactIdPorTelefone(telefone));
    if (!contactId) {
      console.error(`[read-conversation-history] nao foi possivel resolver contactId para ${telefone}`);
      return { sucesso: false };
    }

    try {
      const searchParams = new URLSearchParams({ contactId, limit: '1' });
      const searchUrl = `${GHL_BASE_URL}/conversations/search?${searchParams.toString()}`;
      const searchRes = await fetchTimeout(searchUrl, {
        headers: {
          'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
          'Version': GHL_API_VERSION,
          'Accept': 'application/json',
        },
      });
      if (!searchRes.ok) {
        console.error(`[read-conversation-history] search conversations falhou (${searchRes.status}):`, await searchRes.text());
        return { sucesso: false, contactId };
      }
      const searchData = await searchRes.json();
      const conversationId = searchData?.conversations?.[0]?.id;
      if (!conversationId) {
        console.warn(`[read-conversation-history] nenhuma conversa encontrada para ${contactId}`);
        return { sucesso: true, contactId, mensagens: [] };
      }

      const msgsUrl = `${GHL_BASE_URL}/conversations/${conversationId}/messages?limit=${limite}`;
      const msgsRes = await fetchTimeout(msgsUrl, {
        headers: {
          'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
          'Version': GHL_API_VERSION,
          'Accept': 'application/json',
        },
      });
      if (!msgsRes.ok) {
        console.error(`[read-conversation-history] get messages falhou (${msgsRes.status}):`, await msgsRes.text());
        return { sucesso: false, contactId };
      }
      const msgsData = await msgsRes.json();
      // Estrutura: messages.messages[] OU messages[] (mesma variacao tratada em ghl.ts).
      const bruta: Array<{ direction?: string; body?: string; message?: string }> =
        msgsData?.messages?.messages || msgsData?.messages || [];

      const mensagens = bruta
        .map((m) => ({
          role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
          body: String(m.body || m.message || ''),
        }))
        .filter((m) => m.body.length > 0)
        .reverse(); // API retorna mais recente primeiro — normaliza pra ordem cronologica

      console.log(`[read-conversation-history] ${telefone} (${contactId}) -> ${mensagens.length} mensagens`);
      return { sucesso: true, contactId, mensagens };
    } catch (e) {
      console.error('[read-conversation-history] erro:', e);
      return { sucesso: false, contactId };
    }
  },
});
