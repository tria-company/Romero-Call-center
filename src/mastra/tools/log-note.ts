import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GHL_PIT_TOKEN, GHL_API_VERSION } from '../config';
import { fetchTimeout } from '../http';
import { buscarContactIdPorTelefone } from '../ghl';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const LIMITE_NOTA = 200;

export const logNote = createTool({
  id: 'log-note',
  description:
    'Registra uma nota operacional curta (<=200 chars) no contato do GHL. Rastro interno (ex: motivo de escalacao, resumo de decisao) — NAO e mensagem pro lead.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    nota: z.string().describe('Texto da nota (sera truncado em 200 chars)'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
  }),
  execute: async ({ telefone, nota }) => {
    if (!GHL_PIT_TOKEN) {
      console.error('[log-note] GHL_PIT_TOKEN nao configurado');
      return { sucesso: false };
    }

    const contactId = await buscarContactIdPorTelefone(telefone);
    if (!contactId) {
      console.error(`[log-note] nao foi possivel resolver contactId para ${telefone}`);
      return { sucesso: false };
    }

    const notaTruncada = nota.length > LIMITE_NOTA ? nota.slice(0, LIMITE_NOTA) : nota;

    try {
      const url = `${GHL_BASE_URL}/contacts/${contactId}/notes`;
      const res = await fetchTimeout(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
          'Version': GHL_API_VERSION,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ body: notaTruncada }),
      });
      if (!res.ok) {
        console.error(`[log-note] POST /contacts/${contactId}/notes falhou (${res.status}):`, await res.text());
        return { sucesso: false };
      }
      console.log(`[log-note] ${telefone} (${contactId}) <- nota registrada (${notaTruncada.length} chars)`);
      return { sucesso: true };
    } catch (e) {
      console.error('[log-note] erro:', e);
      return { sucesso: false };
    }
  },
});
