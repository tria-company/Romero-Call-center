import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { enviarMensagem } from '../evolution';
import { getSessao } from '../sessao';
import { salvarMensagem, atualizarConversa } from '../supabase';
import { CHECKOUT_URL_PRINCIPAL, CHECKOUT_URL_ORDERBUMP, CAMPANHA_NOME } from '../config';

export const enviarCheckout = createTool({
  id: 'enviar-checkout',
  description: 'Envia APENAS o link de checkout do curso pro lead via WhatsApp. Chame quando o lead demonstrar intencao clara de compra (pediu link / quero comprar / como pago / etc). A tool envia 1 mensagem com o link puro — voce e responsavel por mandar a frase de boas-vindas/transicao ANTES, na sua propria resposta. NAO duplica o texto: nao escreva "ja te mando" + "aqui esta o link" — basta uma frase curta de transicao na sua resposta, e a tool cuida do link.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    motivoFechamento: z.string().describe('Resumo curto do que destravou a venda (ex: lead confirmou que tem o problema X e quer resolver agora)'),
    oferta: z.enum(['principal', 'orderbump']).default('principal').describe('Qual oferta enviar (principal por padrao)'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
    linkEnviado: z.string(),
  }),
  execute: async ({ telefone, motivoFechamento, oferta }) => {
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

    // Envia APENAS o link puro. A frase de transicao (ex: "ja te mando o caminho")
    // e enviada pelo proprio agent.generate() como resposta normal — antes ou
    // depois desta tool, dependendo da ordem dos steps.
    // Antes a tool concatenava 'mensagemAcompanhante' + link, mas isso duplicava
    // texto: o LLM gerava o texto E passava o mesmo como mensagemAcompanhante,
    // resultando em ate 4 mensagens identicas no WhatsApp.
    // permitirUrl: true porque essa tool envia o link legitimo do Kiwify;
    // o filtro de URL no evolution.ts bloqueia outras chamadas que tentem URL.
    await enviarMensagem(telefone, linkFinal, { permitirUrl: true });

    if (conversaId) {
      salvarMensagem({
        conversation_id: conversaId,
        role: 'assistant',
        content: linkFinal,
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
