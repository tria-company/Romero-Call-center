import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';

// Config: token do device Wavoip (SDK do navegador) + credenciais GHL +
// token do webhook Wavoip (transcricao das calls) + limiar de aderencia do
// Agente Analise (D-P3-10, Fase 03 Plano 03).
// OPER_RETORNO_NAO_ATENDEU_DIAS/OPER_RETORNO_DEFAULT_DIAS: regra fixa de
// PROXIMO_CONTATO quando a ligacao nao trouxe DATA_RETORNO explicito
// (D-P3-14, Agente Contexto — Fase 03 Plano 04).
import {
  WAVOIP_DEVICE_TOKEN,
  WAVOIP_WEBHOOK_TOKEN,
  ANALISE_ADERENCIA_MINIMA,
  OPER_RETORNO_NAO_ATENDEU_DIAS,
  OPER_RETORNO_DEFAULT_DIAS,
} from './config';

// Auth do PWA discador (login por closer, token HMAC sem estado).
import { verificarCredenciais, emitirToken, verificarToken, tokenDoHeader } from './discador-auth';

// Lista de leads qualificados (GHL, pipeline COMERCIAL USI) — legado, ver nota
// na rota /api/discador/qualificados abaixo.
import { buscarQualificados } from './ghl';

// Fila de Ligacoes (Lista 02 ClickUp) do operador logado + detalhe/script de
// uma Ligacao (LOTE-04/05, Fase 02 Plano 03 — substitui buscarQualificados).
// iniciarLigacao grava INICIO+OPERADOR e move a task pra "em processamento"
// ao tocar Ligar (OPER-01/02, D-P3-01/02/07, Fase 03 Plano 01). Os helpers de
// escrita da Ligacao (transcricao/metadados/avulsa) reapontam o webhook RECORD
// do GHL pro ClickUp (OPER-01/02, D-P3-03/04/05, Fase 03 Plano 02).
// lerTask + setCustomField + CAMPOS_LIGACOES sao usados pelo passo do Agente
// Analise (D-P3-08/09/10/11, Fase 03 Plano 03) pra ler o script (descricao da
// task) e gravar ADERENCIA_SCRIPT/NECESSITA_REVISAO/RETORNO_NECESSARIO/
// DATA_RETORNO/ANALISE_IA/OBSERVACOES_EXTRAIDAS por field-id (D-07).
// resolverLeadDaLigacao + consolidarLead + fecharLigacao + CAMPOS_LEADS
// fecham o loop (OPER-05, D-P3-06/12/13/14, Fase 03 Plano 04): resolvem o
// lead da Ligacao, escrevem a consolidacao na Lista 01 e fecham a task.
import {
  buscarFilaLigacoes,
  lerLigacao,
  iniciarLigacao,
  gravarTranscricao,
  gravarMetadadosLigacao,
  buscarLigacaoAbertaPorTelefone,
  criarLigacaoAvulsa,
  lerTask,
  setCustomField,
  CAMPOS_LIGACOES,
  CAMPOS_LEADS,
  resolverLeadDaLigacao,
  lerStatusVotoLead,
  salvarVotoLead,
  consolidarLead,
  fecharLigacao,
} from './clickup';

// Mapa usuario-do-discador -> assignee (memberId) do ClickUp (Fase 02 Plano 02).
import { assigneeDoOperador } from './operadores';

// Transcricao da gravacao da call via Deepgram (entrada por URL).
import { transcreverCallUrl } from './deepgram';

// Derivacoes puras de ATENDEU/MOTIVO_FALHA/DURACAO a partir do payload Wavoip
// (OPER-02, D-P3-05, Fase 03 Plano 02) — modulo puro, so calculo, sem I/O.
// montarPromptAnalise/parseResultadoAnalise/necessitaRevisao/extrairRetorno
// sao o Agente Analise (OPER-03/04, D-P3-09/10/11/15, Fase 03 Plano 03) —
// tambem modulo puro, so monta prompt/parseia/decide, nunca chama o LLM.
import {
  derivarAtendeu,
  derivarMotivoFalha,
  derivarDuracao,
  ehStatusFalhaTerminal,
  montarPromptAnalise,
  parseResultadoAnalise,
  necessitaRevisao,
  extrairRetorno,
} from './analise';

// montarPromptContexto/proximoContato/derivarContadores sao o Agente
// Contexto (OPER-05, D-P3-12/13/14, Fase 03 Plano 04) — modulo puro que
// monta o prompt de consolidacao do lead e calcula PROXIMO_CONTATO +
// contadores; tambem nunca chama o LLM diretamente.
import { montarPromptContexto, proximoContato, derivarContadores } from './contexto';

// chamarLLM(prompt, system) — chamada do provider de IA ativo (D-08), usada
// pelos passos do Agente Analise (Fase 03 Plano 03) e do Agente Contexto
// (Fase 03 Plano 04).
import { chamarLLM } from './llm';

// Assets estaticos do PWA discador (HTML/JS/manifest/SW/icon).
import { DISCADOR_HTML, DISCADOR_APP_JS, DISCADOR_MANIFEST, DISCADOR_SW_JS, DISCADOR_ICON_SVG } from './discador-pwa';
// Durabilidade do webhook (Fase 2 — escala): persiste cada evento antes de processar.
import { registrarEventoWebhook, marcarEventoWebhook } from './supabase';
// Estado do webhook (Fase 5 — escala): correlacao call->telefone, task ativa
// por telefone e dedup de RECORD/falha terminal agora moram na camada
// Redis-ou-memoria (estado-webhook.ts) — alternavel por REDIS_URL sem
// reescrever o handler abaixo.
import {
  guardarCorrelacao,
  lerCorrelacao,
  guardarTaskAtiva,
  lerTaskAtiva,
  limparTaskAtiva,
  marcarRecordProcessado,
  liberarRecordProcessado,
  marcarCallFalhaProcessada,
} from './estado-webhook.ts';

/** Extrai o telefone (so digitos) do evento CALL conforme a direcao. */
function telefoneDoEventoCall(payload: Record<string, any>): string {
  const direction = String(payload.direction || '').toUpperCase();
  const raw = direction === 'INCOMING'
    ? String(payload.caller || '')
    : String(payload.receiver || payload.caller || '');
  return raw.replace(/[^\d]/g, '');
}

// ===== Agente Contexto — consolidacao do lead + fechamento da Ligacao =====
// (OPER-05, D-P3-06/12/13/14/15, Fase 03 Plano 04 — fecha o loop diario)

/** Le os valores atuais do lead (Lista 01) que `derivarContadores`/`consolidarLead` precisam. Defaults seguros quando o campo ainda nao tem valor (primeira ligacao do lead). */
function valoresAtuaisDoLead(lead: Awaited<ReturnType<typeof lerTask>>): {
  observacaoAtual: string;
  tentativasAtuais: number;
  atendimentosAtuais: number;
  naoAtendimentosAtuais: number;
} {
  const campo = (id: string) => lead?.custom_fields?.find((c) => c.id === id)?.value;
  const numero = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    observacaoAtual: String(campo(CAMPOS_LEADS.OBSERVACAO_CONSOLIDADA) ?? ''),
    tentativasAtuais: numero(campo(CAMPOS_LEADS.QTD_TENTATIVAS)),
    atendimentosAtuais: numero(campo(CAMPOS_LEADS.QTD_ATENDIMENTOS)),
    naoAtendimentosAtuais: numero(campo(CAMPOS_LEADS.QTD_NAO_ATENDIMENTOS)),
  };
}

/**
 * Consolida o resultado da ligacao no lead (Lista 01) e fecha a task de
 * Ligacao (Lista 02) — usado nos DOIS caminhos do webhook (atendida, apos o
 * Agente Analise; nao-atendida, sem transcricao/LLM de analise). Resolve o
 * lead via `resolverLeadDaLigacao` (LEAD_REL, fallback telefone); le os
 * valores atuais do lead; chama o Agente Contexto (`montarPromptContexto` +
 * `chamarLLM`) pra reescrever o resumo vivo (D-P3-13) — falha do LLM loga e
 * MANTEM a observacao anterior (nao trava a consolidacao dos contadores/
 * proximo contato); calcula `proximoContato` (D-P3-14) e `derivarContadores`;
 * grava tudo via `consolidarLead`. Fecha a Ligacao (`fecharLigacao`, D-P3-06)
 * SEMPRE ao final, mesmo se a consolidacao do lead falhar (a task nao pode
 * ficar aberta pra sempre so por causa de uma falha isolada de escrita no
 * lead — cada passo loga-e-segue, WR-03/D-P3-08). Nenhuma PII em log — so
 * ids/flags.
 */
async function consolidarEFecharLigacao(
  taskLigacaoId: string,
  opts: {
    atendeu: boolean;
    resumoAnalise: string;
    aderencia: number | null;
    retorno: { necessario: boolean; data: Date | null };
  },
): Promise<void> {
  try {
    const leadTaskId = await resolverLeadDaLigacao(taskLigacaoId);
    if (!leadTaskId) {
      console.warn(`[wavoip] consolidacao: lead nao resolvido a partir da Ligacao ${taskLigacaoId} — pulando consolidarLead`);
    } else {
      const lead = await lerTask(leadTaskId);
      const atuais = valoresAtuaisDoLead(lead);
      const hoje = new Date();

      // D-P3-13: reescreve o resumo vivo. Falha do LLM (indisponibilidade/
      // erro de parse-livre, este prompt nao pede JSON) loga e mantem a
      // observacao anterior — os contadores/proximo contato ainda sao
      // gravados abaixo, a cadeia nao trava (mesmo racional do Agente Analise).
      let observacaoConsolidada = atuais.observacaoAtual;
      try {
        const { system, prompt } = montarPromptContexto({
          observacaoAtual: atuais.observacaoAtual,
          atendeu: opts.atendeu,
          resumoAnalise: opts.resumoAnalise,
          aderencia: opts.aderencia,
          retorno: opts.retorno,
        });
        const textoLLM = await chamarLLM(prompt, system);
        if (textoLLM) observacaoConsolidada = textoLLM.trim();
      } catch (e) {
        console.error('[wavoip] falha no Agente Contexto (LLM) — mantendo observacao anterior:', e);
      }

      const proximoContatoData = proximoContato({
        dataRetorno: opts.retorno.data,
        atendeu: opts.atendeu,
        hoje,
        diasNaoAtendeu: OPER_RETORNO_NAO_ATENDEU_DIAS,
        diasDefault: OPER_RETORNO_DEFAULT_DIAS,
      });
      const contadores = derivarContadores({
        atendeu: opts.atendeu,
        tentativasAtuais: atuais.tentativasAtuais,
        atendimentosAtuais: atuais.atendimentosAtuais,
        naoAtendimentosAtuais: atuais.naoAtendimentosAtuais,
        hoje,
      });

      await consolidarLead(leadTaskId, {
        observacaoConsolidada,
        proximoContato: proximoContatoData.getTime(),
        contadores,
      });
    }
  } catch (e) {
    console.error('[wavoip] falha ao consolidar o lead — a Ligacao ainda sera fechada:', e);
  }

  // D-P3-06: a task fecha sozinha no pos-processamento, mesmo se a
  // consolidacao do lead falhou acima — "Proxima" no discador so avanca a UI.
  try {
    await fecharLigacao(taskLigacaoId);
  } catch (e) {
    console.error('[wavoip] falha ao fechar a Ligacao:', e);
  }
}

/**
 * Processa o caminho terminal NAO-ATENDIDO do branch CALL do webhook Wavoip
 * (CR-01/CR-02, D-P3-05/06/12/14): grava os metadados de falha, consolida o
 * lead (sem Agente Analise — nao ha gravacao pra avaliar) e fecha a Ligacao.
 * Chamado tanto pelo ramo map-hit quanto pelo ramo fallback-hit (busca
 * persistida no ClickUp) do branch CALL — mesma sequencia de efeitos nos
 * dois ramos. O dedup (`marcarCallFalhaProcessada`) e responsabilidade do
 * chamador, avaliado ANTES desta funcao (marca atomica — Fase 5).
 */
async function processarFalhaTerminal(
  taskId: string,
  telefone: string,
  whatsappCallId: string,
  payload: Record<string, any>,
): Promise<void> {
  try {
    await gravarMetadadosLigacao(taskId, {
      atendeu: false,
      motivoFalha: derivarMotivoFalha(payload),
      fim: Date.now(),
      duracao: derivarDuracao(payload),
    });
  } catch (e) {
    // Loga-e-segue (a cadeia do webhook nao pode travar por uma
    // escrita isolada) — o helper subjacente JA lancou (WR-03),
    // este catch so evita que o 200 do CALL vire 500.
    console.error('[wavoip] falha ao gravar metadados de nao-atendida:', e);
  }

  // ---- Agente Contexto (OPER-05, D-P3-06/12/14) — caminho NAO-ATENDIDO ----
  // Sem gravacao/transcricao, PULA o Agente Analise (aderencia)
  // — nao ha o que avaliar. Consolida direto com atendeu:false
  // (observacao objetiva; proximoContato = D+OPER_RETORNO_NAO_ATENDEU_DIAS,
  // D-P3-14) e fecha a Ligacao (D-P3-06).
  await consolidarEFecharLigacao(taskId, {
    atendeu: false,
    resumoAnalise: `Não atendida em ${new Date().toISOString().slice(0, 10)}.`,
    aderencia: null,
    retorno: { necessario: false, data: null },
  });

  // CR-02: limpa a entrada telefone->task apos consolidar/
  // fechar — uma ligacao futura ao mesmo telefone nunca
  // re-consolida sobre esta task ja fechada.
  await limparTaskAtiva(telefone);
}

/**
 * Servidor do Discador Wavoip. Serve o PWA (frontend) e a API minima que ele
 * consome: login, lista de qualificados e o token do device Wavoip. A ligacao
 * em si acontece 100% no navegador via SDK Wavoip (WebRTC) — nao ha nada de
 * telefonia no backend.
 */
export const mastra = new Mastra({
  logger: new PinoLogger({
    name: 'Discador Wavoip',
    level: 'info',
  }),
  server: {
    apiRoutes: [
      // ============ PWA DISCADOR (estatico) ============
      {
        path: '/discador',
        method: 'GET',
        handler: (c) => new Response(DISCADOR_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
      },
      {
        path: '/discador/app.js',
        method: 'GET',
        handler: (c) => new Response(DISCADOR_APP_JS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } }),
      },
      {
        path: '/discador/manifest.webmanifest',
        method: 'GET',
        handler: (c) => new Response(DISCADOR_MANIFEST, { headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' } }),
      },
      {
        path: '/discador/sw.js',
        method: 'GET',
        handler: (c) => new Response(DISCADOR_SW_JS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Service-Worker-Allowed': '/discador' } }),
      },
      {
        path: '/discador/icon.svg',
        method: 'GET',
        handler: (c) => new Response(DISCADOR_ICON_SVG, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' } }),
      },

      // ============ API DISCADOR ============
      {
        path: '/api/discador/login',
        method: 'POST',
        handler: async (c) => {
          try {
            const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
            const usuario = String(body.usuario || '');
            const senha = String(body.senha || '');
            if (!verificarCredenciais(usuario, senha)) {
              return c.json({ status: 'invalido' }, 401);
            }
            return c.json({ token: emitirToken(usuario) });
          } catch (e) {
            console.error('[discador] erro login:', e);
            return c.json({ status: 'erro' }, 500);
          }
        },
      },
      {
        // LEGADO (D-P2-07): a tela do discador nao chama mais esta rota — ela
        // foi substituida por /api/discador/fila (Lista 02 ClickUp, LOTE-04).
        // Mantida so pelo import de buscarQualificados/ghl.ts (nao ha mais
        // nenhum caller ativo no webhook — a transcricao agora vai pro
        // ClickUp, D-P3-04, Fase 03 Plano 02).
        path: '/api/discador/qualificados',
        method: 'GET',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          const q = c.req.query('q') || undefined;
          const startAfter = c.req.query('startAfter') || undefined;
          const startAfterId = c.req.query('startAfterId') || undefined;
          const limit = Number(c.req.query('limit')) || 30;
          const r = await buscarQualificados({ q, limit, startAfter, startAfterId });
          return c.json(r);
        },
      },
      {
        // Fila de Ligacoes do operador logado — Lista 02 ClickUp (LOTE-04,
        // T-02-03-E: cada operador so ve a propria fila via assigneeDoOperador).
        path: '/api/discador/fila',
        method: 'GET',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          const assignee = assigneeDoOperador(sess.usuario);
          if (!assignee) {
            // Operador sem DISCADOR_ASSIGNEES configurado — distinto de fila
            // vazia (WR-03/T-02-03-D): a UI precisa avisar "configure o mapeamento",
            // nao "sem ligacoes hoje".
            return c.json({ fila: [], semMapeamento: true });
          }
          try {
            const fila = await buscarFilaLigacoes(assignee);
            return c.json({ fila });
          } catch (e) {
            console.error('[discador] erro ao buscar fila:', e);
            return c.json({ erro: 'Erro ao carregar a fila' }, 502);
          }
        },
      },
      {
        // Detalhe de uma Ligacao (script na descricao — LOTE-05, D-06 revisado).
        // T-02-03-E/CR-01: precisa do MESMO isolamento por operador que a
        // rota /fila — sem resolver o assignee aqui e passa-lo pra
        // lerLigacao, qualquer operador autenticado poderia ler a Ligacao de
        // outro (ou qualquer task da workspace) so trocando o taskId na URL.
        path: '/api/discador/ligacao/:taskId',
        method: 'GET',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          const assignee = assigneeDoOperador(sess.usuario);
          if (!assignee) {
            // Sem mapeamento, o operador nao tem Ligacao nenhuma pra ver —
            // mesmo 404 generico do caso "task nao e sua" (nao revela nada).
            return c.json({ erro: 'Ligação não encontrada' }, 404);
          }
          const taskId = c.req.param('taskId');
          try {
            const ligacao = await lerLigacao(taskId, assignee);
            return c.json({ ligacao });
          } catch (e) {
            console.error('[discador] erro ao ler ligacao:', e);
            // Task inexistente, fora da Lista 02 ou de outro operador ->
            // 404 identico (nao revela se a task existe, so que "nao e
            // sua"). Erro de infra/rede do ClickUp continua 502.
            const msg = e instanceof Error ? e.message : String(e);
            const naoAutorizada =
              msg.includes('nao encontrada') ||
              msg.includes('nao e uma Ligacao da Lista 02') ||
              msg.includes('nao pertence ao operador');
            return naoAutorizada
              ? c.json({ erro: 'Ligação não encontrada' }, 404)
              : c.json({ erro: 'Erro ao carregar a ligação' }, 502);
          }
        },
      },
      {
        // Reporta a task ativa ao tocar "Ligar" (OPER-01/02, D-P3-01/02/07):
        // grava INICIO+OPERADOR na Ligacao IMEDIATAMENTE e move a task pra
        // "em processamento" (some da fila). Mesmo isolamento por operador
        // de /api/discador/ligacao/:taskId (CR-01/T-03-01-01) — sem ele, um
        // taskId arbitrario no body gravaria em Ligacao de outro operador.
        path: '/api/discador/ligando',
        method: 'POST',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          const assignee = assigneeDoOperador(sess.usuario);
          if (!assignee) {
            return c.json({ erro: 'Ligação não encontrada' }, 404);
          }
          const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
          const taskId = String(body.taskId || '');
          try {
            const { telefone } = await iniciarLigacao(taskId, assignee, sess.usuario);
            if (telefone) await guardarTaskAtiva(telefone, taskId);
            return c.json({ status: 'ok' });
          } catch (e) {
            console.error('[discador] erro ao registrar ligando:', e);
            // Mesmo criterio de /ligacao/:taskId: task inexistente/fora da
            // Lista 02/de outro operador -> 404 identico (nao revela nada);
            // erro de infra do ClickUp -> 502.
            const msg = e instanceof Error ? e.message : String(e);
            const naoAutorizada =
              msg.includes('nao encontrada') ||
              msg.includes('nao e uma Ligacao da Lista 02') ||
              msg.includes('nao pertence ao operador');
            return naoAutorizada
              ? c.json({ erro: 'Ligação não encontrada' }, 404)
              : c.json({ erro: 'Erro ao iniciar ligação' }, 502);
          }
        },
      },
      {
        path: '/api/discador/config',
        method: 'GET',
        handler: (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          return c.json({ wavoipToken: WAVOIP_DEVICE_TOKEN });
        },
      },
      {
        // Status de voto do lead ligado a esta Ligacao — chamado pelo discador
        // ao ENCERRAR uma ligacao ATENDIDA, pra decidir o que perguntar no
        // pos-ligacao (so os campos ainda vazios; se ambos definidos ou sem
        // lead, a UI nem mostra a tela). Mesmo isolamento por operador de
        // /ligacao/:taskId (CR-01) — resolve o lead a partir da Ligacao do
        // proprio operador, nunca de um taskId arbitrario.
        path: '/api/discador/voto/:taskId',
        method: 'GET',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          const assignee = assigneeDoOperador(sess.usuario);
          if (!assignee) return c.json({ erro: 'Ligação não encontrada' }, 404);
          const taskId = c.req.param('taskId');
          try {
            const status = await lerStatusVotoLead(taskId, assignee);
            return c.json(status);
          } catch (e) {
            console.error('[discador] erro ao ler status de voto:', e);
            const msg = e instanceof Error ? e.message : String(e);
            const naoAutorizada =
              msg.includes('nao encontrada') ||
              msg.includes('nao e uma Ligacao da Lista 02') ||
              msg.includes('nao pertence ao operador');
            return naoAutorizada
              ? c.json({ erro: 'Ligação não encontrada' }, 404)
              : c.json({ erro: 'Erro ao carregar o status de voto' }, 502);
          }
        },
      },
      {
        // Grava o(s) voto(s) confirmado(s) no lead (Lista 01 LEADS) ao fim da
        // ligacao atendida. Body: { taskId, romero?, andressa? } com valores
        // 'sim'|'nao'|'naoDeclarou'. Mesmo isolamento CR-01 do GET acima — o
        // lead so pode ser gravado a partir de uma Ligacao do proprio operador.
        path: '/api/discador/voto',
        method: 'POST',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          const assignee = assigneeDoOperador(sess.usuario);
          if (!assignee) return c.json({ erro: 'Ligação não encontrada' }, 404);
          const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
          const taskId = String(body.taskId || '');
          const normalizar = (v: unknown): 'sim' | 'nao' | 'naoDeclarou' | undefined =>
            v === 'sim' || v === 'nao' || v === 'naoDeclarou' ? v : undefined;
          const voto = { romero: normalizar(body.romero), andressa: normalizar(body.andressa) };
          if (!voto.romero && !voto.andressa) {
            // Nada selecionado (ou valores invalidos) — no-op idempotente.
            return c.json({ status: 'ok', semAlteracao: true });
          }
          try {
            const r = await salvarVotoLead(taskId, assignee, voto);
            return c.json({ status: 'ok', temLead: r.temLead });
          } catch (e) {
            console.error('[discador] erro ao salvar voto:', e);
            const msg = e instanceof Error ? e.message : String(e);
            const naoAutorizada =
              msg.includes('nao encontrada') ||
              msg.includes('nao e uma Ligacao da Lista 02') ||
              msg.includes('nao pertence ao operador');
            return naoAutorizada
              ? c.json({ erro: 'Ligação não encontrada' }, 404)
              : c.json({ erro: 'Erro ao salvar o voto' }, 502);
          }
        },
      },

      // ============ WEBHOOK WAVOIP (transcricao + analise das calls) ============
      // Configurado no app Wavoip em Integrations > Webhook. Dois eventos:
      //   CALL   -> guarda whatsapp_call_id -> telefone (pro RECORD correlacionar);
      //             se a call terminou sem gravacao (nao atendida), grava os
      //             metadados de falha na Ligacao correlacionada (D-P3-05).
      //   RECORD -> pega record_url, resolve a task da Ligacao (Lista 02
      //             ClickUp), transcreve (Deepgram) e grava transcricao +
      //             metadados na Ligacao (D-P3-01/03/04/05, OPER-01/02) —
      //             substitui a nota no contato GHL (registrarNotaObservacao).
      {
        path: '/api/webhook/wavoip',
        method: 'POST',
        handler: async (c) => {
          // Fora do try pra o catch tambem poder fechar o desfecho ('erro').
          let eventoDuravelId: string | null = null;
          try {
            // Auth fail-closed ANTES de qualquer parse/efeito. Token vazio desabilita.
            const token = c.req.query('token') || c.req.header('x-webhook-token') || '';
            if (!WAVOIP_WEBHOOK_TOKEN || token !== WAVOIP_WEBHOOK_TOKEN) {
              console.warn(`[wavoip] token invalido ou ausente (recebido: "${token.slice(0, 4)}...")`);
              return c.json({ status: 'unauthorized' }, 401);
            }

            const payload = await c.req.json() as Record<string, any>;
            const evento = String(payload.type || '').toUpperCase();
            const whatsappCallId = String(payload.whatsapp_call_id || payload.whatsappCallId || '');

            // Log do shape (sem telefone). Pula DEVICE (heartbeat frequente).
            if (evento !== 'DEVICE') {
              console.log(`[wavoip] evento type=${evento} status=${payload.status || ''} dir=${payload.direction || ''} dur=${payload.duration ?? ''} record_status=${payload.record_status || ''} keys=[${Object.keys(payload).join(',')}]`);
            }

            // Durabilidade (Fase 2): persiste o evento CRU antes de qualquer
            // processamento — se transcricao/LLM/escrita falhar ou o processo
            // cair no meio, o evento fica gravado e e reprocessavel. Best-effort:
            // loga-e-segue (nunca vira 500) e degrada a no-op sem Supabase. Pula
            // DEVICE (heartbeat frequente).
            if (evento !== 'DEVICE') {
              try {
                eventoDuravelId = await registrarEventoWebhook(evento, payload, whatsappCallId);
              } catch (e) {
                console.error('[wavoip] falha ao persistir evento bruto (durabilidade) — seguindo inline:', e);
              }
            }

            // ---------------- CALL: guarda a correlacao call_id -> telefone ----------------
            if (evento === 'CALL') {
              const telefone = telefoneDoEventoCall(payload);
              if (whatsappCallId && telefone) {
                await guardarCorrelacao(whatsappCallId, telefone);
              }
              // CR-01 (gap-closure 03-06): so entra aqui quando o `status` do
              // evento e uma falha terminal CONFIRMADA (STATUS_NAO_ATENDIDA
              // conhecido, via ehStatusFalhaTerminal) — status de transicao
              // (RINGING/CALLING), desconhecido ou ausente NUNCA gravam
              // ATENDEU=false/consolidam/fecham a Ligacao enquanto a chamada
              // ainda esta tocando. D-P3-01: resolve a task via 1) map
              // in-memory (task reportada em /api/discador/ligando) OU,
              // quando o map nao tem entrada (restart/hot-reload entre o
              // /ligando e este evento CALL), 2) fallback persistido — a
              // Ligacao aberta com o mesmo TELEFONE ja gravada no ClickUp
              // por `iniciarLigacao` (mesmo racional do branch RECORD).
              if (telefone && ehStatusFalhaTerminal(payload)) {
                const taskIdAtiva = await lerTaskAtiva(telefone);
                if (taskIdAtiva) {
                  if (await marcarCallFalhaProcessada(whatsappCallId)) {
                    await processarFalhaTerminal(taskIdAtiva, telefone, whatsappCallId, payload);
                  }
                } else {
                  let taskIdFallback: string | null = null;
                  try {
                    taskIdFallback = await buscarLigacaoAbertaPorTelefone(telefone);
                  } catch (e) {
                    // Loga-e-segue (WR-03: o helper subjacente ja lancou em
                    // erro de infra) — o webhook nunca vira 500 por uma
                    // leitura isolada.
                    console.error('[wavoip] falha ao buscar Ligacao aberta por telefone (branch CALL):', e);
                  }
                  if (taskIdFallback) {
                    if (await marcarCallFalhaProcessada(whatsappCallId)) {
                      await processarFalhaTerminal(taskIdFallback, telefone, whatsappCallId, payload);
                    }
                  } else {
                    const mascarado = telefone.length > 4 ? `${'*'.repeat(telefone.length - 4)}${telefone.slice(-4)}` : telefone;
                    console.warn(`[wavoip] CALL nao-atendida sem Ligacao aberta correlacionavel (telefone=${mascarado})`);
                  }
                }
              }
              try { await marcarEventoWebhook(eventoDuravelId, 'processado'); }
              catch (e) { console.error('[wavoip] falha ao marcar evento CALL processado:', e); }
              return c.json({ status: 'ok', correlacionado: Boolean(whatsappCallId && telefone) });
            }

            // ---------------- RECORD: transcreve + grava na Ligacao (ClickUp) ----------------
            if (evento === 'RECORD') {
              // O RECORD real da Wavoip carrega o status em `status` (=RECORDING/
              // READY); a doc dizia `record_status`. Le os dois por seguranca.
              const recordStatus = String(payload.record_status || payload.status || '').toUpperCase();
              const recordUrl = String(payload.record_url || payload.recordUrl || '');
              if (recordUrl) {
                try {
                  console.log(`[wavoip] RECORD host=${new URL(recordUrl).host} status=${recordStatus} call=${whatsappCallId}`);
                } catch { /* url invalida — ignora */ }
              }
              if (recordStatus !== 'READY' || !recordUrl) {
                return c.json({ status: 'ignorado', motivo: `record_status=${recordStatus}` });
              }
              if (!whatsappCallId) {
                return c.json({ status: 'payload invalido' }, 400);
              }

              const telefone = await lerCorrelacao(whatsappCallId);
              if (!telefone) {
                // CALL nao chegou (ou reinicio do servidor). 200 pra nao entrar
                // em loop de retry do webhook.
                console.warn(`[wavoip] RECORD sem correlacao (call=${whatsappCallId}) — transcricao ignorada`);
                return c.json({ status: 'sem correlacao' });
              }

              // Dedup: retry do webhook nao re-transcreve a mesma gravacao.
              if (!(await marcarRecordProcessado(whatsappCallId))) {
                return c.json({ status: 'duplicado' });
              }

              const transcricao = await transcreverCallUrl(recordUrl);
              if (!transcricao) {
                // Libera o dedup pra permitir um retry futuro transcrever.
                await liberarRecordProcessado(whatsappCallId);
                // WR-01: nunca telefone cru em log — so o whatsapp_call_id.
                console.warn(`[wavoip] transcricao falhou (call=${whatsappCallId})`);
                return c.json({ status: 'transcricao falhou' }, 502);
              }

              // D-P3-01: resolve a task da Ligacao — 1) map in-memory (task
              // reportada em /api/discador/ligando), 2) fallback persistido no
              // ClickUp (Ligacao aberta com o mesmo TELEFONE), 3) D-P3-03: nao
              // casou nenhuma -> cria uma Ligacao avulsa (nenhuma ligacao real
              // fica sem registro).
              let taskId = await lerTaskAtiva(telefone);
              if (!taskId) {
                try {
                  taskId = await buscarLigacaoAbertaPorTelefone(telefone);
                } catch (e) {
                  console.error('[wavoip] falha ao buscar Ligacao aberta por telefone:', e);
                }
              }
              if (!taskId) {
                try {
                  const avulsa = await criarLigacaoAvulsa(telefone);
                  taskId = avulsa.id;
                } catch (e) {
                  // Criar a avulsa e o unico jeito de nao perder o registro
                  // desta gravacao (D-P3-03) — se ISSO falhar, propaga (502)
                  // pro Wavoip poder retentar o webhook.
                  await liberarRecordProcessado(whatsappCallId);
                  console.error('[wavoip] falha ao criar Ligacao avulsa:', e);
                  return c.json({ status: 'erro ao registrar ligacao' }, 502);
                }
              }

              // D-P3-04: grava a transcricao (field TRANSCRICAO + comentario),
              // substituindo a nota no GHL. Loga-e-segue (nao trava a cadeia
              // por uma falha de escrita isolada) — o helper LANCA em falha de
              // infra (WR-03), este catch so evita 500 no webhook.
              try {
                await gravarTranscricao(taskId, transcricao);
              } catch (e) {
                console.error('[wavoip] falha ao gravar transcricao na Ligacao:', e);
              }

              // D-P3-05, OPER-02: metadados 100% automaticos — ATENDEU=true
              // porque houve gravacao (teveGravacao=true).
              try {
                await gravarMetadadosLigacao(taskId, {
                  atendeu: derivarAtendeu(payload, true),
                  fim: Date.now(),
                  duracao: derivarDuracao(payload),
                  urlGravacao: recordUrl,
                });
              } catch (e) {
                console.error('[wavoip] falha ao gravar metadados na Ligacao:', e);
              }

              // ---- Agente Analise (OPER-03/04, D-P3-08/09/10/11/15) ----
              // Encadeado automaticamente logo apos a transcricao+metadados.
              // Falha de LLM/parse NAO trava a cadeia (D-P3-08): marca
              // NECESSITA_REVISAO=true e segue. Nada de transcricao/PII em
              // log — so ids/flags/status, mesmo padrao do resto do webhook.
              // `resultadoAnalise`/`retornoAnalise` ficam fora do try (hoisted)
              // pro passo do Agente Contexto (abaixo) poder consolidar o lead
              // mesmo quando a Analise falhou (valores ficam `null`).
              let resultadoAnalise: ReturnType<typeof parseResultadoAnalise> | null = null;
              let retornoAnalise: ReturnType<typeof extrairRetorno> | null = null;
              try {
                const task = await lerTask(taskId);
                const script = task?.description ?? task?.text_content ?? '';
                const { system, prompt } = montarPromptAnalise({ script, transcricao });
                const textoLLM = await chamarLLM(prompt, system);
                const resultado = parseResultadoAnalise(textoLLM);
                const revisao = necessitaRevisao({
                  aderencia: resultado.aderencia,
                  limiar: ANALISE_ADERENCIA_MINIMA,
                  sinaisAlerta: resultado.sinaisAlerta,
                  falhaTecnica: resultado.falhaTecnica,
                });
                const retorno = extrairRetorno(resultado, { hoje: new Date(), defaultDias: 2 });
                resultadoAnalise = resultado;
                retornoAnalise = retorno;

                await setCustomField(taskId, CAMPOS_LIGACOES.ADERENCIA_SCRIPT, resultado.aderencia);
                await setCustomField(taskId, CAMPOS_LIGACOES.NECESSITA_REVISAO, revisao);
                await setCustomField(taskId, CAMPOS_LIGACOES.RETORNO_NECESSARIO, retorno.necessario);
                await setCustomField(
                  taskId,
                  CAMPOS_LIGACOES.DATA_RETORNO,
                  retorno.data ? retorno.data.getTime() : null,
                );
                await setCustomField(taskId, CAMPOS_LIGACOES.ANALISE_IA, resultado.resumoAnalise);
                await setCustomField(taskId, CAMPOS_LIGACOES.OBSERVACOES_EXTRAIDAS, resultado.observacoesExtraidas);
              } catch (e) {
                // D-P3-08: LLM fora do ar (ou parse/escrita falhou) — marca
                // revisao e segue, nunca trava a cadeia do webhook. O helper
                // de ClickUp subjacente ainda lanca em falha de infra (WR-03);
                // aqui so distinguimos "precisa de revisao humana" de um erro
                // que derrubaria o 200 do webhook.
                console.error('[wavoip] falha no Agente Analise, marcando NECESSITA_REVISAO:', e);
                try {
                  await setCustomField(taskId, CAMPOS_LIGACOES.NECESSITA_REVISAO, true);
                } catch (e2) {
                  console.error('[wavoip] falha ao marcar NECESSITA_REVISAO apos erro do Agente Analise:', e2);
                }
              }

              // ---- Agente Contexto (OPER-05, D-P3-06/12/13/14/15) — caminho ATENDIDO ----
              // Consolida o lead com o resultado da Analise (quando disponivel)
              // e fecha a Ligacao (D-P3-06). D-P3-15: sinais de alerta (opt-out
              // inclusive) entram no resumo consolidado — NUNCA removem o lead
              // nem o tornam inelegivel automaticamente, so a decisao humana
              // (via NECESSITA_REVISAO, ja gravado acima) faz isso.
              const sinaisTexto = resultadoAnalise?.sinaisAlerta?.length
                ? ` Sinais de alerta: ${resultadoAnalise.sinaisAlerta.join('; ')}.`
                : '';
              await consolidarEFecharLigacao(taskId, {
                atendeu: true,
                resumoAnalise: (resultadoAnalise?.resumoAnalise ?? '') + sinaisTexto,
                aderencia: resultadoAnalise?.aderencia ?? null,
                retorno: retornoAnalise ?? { necessario: false, data: null },
              });

              // CR-02: limpa a entrada telefone->task apos consolidar/fechar —
              // uma ligacao futura ao mesmo telefone nunca re-consolida sobre
              // esta task ja fechada.
              await limparTaskAtiva(telefone);

              try { await marcarEventoWebhook(eventoDuravelId, 'processado'); }
              catch (e) { console.error('[wavoip] falha ao marcar evento RECORD processado:', e); }
              return c.json({ status: 'ok' });
            }

            // DEVICE e outros eventos: nao aplicaveis.
            return c.json({ status: 'ignorado', evento });
          } catch (erro) {
            console.error('[wavoip] Erro no webhook:', erro);
            try { await marcarEventoWebhook(eventoDuravelId, 'erro', String(erro)); }
            catch (e2) { console.error('[wavoip] falha ao marcar evento com erro:', e2); }
            return c.json({ status: 'erro', mensagem: String(erro) }, 500);
          }
        },
      },
    ],
  },
});
