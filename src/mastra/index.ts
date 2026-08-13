import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';

// Config: credenciais GHL + token do webhook Wavoip (transcricao das calls).
// O token do device Wavoip (SDK do navegador) agora e resolvido por usuario
// via dispositivos.ts (DEVICE-01, Fase 07 Plano 01) — nao mais um unico
// WAVOIP_DEVICE_TOKEN global importado aqui.
import {
  WAVOIP_WEBHOOK_TOKEN,
} from './config';

// Auth do PWA discador (login por closer, token HMAC sem estado).
import { verificarCredenciais, emitirToken, verificarToken, tokenDoHeader } from './discador-auth';

// Lista de leads qualificados (GHL, pipeline COMERCIAL USI) — legado, ver nota
// na rota /api/discador/qualificados abaixo.
import { buscarQualificados } from './ghl';

// Fila de Ligacoes (Lista 02 ClickUp) do operador logado + detalhe/script de
// uma Ligacao (LOTE-04/05, Fase 02 Plano 03 — substitui buscarQualificados).
// iniciarLigacao grava INICIO+OPERADOR e move a task pra "em processamento"
// ao tocar Ligar (OPER-01/02, D-P3-01/02/07, Fase 03 Plano 01).
// lerStatusVotoLead/salvarVotoLead atendem a tela de voto pos-ligacao (Lista
// 01 LEADS). O resto do acesso ao ClickUp usado pelo webhook (transcricao/
// metadados/avulsa/Agente Analise/Agente Contexto) migrou pra processador.ts
// (Fase 06 Plano 02/03) — nao roda mais no caminho da requisicao.
import {
  buscarFilaLigacoes,
  lerLigacao,
  iniciarLigacao,
  lerStatusVotoLead,
  salvarVotoLead,
} from './clickup';

// Cache-aside da fila (Fase 08 Plano 02/04, CACHE-04): /ligando invalida/
// remove a task recem-iniciada do cache POR OPERADOR (D-04) — iniciarLigacao
// ja escreve no ClickUp de forma SINCRONA, entao so precisa espelhar esse
// efeito no cache. (/voto usa aquecerFilaCache, D-07b — Plano 04 Task 2.)
import { removerDaFilaCache, invalidarFilaCache } from './cache-fila.ts';

// Mapa usuario-do-discador -> assignee (memberId) do ClickUp (Fase 02 Plano 02).
import { assigneeDoOperador } from './operadores';

// ehStatusFalhaTerminal e o gate CR-01 do branch CALL (so falha terminal
// CONFIRMADA enfileira/processa a nao-atendida). O resto do Agente Analise
// migrou pra processador.ts (Fase 06 Plano 02/03) — nao roda mais no
// caminho da requisicao.
import { ehStatusFalhaTerminal } from './analise';

// Assets estaticos do PWA discador (HTML/JS/manifest/SW/icon).
import { DISCADOR_HTML, DISCADOR_APP_JS, DISCADOR_MANIFEST, DISCADOR_SW_JS, DISCADOR_ICON_SVG } from './discador-pwa';
// Durabilidade do webhook (Fase 2 — escala): persiste cada evento antes de processar.
import { registrarEventoWebhook, marcarEventoWebhook } from './supabase';
// Estado do webhook (Fase 5 — escala): correlacao call->telefone (guardada/
// lida no request) mora na camada Redis-ou-memoria (estado-webhook.ts) —
// alternavel por REDIS_URL sem reescrever o handler abaixo. Resolucao de
// task ativa e dedup de RECORD/falha terminal migraram pra processador.ts
// (Fase 06 Plano 02/03).
// guardarCorrelacaoDevice/lerCorrelacaoDevice (DEVICE-03, Fase 07 Plano 03):
// correlacao SEPARADA call->deviceId (DD-07-11) — desambigua a task ativa
// quando 2 devices ligam pro mesmo telefone ao mesmo tempo.
import {
  guardarCorrelacao,
  lerCorrelacao,
  guardarCorrelacaoDevice,
  lerCorrelacaoDevice,
  guardarTaskAtiva,
} from './estado-webhook.ts';
// Fila assincrona de processamento (Fase 06 Plano 01/03): os branches RECORD
// e CALL-terminal enfileiram o trabalho pesado (transcricao/analise/
// consolidacao/resolucao de task) fora do caminho da requisicao; sem Redis
// (modoFila()==='inline') OU se o enqueue falhar em runtime, degradam pro
// processamento INLINE via processador.ts — nunca perde a ligacao (FILA-02).
import { enfileirarRecord, enfileirarFalhaTerminal, modoFila } from './fila.ts';
import type { DadosJobRecord, DadosJobFalhaTerminal } from './fila.ts';
import { processarRecordJob, processarFalhaTerminalJob } from './processador.ts';
// Multi-device Wavoip (Fase 07 Plano 01): resolve o token do device do
// usuario autenticado (dedicado -> pool -> global) em vez do WAVOIP_DEVICE_TOKEN
// unico para todos — destrava N chamadas simultaneas por numeros diferentes.
// alocarDevice/liberarDevice (Fase 07 Plano 02): lease/release do device de
// POOL por chamada — cada atendente em modo:'pool' aloca um device LIVRE no
// inicio da chamada e devolve no fim (DEVICE-02).
// deviceIdPorNumero (Fase 07 Plano 03): mapa reverso numero->deviceId, usado
// pelo branch CALL do webhook pra derivar o deviceId de origem da chamada
// (payload.caller, DD-07-10).
import { resolverConfigDoUsuario, alocarDevice, liberarDevice, deviceIdPorNumero } from './dispositivos.ts';

/**
 * Extrai o telefone (so digitos) do evento CALL conforme a direcao. Exportada
 * porque o CLI de reprocesso (Fase 06 Plano 05, `scripts/reprocessar-eventos.mjs`)
 * precisa derivar o telefone do payload cru de um evento CALL terminal.
 */
export function telefoneDoEventoCall(payload: Record<string, any>): string {
  const direction = String(payload.direction || '').toUpperCase();
  const raw = direction === 'INCOMING'
    ? String(payload.caller || '')
    : String(payload.receiver || payload.caller || '');
  return raw.replace(/[^\d]/g, '');
}

// Visibilidade operacional (boot): qual modo a fila assincrona esta usando —
// 'bullmq' quando REDIS_URL esta configurado (worker separado consome os
// jobs, Fase 06 Plano 04), 'inline' quando nao ha Redis (o webhook processa
// a request sincrona, loop de 1 instancia intacto).
console.log(
  '[webhook] processamento ' + (modoFila() === 'bullmq' ? 'assíncrono (fila BullMQ)' : 'inline (1 instância)'),
);

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
          // DEVICE-03/DD-07-14: o cliente informa o proprio deviceId corrente
          // (dedicado via /config, pool via lease do 07-02) — chaveia so a
          // PROPRIA task ativa do operador (T-07-10, isolamento ja garantido
          // por assigneeDoOperador acima). Ausente -> telefone-so (DD-07-13).
          const deviceId = String(body.deviceId || '') || undefined;
          try {
            const { telefone } = await iniciarLigacao(taskId, assignee, sess.usuario);
            if (telefone) await guardarTaskAtiva(telefone, taskId, deviceId);
            // CACHE-04 (Plano 04): iniciarLigacao ja moveu a task pra "em
            // processamento" no ClickUp de forma SINCRONA — so precisa
            // espelhar esse efeito no cache da fila DO OPERADOR (D-04).
            // Remove a task especifica + invalida a chave inteira
            // (belt-and-suspenders D-03); ambas no-op sem Redis (SC5) e
            // nunca lancam — evento de INICIO DE CHAMADA, distinto do warm
            // do resultado no /voto (D-07b, Task 2).
            await removerDaFilaCache(assignee, taskId);
            await invalidarFilaCache(assignee);
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
          const cfg = resolverConfigDoUsuario(sess.usuario);
          return c.json(cfg);
        },
      },
      {
        // Lease de um device de POOL (DEVICE-02) no inicio da chamada —
        // so chamado pelo frontend quando /config respondeu modo:'pool'. O
        // backend escolhe o device (nunca vem de param/body do cliente —
        // mesmo racional T-07-01 do plano 07-01). Esgotamento -> 503 limpo
        // (DD-07-09), nao 500 — a UI orienta "sem numero livre, tente de novo".
        path: '/api/discador/dispositivo/lease',
        method: 'POST',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          const alocado = await alocarDevice(sess.usuario);
          if (!alocado) return c.json({ erro: 'sem device livre' }, 503);
          return c.json(alocado);
        },
      },
      {
        // Release do device de pool ao fim da chamada (best-effort,
        // idempotente — liberarDevice nunca lanca). Mesmo isolamento de
        // sessao: so o dono do lease (sess.usuario) consegue liberar
        // (T-07-05, checado dentro de liberarDevice).
        path: '/api/discador/dispositivo/release',
        method: 'POST',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
          await liberarDevice(String(body.deviceId || ''), sess.usuario);
          return c.json({ status: 'ok' });
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

            // ---------------- CALL: guarda a correlacao call_id -> telefone; enfileira (ou processa inline) a falha terminal ----------------
            if (evento === 'CALL') {
              const telefone = telefoneDoEventoCall(payload);
              if (whatsappCallId && telefone) {
                await guardarCorrelacao(whatsappCallId, telefone);
              }
              // DEVICE-03/DD-07-10: na saida, payload.caller e o numero do
              // PROPRIO device (receiver e o lead) — deriva o deviceId por
              // lookup estrito no inventario (deviceIdPorNumero). Caller
              // forjado/desconhecido -> deviceId null -> degrada telefone-so
              // (DD-07-13, T-07-07). WR-01/LGPD: nunca loga numero/telefone,
              // so callId/deviceId.
              const deviceId = deviceIdPorNumero(String(payload.caller || '').replace(/[^\d]/g, ''));
              if (whatsappCallId && deviceId) {
                await guardarCorrelacaoDevice(whatsappCallId, deviceId);
              }
              // CR-01 (gap-closure 03-06): so entra aqui quando o `status` do
              // evento e uma falha terminal CONFIRMADA (STATUS_NAO_ATENDIDA
              // conhecido, via ehStatusFalhaTerminal) — status de transicao
              // (RINGING/CALLING), desconhecido ou ausente NUNCA gravam
              // ATENDEU=false/consolidam/fecham a Ligacao enquanto a chamada
              // ainda esta tocando. A resolucao da task (map in-memory ->
              // fallback ClickUp) e o dedup (SETNX) agora moram DENTRO de
              // processarFalhaTerminalJob (processador.ts, Fase 06 Plano 02)
              // — chamavel tanto pelo worker quanto inline aqui.
              const falhaTerminal = Boolean(telefone) && ehStatusFalhaTerminal(payload);
              if (falhaTerminal) {
                // CR-01: propaga o deviceId (mesma derivacao deviceIdPorNumero
                // usada acima p/ guardarCorrelacaoDevice) pro job, pra que o
                // caminho nao-atendido leia/limpe a chave COMPOSTA tambem. null
                // -> undefined (degrada telefone-so, DD-07-13).
                const dados: DadosJobFalhaTerminal = { whatsappCallId, telefone, payload, eventoDuravelId, deviceId: deviceId || undefined };
                const { enfileirado } = await enfileirarFalhaTerminal(dados);
                if (!enfileirado) {
                  // Inline/fallback — mesma tolerancia de hoje: a
                  // nao-atendida e best-effort, log-e-segue (nunca 502; o
                  // processador ja loga-e-segue cada passo internamente).
                  try {
                    await processarFalhaTerminalJob(dados);
                  } catch (e) {
                    console.error('[wavoip] falha ao processar falha terminal inline:', e);
                  }
                }
                // enfileirado=true: o job fecha o desfecho ('processado')
                // quando terminar — NAO marca aqui, o request ja respondeu.
                // enfileirado=false: processarFalhaTerminalJob ja marcou
                // 'processado' (ou fechou 'erro') internamente.
              } else {
                // Sem falha terminal — so a correlacao foi gravada acima
                // (trabalho barato). Fecha o desfecho durave no request.
                try { await marcarEventoWebhook(eventoDuravelId, 'processado'); }
                catch (e) { console.error('[wavoip] falha ao marcar evento CALL processado:', e); }
              }
              return c.json({ status: 'ok', correlacionado: Boolean(whatsappCallId && telefone) });
            }

            // ---------------- RECORD: enfileira (ou processa inline) a transcricao ----------------
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

              // FILA-02: a partir daqui o trabalho pesado (transcricao Deepgram +
              // Agente Analise + Agente Contexto + consolidacao) NAO roda mais no
              // caminho da requisicao — processador.ts (Fase 06 Plano 02) e o
              // UNICO lugar dessa logica (dedup SETNX incluso). Enfileira (fila
              // BullMQ, Fase 06 Plano 01) e responde 200 imediatamente; sem fila
              // OU se o enqueue falhar em runtime, processa INLINE aqui mesmo,
              // chamando a MESMA funcao que o worker chamaria — degradacao
              // graciosa, comportamento identico ao de hoje sem Redis.
              // DEVICE-03/DD-07-15: le a correlacao de device capturada no
              // branch CALL e injeta no job — imune ao TTL entre CALL e
              // RECORD (mesmo racional do telefone). null quando o device
              // nao foi derivavel (degrada telefone-so, DD-07-13).
              const deviceId = (await lerCorrelacaoDevice(whatsappCallId)) || undefined;
              const dados: DadosJobRecord = { whatsappCallId, telefone, recordUrl, payload, eventoDuravelId, deviceId };
              const { enfileirado } = await enfileirarRecord(dados);
              if (enfileirado) {
                return c.json({ status: 'enfileirado' });
              }

              try {
                await processarRecordJob(dados);
                return c.json({ status: 'ok' });
              } catch (e) {
                // Falha retentavel (transcricao/avulsa) — processarRecordJob
                // LANCA em vez de retornar 502 diretamente (semantica pensada
                // pro BullMQ retentar, Fase 06 Plano 02); aqui, em modo inline,
                // traduzimos de volta pro 502-para-Wavoip-retentar de sempre.
                // WR-01: so o whatsapp_call_id em log — nunca telefone/payload.
                const msg = e instanceof Error ? e.message : String(e);
                console.error(`[wavoip] falha ao processar RECORD inline (call=${whatsappCallId}):`, msg);
                try { await marcarEventoWebhook(eventoDuravelId, 'erro', msg); }
                catch (e2) { console.error('[wavoip] falha ao marcar evento RECORD com erro:', e2); }
                return c.json({ status: 'erro' }, 502);
              }
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
