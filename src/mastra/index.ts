import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';

// Agente Qualificador (SDR AUTON) — processa o form 14q em modo batch (01-04)
import { qualificadorAgent } from './agents/qualificador';

// Agente Camila (SDR AUTON) — conduz o SPIN, saida em JSON estrito (01-05).
// CAMILA_INSTRUCTIONS (05-04, HARD-07): mesmo texto de instrucoes reusado
// pelo LLM SECUNDARIO da cascata de fallback (garante o MESMO contrato JSON).
import { camilaAgent, CAMILA_INSTRUCTIONS } from './agents/camila';

// Schema JSON estrito da Camila + parse seguro (01-05, CAM-03)
import { parseSaidaCamila } from './camila-schema';

// HARD-02 (Fase 5, plano 05-05): OUTPUT GUARDRAILS deterministicos — PII
// scrubber + checagem de fatos-autorizados (anti-alucinacao), aplicados
// mensagem-a-mensagem em despacharSaidaCamila logo ANTES de cada
// enviarMensagem (preserva o indice de delay_ms[]). VIOLACOES_GRAVES marca
// quais violacoes de fato preferem 'escalar' (handoff humano) em vez de so
// suprimir o trecho. Substitui o systemPromptScrubber LLM-based aposentado
// (ver processors.ts) — 100% local, sem chamada a LLM/Azure.
import { scrubPII, checarFatosAutorizados, VIOLACOES_GRAVES } from './guardrails/saida';

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
  baixarGravacaoBase64,
  persistirTranscricaoContato,
} from './ghl';
import type { GhlWebhookPayload, TipoGravacao } from './ghl';

// GRAV-04: filtro de anonimizacao LGPD fail-closed da transcricao de gravacao
import { anonimizarTranscricao } from './anonimizacao';

// GRAV-02/GRAV-03 (Fase 3, plano 03-02): extracao LLM dos 6 sinais da
// transcricao anonimizada + gatilho do resgate de 48h por desistencia sem
// fechamento.
import { extrairSinaisDaTranscricao } from './extracao-sinais';

// Bloqueio de IA (quando humano assume)
import { estaBloqueado, desbloquearNumero } from './bloqueio';

// HARD-01: guardrail de entrada anti prompt-injection DETERMINISTICO (local,
// sem LLM/Azure) — substitui o promptInjectionDetector LLM-based aposentado
// em processors.ts (ver comentario-lapide la).
import { detectarInjecao } from './guardrails/injecao';

// HARD-03: rate limit + fila com prioridade in-memory na entrada do webhook
// de mensagens — crise (sofrimento agudo/bloqueio duravel) nunca e
// rate-limited/enfileirada atras de normal/shedada.
import { classificarPrioridade, admitir, PRIORIDADE_CRISE } from './fila';

// HARD-04: cache semantico in-memory particionado por lead (embedding +
// cosseno + TTL/cap + fail-open) — reduz custo/latencia em perguntas
// repetidas do MESMO lead. embedder injetado abaixo reusa o MESMO
// deployment ja usado por memoria.ts (azure.embedding + dimensions:1536),
// sem instanciar recurso novo.
import { CacheSemantico, saidaCacheavel } from './cache-semantico';
import { azure } from './azure-client';
import { AZURE_OPENAI_DEPLOYMENT_EMBEDDING, AZURE_OPENAI_DEPLOYMENT_GPT5_MINI, AZURE_OPENAI_DEPLOYMENT_GPT51 } from './config';

// HARD-08 (Fase 5, plano 05-06): observabilidade por interacao LLM — tokens/
// custo estimado/latencia/versao de prompt, alem dos traces do Mastra
// Observability (abaixo). registrarMetricaLLM e fail-open e NUNCA recebe
// texto bruto de mensagem/resposta (LGPD) — so contadores/ids/versao.
import { registrarMetricaLLM, CAMILA_PROMPT_VERSION, QUALIFICADOR_PROMPT_VERSION } from './observabilidade';

// HARD-05/HARD-06 (Fase 5, plano 05-03): circuit breaker + bulkhead por
// recurso (falha rapida + pool isolado) e backoff com jitter — substitui o
// backoff LINEAR puro de comRetry e roteia a chamada do LLM primario
// (Camila) pelo breaker('llm'). O bypass {crise:true} (usado em
// escalate-to-human.ts) NUNCA passa por aqui na Camila — e exclusivo do
// caminho de escalacao humana.
import { chamarComResiliencia, backoffComJitter, tentarMarcarDespacho } from './resiliencia';

// HARD-07 (Fase 5, plano 05-04): fallback em cascata (LLM secundario ->
// cache de fallback -> resposta segura/handoff humano) — acionado quando a
// chamada acima (chamarComResiliencia({recurso:'llm'})) falha (esgota
// tentativas, breaker_open, content_filter). Handoff SEMPRE preferido a
// canned (evita o loop do Teste 4, ver fallback.ts).
import { resolverFallback, montarHandoffPadrao } from './fallback';

// Storage compartilhado (PostgreSQL/Supabase)
import { pgStore } from './memoria';

// Sessao
import { getSessao, criarSessao, trocarAgente, AGENTES_MAP, type Sessao } from './sessao';

// Memory (so para debug de leitura por turno)
import { memoria } from './memoria';

// Supabase (persistencia)
import { salvarMensagem, buscarCustomerPorTelefone, marcarMsgLead, marcarMsgSofia, salvarErro, tentarRegistrarWebhook, buscarConversaAguardandoHumano, salvarMetricaLLM, buscarMensagensDaConversa } from './supabase';

// Buffer de mensagens (debounce 10s, com persistencia)
import { adicionarAoBuffer } from './buffer';

// crypto pra hash de dedup do webhook
import { createHash } from 'crypto';

// Reset de teste (#55555)
import { resetarConversaTeste, COMANDO_RESET } from './reset';

// Scheduler de follow-ups (1h/3h/5h) e handoff por silencio (24h)
import { iniciarFollowUpScheduler } from './follow-up';

// Scheduler dos lembretes de call agendada (TOOL-08/FUN-02, toques D-1/H-1/5min)
import { iniciarLembretesScheduler } from './lembretes';

// Notificacao ao grupo de suporte em caso de erro
import { enviarAvisoAoSuporte, jaNotificouRecentemente } from './notificacoes';

// CR-01: token fail-closed do webhook do formulario 14q
import { FORMULARIO_WEBHOOK_TOKEN } from './config';
import { GHL_STAGES } from './config';

// T-03-01: token fail-closed do webhook de gravacao de call/ligacao (Fase 3)
import { GRAVACAO_WEBHOOK_TOKEN } from './config';

// CR-02 (4a rodada): token fail-closed do webhook de mensagens WhatsApp
// (/api/webhook/evolution) + allowlist fail-closed do comando de reset #55555
import { EVOLUTION_WEBHOOK_TOKEN, RESET_TELEFONES_PERMITIDOS } from './config';

// CR-03 (4a rodada): token admin fail-closed de /api/desbloquear
import { ADMIN_API_TOKEN } from './config';

// Dashboard de metricas + viewer de conversa
import { handlerDashboard, handlerConversa } from './dashboard';

// HARD-04: instancia UNICA do cache semantico (estado in-memory reusado
// entre turnos — nunca instanciar dentro do handler). O embedder injetado
// chama diretamente `doEmbed` do modelo de embedding Azure (mesmo deployment
// AZURE_OPENAI_DEPLOYMENT_EMBEDDING/dimensions:1536 ja usado por memoria.ts),
// sem depender do pacote 'ai' (zero dependencia npm nova) — cache-semantico.ts
// continua puro/injetavel, este e o UNICO ponto do projeto que fecha o
// embedder real nele.
const modeloEmbeddingCache = azure.embedding(AZURE_OPENAI_DEPLOYMENT_EMBEDDING, { dimensions: 1536 });
const cacheSemantico = new CacheSemantico({
  embedder: async (texto: string) => {
    const resultado = await (modeloEmbeddingCache as any).doEmbed({ values: [texto] });
    return resultado.embeddings[0];
  },
});

// HARD-07 (Fase 5, plano 05-04): modelo do LLM SECUNDARIO da cascata de
// fallback — GPT-5-mini (mesmo deployment do Qualificador), mais barato/
// rapido que o GPT-5.1 primario da Camila. Chamado via `doGenerate` direto
// da LanguageModelV2 (mesmo padrao de `doEmbed` acima, sem depender do
// pacote 'ai' — zero dependencia npm nova) SO quando o primario ja falhou
// neste turno (nao substitui o primario em nenhum outro caso).
const modeloSecundario = azure.chat(AZURE_OPENAI_DEPLOYMENT_GPT5_MINI);

// Timeout MENOR que TIMEOUT_AGENTE (60s) do primario — o secundario ja e a
// SEGUNDA tentativa do turno, uma cascata rapida degrada mais cedo pro cache/
// handoff em vez de fazer o lead esperar tanto quanto o primario ja esperou.
const TIMEOUT_SECUNDARIO = 20_000;

/**
 * LLM secundario da cascata de fallback (HARD-07). Recebe o texto BRUTO do
 * turno do lead (mesmo texto usado pelo cache semantico) e monta um prompt
 * minimo com o MESMO texto de instrucoes da Camila (CAMILA_INSTRUCTIONS) —
 * a saida bruta ainda passa por parseSaidaCamila DENTRO de resolverFallback
 * (T-05-04-02: secundario nunca contorna o schema/guardrails). Roda sob
 * chamarComResiliencia({recurso:'llm'}) — MESMO recurso/breaker do primario
 * (T-05-04-05: nao cria um pool paralelo ilimitado; se o breaker('llm') ja
 * estiver aberto — o proprio motivo mais comum da falha do primario — esta
 * chamada fast-faila rapido, sem gastar uma chamada real ao Azure, e a
 * cascata degrada pro cache/handoff normalmente). NUNCA lanca pro caller —
 * qualquer falha vira `null` (resolverFallback ja trata null como "vai pro
 * proximo nivel").
 */
async function chamarLlmSecundario(numero: string, nome: string, textoLead: string): Promise<string | null> {
  const t0Secundario = Date.now();
  try {
    // WR-06 (review Fase 5): o secundario NAO tem acesso a memoria Mastra do
    // primario — sem contexto, a saida mais provavel dele no MEIO do SPIN
    // era uma NOVA abertura personalizada (violacao CAM-01: abertura e
    // UNICA). Injeta uma janela compacta do historico recente (transcript
    // Supabase ja persistido por salvarMensagem — mesmo dado que o viewer de
    // conversa usa) + instrucao explicita de nao reabrir. Best-effort: falha
    // na leitura do historico degrada pro prompt sem contexto (o
    // schema/guardrails seguem valendo pra saida).
    let contextoHistorico = '';
    try {
      const sessaoSecundario = await getSessao(numero);
      if (sessaoSecundario?.conversaId) {
        const mensagensAnteriores = await buscarMensagensDaConversa(sessaoSecundario.conversaId);
        const ultimas = (mensagensAnteriores || []).slice(-10);
        if (ultimas.length > 0) {
          contextoHistorico =
            '\n\nHISTORICO RECENTE DA CONVERSA (mais antigo -> mais novo; as falas da CAMILA estao no formato JSON estrito de saida):\n' +
            ultimas
              .map((m: any) => `${m.role === 'user' ? 'LEAD' : 'CAMILA'}: ${String(m.content || '').slice(0, 400)}`)
              .join('\n') +
            '\n\nIMPORTANTE: a conversa acima JA ESTA EM ANDAMENTO — NUNCA refaca a abertura/apresentacao (CAM-01); continue exatamente do ponto atual do SPIN.';
        }
      }
    } catch (eHistorico) {
      console.warn(`[fallback] secundario sem historico para ${numero} (best-effort, segue sem contexto):`, (eHistorico as Error)?.message || eHistorico);
    }

    const promptSecundario = `[telefone: ${numero}] ${nome || '(lead sem nome ainda)'} diz: ${textoLead}${contextoHistorico}`;
    const resultado = await chamarComResiliencia(
      () => modeloSecundario.doGenerate({
        prompt: [
          { role: 'system', content: CAMILA_INSTRUCTIONS },
          { role: 'user', content: [{ type: 'text', text: promptSecundario }] },
        ],
      }),
      { recurso: 'llm', tentativas: 1, timeoutMs: TIMEOUT_SECUNDARIO },
    );
    const textoGerado = (resultado?.content || [])
      .filter((parte: any) => parte?.type === 'text')
      .map((parte: any) => parte.text)
      .join('');

    // HARD-08 (05-06): metrica do LLM secundario da cascata de fallback.
    // Best-effort/fail-open — registrarMetricaLLM nunca lanca, entao nunca
    // atrasa/derruba a resolucao do fallback. NAO passa telefone/nome pro
    // texto do log (so o proprio `telefone` como identificador, nunca
    // textoLead/textoGerado — LGPD).
    const usageSecundario = (resultado as any)?.usage;
    registrarMetricaLLM(
      {
        modelo: AZURE_OPENAI_DEPLOYMENT_GPT5_MINI,
        tipo: 'secundario_fallback',
        promptTokens: usageSecundario?.inputTokens ?? 0,
        completionTokens: usageSecundario?.outputTokens ?? 0,
        latenciaMs: Date.now() - t0Secundario,
        promptVersao: CAMILA_PROMPT_VERSION,
        telefone: numero,
        cacheHit: false,
        tokensEstimados: !usageSecundario,
      },
      salvarMetricaLLM,
    );

    return textoGerado || null;
  } catch (e) {
    console.error(`[fallback] LLM secundario (GPT-5-mini) falhou para ${numero}:`, (e as Error)?.message || e);
    return null;
  }
}

/**
 * WR-06 (review Fase 5): registra na memoria Mastra (thread do lead) um
 * turno respondido SEM agent.generate — cache HIT (HARD-04) e cascata de
 * fallback (HARD-07). Sem isso, o turno ficava no transcript Supabase mas
 * NAO na memoria do agente: no proximo turno real a Camila nao "lembrava" de
 * ter respondido (podia se repetir, contradizer a resposta cacheada ou
 * re-perguntar um SPIN ja respondido — violacao de cadencia/anti-template).
 * Best-effort/fail-open: usa saveMessages da Memory quando disponivel
 * (feature-detected, mesmo padrao do DEBUG de memoria em processarMensagem);
 * QUALQUER falha vira warn — nunca derruba/atrasa o turno (a mensagem ja foi
 * enviada ao lead). O conteudo assistant gravado e a MESMA saida bruta (JSON
 * estrito) que um generate normal deixaria no historico — consistente com o
 * que a Camila ve nos turnos reais.
 */
async function registrarTurnoNaMemoriaMastra(numero: string, textoLead: string, saidaAssistente: string): Promise<void> {
  try {
    const memAny = memoria as unknown as Record<string, any>;
    if (typeof memAny.saveMessages !== 'function') {
      console.warn('[memoria] Memory.saveMessages indisponivel nesta versao — turno sem-generate NAO registrado na memoria (WR-06, best-effort)');
      return;
    }
    const agora = Date.now();
    const base = { threadId: numero, resourceId: numero };
    await memAny.saveMessages({
      messages: [
        {
          id: `sem-generate-${numero}-${agora}-user`,
          ...base,
          role: 'user',
          type: 'text',
          createdAt: new Date(agora),
          content: { format: 2, parts: [{ type: 'text', text: textoLead }] },
        },
        {
          id: `sem-generate-${numero}-${agora}-assistant`,
          ...base,
          role: 'assistant',
          type: 'text',
          createdAt: new Date(agora + 1),
          content: { format: 2, parts: [{ type: 'text', text: saidaAssistente }] },
        },
      ],
      format: 'v2',
    });
    console.log(`[memoria] turno sem-generate (cache/fallback) registrado na memoria Mastra de ${numero} (WR-06)`);
  } catch (e) {
    console.warn(`[memoria] falha ao registrar turno sem-generate na memoria de ${numero} (best-effort, WR-06): ${(e as Error)?.message || e}`);
  }
}

// Classifica o tipo de erro do agent.generate pra metrica agregada no dashboard.
function classificarErro(erro: any): string {
  const msg = String(erro?.message || erro || '').toLowerCase();
  if (msg.includes('content_filter') || msg.includes('responsibleai') || msg.includes('content management policy')) return 'content_filter';
  if (msg.includes('timeout') || msg.includes('exceeded')) return 'timeout';
  if (msg.includes('rate') || msg.includes('429')) return 'rate_limit';
  return 'outro';
}

// Timeout e retry para agent.generate(). EXPORTADOS (WR-03, 3a rodada) pra
// dupla-acao.ts embrulhar o camilaAgent.generate da abertura proativa com o
// MESMO padrao dos demais generates — sao function declarations/consts
// acessados so em runtime, entao o import circular dupla-acao <-> index e
// seguro (mesmo argumento de despacharSaidaCamila, hoisting + call-time).
export const TIMEOUT_AGENTE = 60_000;
export const MAX_TENTATIVAS = 3;

export function comTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`[timeout] ${label} excedeu ${ms / 1000}s`)), ms);
    }),
  ]);
}

// HARD-06: backoff com JITTER (backoffComJitter, resiliencia.ts) em vez do
// antigo backoff LINEAR puro (tentativa vezes 2000ms) — dessincroniza retries
// concorrentes sob falha compartilhada do Azure/GHL (T-05-03-04, thundering
// herd). Propaga
// automaticamente pra TODOS os call sites de comRetry (dispatch da Camila
// via este helper generico, qualificador, dupla-acao.ts, no-show.ts,
// extracao-sinais.ts) sem precisar tocar em cada um.
export async function comRetry<T>(fn: () => Promise<T>, tentativas: number, label: string): Promise<T> {
  for (let i = 1; i <= tentativas; i++) {
    try {
      return await fn();
    } catch (erro: any) {
      console.error(`[retry] ${label} falhou (tentativa ${i}/${tentativas}): ${erro.message}`);
      if (i === tentativas) throw erro;
      await new Promise(r => setTimeout(r, backoffComJitter(i)));
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
  // CR-02/CR-03: captura o retorno HONESTO de enviarMensagem — o boolean
  // devolvido por esta funcao passa a significar "pelo menos 1 mensagem
  // ACEITA pelo GHL", nao "a Camila declarou mensagens". O loop de no-show
  // usa esse sinal (camilaOk) pra decidir se registra a recuperacao/inicia
  // o relogio de 48h.
  //
  // HARD-02 (05-05): OUTPUT GUARDRAILS deterministicos ANTES de cada envio —
  // (a) scrubPII redige PII estruturado/clinico (reusa anonimizacao.ts,
  // LGPD); (b) checarFatosAutorizados bloqueia invencao proibida pelo Safety
  // Envelope (preco/%/prazo de resultado clinico/garantia/concorrente
  // nominal). Uma mensagem com violacao de FATO e SUPRIMIDA (nunca enviada
  // crua) — o indice de delay_ms[] permanece 1:1 com data.mensagens[i], so
  // pulamos o envio+delay do item violante. Violacao GRAVE
  // (VIOLACOES_GRAVES) sinaliza escalate_to_human apos o loop, em vez de so
  // suprimir e seguir o turno normalmente.
  let algumaEnviada = false;
  let violacaoGraveDetectada = false;
  for (let i = 0; i < data.mensagens.length; i++) {
    const { texto: mensagemScrubada, redacoes } = scrubPII(data.mensagens[i]);
    const { seguro, violacoes } = checarFatosAutorizados(mensagemScrubada);

    if (redacoes > 0) {
      console.log(`[camila][dispatch][guardrail-saida] PII redigido para ${numero} (${redacoes} redacao(oes) — texto nao logado, LGPD)`);
    }

    if (!seguro) {
      console.warn(`[camila][dispatch][guardrail-saida] mensagem SUPRIMIDA (nao enviada) para ${numero} — violacoes: ${violacoes.join(', ')}`);
      if (violacoes.some((v) => VIOLACOES_GRAVES.has(v))) {
        violacaoGraveDetectada = true;
      }
      continue; // NUNCA envia a promessa/estatistica inventada crua
    }

    const atraso = data.delay_ms?.[i];
    if (atraso && atraso > 0) {
      await new Promise((resolve) => setTimeout(resolve, atraso));
    }
    const enviada = await enviarMensagem(numero, mensagemScrubada);
    if (enviada) algumaEnviada = true;
  }

  if (violacaoGraveDetectada) {
    // Violacao GRAVE (prazo de resultado clinico/garantia-bonus inventados):
    // preferir ESCALAR pra humano a so suprimir o trecho e seguir o turno —
    // mesmo espirito do Behavioral Gradient "Alto Risco" do playbook.
    try {
      await escalateToHuman.execute!(
        {
          telefone: numero,
          motivo: 'output_guardrail_fato_grave',
          resumo: 'Guardrail de saida (HARD-02) bloqueou uma promessa proibida (prazo de resultado clinico/garantia) antes do envio.',
        } as any,
        {} as any,
      );
    } catch (e) {
      console.error(`[camila][dispatch][guardrail-saida] falha ao escalar apos violacao grave para ${numero}:`, e);
    }
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

  return algumaEnviada;
}

async function processarMensagem(mastraRef: Mastra, numero: string, texto: string, nome: string) {
  // HARD-06: idempotencyKey de nivel-chamada por (lead + turno) — hash curto
  // do texto BRUTO do lead + bucket de 1 min (mesmo padrao de minBucket do
  // dedup de webhook). Um retry interno (backoffComJitter) do MESMO turno
  // nunca re-executa agent.generate duplicado.
  //
  // WR-08 (review Fase 5): a chave e computada AQUI (fora do try, sobre o
  // texto bruto — estavel entre invocacoes concorrentes) porque ela tambem
  // deduplica o DESPACHO (tentarMarcarDespacho): a idempotencia de chamada
  // garante 1 chamada LLM, mas 2 invocacoes concorrentes (webhook +
  // buffer-recovery no mesmo turno) recebiam a MESMA promise e despachavam
  // 2x (mensagens/tools duplicadas). O catch (cascata de fallback) tambem
  // precisa da chave em escopo.
  const minBucketTurno = Math.floor(Date.now() / 60_000);
  const idempotencyKeyTurno = `${numero}:${createHash('sha1').update(texto).digest('hex').slice(0, 16)}:${minBucketTurno}`;
  // WR-08: true quando ESTA invocacao marcou o despacho — distingue, no
  // catch, "outra invocacao concorrente ja despachou" (pula a cascata) de
  // "eu mesmo marquei e o dispatch falhou no meio" (cascata segue rodando,
  // comportamento anterior preservado).
  let marcouDespachoNestaInvocacao = false;
  try {
    let sessao = await getSessao(numero);
    if (!sessao) {
      // CLEAN-01: cold-inbound (numero sem sessao, sem formulario) passa a
      // ser tratado como 'humano' (silencio seguro) em vez de instanciar o
      // agente vendedor/Sofia (removido). O fluxo do SDR e form-driven:
      // /api/webhook/formulario cria/troca a sessao pra 'qualificador' ANTES
      // da Camila abrir, entao um inbound cold e sempre um numero fora do
      // funil — silenciar (persistido no banco) e o comportamento seguro pra
      // base USI. Re-engajamento pre-call fica como item deferido (ver
      // SUMMARY do plano 04-01).
      const dadosCustomer: Partial<Sessao> = { agenteAtual: 'humano' };
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
    // O aviso de transicao (quando ha) e a notificacao ao time vao pelo
    // grupo SUPORTE (ver tools/escalate-to-human.ts — CLEAN-01: o antigo
    // handoff-humano.ts do Closer foi removido).
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

    // CLEAN-01: resolucao segura do agente Mastra. O agente vendedor/Sofia
    // (Closer) foi removido — nenhum caminho pode cair nele. Se AGENTES_MAP
    // nao mapear pra um agente Mastra REALMENTE registrado (qualificadorAgent/
    // camilaAgent) — ex: estado desconhecido/legado que nao seja 'humano'
    // nem 'qualificador' (ja tratados acima) — loga e retorna, mesmo
    // tratamento de silencio ja aplicado a 'humano'/'qualificador'.
    const AGENTES_MASTRA_VALIDOS = new Set(['qualificadorAgent', 'camilaAgent']);
    const agenteKey = AGENTES_MAP[sessao.agenteAtual];
    if (!agenteKey || !AGENTES_MASTRA_VALIDOS.has(agenteKey)) {
      console.log(`[WhatsApp] ${numero} em estado '${sessao.agenteAtual}' sem agente Mastra valido (agenteKey=${agenteKey || 'indefinido'}) — IA silenciada, mensagem ignorada (fail-closed)`);
      return;
    }
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

    // HARD-01: guardrail de injection ANTES de montar o prompt. So o
    // caminho lead-facing (Camila) chega aqui — sessao.agenteAtual so pode
    // ser 'camila' neste ponto (as guardas acima ja retornaram cedo pra
    // 'humano'/'qualificador'/estado invalido); o Qualificador processa form
    // (nao texto livre de chat), entao nao passa por este trecho. Estrategia
    // 'rewrite': se suspeito, usa o texto NEUTRALIZADO como prompt (remove o
    // trecho de override, preserva a intencao legitima do lead) — a Camila
    // ainda responde normalmente (Boundary 7/Example 8 seguem como defesa em
    // profundidade, nao sao substituidas por este guardrail). Fail-open: o
    // guardrail nunca lanca, entao esta chamada nunca derruba o turno.
    const deteccaoInjecao = detectarInjecao(texto);
    if (deteccaoInjecao.suspeito) {
      console.warn(`[guardrail-injecao] ${numero} — tentativa detectada (categoria=${deteccaoInjecao.categoria}), texto neutralizado`);
      texto = deteccaoInjecao.textoNeutralizado;
      if (sessao.conversaId && !jaNotificouRecentemente(numero, 'injection_attempt')) {
        enviarAvisoAoSuporte([
          `⚠️ Possivel prompt-injection de ${numero} (categoria=${deteccaoInjecao.categoria}) — guardrail local neutralizou o trecho antes do prompt da Camila.`,
        ]).catch((e) => console.error('[guardrail-injecao] falha ao avisar suporte:', e));
      }
    }

    // HARD-04: lookup do cache semantico ANTES de montar o prompt/chamar o
    // LLM — so no caminho lead-facing da Camila (mesma justificativa do
    // guardrail acima: sessao.agenteAtual so pode ser 'camila' neste ponto).
    // A chave de isolamento e `numero` (telefone confiavel do PROCESSO, nunca
    // do payload) — nunca outro identificador. Fail-open: buscar() nunca
    // lanca; se o embedder falhar (deployment ausente/timeout), o resultado
    // e sempre MISS e o fluxo cai pro generate normal abaixo, sem nenhum
    // caminho que derrube o processamento por causa do cache.
    const t0Cache = Date.now();
    const respostaCacheada = await cacheSemantico.buscar(numero, texto);
    const latenciaCacheMs = Date.now() - t0Cache;
    if (respostaCacheada) {
      console.log(`[cache-semantico] HIT — reusando resposta cacheada de ${numero}, agent.generate pulado`);
      // WR-08: dedup de DESPACHO — se uma invocacao concorrente do MESMO
      // turno ja despachou (via cache ou generate), esta nao envia de novo.
      if (!tentarMarcarDespacho(idempotencyKeyTurno)) {
        console.log(`[cache-semantico] turno ja despachado por invocacao concorrente — dispatch do HIT pulado para ${numero} (WR-08)`);
        return;
      }
      marcouDespachoNestaInvocacao = true;
      // Resposta cacheada re-passa pelo MESMO dispatcher de validacao/envio
      // (T-05-02-02: cache poisoning) — se por acaso nao parsear mais (nunca
      // deveria acontecer, ja que so cacheamos JSON valido), o dispatcher ja
      // trata como silencio seguro.
      const enviouAlgoCache = await despacharSaidaCamila(numero, respostaCacheada);
      if (enviouAlgoCache && sessao.conversaId) {
        salvarMensagem({
          conversation_id: sessao.conversaId,
          role: 'assistant',
          content: respostaCacheada,
          agent_table: sessao.agenteAtual,
        });
        marcarMsgSofia(sessao.conversaId);
      }
      if (enviouAlgoCache) {
        // WR-06: o generate foi pulado, entao a memoria Mastra nao viu este
        // turno — registra (best-effort, fire-and-forget) pra Camila nao
        // "esquecer" a resposta cacheada no proximo turno real.
        registrarTurnoNaMemoriaMastra(numero, texto, respostaCacheada).catch(() => {});
      }

      // HARD-08 (05-06): cache HIT — tokens/custo=0 (o generate foi pulado),
      // latencia = tempo do lookup do cache. Mensuravel: quanto o cache
      // semantico (HARD-04) economizou em custo/tempo de LLM.
      registrarMetricaLLM(
        {
          modelo: AZURE_OPENAI_DEPLOYMENT_GPT51,
          tipo: 'camila_primaria',
          promptTokens: 0,
          completionTokens: 0,
          latenciaMs: latenciaCacheMs,
          promptVersao: CAMILA_PROMPT_VERSION,
          telefone: numero,
          conversationId: sessao.conversaId || null,
          customerId: sessao.customerId || null,
          cacheHit: true,
        },
        salvarMetricaLLM,
      );
      return;
    }

    const nomeFormatado = sessao.nome && sessao.nome !== 'Não identificado'
      ? sessao.nome
      : (nome && nome !== 'Não identificado' ? nome : '');

    const prompt = nomeFormatado
      ? `[telefone: ${numero}] ${nomeFormatado} diz: ${texto}`
      : `[telefone: ${numero}] (lead sem nome ainda) diz: ${texto}`;

    // HARD-05: LLM primario (caminho da Camila — o unico que chega aqui,
    // 'qualificador'/'humano'/estado invalido ja retornaram cedo acima)
    // roteado por chamarComResiliencia com recurso 'llm'. Se o breaker('llm')
    // estiver ABERTO (falhas consecutivas recentes), esta chamada faz
    // FAST-FAIL com ErroBreakerAberto (codigo 'breaker_open') em vez de
    // esperar ate 3x60s de timeout — esse erro tipado e o GATILHO documentado
    // pro fallback em cascata do plano 05-04.
    //
    // HARD-06: idempotencyKeyTurno (lead + turno) foi computada no TOPO da
    // funcao (WR-08) — um retry interno (backoffComJitter) do MESMO turno
    // nunca re-executa agent.generate duplicado. Complementa (nao substitui)
    // o dedup de webhook existente, que e de nivel-request.
    //
    // CR-02 (review Fase 5): predicado de CRISE computado ANTES do generate
    // — mesma logica pura do catch abaixo (classificarPrioridade, lexico de
    // sofrimento agudo + bloqueio duravel). Passar {crise:true} garante o
    // invariante de resiliencia.ts ("prefere-se SEMPRE TENTAR"): um turno de
    // crise SEMPRE tenta o LLM primario pelo menos 1x, mesmo com o
    // breaker('llm') ABERTO por falhas NAO relacionadas — sem isso, "quero
    // me matar" fast-failava sem nenhuma tentativa e a mensagem CVV-188 do
    // protocolo (Safety Envelope item 13) dependia so do fallback. Fail-safe:
    // erro na leitura duravel degrada pro lexico local (nunca trava o turno).
    let criseTurno = false;
    try {
      const emCriseDuravelTurno = await estaBloqueado(numero);
      criseTurno = classificarPrioridade(numero, texto, () => emCriseDuravelTurno) === PRIORIDADE_CRISE;
    } catch {
      criseTurno = classificarPrioridade(numero, texto) === PRIORIDADE_CRISE;
    }

    const t0Primario = Date.now();
    const resposta = await chamarComResiliencia(
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
      { recurso: 'llm', tentativas: MAX_TENTATIVAS, idempotencyKey: idempotencyKeyTurno, crise: criseTurno },
    );
    const latenciaPrimarioMs = Date.now() - t0Primario;

    // WR-08: dedup de DESPACHO — a idempotencia acima pode ter devolvido a
    // MESMA promise pra 2 invocacoes concorrentes deste turno (webhook +
    // buffer-recovery); os EFEITOS (mensagens/tools) vivem no dispatcher,
    // fora da regiao guardada. So o PRIMEIRO caller despacha.
    if (!tentarMarcarDespacho(idempotencyKeyTurno)) {
      console.log(`[camila][dispatch] turno ja despachado por invocacao concorrente — dispatch pulado para ${numero} (WR-08)`);
      return;
    }
    marcouDespachoNestaInvocacao = true;

    if (sessao.agenteAtual === 'camila') {
      // Camila responde em JSON estrito (camila-schema.ts) — o dispatcher
      // parseia, executa tools_a_executar e envia mensagens[] com delay.
      // JSON invalido -> despacharSaidaCamila ja trata como silencio
      // seguro (T-05-JSON); NAO cai no path de texto livre abaixo.
      const enviouAlgo = await despacharSaidaCamila(numero, resposta.text || '');

      // HARD-08 (05-06): metrica do LLM primario (Camila). Tokens vem de
      // `resposta.usage` (LanguageModelV2Usage do @ai-sdk: inputTokens/
      // outputTokens/totalTokens) — se o campo vier ausente/indefinido
      // (shape inesperado do provider), marca tokensEstimados:true e usa 0
      // em vez de travar a metrica. Best-effort/fail-open: nunca afeta o
      // envio/dispatch acima, que ja aconteceu.
      const usagePrimario = (resposta as any)?.usage;
      registrarMetricaLLM(
        {
          modelo: AZURE_OPENAI_DEPLOYMENT_GPT51,
          tipo: 'camila_primaria',
          promptTokens: usagePrimario?.inputTokens ?? 0,
          completionTokens: usagePrimario?.outputTokens ?? 0,
          latenciaMs: latenciaPrimarioMs,
          promptVersao: CAMILA_PROMPT_VERSION,
          telefone: numero,
          conversationId: sessao.conversaId || null,
          customerId: sessao.customerId || null,
          cacheHit: false,
          tokensEstimados: !usagePrimario,
        },
        salvarMetricaLLM,
      );

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

      // HARD-04 + CR-01 (review Fase 5): so cacheia saida SEM EFEITO
      // COLATERAL. O guard antigo (`enviouAlgo`) so provava "≥1 mensagem
      // aceita pelo GHL" — mas cacheava saidas com tools_a_executar[] (um
      // HIT futuro re-executa TODAS: double booking de create_calendar_event,
      // card re-movido, re-escalacao) e ate a saida do PROTOCOLO DE CRISE
      // (acao 'escalar' + 1 mensagem CVV — Safety Envelope item 13).
      // saidaCacheavel (cache-semantico.ts, puro/smoke-avel) exige parse ok
      // + acao 'responder' + tools_a_executar VAZIO + sem sinal de
      // sofrimento_agudo; !criseTurno e cinto-e-suspensorio (um turno
      // classificado como crise nunca alimenta o cache, seja qual for o
      // shape da saida). Fail-open: guardar() nunca lanca.
      if (enviouAlgo && !criseTurno && saidaCacheavel(resposta.text || '')) {
        await cacheSemantico.guardar(numero, texto, resposta.text || '');
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
    // NAO enviar mensagem visivel ao lead em caso de erro — o comportamento
    // ANTIGO (removido) mandava uma frase fixa de erro generica pedindo pro
    // lead escrever de novo o que tinha dito, mas isso virava loop infinito
    // visivel quando o erro era persistente (ex: timeout repetido no Azure
    // OpenAI sob carga). Comprovado nos relatorios do Teste 4 (ClickUp
    // 868jjn1f4): 6 dos 9 cenarios reprovados tinham loops dessa frase.
    //
    // HARD-07 (05-04): em vez de silenciar direto, o LLM primario falho
    // aciona a CASCATA DE FALLBACK (resolverFallback, fallback.ts) —
    // secundario (GPT-5-mini) -> cache de fallback (do PROPRIO lead) ->
    // resposta segura. A resposta segura final e SEMPRE handoff humano
    // (escalate_to_human via montarHandoffPadrao), NUNCA uma frase canned
    // repetida — mesma nuance do paragrafo acima. O silencio+alerta abaixo
    // (comportamento anterior a este plano) passa a ser so o ULTIMO
    // recurso, acionado apenas se ate a cascata de fallback falhar.
    console.error('[WhatsApp] Erro ao processar mensagem (LLM primario falhou) — acionando cascata de fallback HARD-07:', erro);

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

    // HARD-07: predicado de CRISE deste turno especifico — mesmo lexico de
    // sofrimento agudo/bloqueio duravel do HARD-03 (fila.ts). A
    // admissao/prioridade calculada no handler do webhook (antes do buffer)
    // nao chega ate aqui como parametro, entao recomputamos com a MESMA
    // funcao pura (classificarPrioridade) sobre o `texto` deste turno. Fail
    // -safe: qualquer falha aqui degrada pra NORMAL (nunca trava o catch).
    let crise = false;
    try {
      const emCriseDuravel = await estaBloqueado(numero);
      crise = classificarPrioridade(numero, texto, () => emCriseDuravel) === PRIORIDADE_CRISE;
    } catch (eCrise) {
      console.error(`[fallback] ${numero}: falha ao classificar crise, degradando pra NORMAL:`, eCrise);
    }

    // Somente o caminho da Camila chega a chamar o LLM primario neste ponto
    // do codigo ('qualificador'/'humano'/estado invalido ja retornaram cedo
    // acima, antes do try) — a cascata sempre re-passa pelo MESMO
    // dispatcher de validacao/envio (despacharSaidaCamila), igual a saida
    // normal do primario. `cascataResolveu` so vira true se o despacho
    // realmente rodou (nao precisa ter enviado mensagem — handoff nao
    // envia, so escala).
    let cascataResolveu = false;
    try {
      // WR-08: se uma invocacao CONCORRENTE do mesmo turno ja despachou
      // (generate ou cache), esta nao roda a cascata — evita mensagens/tools
      // de fallback duplicadas em cima de um turno ja respondido. Se quem
      // marcou foi ESTA invocacao (dispatch comecou e falhou no meio), a
      // cascata segue normalmente (comportamento anterior preservado).
      if (!marcouDespachoNestaInvocacao && !tentarMarcarDespacho(idempotencyKeyTurno)) {
        console.log(`[fallback] ${numero}: turno ja despachado por invocacao concorrente — cascata pulada (WR-08)`);
        cascataResolveu = true;
        return;
      }

      const resultadoFallback = await resolverFallback({
        lead: numero,
        texto,
        crise,
        secundario: (t) => chamarLlmSecundario(numero, nome, t),
        cacheBuscar: (lead, t) => cacheSemantico.buscar(lead, t),
        // CR-02 (review Fase 5): handoff SENSIVEL A CRISE — com crise=true,
        // montarHandoffPadrao emite motivo 'sofrimento_agudo' (task URGENTE
        // com marcador CVV 188/IMEDIATO em escalate-to-human.ts) e a
        // mensagem CVV-188 do Safety Envelope item 13 em mensagens[] — o
        // lead em sofrimento agudo nunca recebe silencio + falha generica.
        montarHandoff: (lead) => montarHandoffPadrao(lead, crise),
      });

      console.log(`[fallback] ${numero}: cascata de fallback resolveu no nivel '${resultadoFallback.tipo}'`);

      const enviouAlgoFallback = await despacharSaidaCamila(numero, resultadoFallback.saida);
      cascataResolveu = true;

      if (enviouAlgoFallback && sessaoAtual?.conversaId) {
        salvarMensagem({
          conversation_id: sessaoAtual.conversaId,
          role: 'assistant',
          content: resultadoFallback.saida,
          agent_table: 'camila',
        });
        marcarMsgSofia(sessaoAtual.conversaId);
      }

      if (enviouAlgoFallback) {
        // WR-06: turno respondido sem generate — registra na memoria Mastra
        // (best-effort) pra Camila lembrar deste turno no proximo real.
        registrarTurnoNaMemoriaMastra(numero, texto, resultadoFallback.saida).catch(() => {});
      }

      // CR-01/WR-06 (review Fase 5): a saida do SECUNDARIO NUNCA e cacheada.
      // O cache antigo aqui guardava um output gerado SEM o contexto/memoria
      // do primario (mid-SPIN, provavel re-abertura CAM-01) e com possiveis
      // tools_a_executar — que um HIT futuro re-executaria (CR-01). O cache
      // semantico so aprende com saidas do PRIMARIO validadas pelo guard de
      // saidaCacheavel (caminho normal acima).

      if (resultadoFallback.tipo === 'handoff' && !jaNotificouRecentemente(numero, 'fallback_handoff')) {
        enviarAvisoAoSuporte([
          '🚨 *Fallback esgotado — handoff humano acionado automaticamente*',
          `Lead: ${nome || sessaoAtual?.nome || '(sem nome)'}`,
          `Telefone: ${numero}`,
          `Codigo do erro original: ${errorCode}`,
          '',
          'O LLM primario e o secundario falharam e nao havia cache de fallback do lead — a IA acionou escalate_to_human automaticamente (protocolo HARD-07). Alguem do time precisa assumir.',
        ]).catch((e) => console.error('[notificacao] Falha ao avisar grupo (fallback handoff):', e));
      }
    } catch (eCascata) {
      console.error(`[fallback] ${numero}: cascata de fallback tambem falhou — caindo no silencio+alerta padrao (ultimo recurso):`, eCascata);
    }

    // Ultimo recurso (defesa em profundidade): so dispara se a cascata acima
    // NAO conseguiu resolver nada (nem secundario, nem cache, nem sequer
    // despachar o handoff) — evita alerta duplicado quando a cascata ja
    // avisou o handoff acima. Idempotencia de 1h por telefone — evita virar
    // spam no grupo se o erro persistir turno apos turno.
    if (!cascataResolveu && !jaNotificouRecentemente(numero, 'erro_agente')) {
      enviarAvisoAoSuporte([
        '🚨 *Erro no agente — atender o lead manualmente*',
        `Lead: ${nome || '(sem nome)'}`,
        `Telefone: ${numero}`,
        `Codigo: ${errorCode}`,
        `Erro: ${mensagemErro.slice(0, 250)}`,
        '',
        'A IA falhou ao gerar resposta neste turno e a cascata de fallback tambem nao conseguiu responder. Alguem do time precisa olhar.',
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
    qualificadorAgent,
    camilaAgent,
  },
  storage: pgStore,
  logger: new PinoLogger({
    name: 'SDR Auton',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'sdr-auton',
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
            // CR-03 (4a rodada): autenticacao fail-closed ANTES de qualquer
            // efeito. desbloquearNumero desfaz a pausa DURAVEL de crise
            // (limpa metadata.bloqueado_ate E volta a conversa
            // aguardando_humano pra em_atendimento) — exatamente os 2 sinais
            // que o guard de crise do webhook do formulario (CR-01) e os
            // schedulers (no-show/lembretes) usam. ADMIN_API_TOKEN vazio
            // desabilita o endpoint por completo (mesmo padrao dos webhooks).
            const tokenAdmin = c.req.query('token') || c.req.header('x-admin-token') || '';
            if (!ADMIN_API_TOKEN || tokenAdmin !== ADMIN_API_TOKEN) {
              console.warn(`[desbloquear] token invalido ou ausente (recebido: "${tokenAdmin.slice(0, 4)}...")`);
              return c.json({ status: 'unauthorized' }, 401);
            }

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
            // CR-01: autenticacao fail-closed. ANTES de qualquer parse/efeito
            // colateral (dedup, sessao, pipeline, dupla acao) — um POST sem o
            // segredo compartilhado (?token= na URL ou header
            // x-webhook-token) e rejeitado com 401. FORMULARIO_WEBHOOK_TOKEN
            // vazio desabilita o endpoint por completo (qualquer token
            // recebido falha a comparacao contra string vazia).
            const token = c.req.query('token') || c.req.header('x-webhook-token') || '';
            if (!FORMULARIO_WEBHOOK_TOKEN || token !== FORMULARIO_WEBHOOK_TOKEN) {
              console.warn(`[formulario] token invalido ou ausente (recebido: "${token.slice(0, 4)}...")`);
              return c.json({ status: 'unauthorized' }, 401);
            }

            const payload = await c.req.json() as Record<string, unknown>;

            // Telefone/nome/contactId: aceita variantes comuns de payload
            // (GHL Workflow costuma mandar {{contact.phone}}/{{contact.name}}
            // como texto puro no corpo do POST). Formato exato e Claude's
            // Discretion (01-CONTEXT.md).
            const contatoBruto = (payload.contact as Record<string, unknown>) || {};
            const telefoneRaw = String(payload.telefone || payload.phone || contatoBruto.phone || '');
            const telefone = telefoneRaw.replace(/[^\d]/g, '');
            const nomeBruto = String(payload.nome || payload.name || contatoBruto.name || '');
            // WR-01 (4a rodada): NUNCA propagar o placeholder pra
            // persistencia — criarSessao -> upsertCustomer (merge-duplicates)
            // com nome='Não identificado' (truthy) clobberaria o nome REAL de
            // um customer existente. nomeReal ('' quando o payload nao traz
            // nome, e o upsert ignora string vazia) vai pra sessao/dupla
            // acao; o placeholder fica SO em logs/notificacoes.
            const nomeReal = nomeBruto;
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

            // CR-01 (4a rodada): pausa de crise por SINAIS DURAVEIS, ANTES de
            // tocar a sessao. O estado logico 'humano' deixou de ser sinal de
            // crise — desde o CLEAN-01 ele tambem significa "inbound frio
            // silenciado" (cold-inbound sem formulario). Um lead frio com
            // sessao 'humano' que finalmente submete o form 14q DEVE ser
            // promovido e qualificado normalmente (core value: agendar a
            // call). Crise REAL e o que escalate-to-human/bloquearNumero
            // gravam de forma DURAVEL: conversa aberta com
            // status='aguardando_humano' (SEM janela de tempo —
            // buscarConversaAguardandoHumano) OU bloqueio ativo
            // (estaBloqueado, metadata.bloqueado_ate). SO esses sinais
            // suprimem o pipeline — nunca o agenteAtual da sessao. Suprime o
            // pipeline inteiro (Qualificador + dupla acao) e AVISA o time em
            // vez de silenciar (o lead submeteu, algo pode ter mudado).
            try {
              const customerCrise = await buscarCustomerPorTelefone(telefone);
              const conversaCrise = customerCrise
                ? await buscarConversaAguardandoHumano(customerCrise.id)
                : null;
              const emCriseDuravel = Boolean(conversaCrise) || (await estaBloqueado(telefone));

              if (emCriseDuravel) {
                console.log(`[formulario] ${telefone} em pausa de crise duravel (aguardando_humano/bloqueio) — pipeline do Qualificador SUPRIMIDO`);
                enviarAvisoAoSuporte([
                  `⚠️ Lead ${telefone} submeteu o formulario mas esta em atendimento humano/bloqueado — avaliar manualmente (nao reativado automaticamente).`,
                ]).catch((e) => console.error('[formulario] falha ao avisar suporte da supressao:', e));
                return c.json({ status: 'em_atendimento_humano' });
              }
            } catch (e) {
              // WR-05 (3a rodada, mantido): fail CLOSED. Se a checagem de
              // crise nao pode ser feita (Supabase instavel), NAO seguimos
              // com o pipeline — um guard que protege uma pausa de CVV-188
              // nao pode falhar aberto (o Qualificador mutaria CRM/tasks de
              // um lead em crise). 503 => o GHL Workflow re-tenta depois; o
              // hash de dedup deste disparo ja foi consumido, mas um retry
              // >1min cai num minBucket novo e passa — e perder um retry raro
              // e mais seguro que rodar o pipeline por cima de uma possivel
              // escalacao.
              console.error('[formulario] erro ao checar pausa de crise — pipeline SUPRIMIDO (fail-closed):', e);
              return c.json({ status: 'erro_verificacao_crise' }, 503);
            }

            // Garante sessao com ghlContactId em cache ANTES de invocar o
            // agente — mesma logica do webhook de mensagens — pra tools do
            // Qualificador (read-lead-ficha, gravar-bant-fields, etc)
            // resolverem contactId sem lookup extra via API.
            //
            // WR-05 (sustentado): sessao PRE-EXISTENTE e movida pra
            // 'qualificador' ANTES do pipeline — assim a guarda de silencio
            // do Gap 2 vale tambem pra sessoes antigas, e um PERDIDO nao
            // vaza pra persona errada na proxima mensagem.
            // CR-01 (4a rodada): isso INCLUI sessao 'humano' FRIA
            // (cold-inbound) — a crise ja foi descartada acima pelos sinais
            // duraveis, entao 'humano' aqui e so silencio de fora-do-funil e
            // o form e justamente o gatilho que traz o lead PRO funil.
            // WR-02 (4a rodada): 'camila' e estado terminal-forward — um
            // re-submit do form com SPIN em andamento NAO rebaixa a sessao
            // pra 'qualificador' (a guarda de silencio mataria a conversa
            // viva no proximo turno) nem re-dispara a abertura proativa
            // (CAM-01: abertura UNICA). A ficha/ancora ainda e atualizada
            // pelo pipeline abaixo; jaEmSpin suprime SO a dupla acao.
            let jaEmSpin = false;
            try {
              const sessaoExistente = await getSessao(telefone);
              if (!sessaoExistente) {
                await criarSessao(telefone, { nome: nomeReal, ghlContactId: contactId, agenteAtual: 'qualificador' });
              } else {
                jaEmSpin = sessaoExistente.agenteAtual === 'camila';
                if (contactId && sessaoExistente.ghlContactId !== contactId) {
                  const { atualizarSessao } = await import('./sessao');
                  await atualizarSessao(telefone, { ghlContactId: contactId });
                }
                if (!jaEmSpin && sessaoExistente.agenteAtual !== 'qualificador') {
                  await trocarAgente(telefone, 'qualificador');
                }
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
              const t0Qualificador = Date.now();
              try {
                const respostaQualificador = await comRetry(
                  () => comTimeout(agent.generate(prompt), TIMEOUT_AGENTE, 'qualificador'),
                  MAX_TENTATIVAS,
                  'qualificador',
                );

                // HARD-08 (05-06): metrica do Qualificador. Best-effort/
                // fail-open — nunca atrasa/derruba a dupla acao (QUAL-04)
                // abaixo. Sem conversationId/customerId aqui (nao
                // disponiveis nesta closure sem lookup extra) — telefone
                // basta como identificador pra correlacao.
                const usageQualificador = (respostaQualificador as any)?.usage;
                registrarMetricaLLM(
                  {
                    modelo: AZURE_OPENAI_DEPLOYMENT_GPT5_MINI,
                    tipo: 'qualificador',
                    promptTokens: usageQualificador?.inputTokens ?? 0,
                    completionTokens: usageQualificador?.outputTokens ?? 0,
                    latenciaMs: Date.now() - t0Qualificador,
                    promptVersao: QUALIFICADOR_PROMPT_VERSION,
                    telefone,
                    cacheHit: false,
                    tokensEstimados: !usageQualificador,
                  },
                  salvarMetricaLLM,
                );
              } catch (erro) {
                // WR-04 (3a rodada): a falha do Qualificador NAO pode ser
                // log-only. A sessao ja foi movida pra 'qualificador' (WR-05)
                // — um estado cuja guarda de mensagens e silencio absoluto —
                // entao sem sinal team-visivel um lead ficaria mudo e
                // invisivel indefinidamente. Mesmo handler de erro de
                // processarMensagem: persiste em auton_sdr_errors (dashboard)
                // + aviso idempotente no grupo de suporte.
                console.error(`[formulario] qualificadorAgent falhou para ${telefone} (todas as tentativas):`, erro);
                const mensagemErro = String((erro as Error)?.message || erro).slice(0, 500);
                salvarErro({
                  telefone,
                  nome,
                  error_message: mensagemErro,
                  error_code: classificarErro(erro),
                  context: { origem: 'webhook_formulario', stage: roteamento.stage },
                }).catch((e) => console.error('[supabase] Falha ao salvar erro do qualificador:', e));
                if (!jaNotificouRecentemente(telefone, 'qualificador_falhou')) {
                  enviarAvisoAoSuporte([
                    '🚨 *Qualificador falhou apos submit do formulario — agir manualmente*',
                    `Lead: ${nome || '(sem nome)'}`,
                    `Telefone: ${telefone}`,
                    `Stage decidido (deterministico): ${roteamento.stage}`,
                    `Erro: ${mensagemErro.slice(0, 250)}`,
                    '',
                    roteamento.stage === 'QUALIFICADO'
                      ? 'A dupla acao (abertura da Camila + task) sera disparada mesmo assim; conferir as gravacoes bant_*/move de card no GHL.'
                      : 'As gravacoes bant_*/motivo_perdido e o move de card podem NAO ter acontecido — conferir o GHL. O lead esta em silencio (estado qualificador).',
                  ]).catch((e) => console.error('[notificacao] Falha ao avisar grupo sobre falha do qualificador:', e));
                }
              }

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
              // WR-04: dispara MESMO se o generate acima falhou — a decisao
              // de roteamento e deterministica e ja conhecida aqui; um lead
              // QUALIFICADO nao pode ficar sem abertura da Camila nem sem
              // task so porque a burocracia de CRM do Qualificador falhou
              // (a acao (A) tambem tira a sessao do estado 'qualificador'
              // silenciado, promovendo pra 'camila').
              // WR-02 (4a rodada): jaEmSpin (sessao ja era 'camila' no
              // momento do submit — re-submit legitimo fora da janela de
              // dedup) SUPRIME a dupla acao: uma 2a abertura proativa no
              // meio do SPIN violaria CAM-01, e a task ja foi criada no 1o
              // disparo. A ficha foi atualizada pelo pipeline acima; um
              // humano decide o resto (aviso idempotente ao suporte).
              if (jaEmSpin) {
                console.log(`[formulario] ${telefone} re-submeteu o form com SPIN em andamento — dupla acao SUPRIMIDA (ficha atualizada, sem nova abertura)`);
                if (!jaNotificouRecentemente(telefone, 'form_resubmit_spin')) {
                  enviarAvisoAoSuporte([
                    `ℹ️ Lead ${telefone} re-submeteu o formulario com conversa da Camila em andamento.`,
                    `Stage recalculado: ${roteamento.stage}` +
                      (roteamento.stage === 'PERDIDO' ? ` (${roteamento.motivo})` : '') +
                      '. Ficha atualizada; NENHUMA nova abertura/task disparada (CAM-01) e a sessao NAO foi silenciada (conversa viva) — avaliar manualmente.',
                  ]).catch((e) => console.error('[formulario] falha ao avisar suporte do re-submit em SPIN:', e));
                }
              } else if (roteamento.stage === 'QUALIFICADO') {
                dispararDuplaAcao({
                  telefone,
                  contactId,
                  nome: nomeReal,
                  bant: roteamento.bant,
                  ancora: '',
                }).catch((e) => console.error(`[formulario] dispararDuplaAcao falhou para ${telefone}:`, e));
              }
            })().catch((e) => console.error(`[formulario] pipeline do Qualificador falhou para ${telefone}:`, e));

            // Resposta IMEDIATA (202 Accepted): o GHL so precisa saber que o
            // submit foi aceito; o processamento segue em background.
            return c.json({ status: 'aceito', stage: roteamento.stage, stage_id: GHL_STAGES[roteamento.stage] }, 202);
          } catch (erro) {
            console.error('[formulario] Erro no webhook:', erro);
            return c.json({ status: 'erro', mensagem: String(erro) }, 500);
          }
        },
      },
      // Webhook de gravacao de call/ligacao (Fase 3, GRAV-01/GRAV-04). Dispara
      // de um Workflow GHL NOVO (Automation -> Workflow "Call/Recording
      // completed" -> acao Webhook) com { telefone, recordingUrl, tipo }.
      // Pipeline 100% determinístico ate a transcricao (Whisper/Azure via
      // transcreverAudio, reuso do audio de WhatsApp): download -> transcreve
      // -> ANONIMIZA (gate LGPD fail-closed, GRAV-04) -> persiste no custom
      // field certo por `tipo`. Nenhuma mensagem e enviada ao lead neste
      // fluxo (persistencia de dado, nao acao proativa).
      {
        path: '/api/webhook/gravacao',
        method: 'POST',
        handler: async (c) => {
          try {
            // T-03-01: autenticacao fail-closed. ANTES de qualquer parse do
            // body/efeito colateral (dedup, download, transcricao,
            // persistencia) — um POST sem o segredo compartilhado (?token=
            // na URL ou header x-webhook-token) e rejeitado com 401.
            // GRAVACAO_WEBHOOK_TOKEN vazio desabilita o endpoint por completo
            // (qualquer token recebido falha a comparacao contra string
            // vazia) — mesmo padrao de /api/webhook/formulario (CR-01).
            const token = c.req.query('token') || c.req.header('x-webhook-token') || '';
            if (!GRAVACAO_WEBHOOK_TOKEN || token !== GRAVACAO_WEBHOOK_TOKEN) {
              console.warn(`[gravacao] token invalido ou ausente (recebido: "${token.slice(0, 4)}...")`);
              return c.json({ status: 'unauthorized' }, 401);
            }

            const payload = await c.req.json() as Record<string, unknown>;

            // Parse tolerante — shape exato do Workflow GHL de gravacao ainda
            // nao validado ao vivo (deferido ao UAT de fim de fase); aceita
            // variantes comuns de chave.
            const telefoneRaw = String(
              payload.telefone || payload.phone || (payload.contact as any)?.phone || '',
            );
            const telefone = telefoneRaw.replace(/[^\d]/g, '');
            const recordingUrl = String(
              payload.recordingUrl || payload.recording_url || payload.url || payload.gravacaoUrl || '',
            );
            const tipoRaw = String(payload.tipo || payload.type || '');
            const tipo = (tipoRaw === 'sdr_ligacao' || tipoRaw === 'closer_call') ? (tipoRaw as TipoGravacao) : null;

            if (!telefone || !tipo) {
              console.warn(
                `[gravacao] payload invalido (telefone=${telefone ? 'ok' : 'ausente'}, tipo=${tipoRaw || 'ausente'})`,
              );
              return c.json({ status: 'payload invalido' }, 400);
            }

            // Dedup — retry do GHL Workflow nao reprocessa a MESMA gravacao
            // (mesmo padrao de tentarRegistrarWebhook do formulario, T-03-05
            // parcial: reduz reprocessamento de retry, nao e o guard de
            // tamanho). Fail-open por design (T-01-10-05 herdado): preferimos
            // reprocessar raro a nunca processar por erro no dedup.
            // CR-05: bucket de MINUTO no hash (mesmo padrao do formulario/
            // evolution) — sem ele, o retry que o 502 abaixo provoca chegava
            // com hash identico e era descartado como 'duplicado', perdendo a
            // transcricao pra sempre. Com o bucket, so a rajada de retry
            // automatico DENTRO do mesmo minuto e deduplicada; um retry
            // pos-falha (>1min) ganha hash novo e reprocessa.
            const minBucket = Math.floor(Date.now() / 60_000);
            const hashGravacao = createHash('sha1').update(`${telefone}|${recordingUrl}|${tipo}|${minBucket}`).digest('hex');
            const ehNovaGravacao = await tentarRegistrarWebhook(hashGravacao);
            if (!ehNovaGravacao) {
              console.log(`[gravacao] webhook duplicado descartado (hash=${hashGravacao.slice(0, 8)}, telefone=${telefone})`);
              return c.json({ status: 'duplicado' });
            }

            // Download (anti-SSRF, T-03-02) -> transcreve (reuso do Whisper/
            // Azure de audio de WhatsApp) -> anonimiza (GATE LGPD, GRAV-04).
            // CR-05: falha transitoria (download/transcricao) retorna 502 —
            // nada de "fake 200": o GHL Workflow precisa RE-TENTAR (o retry
            // >1min ganha hash de dedup novo, ver minBucket acima). A
            // persistencia e idempotente (PUT do custom field), entao
            // reprocessar e seguro.
            const audioBase64 = await baixarGravacaoBase64(recordingUrl);
            if (!audioBase64) {
              console.warn(`[gravacao] download/validacao da recordingUrl falhou para ${telefone} — nada a transcrever`);
              return c.json({ status: 'download falhou' }, 502);
            }

            const transcricaoBruta = await transcreverAudio(audioBase64);
            if (!transcricaoBruta) {
              console.warn(`[gravacao] transcricao falhou para ${telefone} — nada a persistir`);
              return c.json({ status: 'transcricao falhou' }, 502);
            }

            const anonimizacao = anonimizarTranscricao(transcricaoBruta);
            // GRAV-04 (gate fail-closed): se a anonimizacao NAO confirmar
            // ok:true, a transcricao bruta (potencial dado de PACIENTE) NUNCA
            // e persistida nem logada — so o log de contador abaixo.
            if (!anonimizacao.ok) {
              console.warn('[gravacao] anonimizacao falhou — transcricao descartada (fail-closed, nada persistido)');
              return c.json({ status: 'anonimizacao falhou' });
            }

            const persistiu = await persistirTranscricaoContato(telefone, tipo, anonimizacao.textoAnon);
            if (!persistiu) {
              console.error(`[gravacao] persistencia falhou para ${telefone} (tipo=${tipo})`);
              return c.json({ status: 'persistencia falhou' }, 502);
            }

            // GRAV-02/GRAV-03: extracao dos 6 sinais FIRE-AND-FORGET (nao
            // await no caminho critico — mesmo padrao de dispararDuplaAcao/
            // dupla-acao.ts) pra nao somar a latencia do LLM extrator a
            // resposta deste webhook. Passa a transcricao JA ANONIMIZADA
            // (nunca a bruta).
            extrairSinaisDaTranscricao(mastra, telefone, tipo, anonimizacao.textoAnon).catch((e) =>
              console.error(`[gravacao] extrairSinaisDaTranscricao falhou para ${telefone}:`, e),
            );

            return c.json({ status: 'ok', tipo, redacoes: anonimizacao.redacoes });
          } catch (erro) {
            console.error('[gravacao] Erro no webhook:', erro);
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
            // CR-02 (4a rodada): autenticacao fail-closed, MESMO padrao dos
            // outros 2 webhooks (formulario/gravacao). ANTES de qualquer
            // parse/efeito colateral (dedup, sessao, buffer, reset) — um
            // POST sem o segredo compartilhado (?token= na URL ou header
            // x-webhook-token) e rejeitado com 401. Sem isso, um POST
            // anonimo forjava "mensagem do lead" (prompt injection com
            // tools reais de CRM via Camila) ou disparava o reset destrutivo
            // #55555 pra qualquer telefone. EVOLUTION_WEBHOOK_TOKEN vazio
            // desabilita o endpoint por completo (fail-closed).
            const tokenMsg = c.req.query('token') || c.req.header('x-webhook-token') || '';
            if (!EVOLUTION_WEBHOOK_TOKEN || tokenMsg !== EVOLUTION_WEBHOOK_TOKEN) {
              console.warn(`[GHL] token invalido ou ausente no webhook de mensagens (recebido: "${tokenMsg.slice(0, 4)}...")`);
              return c.json({ status: 'unauthorized' }, 401);
            }

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
            let sessaoWebhook: Sessao | undefined;
            try {
              sessaoWebhook = await getSessao(numero);
              if (!sessaoWebhook) {
                // CLEAN-01: cold-inbound (mesma decisao de processarMensagem
                // acima) — 'humano' (silencio seguro), nunca 'vendedor'
                // (agente removido).
                sessaoWebhook = await criarSessao(numero, { nome, ghlContactId, agenteAtual: 'humano' });
              } else if (sessaoWebhook.ghlContactId !== ghlContactId) {
                const { atualizarSessao } = await import('./sessao');
                await atualizarSessao(numero, { ghlContactId });
              }
            } catch (e) {
              console.error('[GHL] erro ao garantir sessao com ghlContactId:', e);
            }

            // WR-05 (4a rodada): contrato de silencio do funil. Os fallbacks
            // amigaveis abaixo (MSG_AUDIO_FALHOU) rodam ANTES da guarda de
            // estado de processarMensagem (que so executa apos o buffer de
            // 10s) — sem esta checagem, um numero FRIO fora do funil que
            // mandasse um audio/sticker recebia a resposta simpatica "ta com
            // muito barulho aqui..." e, ao digitar, caia no silencio
            // permanente (quebra do contrato CLEAN-01 + beco sem saida pro
            // lead). Mesmos estados silenciados de processarMensagem:
            // 'humano' (pausa/fora do funil) e 'qualificador' (batch).
            // Fail-closed: sessao indisponivel (erro acima) tambem silencia.
            const sessaoSilenciada =
              !sessaoWebhook ||
              sessaoWebhook.agenteAtual === 'humano' ||
              sessaoWebhook.agenteAtual === 'qualificador';

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
                // WR-05: numero silenciado (fora do funil/batch) nao recebe
                // o fallback amigavel — silencio consistente com o contrato.
                if (!sessaoSilenciada && !jaNotificouRecentemente(numero, 'audio_falhou')) {
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
              // WR-05: mesmo contrato de silencio do fallback de audio acima.
              if (!sessaoSilenciada && !jaNotificouRecentemente(numero, 'audio_falhou')) {
                await enviarMensagem(numero, MSG_AUDIO_FALHOU).catch((e) => console.error('[GHL] Falha ao enviar fallback de mensagem nao reconhecida:', e));
              }
              return c.json({ status: 'sem texto' });
            }

            // Comando de reset de teste (#55555).
            if (texto.trim() === COMANDO_RESET) {
              // CR-02 (4a rodada): allowlist fail-closed. resetarConversaTeste
              // DESTROI dados do lead (mensagens, conversas, memoria Mastra)
              // e derruba o bloqueio de crise (desbloquearNumero) — mesmo com
              // o webhook autenticado, o comando so pode agir sobre telefones
              // de TESTE explicitamente listados em RESET_TELEFONES_PERMITIDOS
              // (lista vazia = comando desabilitado pra todo mundo). Um lead
              // real de producao que digite #55555 nunca se auto-reseta.
              if (!RESET_TELEFONES_PERMITIDOS.includes(numero)) {
                console.warn(`[GHL] Comando ${COMANDO_RESET} de ${numero} IGNORADO — numero fora de RESET_TELEFONES_PERMITIDOS (fail-closed)`);
                return c.json({ status: 'reset_nao_autorizado' });
              }
              console.log(`[GHL] Comando ${COMANDO_RESET} recebido de ${numero}, resetando...`);
              const resultado = await resetarConversaTeste(numero);
              const status = resultado.erros.length === 0 ? 'memoria limpa, pode comecar de novo' : 'memoria limpa (alguns subitens falharam, ver logs)';
              await enviarMensagem(numero, `🧹 ${status}`);
              return c.json({ status: 'reset', ...resultado });
            }

            console.log(`[GHL] Mensagem de ${nome} (${numero}, contact:${ghlContactId}): ${texto}`);

            // HARD-03: controle de admissao (rate limit + fila com
            // prioridade), ANTES do buffer/processarMensagem. Ordem no
            // handler: auth (topo) -> dedup (hash) -> estaBloqueado (acima)
            // -> ADMISSAO (aqui) -> buffer/processarMensagem (abaixo). O
            // texto ja esta na forma final (pos audio/fallback/reset), entao
            // classificarPrioridade avalia o conteudo real que vai virar
            // prompt. `leadEmCrise` reusa a MESMA leitura duravel de
            // estaBloqueado ja checada acima nesta requisicao — recalculada
            // aqui pra fechar a janela de corrida entre aquela checagem e
            // este ponto (downloads/transcricao de audio podem levar tempo).
            const emCriseDuravelParaFila = await estaBloqueado(numero);
            const prioridadeMsg = classificarPrioridade(numero, texto, () => emCriseDuravelParaFila);
            const decisaoAdmissao = admitir(prioridadeMsg);

            if (!decisaoAdmissao.admitido) {
              // T-05-01-03: shed EXPLICITO de NORMAL sob overload sustentado
              // — NUNCA perda silenciosa. Avisa o suporte (idempotente 1h) e
              // responde 200 ao GHL (evita retry infinito do Workflow).
              // CRISE nunca cai aqui (admitir(0) e sempre {admitido:true}).
              console.warn(`[fila] ${numero} shedado sob overload (motivo=${decisaoAdmissao.motivo})`);
              if (!jaNotificouRecentemente(numero, 'fila_overload')) {
                enviarAvisoAoSuporte([
                  `⚠️ Mensagem de ${numero} shedada por overload de rate limit — lead pode precisar de retorno manual.`,
                ]).catch((e) => console.error('[fila] falha ao avisar suporte do shed:', e));
              }
              return c.json({ status: 'overload_shed' });
            }

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

// Scheduler dos lembretes de call agendada (TOOL-08/FUN-02): D-1 (24h antes),
// H-1 (1h antes) e 5min antes. O toque 1 (confirmacao imediata) ja disparou
// no momento do agendamento (tools/schedule-reminder.ts). State no Supabase
// (auton_sdr_call_reminders) sobrevive reinicio, mesmo padrao do follow-up.
iniciarLembretesScheduler(mastra);
