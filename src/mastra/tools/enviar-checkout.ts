import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { enviarMensagem } from '../ghl';
import { getSessao } from '../sessao';
import { salvarMensagem, atualizarConversa } from '../supabase';
import { CHECKOUT_URL_CAMINHO, CHECKOUT_URL_BOLHA, CHECKOUT_URL_PRINCIPAL } from '../config';

export const enviarCheckout = createTool({
  id: 'enviar-checkout',
  description: 'Envia APENAS o link de checkout pro lead via WhatsApp. Chame quando o lead demonstrar intencao clara de compra (pediu link / quero comprar / como pago / etc) E voce ja recomendou UM produto especifico (Caminho da Rainha OU Bolha RR). A tool envia 1 mensagem com o link puro — voce e responsavel por mandar a frase de transicao ANTES, na sua propria resposta. NAO duplica o texto: nao escreva "ja te mando" + "aqui esta o link" — basta uma frase curta de transicao na sua resposta, e a tool cuida do link.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    motivoFechamento: z.string().describe('Resumo curto do que destravou a venda (ex: lead solteira, padrao reconhecido, urgencia agora)'),
    produto: z.enum(['caminho', 'bolha']).describe('Qual produto foi recomendado: "caminho" (Caminho da Rainha, R$ 1.997) ou "bolha" (Bolha RR, R$ 2.997). Usado pra rastreio interno (oferta_enviada na conversa) — nao vai como UTM no link.'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
    linkEnviado: z.string(),
  }),
  execute: async ({ telefone, motivoFechamento, produto }) => {
    // Cada produto tem URL Kiwify propria. Fallback: CHECKOUT_URL_PRINCIPAL
    // (legado — se as ENVs especificas nao estiverem setadas, cai aqui).
    const urlPorProduto = produto === 'caminho' ? CHECKOUT_URL_CAMINHO : CHECKOUT_URL_BOLHA;
    const linkFinal = urlPorProduto || CHECKOUT_URL_PRINCIPAL;
    if (!linkFinal) {
      console.error(`[enviar-checkout] URL nao configurada pro produto "${produto}" (CHECKOUT_URL_${produto.toUpperCase()} ou CHECKOUT_URL_PRINCIPAL)`);
      return { sucesso: false, linkEnviado: '' };
    }

    const sessao = await getSessao(telefone);
    const conversaId = sessao?.conversaId || '';

    // Envia APENAS o link puro. A frase de transicao (ex: "fechado, vou te
    // mandar o link agora") e enviada pelo proprio agent.generate() como
    // resposta normal — antes ou depois desta tool, dependendo da ordem dos
    // steps. permitirUrl: true porque essa tool envia o link legitimo;
    // o filtro de URL no ghl.ts bloqueia outras chamadas que tentem URL.
    await enviarMensagem(telefone, linkFinal, { permitirUrl: true });

    if (conversaId) {
      salvarMensagem({
        conversation_id: conversaId,
        role: 'assistant',
        content: linkFinal,
        agent_table: 'vendedor',
        tool_name: 'enviar-checkout',
        tool_input: { motivoFechamento, produto },
        tool_output: { linkEnviado: linkFinal },
      });
      atualizarConversa(conversaId, {
        link_enviado: true,
        link_enviado_em: new Date().toISOString(),
        oferta_enviada: produto,
      });
    }

    console.log(`[enviar-checkout] ${telefone} ← link (${produto}): ${motivoFechamento}`);
    return { sucesso: true, linkEnviado: linkFinal };
  },
});
