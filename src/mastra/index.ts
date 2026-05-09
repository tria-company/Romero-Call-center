import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';

// Agente unico do projeto Roberth
import { vendedorAgent } from './agents/vendedor';

// GoHighLevel (canal WhatsApp via API oficial). Substitui Evolution.
import {
  enviarMensagem,
  extrairTelefone,
  extrairContactId,
  extrairTexto,
  extrairNome,
  ehMensagemAudio,
  baixarAudioBase64,
  transcreverAudio,
} from './ghl';
import type { GhlWebhookPayload } from './ghl';

// Bloqueio de IA (quando humano assume)
import { estaBloqueado, desbloquearNumero } from './bloqueio';

// Storage compartilhado (PostgreSQL/Supabase)
import { pgStore } from './memoria';

// Sessao
import { getSessao, criarSessao, AGENTES_MAP, type Sessao } from './sessao';

// Memory (so para debug de leitura por turno)
import { memoria } from './memoria';

// Supabase (persistencia)
import { salvarMensagem, buscarCustomerPorTelefone, marcarMsgLead, marcarMsgSofia, salvarErro } from './supabase';

// Buffer de mensagens (debounce 10s)
import { adicionarAoBuffer } from './buffer';

// Reset de teste (#55555)
import { resetarConversaTeste, COMANDO_RESET } from './reset';

// Scheduler de follow-ups (1h/3h/5h) e handoff por silencio (24h)
import { iniciarFollowUpScheduler } from './follow-up';

// Notificacao ao grupo de suporte em caso de erro
import { enviarAvisoAoSuporte, jaNotificouRecentemente } from './notificacoes';

// Dashboard de metricas + viewer de conversa
import { handlerDashboard, handlerConversa } from './dashboard';

// Classifica o tipo de erro do agent.generate pra metrica agregada no dashboard.
function classificarErro(erro: any): string {
  const msg = String(erro?.message || erro || '').toLowerCase();
  if (msg.includes('content_filter') || msg.includes('responsibleai') || msg.includes('content management policy')) return 'content_filter';
  if (msg.includes('timeout') || msg.includes('exceeded')) return 'timeout';
  if (msg.includes('rate') || msg.includes('429')) return 'rate_limit';
  return 'outro';
}

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
      // Lead voltou a falar: registra timestamp e zera marcadores de FUP/handoff
      // (proximo silencio comeca do zero). O scheduler em follow-up.ts depende
      // dessas colunas pra decidir quando mandar 1h/3h/5h e quando dar handoff
      // automatico em 24h.
      marcarMsgLead(sessao.conversaId);
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

    // DEBUG da memoria: quantas mensagens a Memory devolve pra esse threadId
    try {
      const memAny = memoria as unknown as Record<string, any>;
      if (typeof memAny.query === 'function') {
        const result = await memAny.query({ threadId: numero, resourceId: numero, selectBy: { last: 40 } });
        const count = Array.isArray(result?.messages) ? result.messages.length : Array.isArray(result) ? result.length : 0;
        console.log(`[memoria] ${numero} → ${count} mensagens recuperadas pelo Mastra`);
      } else if (typeof memAny.getMessages === 'function') {
        const result = await memAny.getMessages({ threadId: numero });
        const count = Array.isArray(result) ? result.length : Array.isArray(result?.messages) ? result.messages.length : 0;
        console.log(`[memoria] ${numero} → ${count} mensagens recuperadas pelo Mastra`);
      }
    } catch (e) {
      console.log(`[memoria] erro ao consultar memoria de ${numero}: ${(e as Error).message}`);
    }

    const nomeFormatado = sessao.nome && sessao.nome !== 'Não identificado'
      ? sessao.nome
      : (nome && nome !== 'Não identificado' ? nome : '');

    const prompt = nomeFormatado
      ? `[telefone: ${numero}] ${nomeFormatado} diz: ${texto}`
      : `[telefone: ${numero}] (lead sem nome ainda) diz: ${texto}`;

    const resposta = await comRetry(
      () => comTimeout(
        // Mastra v1.17+: usar { memory: { thread, resource } }.
        // O formato antigo { threadId, resourceId } e ignorado em alguns
        // contextos, fazendo o agent perder historico de mensagens entre
        // turnos (sintoma: Sofia recomeca a conversa toda vez).
        agent.generate(prompt, {
          memory: { thread: numero, resource: numero },
          threadId: numero,
          resourceId: numero,
        } as any),
        TIMEOUT_AGENTE,
        sessao.agenteAtual,
      ),
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
        // Sofia falou: inicia (ou reinicia) o relogio de silencio. Se o lead
        // sumir agora, o scheduler vai disparar FUP1 em 1h.
        marcarMsgSofia(sessao.conversaId);
      }
    }
  } catch (erro) {
    // NAO enviar mensagem visivel ao lead em caso de erro — antes mandavamos
    // 'Tive um problema rapido aqui. Voce pode reenviar a ultima mensagem?',
    // mas isso virava loop infinito visivel quando o erro era persistente
    // (ex: timeout repetido no Azure OpenAI sob carga). Comprovado nos
    // relatorios do Teste 4 (ClickUp 868jjn1f4): 6 dos 9 cenarios reprovados
    // tinham loops dessa frase.
    //
    // Comportamento atual: silencio pro lead + alerta no grupo de suporte
    // + persistencia em errors_roberth (pra dashboard agregar/listar).
    console.error('[WhatsApp] Erro ao processar mensagem (silencioso pro lead):', erro);

    const mensagemErro = String((erro as Error)?.message || erro).slice(0, 500);
    const errorCode = classificarErro(erro);

    // Persistir no Supabase pra aparecer no dashboard (silencioso se Supabase falhar).
    let sessaoAtual: any = null;
    try { sessaoAtual = await getSessao(numero); } catch { /* ignore */ }
    salvarErro({
      telefone: numero,
      nome: nome || sessaoAtual?.nome,
      error_message: mensagemErro,
      error_code: errorCode,
      conversation_id: sessaoAtual?.conversaId || null,
      customer_id: sessaoAtual?.customerId || null,
      context: { texto_lead: texto?.slice(0, 200), agente_atual: sessaoAtual?.agenteAtual },
    }).catch((e) => console.error('[supabase] Falha ao salvar erro:', e));

    // Notifica grupo de suporte (idempotencia de 1h por telefone — evita
    // virar spam no grupo se erro persistir turno apos turno).
    if (!jaNotificouRecentemente(numero, 'erro_agente')) {
      enviarAvisoAoSuporte([
        '🚨 *Erro no agente — atender o lead manualmente*',
        `Lead: ${nome || '(sem nome)'}`,
        `Telefone: ${numero}`,
        `Codigo: ${errorCode}`,
        `Erro: ${mensagemErro.slice(0, 250)}`,
        '',
        'A IA falhou ao gerar resposta neste turno. Alguem do time precisa olhar.',
      ]).catch((e) => console.error('[notificacao] Falha ao avisar grupo:', e));
    }
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
      // Dashboard de metricas (Basic Auth via env DASHBOARD_USER/PASS)
      {
        path: '/api/dashboard',
        method: 'GET',
        handler: handlerDashboard,
      },
      // Viewer de uma conversa especifica em estilo WhatsApp
      {
        path: '/api/dashboard/conversa/:id',
        method: 'GET',
        handler: handlerConversa,
      },
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
        // URL mantida (/api/webhook/evolution) pra nao precisar reconfigurar
        // o GHL Workflow. O parser foi trocado pra formato GHL.
        path: '/api/webhook/evolution',
        method: 'POST',
        handler: async (c) => {
          try {
            const payload = await c.req.json() as GhlWebhookPayload;

            const numero = extrairTelefone(payload);
            const ghlContactId = extrairContactId(payload);
            const nome = extrairNome(payload);
            let texto = extrairTexto(payload);

            // Validacao basica do payload
            if (!numero || !ghlContactId) {
              console.warn('[GHL] payload sem telefone ou contact_id, ignorando:', JSON.stringify(payload).slice(0, 500));
              return c.json({ status: 'payload invalido' });
            }

            // Bloqueio manual (humano assumiu via /api/desbloquear externo, ou
            // futuramente via outro workflow do GHL marcando bloqueio).
            if (await estaBloqueado(numero)) {
              console.log(`[GHL] IA bloqueada para ${numero}, humano atendendo`);
              return c.json({ status: 'bloqueado_humano' });
            }

            // Audio: detecta URL de attachments, baixa, transcreve via Azure.
            if (!texto && ehMensagemAudio(payload)) {
              console.log(`[GHL] Audio recebido de ${nome} (${numero}), transcrevendo...`);
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
              // Diagnostico: log do customData pra ajudar a entender o formato
              // de attachments do GHL quando body vier vazio. Util pra ajustar
              // a regex de detecao de audio se algum formato escapar.
              console.log('[GHL][debug] mensagem sem texto. customData:',
                JSON.stringify(payload.customData),
                '| message.type:', payload.message?.type);
              return c.json({ status: 'sem texto' });
            }

            // Garante que a sessao tem o ghlContactId em cache antes do buffer
            // disparar processarMensagem. Sem isso, enviarMensagem nao consegue
            // resolver o contactId no momento do envio.
            try {
              const sessaoExistente = await getSessao(numero);
              if (!sessaoExistente) {
                await criarSessao(numero, { nome, ghlContactId, agenteAtual: 'vendedor' });
              } else if (sessaoExistente.ghlContactId !== ghlContactId) {
                // Atualiza ghlContactId se mudou (raro, mas pra garantir consistencia)
                const { atualizarSessao } = await import('./sessao');
                await atualizarSessao(numero, { ghlContactId });
              }
            } catch (e) {
              console.error('[GHL] erro ao garantir sessao com ghlContactId:', e);
            }

            // Comando de reset de teste (#55555).
            if (texto.trim() === COMANDO_RESET) {
              console.log(`[GHL] Comando ${COMANDO_RESET} recebido de ${numero}, resetando...`);
              const resultado = await resetarConversaTeste(numero);
              const status = resultado.erros.length === 0 ? 'memoria limpa, pode comecar de novo' : 'memoria limpa (alguns subitens falharam, ver logs)';
              await enviarMensagem(numero, `🧹 ${status}`);
              return c.json({ status: 'reset', ...resultado });
            }

            console.log(`[GHL] Mensagem de ${nome} (${numero}, contact:${ghlContactId}): ${texto}`);

            adicionarAoBuffer(numero, texto, nome, (num, textoCompleto, nomeCliente) => {
              processarMensagem(mastra, num, textoCompleto, nomeCliente);
            });

            return c.json({ status: 'bufferizado' });
          } catch (erro) {
            console.error('[GHL] Erro no webhook:', erro);
            return c.json({ status: 'erro', mensagem: String(erro) }, 500);
          }
        },
      },
    ],
  },
});

// Scheduler de follow-ups (1h/3h/5h) e handoff por silencio (24h).
// Roda em background no mesmo container — 1 replica Docker Swarm garante
// que so 1 processo varre, sem risco de duplicacao. State no Supabase
// sobrevive reinicio.
iniciarFollowUpScheduler(mastra);
