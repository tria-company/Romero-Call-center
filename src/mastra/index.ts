import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';

// Agente unico do projeto Roberth
import { vendedorAgent } from './agents/vendedor';

// Evolution API (WhatsApp)
import { enviarMensagem, extrairNumero, extrairTexto, foiEnviadaPeloBot, ehMensagemAudio, baixarAudioBase64, transcreverAudio } from './evolution';
import type { EvolutionWebhookPayload } from './evolution';

// Bloqueio de IA (quando humano assume)
import { bloquearNumero, estaBloqueado, desbloquearNumero } from './bloqueio';

// Storage compartilhado (PostgreSQL/Supabase)
import { pgStore } from './memoria';

// Sessao
import { getSessao, criarSessao, AGENTES_MAP, type Sessao } from './sessao';

// Supabase (persistencia)
import { salvarMensagem, buscarCustomerPorTelefone } from './supabase';

// Buffer de mensagens (debounce 10s)
import { adicionarAoBuffer } from './buffer';

// Reset de teste (#55555)
import { resetarConversaTeste, COMANDO_RESET } from './reset';

// Timeout e retry para agent.generate()
const TIMEOUT_AGENTE = 60_000;
const MAX_TENTATIVAS = 3;

function comTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`[timeout] ${label} excedeu ${ms / 1000}s`)), ms);
    }),
  ]);
}

async function comRetry<T>(fn: () => Promise<T>, tentativas: number, label: string): Promise<T> {
  for (let i = 1; i <= tentativas; i++) {
    try {
      return await fn();
    } catch (erro: any) {
      console.error(`[retry] ${label} falhou (tentativa ${i}/${tentativas}): ${erro.message}`);
      if (i === tentativas) throw erro;
      await new Promise(r => setTimeout(r, i * 2000));
    }
  }
  throw new Error(`[retry] ${label} esgotou tentativas`);
}

async function processarMensagem(mastraRef: Mastra, numero: string, texto: string, nome: string) {
  try {
    let sessao = await getSessao(numero);
    if (!sessao) {
      const dadosCustomer: Partial<Sessao> = { agenteAtual: 'vendedor' };
      const customerExistente = await buscarCustomerPorTelefone(numero);
      if (customerExistente) {
        dadosCustomer.nome = customerExistente.nome || '';
        dadosCustomer.email = customerExistente.email || '';
        dadosCustomer.customerId = customerExistente.id;
      }
      if (nome && nome !== 'Não identificado' && !dadosCustomer.nome) {
        dadosCustomer.nome = nome;
      }
      sessao = await criarSessao(numero, dadosCustomer);
    }

    if (sessao.conversaId) {
      salvarMensagem({
        conversation_id: sessao.conversaId,
        role: 'user',
        content: texto,
        agent_table: sessao.agenteAtual,
      });
    }

    // Conversa pausada por humano — IA fica em silencio absoluto.
    // O aviso de transicao ja foi enviado pela Sofia antes do handoff;
    // a notificacao ao time vai pelo grupo SUPORTE (ver tools/handoff-humano.ts).
    // Repetir mensagem aqui gera loop ("voce esta sendo atendido..." a cada turno).
    if (sessao.agenteAtual === 'humano') {
      console.log(`[WhatsApp] ${numero} em handoff humano — IA silenciada, mensagem ignorada`);
      return;
    }

    const agenteKey = AGENTES_MAP[sessao.agenteAtual] || 'vendedorAgent';
    const agent = mastraRef.getAgent(agenteKey);
    console.log(`[WhatsApp] Roteando para: ${sessao.agenteAtual} (${agenteKey})`);

    const nomeFormatado = sessao.nome && sessao.nome !== 'Não identificado'
      ? sessao.nome
      : (nome && nome !== 'Não identificado' ? nome : '');

    const prompt = nomeFormatado
      ? `[telefone: ${numero}] ${nomeFormatado} diz: ${texto}`
      : `[telefone: ${numero}] (lead sem nome ainda) diz: ${texto}`;

    const resposta = await comRetry(
      () => comTimeout(agent.generate(prompt, { threadId: numero, resourceId: numero }), TIMEOUT_AGENTE, sessao.agenteAtual),
      MAX_TENTATIVAS,
      sessao.agenteAtual,
    );

    if (resposta.text) {
      await enviarMensagem(numero, resposta.text);

      if (sessao.conversaId) {
        salvarMensagem({
          conversation_id: sessao.conversaId,
          role: 'assistant',
          content: resposta.text,
          agent_table: sessao.agenteAtual,
        });
      }
    }
  } catch (erro) {
    console.error('[WhatsApp] Erro ao processar mensagem:', erro);
    await enviarMensagem(numero, 'Tive um problema rapido aqui. Voce pode reenviar a ultima mensagem?');
  }
}

export const mastra = new Mastra({
  agents: {
    vendedorAgent,
  },
  storage: pgStore,
  logger: new PinoLogger({
    name: 'Roberth',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'roberth-vendedor',
        exporters: [
          new DefaultExporter(),
          new CloudExporter(),
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(),
        ],
      },
    },
  }),
  server: {
    apiRoutes: [
      // Reativa a IA manualmente quando o humano termina o atendimento
      {
        path: '/api/desbloquear',
        method: 'POST',
        handler: async (c) => {
          try {
            const { telefone } = await c.req.json() as { telefone: string };
            if (!telefone) {
              return c.json({ erro: 'telefone obrigatorio' }, 400);
            }
            await desbloquearNumero(telefone);
            return c.json({ status: 'desbloqueado', telefone });
          } catch (erro) {
            return c.json({ status: 'erro', mensagem: String(erro) }, 500);
          }
        },
      },
      {
        path: '/api/webhook/evolution',
        method: 'POST',
        handler: async (c) => {
          try {
            const payload = await c.req.json() as EvolutionWebhookPayload;

            if (payload.event !== 'messages.upsert') {
              return c.json({ status: 'ignorado' });
            }

            // Mensagem fromMe — descobre se foi humano ou bot
            if (payload.data?.key?.fromMe) {
              const remoteJid = payload.data.key.remoteJid;
              if (remoteJid.endsWith('@g.us')) {
                return c.json({ status: 'grupo ignorado' });
              }
              const messageId = payload.data.key.id;
              if (messageId && !foiEnviadaPeloBot(messageId)) {
                const numero = extrairNumero(remoteJid);
                await bloquearNumero(numero);
              }
              return c.json({ status: 'fromMe processado' });
            }

            if (payload.data.key.remoteJid.endsWith('@g.us')) {
              return c.json({ status: 'grupo ignorado' });
            }

            const numero = extrairNumero(payload.data.key.remoteJid);
            const nome = payload.data.pushName || 'Não identificado';

            if (await estaBloqueado(numero)) {
              console.log(`[WhatsApp] IA bloqueada para ${numero}, humano atendendo`);
              return c.json({ status: 'bloqueado_humano' });
            }

            let texto = extrairTexto(payload);

            if (!texto && ehMensagemAudio(payload)) {
              console.log(`[WhatsApp] Audio recebido de ${nome} (${numero}), transcrevendo...`);
              const base64 = await baixarAudioBase64(payload);
              if (base64) {
                const transcricao = await transcreverAudio(base64);
                if (transcricao) texto = transcricao;
              }
              if (!texto) {
                await enviarMensagem(numero, 'Nao consegui entender o audio. Pode mandar em texto?');
                return c.json({ status: 'audio nao transcrito' });
              }
            }

            if (!texto) {
              return c.json({ status: 'sem texto' });
            }

            // Comando de reset de teste (#55555): apaga sessao, conversa, memoria
            // e responde "memoria limpa" sem passar pelo agente.
            if (texto.trim() === COMANDO_RESET) {
              console.log(`[WhatsApp] Comando ${COMANDO_RESET} recebido de ${numero}, resetando...`);
              const resultado = await resetarConversaTeste(numero);
              const status = resultado.erros.length === 0 ? 'memoria limpa, pode comecar de novo' : 'memoria limpa (alguns subitens falharam, ver logs)';
              await enviarMensagem(numero, `🧹 ${status}`);
              return c.json({ status: 'reset', ...resultado });
            }

            console.log(`[WhatsApp] Mensagem de ${nome} (${numero}): ${texto}`);

            adicionarAoBuffer(numero, texto, nome, (num, textoCompleto, nomeCliente) => {
              processarMensagem(mastra, num, textoCompleto, nomeCliente);
            });

            return c.json({ status: 'bufferizado' });
          } catch (erro) {
            console.error('[WhatsApp] Erro no webhook:', erro);
            return c.json({ status: 'erro', mensagem: String(erro) }, 500);
          }
        },
      },
    ],
  },
});
