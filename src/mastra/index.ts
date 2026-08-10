import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';

// Config: token do device Wavoip (SDK do navegador) + credenciais GHL +
// token do webhook Wavoip (transcricao das calls).
import { WAVOIP_DEVICE_TOKEN, WAVOIP_WEBHOOK_TOKEN } from './config';

// Auth do PWA discador (login por closer, token HMAC sem estado).
import { verificarCredenciais, emitirToken, verificarToken, tokenDoHeader } from './discador-auth';

// Lista de leads qualificados (GHL, pipeline COMERCIAL USI) — legado, ver nota
// na rota /api/discador/qualificados abaixo. registrarNotaObservacao ainda e
// usado pelo webhook de transcricao (nota no contato GHL).
import { buscarQualificados, registrarNotaObservacao } from './ghl';

// Fila de Ligacoes (Lista 02 ClickUp) do operador logado + detalhe/script de
// uma Ligacao (LOTE-04/05, Fase 02 Plano 03 — substitui buscarQualificados).
import { buscarFilaLigacoes, lerLigacao } from './clickup';

// Mapa usuario-do-discador -> assignee (memberId) do ClickUp (Fase 02 Plano 02).
import { assigneeDoOperador } from './operadores';

// Transcricao da gravacao da call via Deepgram (entrada por URL).
import { transcreverCallUrl } from './deepgram';

// Assets estaticos do PWA discador (HTML/JS/manifest/SW/icon).
import { DISCADOR_HTML, DISCADOR_APP_JS, DISCADOR_MANIFEST, DISCADOR_SW_JS, DISCADOR_ICON_SVG } from './discador-pwa';

// ===== Estado in-memory do webhook Wavoip (transcricao das calls) =====
//
// O evento RECORD so traz `whatsapp_call_id` + `record_url` (sem telefone). O
// evento CALL traz o telefone (caller/receiver). Correlacionamos os dois por
// whatsapp_call_id num Map em memoria — sem banco. Caveat: se o servidor
// reiniciar entre o CALL e o RECORD, a correlacao se perde e a transcricao
// daquela call e ignorada (aceitavel: a call em si nao depende disto).
const correlacaoCallTelefone = new Map<string, { telefone: string; ts: number }>();
// Dedup de RECORD ja processado (retry do webhook nao re-transcreve).
const recordsProcessados = new Set<string>();
const CORRELACAO_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/** Guarda call_id -> telefone e faz uma limpeza preguicosa de entradas velhas. */
function guardarCorrelacao(callId: string, telefone: string): void {
  const agora = Date.now();
  correlacaoCallTelefone.set(callId, { telefone, ts: agora });
  if (correlacaoCallTelefone.size > 2000) {
    for (const [k, v] of correlacaoCallTelefone) {
      if (agora - v.ts > CORRELACAO_TTL_MS) correlacaoCallTelefone.delete(k);
    }
  }
}

/** Extrai o telefone (so digitos) do evento CALL conforme a direcao. */
function telefoneDoEventoCall(payload: Record<string, any>): string {
  const direction = String(payload.direction || '').toUpperCase();
  const raw = direction === 'INCOMING'
    ? String(payload.caller || '')
    : String(payload.receiver || payload.caller || '');
  return raw.replace(/[^\d]/g, '');
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
        // Mantida inativa no backend so porque buscarQualificados/ghl.ts ainda
        // e usado pelo webhook de transcricao (registrarNotaObservacao).
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
        path: '/api/discador/ligacao/:taskId',
        method: 'GET',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          const taskId = c.req.param('taskId');
          try {
            const ligacao = await lerLigacao(taskId);
            return c.json({ ligacao });
          } catch (e) {
            console.error('[discador] erro ao ler ligacao:', e);
            return c.json({ erro: 'Erro ao carregar a ligação' }, 502);
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

      // ============ WEBHOOK WAVOIP (transcricao das calls) ============
      // Configurado no app Wavoip em Integrations > Webhook. Dois eventos:
      //   CALL   -> guarda whatsapp_call_id -> telefone (pro RECORD correlacionar).
      //   RECORD -> pega record_url, resolve o telefone, transcreve (Deepgram)
      //             e registra a transcricao como nota no contato do GHL.
      {
        path: '/api/webhook/wavoip',
        method: 'POST',
        handler: async (c) => {
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

            // ---------------- CALL: guarda a correlacao call_id -> telefone ----------------
            if (evento === 'CALL') {
              const telefone = telefoneDoEventoCall(payload);
              if (whatsappCallId && telefone) {
                guardarCorrelacao(whatsappCallId, telefone);
              }
              return c.json({ status: 'ok', correlacionado: Boolean(whatsappCallId && telefone) });
            }

            // ---------------- RECORD: transcreve + nota no contato ----------------
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

              const correlacao = correlacaoCallTelefone.get(whatsappCallId);
              if (!correlacao) {
                // CALL nao chegou (ou reinicio do servidor). 200 pra nao entrar
                // em loop de retry do webhook.
                console.warn(`[wavoip] RECORD sem correlacao (call=${whatsappCallId}) — transcricao ignorada`);
                return c.json({ status: 'sem correlacao' });
              }
              const telefone = correlacao.telefone;

              // Dedup: retry do webhook nao re-transcreve a mesma gravacao.
              if (recordsProcessados.has(whatsappCallId)) {
                return c.json({ status: 'duplicado' });
              }
              recordsProcessados.add(whatsappCallId);
              if (recordsProcessados.size > 5000) {
                recordsProcessados.clear(); // backstop de memoria (dedup e best-effort)
              }

              const transcricao = await transcreverCallUrl(recordUrl);
              if (!transcricao) {
                // Libera o dedup pra permitir um retry futuro transcrever.
                recordsProcessados.delete(whatsappCallId);
                console.warn(`[wavoip] transcricao falhou para ${telefone}`);
                return c.json({ status: 'transcricao falhou' }, 502);
              }

              const nota = `📞 Transcrição da ligação (Wavoip)\n\n${transcricao}`;
              const notaOk = await registrarNotaObservacao(telefone, nota);
              if (!notaOk) {
                recordsProcessados.delete(whatsappCallId);
                return c.json({ status: 'nota falhou' }, 502);
              }
              return c.json({ status: 'ok' });
            }

            // DEVICE e outros eventos: nao aplicaveis.
            return c.json({ status: 'ignorado', evento });
          } catch (erro) {
            console.error('[wavoip] Erro no webhook:', erro);
            return c.json({ status: 'erro', mensagem: String(erro) }, 500);
          }
        },
      },
    ],
  },
});
