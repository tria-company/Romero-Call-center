import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GHL_PIT_TOKEN, GHL_API_VERSION } from '../config';
import { fetchTimeout } from '../http';
import { buscarContactIdPorTelefone } from '../ghl';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';

// Guarda: bant_* e propriedade do Qualificador (scoring BANT). Decisao
// travada em 01-CONTEXT.md ("update_contact_field (nunca bant_*)") — a
// Camila (e qualquer outro chamador desta tool) NUNCA sobrescreve essas
// chaves. O Qualificador grava bant_* por um helper dedicado (gravarBant),
// fora desta tool, direto na API GHL.
export function chaveBloqueada(chave: string): boolean {
  return /^bant_/i.test(chave.trim());
}

export const updateContactField = createTool({
  id: 'update-contact-field',
  description:
    'Grava um custom field do contato no GHL (ex: spin_stage, ancora_abordagem, objecao_ativa). NUNCA aceita chaves bant_* — essas sao read-only pra este agente (o dono e o Qualificador, que grava via helper proprio).',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    chave: z.string().describe('Chave do custom field (ex: spin_stage). Chaves bant_* sao bloqueadas.'),
    valor: z.string().describe('Valor a gravar'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
    motivo: z.string().optional(),
  }),
  execute: async ({ telefone, chave, valor }) => {
    if (chaveBloqueada(chave)) {
      console.warn(`[update-contact-field] chave bant_* bloqueada: ${chave} (telefone ${telefone})`);
      return { sucesso: false, motivo: 'chave bant_* e read-only pra este agente' };
    }

    if (!GHL_PIT_TOKEN) {
      console.error('[update-contact-field] GHL_PIT_TOKEN nao configurado');
      return { sucesso: false, motivo: 'GHL_PIT_TOKEN nao configurado' };
    }

    const contactId = await buscarContactIdPorTelefone(telefone);
    if (!contactId) {
      console.error(`[update-contact-field] nao foi possivel resolver contactId para ${telefone}`);
      return { sucesso: false, motivo: 'contactId nao resolvido' };
    }

    try {
      const url = `${GHL_BASE_URL}/contacts/${contactId}`;
      const res = await fetchTimeout(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
          'Version': GHL_API_VERSION,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ customFields: [{ key: chave, value: valor }] }),
      });
      if (!res.ok) {
        const erroBody = await res.text();
        console.error(`[update-contact-field] PUT /contacts/${contactId} falhou (${res.status}):`, erroBody);
        return { sucesso: false, motivo: `GHL respondeu ${res.status}` };
      }
      // LGPD (WR-01): NUNCA logar o valor completo — campos como
      // objecao_ativa/resumo_ultima_ligacao carregam excertos (quase)
      // literais de transcricao de call. So chave + tamanho vao pro log.
      console.log(`[update-contact-field] ${telefone} (${contactId}) <- ${chave} (${valor.length} chars)`);
      return { sucesso: true };
    } catch (e) {
      console.error('[update-contact-field] erro:', e);
      return { sucesso: false, motivo: 'erro de rede' };
    }
  },
});
