import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';

// Agente do projeto Roberth (Closer)
import { vendedorAgent } from './agents/vendedor';

// Agente Qualificador (SDR AUTON) — processa o form 14q em modo batch (01-04)
import { qualificadorAgent } from './agents/qualificador';

// Agente Camila (SDR AUTON) — conduz o SPIN, saida em JSON estrito (01-05)
import { camilaAgent } from './agents/camila';

// Schema JSON estrito da Camila + parse seguro (01-05, CAM-03)
import { parseSaidaCamila } from './camila-schema';

// Tools GHL do allowlist da Camila — o dispatcher (despacharSaidaCamila,
// abaixo) e o UNICO executor real dessas tools quando a Camila as declara
// em tools_a_executar[] (contrato travado em 01-CONTEXT.md: a Camila nunca
// executa tool nativamente, evita dupla execucao).
import { readLeadFicha } from './tools/read-lead-ficha';
import { readConversationHistory } from './tools/read-conversation-history';
import { sendWhatsappMessage } from './tools/send-whatsapp-message';
import { updateContactField } from './tools/update-contact-field';
import { movePipelineStage } from './tools/move-pipeline-stage';
import { createTask } from './tools/create-task';
import { createCalendarEvent } from './tools/create-calendar-event';
import { escalateToHuman } from './tools/escalate-to-human';
import { logNote } from './tools/log-note';

// Modulos puros do fluxo de qualificacao SDR AUTON (parse do form + BANT/roteamento)
import { parseFormulario } from './formulario';
import { decidirRoteamento } from './bant';

// Dupla acao (QUAL-04): quando o Qualificador marca o lead como QUALIFICADO,
// dispara a abertura proativa da Camila + a task priorizada pro SDR humano.
import { dispararDuplaAcao } from './dupla-acao';

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

// Mapa tool-id (allowlist da Camila, camila-schema.ts) -> executor real da
// tool. `create_calendar_event` (01-07): a tool ja existe
// (tools/create-calendar-event.ts) e o executor foi adicionado aqui — antes
// da 01-07 essa chave ficava de fora de proposito, e se a Camila
// declarasse, o dispatcher logava e ignorava.
type ExecutorTool = (args: Record<string, unknown>) => Promise<unknown>;

const CAMILA_TOOLS_EXECUTORES: Record<string, ExecutorTool> = {
  read_lead_ficha: (args) => readLeadFicha.execute!(args as any, {} as any),
  read_conversation_history: (args) => readConversationHistory.execute!(args as any, {} as any),
  send_whatsapp_message: (args) => sendWhatsappMessage.execute!(args as any, {} as any),
  update_contact_field: (args) => updateContactField.execute!(args as any, {} as any),
  move_pipeline_stage: (args) => movePipelineStage.execute!(args as any, {} as any),
  create_task: (args) => createTask.execute!(args as any, {} as any),
  create_calendar_event: (args) => createCalendarEvent.execute!(args as any, {} as any),
  escalate_to_human: (args) => escalateToHuman.execute!(args as any, {} as any),
  log_note: (args) => logNote.execute!(args as any, {} as any),
};

/**
 * Dispatcher do JSON estrito da Camila (CAM-03 runtime). Parseia a saida
 * bruta do LLM (parseSaidaCamila), executa cada item de tools_a_executar[]
 * (1x cada, aqui — nunca a propria Camila) e envia mensagens[] respeitando
 * delay_ms[]. Funcao EXPORTADA e reutilizavel (01-CONTEXT.md: "Dispatcher
 * reutilizavel") — a abertura proativa da Camila (01-06) chama a mesma
 * funcao com o texto bruto gerado pelo agente, sem duplicar essa logica.
 *
 * T-05-JSON: se o parse falhar (JSON malformado ou schema invalido), NAO
 * envia nada ao lead — loga + notifica suporte (idempotente) em vez de
 * arriscar mandar lixo pro WhatsApp. Retorna `true` quando pelo menos 1
 * mensagem foi de fato enviada ao lead (usado pelo caller pra decidir se
 * persiste o turno / atualiza o relogio de silencio do follow-up).
 */
export async function despacharSaidaCamila(numero: string, textoLLM: string): Promise<boolean> {
  const resultado = parseSaidaCamila(textoLLM);

  if (!resultado.ok) {
    console.error(`[camila][dispatch] JSON invalido para ${numero}: ${resultado.erro}`);
    if (!jaNotificouRecentemente(numero, 'camila_json_invalido')) {
      enviarAvisoAoSuporte([
        '🚨 *Camila gerou JSON invalido — atender o lead manualmente*',
        `Telefone: ${numero}`,
        `Erro: ${resultado.erro.slice(0, 250)}`,
        '',
        'Nenhuma mensagem foi enviada ao lead neste turno (fallback seguro, T-05-JSON).',
      ]).catch((e) => console.error('[camila][dispatch] Falha ao avisar grupo:', e));
    }
    return false;
  }

  const { data } = resultado;

  // 1) Executa tools_a_executar. `telefone` SEMPRE vem do numero confiavel
  // do processo (nunca do que o LLM escreveu em args.telefone) — defesa
  // contra a Camila hallucinando ou trocando o telefone por engano.
  for (const item of data.tools_a_executar) {
    const executor = CAMILA_TOOLS_EXECUTORES[item.tool];
    if (!executor) {
      console.warn(`[camila][dispatch] tool "${item.tool}" ainda sem executor no dispatcher — ignorando`);
      continue;
    }
    try {
      const args = { ...item.args, telefone: numero };
      const saida = await executor(args);
      console.log(`[camila][dispatch] ${numero} <- tool ${item.tool}: ${JSON.stringify(saida).slice(0, 200)}`);
    } catch (e) {
      console.error(`[camila][dispatch] erro ao executar tool ${item.tool} para ${numero}:`, e);
    }
  }

  // 2) Envia mensagens[] respeitando delay_ms[] (indice a indice).
  for (let i = 0; i < data.mensagens.length; i++) {
    const atraso = data.delay_ms?.[i];
    if (atraso && atraso > 0) {
      await new Promise((resolve) => setTimeout(resolve, atraso));
    }
    await enviarMensagem(numero, data.mensagens[i]);
  }

  // 3) Grava spin_stage = proximo_estado (best-effort — nao bloqueia o
  // restante do turno se a chamada falhar; a Camila pode ja ter declarado
  // o mesmo valor via tools_a_executar, gravar de novo e idempotente).
  try {
    await updateContactField.execute!(
      { telefone: numero, chave: 'spin_stage', valor: data.proximo_estado } as any,
      {} as any,
    );
  } catch (e) {
    console.error(`[camila][dispatch] falha ao gravar spin_stage=${data.proximo_estado} para ${numero}:`, e);
  }

  if (data.sinal_alerta) {
    console.log(`[camila][dispatch] sinal_alerta=${data.sinal_alerta} para ${numero} (log_interno: ${data.log_interno || '-'})`);
  }

  return data.mensagens.length > 0;
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

    // Gap 2/CR-02 (QUAL-02 sustentado): o Qualificador e um agente BATCH que
    // roda uma vez por submissao de formulario (webhook /api/webhook/formulario)
    // e cuja saida e log tecnico interno (bant_*, spin_stage, motivo_perdido) —
    // NUNCA uma mensagem pro lead. Um lead roteado como PERDIDO fica com
    // agenteAtual='qualificador' indefinidamente (nao ha trigger que o troque
    // pra outro agente). Sem esta guarda, qualquer mensagem que ele mande depois
    // cairia no roteamento normal (AGENTES_MAP['qualificador'] -> qualificadorAgent),
    // o agent.generate() rodaria de novo turno-a-turno (T-01-10-04: lead ganhando
    // acesso conversacional a um agente com tools reais de gravacao/move de card)
    // e o ramo nao-Camila (`else if (resposta.text)`) enviaria o log interno
    // direto pro WhatsApp do lead — vazando dado que deveria ficar so no CRM.
    // Fica em silencio absoluto, igual ao humano; NAO reroteamos pra 'vendedor'
    // (Sofia) pois isso vazaria a persona errada pro lead USI (mesmo risco do Gap 3).
    if (sessao.agenteAtual === 'qualificador') {
      console.log(`[WhatsApp] ${numero} em estado 'qualificador' (batch) — IA silenciada, mensagem ignorada`);
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

    if (sessao.agenteAtual === 'camila') {
      // Camila responde em JSON estrito (camila-schema.ts) — o dispatcher
      // parseia, executa tools_a_executar e envia mensagens[] com delay.
      // JSON invalido -> despacharSaidaCamila ja trata como silencio
      // seguro (T-05-JSON); NAO cai no path de texto livre abaixo.
      const enviouAlgo = await despacharSaidaCamila(numero, resposta.text || '');

      if (enviouAlgo && sessao.conversaId) {
        salvarMensagem({
          conversation_id: sessao.conversaId,
          role: 'assistant',
          content: resposta.text,
          agent_table: sessao.agenteAtual,
        });
        // Camila falou: inicia (ou reinicia) o relogio de silencio, mesmo
        // mecanismo do vendedor (Sofia) — reusa marcarMsgSofia (coluna
        // generica de "ultima msg do agente", nome legado do projeto).
        marcarMsgSofia(sessao.conversaId);
      }
    } else if (resposta.text) {
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

// construirHashFormulario (Gap 5/CR-06, CAM-01/QUAL-04): hash de dedup do
// webhook do formulario 14q. Mesmo padrao do webhook de mensagens
// (/api/webhook/evolution): sha1 sobre `telefone|<conteudo estavel>|minBucket`.
// O conteudo estavel e um JSON deterministico SO dos campos do form
// (chaves q01..q14, ordenadas) — NUNCA timestamps/IDs volateis do GHL, que
// mudariam entre retries do mesmo submit e furariam o dedup. Se o payload
// nao tiver nenhuma chave q##_ (variante de shape), cai num fallback com as
// demais chaves ordenadas, filtrando nomes tipicamente volateis.
// minBucket = Math.floor(Date.now()/60_000) (janela de 1 min): 2-3 retries
// do GHL Workflow caem no mesmo bucket e viram 1 processamento so; um
// re-submit legitimo minutos depois gera hash novo.
// Function declaration (hoisted) e corpo autocontido (so usa createHash +
// args) de proposito: o smoke-webhook-formulario-dedup.mjs extrai o corpo
// por regex e reconstroi via new Function — mesmo padrao de smoke-coordenacao.
export function construirHashFormulario(telefone: string, payload: Record<string, unknown>, minBucket: number): string {
  const chavesForm = Object.keys(payload).filter((chave) => /^q\d{2}/.test(chave)).sort();
  const chavesEstaveis = chavesForm.length > 0
    ? chavesForm
    : Object.keys(payload).filter((chave) => !/(timestamp|date|created|updated|workflow|attribution|event|message)/i.test(chave)).sort();
  const conteudoEstavel = JSON.stringify(chavesEstaveis.map((chave) => [chave, String(payload[chave] ?? '')]));
  return createHash('sha1')
    .update(`${telefone}|${conteudoEstavel}|${minBucket}`)
    .digest('hex');
}

export const mastra = new Mastra({
  agents: {
    vendedorAgent,
    qualificadorAgent,
    camilaAgent,
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

            // Gap 5/CR-06: idempotencia. O GHL Workflow dispara o webhook
            // 2-3x por retry — sem dedup, cada disparo re-executa o
            // Qualificador + dispararDuplaCao => 2-3 aberturas proativas
            // da Camila (viola CAM-01). Dedup ANTES de qualquer efeito
            // colateral, mesmo padrao do /api/webhook/evolution.
            // tentarRegistrarWebhook e fail-open por design (T-01-10-05):
            // preferimos abertura duplicada rara a nao abrir nunca.
            const minBucket = Math.floor(Date.now() / 60_000);
            const hashForm = construirHashFormulario(telefone, payload, minBucket);
            const ehNovoForm = await tentarRegistrarWebhook(hashForm);
            if (!ehNovoForm) {
              console.log(`[formulario] webhook duplicado descartado (hash=${hashForm.slice(0, 8)}, telefone=${telefone})`);
              return c.json({ status: 'duplicado' });
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

            // Gap 5/CR-06 (T-01-10-03): pipeline pesado ASSINCRONO. O
            // agent.generate do Qualificador leva ate ~3min no pior caso
            // (timeout 60s x 3 tentativas) — segurar a resposta HTTP esse
            // tempo todo estoura o timeout do GHL Workflow e AUMENTA os
            // retries (retro-alimentando o proprio problema de duplicacao).
            // Parse + roteamento deterministico + sessao ja rodaram acima
            // (baratos, sincronos); daqui pra frente e fire-and-forget com
            // .catch de log, mesmo padrao ja usado por dispararDuplaAcao.
            (async () => {
              const agent = mastra.getAgent('qualificadorAgent');
              await comRetry(
                () => comTimeout(agent.generate(prompt), TIMEOUT_AGENTE, 'qualificador'),
                MAX_TENTATIVAS,
                'qualificador',
              );

              // QUAL-04: lead QUALIFICADO -> dispara a DUPLA ACAO (abertura
              // proativa da Camila no WhatsApp + task priorizada pro SDR
              // humano). O Qualificador ja gravou bant_*/ancora_abordagem/
              // spin_stage e moveu o card ANTES deste ponto (ele executa suas
              // 4 tools em sequencia sincrona no agent.generate acima) —
              // dispararDuplaAcao rele a ficha do GHL pra pegar a ancora mais
              // fresca, mas usa `ancora` (vazio aqui; nao calculado por
              // codigo deterministico) so como fallback de ultimo caso.
              // So chega aqui no PRIMEIRO disparo (dedup acima ja descartou
              // os retries do GHL) => abertura UNICA da Camila (CAM-01).
              if (roteamento.stage === 'QUALIFICADO') {
                dispararDuplaAcao({
                  telefone,
                  contactId,
                  nome,
                  bant: roteamento.bant,
                  ancora: '',
                }).catch((e) => console.error(`[formulario] dispararDuplaAcao falhou para ${telefone}:`, e));
              }
            })().catch((e) => console.error(`[formulario] pipeline do Qualificador falhou para ${telefone}:`, e));

            // Resposta IMEDIATA (202 Accepted): o GHL so precisa saber que o
            // submit foi aceito; o processamento segue em background.
            return c.json({ status: 'aceito', stage: roteamento.stage }, 202);
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
