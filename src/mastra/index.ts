import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';

// Agente do projeto Roberth (Closer)
import { vendedorAgent } from './agents/vendedor';

// Agente Qualificador (SDR AUTON) — processa o form 14q em modo batch (01-04)
import { qualificadorAgent } from './agents/qualificador';

// Modulos puros do fluxo de qualificacao SDR AUTON (parse do form + BANT/roteamento)
import { parseFormulario } from './formulario';
import { decidirRoteamento } from './bant';

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
  buscarUltimaMensagem,
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
import { salvarMensagem, buscarCustomerPorTelefone, marcarMsgLead, marcarMsgSofia, salvarErro, tentarRegistrarWebhook, confirmarPagamento } from './supabase';

// Tokens dos webhooks Kiwify (1 por produto)
import { KIWIFY_TOKEN_CAMINHO, KIWIFY_TOKEN_BOLHA } from './config';

// Buffer de mensagens (debounce 10s, com persistencia)
import { adicionarAoBuffer } from './buffer';

// crypto pra hash de dedup do webhook
import { createHash } from 'crypto';

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
    qualificadorAgent,
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
      // Webhook Kiwify — confirma pagamento e marca conversao do agente.
      // 1 endpoint, 2 produtos (path param). Cada produto tem token proprio.
      // URL no Kiwify: https://<host>/api/webhook/kiwify/<produto>?token=<TOKEN>
      // So marca como conversao se o telefone foi atendido pela Sofia antes
      // (existe customer + alguma conversa). Pagou via anuncio direto sem
      // falar no whats -> ignorado (status: 'sem_atendimento').
      {
        path: '/api/webhook/kiwify/:produto',
        method: 'POST',
        handler: async (c) => {
          try {
            const produto = c.req.param('produto');
            if (produto !== 'caminho' && produto !== 'bolha') {
              return c.json({ status: 'produto invalido' }, 400);
            }
            const token = c.req.query('token') || '';
            const expected = produto === 'caminho' ? KIWIFY_TOKEN_CAMINHO : KIWIFY_TOKEN_BOLHA;
            if (!expected || token !== expected) {
              console.warn(`[kiwify] token invalido pra ${produto} (recebido: "${token.slice(0, 4)}...")`);
              return c.json({ status: 'unauthorized' }, 401);
            }

            const payload = await c.req.json() as any;

            // Parse tolerante — Kiwify usa diferentes envelopes (Customer, Order)
            // dependendo da versao/lingua. Prioriza camelCase comum.
            const evento = String(payload.webhook_event_type || payload.event || '').toLowerCase();
            const statusKiwify = String(payload.order_status || payload.Order?.status || payload.status || '').toLowerCase();
            const ehAprovado =
              evento === 'order_approved' ||
              evento === 'paid' ||
              statusKiwify === 'paid' ||
              statusKiwify === 'approved';
            if (!ehAprovado) {
              console.log(`[kiwify] evento ignorado: ${produto} evento="${evento}" status="${statusKiwify}"`);
              return c.json({ status: 'evento ignorado', evento, statusKiwify });
            }

            const telefoneRaw = String(
              payload.Customer?.mobile ||
              payload.Customer?.phone ||
              payload.customer?.phone ||
              payload.customer?.mobile ||
              ''
            );
            const telefone = telefoneRaw.replace(/[^\d]/g, '');
            const orderId = String(payload.order_id || payload.Order?.id || payload.id || '');
            const valorRaw = payload.Commissions?.charge_amount || payload.Order?.total_value || payload.amount || payload.charge_amount || '0';
            // Kiwify as vezes manda valor em centavos (string ou number) — heuristica:
            // se valor inteiro > 10000 e string sem ponto, divide por 100.
            const valorParsed = parseFloat(String(valorRaw).replace(',', '.'));
            const valor = Number.isFinite(valorParsed) ? valorParsed : 0;

            if (!telefone || !orderId) {
              console.warn('[kiwify] payload incompleto:', JSON.stringify(payload).slice(0, 400));
              return c.json({ status: 'payload incompleto' }, 400);
            }

            const result = await confirmarPagamento({
              telefone,
              kiwify_order_id: orderId,
              valor_pago: valor,
              produto,
            });

            if (!result.novo) {
              const motivo = result.ignorado;
              console.log(`[kiwify] ${produto} order ${orderId} ignorado (${motivo}) pra ${telefone}`);
              return c.json({ status: motivo, orderId });
            }

            console.log(`[kiwify] ✓ pagamento confirmado: ${telefone} ← ${produto} R$${valor.toFixed(2)} (order ${orderId})`);

            const produtoLabel = produto === 'caminho' ? 'Caminho da Rainha' : 'Bolha RR';
            enviarAvisoAoSuporte([
              '🎉 *Conversao confirmada*',
              `Lead: ${result.nome || '(sem nome)'}`,
              `Telefone: ${telefone}`,
              `Produto: ${produtoLabel}`,
              `Valor: R$ ${valor.toFixed(2)}`,
              `Order: ${orderId}`,
            ]).catch((e) => console.error('[kiwify] Falha notificar grupo:', e));

            return c.json({ status: 'confirmado', orderId, produto });
          } catch (erro) {
            console.error('[kiwify] Erro no webhook:', erro);
            return c.json({ status: 'erro', mensagem: String(erro) }, 500);
          }
        },
      },
      // Webhook do formulario de 14 perguntas (SDR AUTON — dispara no submit
      // do GHL Workflow, stage "Formulario respondido"). Parse + BANT +
      // roteamento sao 100% deterministicos (formulario.ts/bant.ts, sem
      // LLM); o qualificadorAgent so EXECUTA as gravacoes (bant_*, ancora,
      // spin_stage, motivo_perdido) + o move de card com o resultado ja
      // pronto. QUAL-02: se o roteamento for PERDIDO, nenhuma mensagem e
      // enviada ao lead (o Qualificador nao tem tool de envio de WhatsApp).
      {
        path: '/api/webhook/formulario',
        method: 'POST',
        handler: async (c) => {
          try {
            const payload = await c.req.json() as Record<string, unknown>;

            // Telefone/nome/contactId: aceita variantes comuns de payload
            // (GHL Workflow costuma mandar {{contact.phone}}/{{contact.name}}
            // como texto puro no corpo do POST). Formato exato e Claude's
            // Discretion (01-CONTEXT.md).
            const contatoBruto = (payload.contact as Record<string, unknown>) || {};
            const telefoneRaw = String(payload.telefone || payload.phone || contatoBruto.phone || '');
            const telefone = telefoneRaw.replace(/[^\d]/g, '');
            const nomeBruto = String(payload.nome || payload.name || contatoBruto.name || '');
            const nome = nomeBruto || 'Não identificado';
            const contactId = String(payload.contactId || payload.contact_id || contatoBruto.id || '') || undefined;

            if (!telefone) {
              console.warn('[formulario] payload sem telefone, ignorando:', JSON.stringify(payload).slice(0, 400));
              return c.json({ status: 'payload invalido' }, 400);
            }

            const form = parseFormulario(payload as any);
            const roteamento = decidirRoteamento(form);

            console.log(
              `[formulario] ${telefone} -> ${roteamento.stage}` +
              (roteamento.stage === 'PERDIDO' ? ` (${roteamento.motivo})` : '') +
              (roteamento.bant ? ` bant_total=${roteamento.bant.total}` : ''),
            );

            // Garante sessao com ghlContactId em cache ANTES de invocar o
            // agente — mesma logica do webhook de mensagens — pra tools do
            // Qualificador (read-lead-ficha, gravar-bant-fields, etc)
            // resolverem contactId sem lookup extra via API.
            try {
              const sessaoExistente = await getSessao(telefone);
              if (!sessaoExistente) {
                await criarSessao(telefone, { nome, ghlContactId: contactId, agenteAtual: 'qualificador' });
              } else if (contactId && sessaoExistente.ghlContactId !== contactId) {
                const { atualizarSessao } = await import('./sessao');
                await atualizarSessao(telefone, { ghlContactId: contactId });
              }
            } catch (e) {
              console.error('[formulario] erro ao garantir sessao:', e);
            }

            // Prompt de entrada do Qualificador: o resultado de
            // decidirRoteamento ja vem PRONTO (o agente nao recalcula BANT
            // nem reavalia o Filtro 1/2 — so executa as gravacoes e o move
            // de card com o que o codigo deterministico decidiu).
            const promptPartes = [
              `Telefone: ${telefone}`,
              `Stage decidido: ${roteamento.stage}`,
            ];
            if (roteamento.stage === 'PERDIDO') {
              promptPartes.push(`Motivo: ${roteamento.motivo}`);
            }
            if (roteamento.bant) {
              const { budget, authority, need, timing, total } = roteamento.bant;
              promptPartes.push(`BANT: budget=${budget} authority=${authority} need=${need} timing=${timing} total=${total}`);
            }
            promptPartes.push(
              `Ancora 08 (aplicou Metodo ADS?): ${form.q08 || '(nao respondeu)'}`,
              `Ancora 12 (modulo que ficou/interrompido): ${form.q12 || '(nao respondeu)'}`,
              `Ancora 14 (maior dificuldade hoje): ${form.q14 || '(nao respondeu)'}`,
            );
            const prompt = promptPartes.join('\n');

            const agent = mastra.getAgent('qualificadorAgent');
            await comRetry(
              () => comTimeout(agent.generate(prompt), TIMEOUT_AGENTE, 'qualificador'),
              MAX_TENTATIVAS,
              'qualificador',
            );

            return c.json({ status: 'processado', stage: roteamento.stage });
          } catch (erro) {
            console.error('[formulario] Erro no webhook:', erro);
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

            // Idempotencia: GHL Workflow as vezes dispara webhook 2-3x por bug
            // de rede/retry automatico. Sem dedup, o mesmo payload viraria 2-3
            // mensagens identicas pro lead. Hash inclui contact_id + conteudo
            // (body + attachments + tipo) + bucket de tempo de 1min — webhooks
            // duplicados na mesma janela sao descartados.
            const conteudoBruto = JSON.stringify({
              body: payload.customData?.body || payload.message?.body || '',
              attachments: payload.customData?.attachments || '',
              type: payload.message?.type ?? '',
            });
            const minBucket = Math.floor(Date.now() / 60_000);
            const hashWebhook = createHash('sha1')
              .update(`${ghlContactId}|${conteudoBruto}|${minBucket}`)
              .digest('hex');
            const ehNovoWebhook = await tentarRegistrarWebhook(hashWebhook);
            if (!ehNovoWebhook) {
              console.log(`[GHL] webhook duplicado descartado (hash=${hashWebhook.slice(0, 8)}, contact=${ghlContactId})`);
              return c.json({ status: 'duplicado' });
            }

            // Bloqueio manual (humano assumiu via /api/desbloquear externo, ou
            // futuramente via outro workflow do GHL marcando bloqueio).
            if (await estaBloqueado(numero)) {
              console.log(`[GHL] IA bloqueada para ${numero}, humano atendendo`);
              return c.json({ status: 'bloqueado_humano' });
            }

            // Garante sessao com ghlContactId em cache ANTES de qualquer
            // fallback que possa chamar enviarMensagem. Sem isso, mensagens
            // de fallback (audio falhou, formato nao reconhecido) caem no
            // /contacts/lookup que as vezes retorna 400 — e o lead nao
            // recebe aviso nenhum. Cache em sessao resolve com 0 chamadas
            // adicionais a API.
            try {
              const sessaoExistente = await getSessao(numero);
              if (!sessaoExistente) {
                await criarSessao(numero, { nome, ghlContactId, agenteAtual: 'vendedor' });
              } else if (sessaoExistente.ghlContactId !== ghlContactId) {
                const { atualizarSessao } = await import('./sessao');
                await atualizarSessao(numero, { ghlContactId });
              }
            } catch (e) {
              console.error('[GHL] erro ao garantir sessao com ghlContactId:', e);
            }

            // Fallback: o Workflow GHL nao popula {{message.attachments}} pra
            // mensagens de audio. Quando body+attachments vierem vazios,
            // buscamos a ultima mensagem do contato direto via API GHL.
            if (!texto && !ehMensagemAudio(payload)) {
              console.log(`[GHL] body+attachments vazios — buscando ultima msg via API pra ${ghlContactId}`);
              const ultima = await buscarUltimaMensagem(ghlContactId, payload.location?.id);
              if (ultima) {
                console.log(`[GHL][api] msg recuperada. body="${ultima.body.slice(0,80)}" attachments=${JSON.stringify(ultima.attachments).slice(0,200)} type=${ultima.type}`);
                if (ultima.body) {
                  texto = ultima.body;
                } else if (ultima.attachments.length > 0) {
                  // Injeta attachments no payload pra fluir pelo path de audio
                  payload.customData = payload.customData || {};
                  payload.customData.attachments = ultima.attachments as any;
                }
              }
            }

            // Mensagem amigavel quando nao conseguimos entender (audio falhou
            // OU formato nao reconhecido — sticker, imagem sem caption, etc).
            // Idempotente em 1h pra nao virar spam se o lead mandar varios
            // audios seguidos.
            const MSG_AUDIO_FALHOU = 'oi! tá com muito barulho aqui e não consegui escutar direito 🙉 consegue digitar pra mim pra eu te responder?';

            // Audio: detecta URL de attachments, baixa, transcreve via Azure.
            if (!texto && ehMensagemAudio(payload)) {
              console.log(`[GHL] Audio recebido de ${nome} (${numero}), transcrevendo...`);
              const base64 = await baixarAudioBase64(payload);
              if (base64) {
                const transcricao = await transcreverAudio(base64);
                if (transcricao) texto = transcricao;
              }
              if (!texto) {
                if (!jaNotificouRecentemente(numero, 'audio_falhou')) {
                  await enviarMensagem(numero, MSG_AUDIO_FALHOU).catch((e) => console.error('[GHL] Falha ao enviar fallback de audio:', e));
                }
                return c.json({ status: 'audio nao transcrito' });
              }
            }

            if (!texto) {
              // Diagnostico final: payload completo e customData pra debug
              // de formatos de attachment ainda nao tratados.
              console.log('[GHL][debug] mensagem sem texto apos todos fallbacks. customData:',
                JSON.stringify(payload.customData),
                '| message.type:', payload.message?.type);
              if (!jaNotificouRecentemente(numero, 'audio_falhou')) {
                await enviarMensagem(numero, MSG_AUDIO_FALHOU).catch((e) => console.error('[GHL] Falha ao enviar fallback de mensagem nao reconhecida:', e));
              }
              return c.json({ status: 'sem texto' });
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

// Scheduler de follow-ups (1h/3h/5h) e handoff por silencio (24h),
// recovery do buffer persistente, e cleanups periodicos.
// Roda em background no mesmo container — 1 replica Docker Swarm garante
// que so 1 processo varre, sem risco de duplicacao. State no Supabase
// sobrevive reinicio.
//
// O callback abaixo e o handler de buffer-recovery: se um container caiu
// nos 10s de debounce do buffer (deixando msgs orfas no Supabase), outro
// container pega e processa via essa funcao. Reusa o mesmo processarMensagem
// do webhook handler.
iniciarFollowUpScheduler(mastra, (numero, texto, nome) => {
  return processarMensagem(mastra, numero, texto, nome);
});
