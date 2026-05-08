import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { enviarMensagem } from '../evolution';
import { getSessao } from '../sessao';
import { salvarMensagem, atualizarConversa } from '../supabase';
import { CHECKOUT_URL_PRINCIPAL, CHECKOUT_URL_ORDERBUMP, CAMPANHA_NOME } from '../config';

export const enviarCheckout = createTool({
  id: 'enviar-checkout',
  description: 'Envia o link de checkout do curso para o lead via WhatsApp. Chame APENAS depois que o lead demonstrar intencao clara de compra (perguntou preco/como pagar/quero comprar/me manda o link). Nao envie no meio da qualificacao.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    motivoFechamento: z.string().describe('Resumo curto do que destravou a venda (ex: lead confirmou que tem o problema X e quer resolver agora)'),
    oferta: z.enum(['principal', 'orderbump']).default('principal').describe('Qual oferta enviar (principal por padrao)'),
    mensagemAcompanhante: z.string().optional().describe('Mensagem curta opcional que vai antes do link (ex: "Aqui ta, o link expira hoje a noite:")'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
    linkEnviado: z.string(),
  }),
  execute: async ({ telefone, motivoFechamento, oferta, mensagemAcompanhante }) => {
    const baseUrl = oferta === 'orderbump' ? CHECKOUT_URL_ORDERBUMP : CHECKOUT_URL_PRINCIPAL;
    if (!baseUrl) {
      console.error('[enviar-checkout] CHECKOUT_URL nao configurada no .env');
      return { sucesso: false, linkEnviado: '' };
    }

    const sessao = await getSessao(telefone);
    const conversaId = sessao?.conversaId || '';

    // Anexa UTM ao link para Roberth conseguir medir conversao
    const url = new URL(baseUrl);
    url.searchParams.set('utm_source', 'whatsapp');
    url.searchParams.set('utm_medium', 'agente-ia');
    url.searchParams.set('utm_campaign', CAMPANHA_NOME);
    url.searchParams.set('utm_content', conversaId || telefone);
    const linkFinal = url.toString();

    const texto = mensagemAcompanhante
      ? `${mensagemAcompanhante}\n\n${linkFinal}`
      : `Aqui esta o link da inscricao:\n\n${linkFinal}`;

    await enviarMensagem(telefone, texto);

    if (conversaId) {
      salvarMensagem({
        conversation_id: conversaId,
        role: 'assistant',
        content: texto,
        agent_table: 'vendedor',
        tool_name: 'enviar-checkout',
        tool_input: { motivoFechamento, oferta },
        tool_output: { linkEnviado: linkFinal },
      });
      atualizarConversa(conversaId, {
        link_enviado: true,
        link_enviado_em: new Date().toISOString(),
        oferta_enviada: oferta,
      });
    }

    console.log(`[enviar-checkout] ${telefone} ← link (${oferta}): ${motivoFechamento}`);
    return { sucesso: true, linkEnviado: linkFinal };
  },
});
