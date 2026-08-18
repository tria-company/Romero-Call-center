import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';

// Config: credenciais GHL + token do webhook Wavoip (transcricao das calls).
// O token do device Wavoip (SDK do navegador) agora e resolvido por usuario
// via dispositivos.ts (DEVICE-01, Fase 07 Plano 01) — nao mais um unico
// WAVOIP_DEVICE_TOKEN global importado aqui.
import {
  WAVOIP_WEBHOOK_TOKEN,
  DISCADOR_PANEL_URL,
} from './config';

// Auth do PWA discador (login por closer, token HMAC sem estado).
import { verificarCredenciais, emitirToken, verificarToken, tokenDoHeader } from './discador-auth';
// Seed idempotente (USER-05) + snapshot em memoria de discador_usuarios
// (Fase 11 D-01/D-02) — disparados 1x no boot abaixo; verificarCredenciais
// (discador-auth.ts) e assigneeDoOperador/resolverConfigDoUsuario
// (operadores.ts/dispositivos.ts) leem do store a partir daqui.
// CRUD de operadores (Fase 11 Plano 04) — consumido pelas rotas
// /api/admin/usuarios* do painel admin, todas atras do gate de gestor.
import {
  semearUsuariosSeVazio,
  recarregarUsuarios,
  listarUsuarios,
  criarUsuario,
  atualizarUsuario,
  atualizarSenha,
  removerUsuario,
  buscarUsuario,
  papelDoUsuario,
  donoDoDevice,
  deviceIdDoUsuario,
  donosDevices,
  snapshotUsuarios,
} from './usuarios.ts';

// Lista de leads qualificados (GHL, pipeline COMERCIAL USI) — legado, ver nota
// na rota /api/discador/qualificados abaixo.
import { buscarQualificados } from './ghl';

// Fila de Ligacoes (Lista 02 ClickUp) do operador logado + detalhe/script de
// uma Ligacao (LOTE-04/05, Fase 02 Plano 03 — substitui buscarQualificados).
// iniciarLigacao grava INICIO+OPERADOR e move a task pra "em processamento"
// ao tocar Ligar (OPER-01/02, D-P3-01/02/07, Fase 03 Plano 01).
// lerStatusVotoLead atende a tela de voto pos-ligacao (Lista 01 LEADS); a
// gravacao (salvarVotoLead) agora e chamada indiretamente via
// processarSyncClickupJob (enfileirado ou fallback inline, Fase 08 Plano
// 03/04 — CACHE-03/04). O resto do acesso ao ClickUp usado pelo webhook
// (transcricao/metadados/avulsa/Agente Analise/Agente Contexto) migrou pra
// processador.ts (Fase 06 Plano 02/03) — nao roda mais no caminho da
// requisicao.
import {
  buscarFilaLigacoes,
  lerLigacao,
  iniciarLigacao,
  registrarDesfecho,
  lerStatusVotoLead,
  lerContextoLead,
  validarLigacaoDoOperador,
  listarMembrosWorkspace,
  // Rotas da Lista 01 LEADS pro app do Romero (quick 260815-b1): choke point de
  // mascaramento/validacao/resolucao vive em clickup.ts — aqui so o wiring HTTP.
  listarLeadsResumo,
  contarLeadsDaLista,
  lerLeadDetalhe,
  validarLeadDaLista01,
  lerTimelineDaLigacao,
  definirVotoLeadCampo,
  comentarTask,
  // quick-260815-r3: "Ligar" na ficha cria uma Ligação avulsa ATRIBUÍDA ao
  // operador (deep-link do discador). valorCampoLead/CAMPOS_LEADS leem o
  // telefone do lead pra criar a avulsa (choke point de leitura de campo).
  criarLigacaoAvulsa,
  valorCampoLead,
  CAMPOS_LEADS,
  // Canal de envio Evolution API + Lista de Áudios (Fase 12 Plano 03,
  // ENVIO-01/02/03/06): buscarLeadsNuncaLigados/registrarEnvioAudio vêm do
  // Plano 02; normalizarTelefoneE164 resolve o E.164 do lead antes de
  // chamar evolution.enviarAudio.
  buscarLeadsNuncaLigados,
  registrarEnvioAudio,
  normalizarTelefoneE164,
  // quick 260818-mv2: pré-check de WhatsApp ANTES do envio de áudio — marca
  // o lead "Sem WhatsApp" (comenta + Ligação fechada) sem tocar em
  // buscarLeadsNuncaLigados.
  marcarLeadSemWhatsapp,
} from './clickup';
// Client Evolution API (Fase 12 Plano 01, D-06/D-08): choke-point único de
// envio/status — enviarAudio LANÇA em falha (nunca 200 silencioso).
// numeroExisteNoWhatsapp (quick 260818-mv2): pré-check ANTES de enviarAudio.
import { enviarAudio, statusInstancia, numeroExisteNoWhatsapp } from './evolution.ts';

// Cache-aside da fila (Fase 08 Plano 02/04, CACHE-04): /ligando invalida/
// remove a task recem-iniciada do cache POR OPERADOR (D-04) — iniciarLigacao
// ja escreve no ClickUp de forma SINCRONA, entao so precisa espelhar esse
// efeito no cache. /voto usa aquecerFilaCache (D-07b, read-your-writes) —
// evento SEPARADO, o sync ao ClickUp e ASSINCRONO (janela <60s).
import { removerDaFilaCache, invalidarFilaCache, aquecerFilaCache } from './cache-fila.ts';
// Sync assincrono do voto pos-ligacao (Fase 08 Plano 03, CACHE-03/D-07a):
// /voto enfileira o job (worker espelha no ClickUp em <60s) com fallback
// inline (processarSyncClickupJob) sem Redis (SC5).
import { enfileirarSyncClickup } from './fila.ts';
import { processarSyncClickupJob } from './sync-clickup.ts';

// Mapa usuario-do-discador -> assignee (memberId) do ClickUp (Fase 02 Plano 02).
import { assigneeDoOperador, papelDoOperador } from './operadores';

// ehStatusFalhaTerminal e o gate CR-01 do branch CALL (so falha terminal
// CONFIRMADA enfileira/processa a nao-atendida). O resto do Agente Analise
// migrou pra processador.ts (Fase 06 Plano 02/03) — nao roda mais no
// caminho da requisicao.
import { ehStatusFalhaTerminal } from './analise';

// Assets estaticos do PWA discador (HTML/JS/manifest/SW/icon).
import { DISCADOR_HTML, DISCADOR_APP_JS, DISCADOR_MANIFEST, DISCADOR_SW_JS, DISCADOR_ICON_SVG } from './discador-pwa';
// Painel operacional (Fase 10 Plano 05, OBS-01): HTML/JS estaticos, mesmo
// padrao dos assets do discador acima.
import { ADMIN_HTML, ADMIN_APP_JS } from './admin-painel';
// Metricas operacionais (Fase 10 Plano 02, OBS-02/D-06): leitura agregada
// (painel) + presenca de operador + contagem de erro por etapa (webhook).
import {
  lerMetricas,
  registrarPresenca,
  registrarErroEtapa,
  registrarChamadaDevice,
  lerChamadasDevicesHoje,
  marcarEmChamada,
  limparEmChamada,
  limparPresenca,
  listarAtendentesOnline,
  listarEmChamada,
} from './metricas.ts';
import { METRICAS_FILA_ALERTA, METRICAS_ERRO_TAXA_ALERTA, METRICAS_429_ALERTA } from './config';
// Durabilidade do webhook (Fase 2 — escala): persiste cada evento antes de processar.
import {
  registrarEventoWebhook,
  marcarEventoWebhook,
  listarLeadsEspelho,
  atualizarVotoEspelho,
  contarVotosEspelho,
  type RecorteEspelho,
} from './supabase';
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
import { resolverConfigDoUsuario, alocarDevice, liberarDevice, deviceIdPorNumero, inventarioPublico } from './dispositivos.ts';
import {
  listarDispositivosWavoip,
  lerWebhookDispositivo,
  configurarWebhookDispositivo,
  webhookBate,
  urlWebhookProd,
  autoWebhookConfigurado,
  wavoipApiConfigurada,
  garantirInventarioWavoip,
  snapshotDevicesWavoip,
} from './wavoip-api.ts';

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

// Boot (Fase 11, USER-05/D-02): seed idempotente de discador_usuarios (so
// importa do env se a tabela estiver vazia) + aquece o snapshot em memoria
// usado por operadores.ts/dispositivos.ts. Fire-and-forget nao-fatal — nunca
// derruba o boot do processo; usuarios.ts ja loga sucesso/falha internamente.
void semearUsuariosSeVazio().then(() => recarregarUsuarios()).catch(() => {});

/**
 * Gate de gestor (Fase 11 Plano 04, USER-03 — a peca de seguranca central da
 * fase; T-11-04-E1/S1): resolve a sessao (`verificarToken` a partir do
 * header Authorization) e, se valida, le o PAPEL FRESCO do store por
 * request (`buscarUsuario`) — nunca do token/body/query do cliente
 * (T-11-04-S1). Retorna `{ status: 401 }` sem sessao, `{ status: 403 }` sem
 * papel 'gestor', ou `{ status: 200, usuario }` liberado. Sem analogo no
 * codigo (todo gate existente hoje e binario autenticado/nao-autenticado) —
 * logica nova, PATTERNS.md "No Analog Found".
 */
async function sessaoGestor(c: { req: { header: (nome: string) => string | undefined } }): Promise<
  { status: 401 } | { status: 403 } | { status: 200; usuario: string }
> {
  const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
  if (!sess) return { status: 401 };
  const reg = await buscarUsuario(sess.usuario);
  if (!reg || reg.papel !== 'gestor') return { status: 403 };
  return { status: 200, usuario: sess.usuario };
}

/**
 * Gate romero-only (Fase 12 Plano 03, ENVIO-07) — MAIS ESTREITO que
 * sessaoGestor: barra por USUÁRIO ('romero'), não por PAPEL ('gestor').
 * Existe porque romero é um único usuário específico (ele É gestor, mas nem
 * todo gestor é romero) — as rotas /api/discador/audios* são a peça de
 * segurança de verdade desta fase: como o `proxy.ts` do romero-mobile NÃO é
 * compilado como middleware nesta versão do Next (o layout gateia só por
 * papel/UI), esconder a UI não basta — um não-romero autenticado batendo
 * direto na rota tem que tomar 403 AQUI. Mesmo racional anti-spoof de
 * sessaoGestor (T-11-04-S1): o usuário SEMPRE vem de `verificarToken`
 * (header Authorization), NUNCA de body/query/header controlado pelo
 * cliente. Nunca loga o token. Retorna `{ status: 401 }` sem sessão válida,
 * `{ status: 403 }` pra sessão válida mas usuário != 'romero', ou
 * `{ status: 200, usuario: 'romero' }` liberado — mesmo shape de retorno de
 * sessaoGestor pra reuso uniforme no call-site.
 */
async function sessaoRomero(c: { req: { header: (nome: string) => string | undefined } }): Promise<
  { status: 401 } | { status: 403 } | { status: 200; usuario: string }
> {
  const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
  if (!sess) return { status: 401 };
  if (sess.usuario !== 'romero') return { status: 403 };
  return { status: 200, usuario: sess.usuario };
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

      // ============ PAINEL OPERACIONAL (estatico) — Fase 10, OBS-01/D-01..D-04 ============
      // Mesmo shape das rotas /discador acima: HTML/JS servidos como texto puro.
      // O gate de sessao e client-side (reusa o token do discador, D-02) — a
      // rota HTML em si nao precisa de verificarToken no servidor (T-10-05-I2,
      // accept: o markup sozinho nao vaza dado, so /api/admin/metricas exige auth).
      {
        path: '/admin',
        method: 'GET',
        handler: (c) => new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
      },
      {
        path: '/admin/app.js',
        method: 'GET',
        handler: (c) => new Response(ADMIN_APP_JS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } }),
      },

      // ============ API DISCADOR ============
      {
        // Healthcheck HTTP raso (D-06, INFRA-03): confirma so que o processo
        // esta de pe, sem checar Redis/ClickUp/Supabase nem tocar estado-webhook.ts/
        // fila.ts. Sem auth de proposito -- o Swarm/Traefik consultam sem sessao de
        // operador. Um health PROFUNDO derrubaria as 2 replicas juntas se uma
        // dependencia externa cair (o oposto da degradacao graciosa do projeto).
        // Payload minimo por design (T-09-01): nunca versao/deps/stack/token.
        path: '/api/discador/health',
        method: 'GET',
        handler: (c) => c.json({ status: 'ok' }),
      },
      {
        path: '/api/discador/login',
        method: 'POST',
        handler: async (c) => {
          try {
            const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
            const usuario = String(body.usuario || '');
            const senha = String(body.senha || '');
            let credenciaisValidas: boolean;
            try {
              credenciaisValidas = await verificarCredenciais(usuario, senha);
            } catch (e) {
              // Fail-closed (T-11-03-D1): falha de infra do store (Postgres fora
              // do ar/config ausente) NUNCA vira "credencial valida" — 503
              // distinto do 401 de credencial errada.
              console.error('[discador] store indisponivel no login:', e instanceof Error ? e.message : String(e));
              return c.json({ status: 'indisponivel' }, 503);
            }
            if (!credenciaisValidas) {
              return c.json({ status: 'invalido' }, 401);
            }
            return c.json({ token: emitirToken(usuario), usuario, papel: papelDoUsuario(usuario) ?? 'atendente', panelUrl: DISCADOR_PANEL_URL });
          } catch (e) {
            console.error('[discador] erro login:', e);
            return c.json({ status: 'erro' }, 500);
          }
        },
      },
      {
        // Identidade da sessao (quick 260816-u5): papel + panelUrl do usuario
        // logado. Serve pro front decidir o redirect do GESTOR pro painel no
        // reload/retorno (o login ja devolve o mesmo shape na hora de entrar).
        // Bearer padrao (verificarToken) — 401 sem sessao. Nunca loga o token.
        path: '/api/discador/me',
        method: 'GET',
        handler: (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          return c.json({
            usuario: sess.usuario,
            papel: papelDoUsuario(sess.usuario) ?? 'atendente',
            panelUrl: DISCADOR_PANEL_URL,
          });
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
          // Fonte do KPI "atendentes online" (10-05, OBS-01) — nunca lanca.
          registrarPresenca(sess.usuario);
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
          // Fonte do KPI "atendentes online" (10-05, OBS-01) — nunca lanca.
          registrarPresenca(sess.usuario);
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
            // Operação ao vivo (Fase 2): operador entrou EM CHAMADA — some no
            // desfecho (ou pelo TTL de teto). Não-fatal, nunca lança.
            marcarEmChamada(sess.usuario);
            // Métrica "chamadas por número" (Fase 1): NÃO conta aqui. A chamada é
            // contada 1x no DESFECHO (fonte única → "hoje" = atendidas + não,
            // sempre consistente e atribuída ao mesmo número). Clicar "Ligar" sem
            // desfecho não infla o total.
            // quick-260813-lf7 (RETENTION-BY-OUTCOME): /ligando virou TELEMETRIA
            // PURA (INICIO+OPERADOR+correlacao call<->task). NAO despeja mais o
            // cache da fila — a task FICA na fila ao clicar "Ligar"; despejar o
            // cache aqui so causaria um refetch inutil que retornaria a MESMA
            // task. A eviction (removerDaFilaCache/invalidarFilaCache) migrou
            // pro POST /desfecho, junto com a transicao de status — a fila so
            // muda no RESULTADO da chamada (atendida/recusou), nao no clique.
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
        // Desfecho da chamada (quick-260813-lf7 / RETENTION-BY-OUTCOME, ampliado
        // em quick-260815-w6h) — body: { taskId, resultado } com resultado
        // 'atendida'|'recusou'|'nao_atendida' (whitelist estrita — T-lf7-02).
        // Mesmo isolamento por operador de /ligando (CR-01/T-lf7-01): assignee
        // vem SEMPRE de sess.usuario, nunca do body; um taskId arbitrario nao
        // pode desfechar a Ligacao de outro operador.
        // 'atendida'/'recusou' sao TERMINAIS (tiram a Ligacao da fila).
        // 'nao_atendida' (unanswered/ended/hangup sem atender) NAO fecha a task
        // — so carimba INICIO (ultima tentativa) e invalida o cache, forcando
        // um refetch RE-ORDENADO: a task afunda pro fim da fila e o proximo
        // lead vira itens[0].
        path: '/api/discador/desfecho',
        method: 'POST',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          // Fonte do KPI "atendentes online" (10-05, OBS-01) — nunca lanca.
          registrarPresenca(sess.usuario);
          const assignee = assigneeDoOperador(sess.usuario);
          if (!assignee) return c.json({ erro: 'Ligação não encontrada' }, 404);
          const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
          const taskId = String(body.taskId || '');
          const resultado = body.resultado;
          if (resultado !== 'atendida' && resultado !== 'recusou' && resultado !== 'nao_atendida') {
            return c.json({ erro: 'resultado inválido' }, 400);
          }
          // u13: motivo do não-atendimento anotado pelo operador (categoria +
          // frase + segundos de tentativa). Limites defensivos; ausente quando
          // o cliente não manda (mantém compat). LGPD: nada disso vai a log.
          const categoria = body.categoria ? String(body.categoria).slice(0, 60) : '';
          // u26: quem ligou + qual linha, pro comentário ficar rastreável
          // ("preencha todas as informações possíveis"). deviceIdDoUsuario só
          // resolve pra operador DEDICADO (a maioria) — pool-mode fica sem
          // número no comentário (degrada, não quebra).
          const deviceIdOp = deviceIdDoUsuario(sess.usuario);
          const numeroOp = deviceIdOp
            ? snapshotDevicesWavoip().find((d) => d.id === deviceIdOp)?.numero
            : undefined;
          const motivo = categoria
            ? {
                categoria,
                observacao: body.observacao ? String(body.observacao).slice(0, 500) : undefined,
                duracao: Number.isFinite(Number(body.duracao))
                  ? Math.max(0, Math.round(Number(body.duracao)))
                  : undefined,
                usuario: sess.usuario,
                numero: numeroOp,
              }
            : undefined;
          try {
            await registrarDesfecho(taskId, assignee, resultado, motivo);
            // Métrica "chamadas por número" (Fase 1): conta 1 chamada por DESFECHO,
            // atribuída ao NÚMERO do operador (deviceIdDoUsuario). "hoje" no painel
            // é derivado (atendidas + não), então nunca diverge do detalhe.
            // Não-fatal — nunca atrapalha o desfecho.
            registrarChamadaDevice(deviceIdDoUsuario(sess.usuario) || '', resultado === 'atendida' ? 'atendida' : 'nao');
            // Operação ao vivo (Fase 2): operador saiu da chamada. Não-fatal.
            limparEmChamada(sess.usuario);
            // Espelha no cache do OPERADOR a saida da fila — a MESMA eviction
            // que saiu do /ligando (D-04/D-03, belt-and-suspenders). Ambas
            // no-op sem Redis (SC5) e nunca lancam — fica fora do caminho
            // critico, nunca transforma um sucesso em erro.
            await removerDaFilaCache(assignee, taskId);
            await invalidarFilaCache(assignee);
            return c.json({ status: 'ok' });
          } catch (e) {
            // LGPD: nunca logar telefone/CPF/taskId em claro — so a mensagem
            // generica de erro (mesmo padrao de /ligando).
            console.error('[discador] erro ao registrar desfecho:', e);
            const msg = e instanceof Error ? e.message : String(e);
            const naoAutorizada =
              msg.includes('nao encontrada') ||
              msg.includes('nao e uma Ligacao da Lista 02') ||
              msg.includes('nao pertence ao operador');
            return naoAutorizada
              ? c.json({ erro: 'Ligação não encontrada' }, 404)
              : c.json({ erro: 'Erro ao registrar desfecho' }, 502);
          }
        },
      },
      {
        // Heartbeat de presença (Operação ao vivo, Fase 2): o discador pinga a
        // cada ~60s enquanto aberto → "Atendentes online" passa a refletir quem
        // está de fato com o discador aberto (a presença dura 120s). Telemetria
        // pura — registrarPresenca nunca lança e não tem efeito colateral.
        path: '/api/discador/presenca',
        method: 'POST',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          registrarPresenca(sess.usuario);
          return c.json({ status: 'ok' });
        },
      },
      {
        // Logout explícito (Operação ao vivo): zera presença + em-chamada do
        // operador NA HORA, pra ele sumir do painel sem esperar o TTL (120s).
        // Sem sessão válida = já está fora → responde ok (idempotente).
        path: '/api/discador/sair',
        method: 'POST',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (sess) {
            limparPresenca(sess.usuario);
            limparEmChamada(sess.usuario);
          }
          return c.json({ status: 'ok' });
        },
      },
      {
        path: '/api/discador/config',
        method: 'GET',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          // Aquece o inventário vivo da Wavoip (TTL 60s) pra resolver o token do
          // device dedicado do operador. Não-fatal: se a API cair, resolve pelo
          // env/pool/global como sempre (garantirInventarioWavoip nunca lança).
          await garantirInventarioWavoip();
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
          // DEVICE-04: aquece o inventário vivo (TTL 60s) — alocarDevice usa
          // deviceConectadoWavoip pra pular device caido do pool. Sem isso, esta
          // rota (chamada isolada, sem passar por /config antes) podia rodar
          // com cache frio e nunca filtrar hibernating. Não-fatal (nunca lança).
          await garantirInventarioWavoip();
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
        // Contexto (dossie 360) do lead ligado a esta Ligacao — chamado pelo
        // preview ao tocar "Ligar" na fila (T-m3v), antes de discar. Leitura
        // pura (sem registrarPresenca — nao e "atividade" do operador, so
        // consulta). Mesmo isolamento por operador de /voto/:taskId (CR-01) —
        // resolve o lead a partir da Ligacao do proprio operador.
        path: '/api/discador/contexto/:taskId',
        method: 'GET',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          const assignee = assigneeDoOperador(sess.usuario);
          if (!assignee) return c.json({ erro: 'Ligação não encontrada' }, 404);
          const taskId = c.req.param('taskId');
          try {
            const contexto = await lerContextoLead(taskId, assignee);
            return c.json(contexto);
          } catch (e) {
            console.error('[discador] erro ao ler contexto:', e);
            const msg = e instanceof Error ? e.message : String(e);
            const naoAutorizada =
              msg.includes('nao encontrada') ||
              msg.includes('nao e uma Ligacao da Lista 02') ||
              msg.includes('nao pertence ao operador');
            return naoAutorizada
              ? c.json({ erro: 'Ligação não encontrada' }, 404)
              : c.json({ erro: 'Erro ao carregar o contexto' }, 502);
          }
        },
      },

      // ============ LISTA 01 LEADS — app do Romero (quick 260815-b1) ============
      // Rotas 1-4: Bearer + gate de PAPEL gestor (quick 260815-r12) — só quem é
      // 'gestor' no snapshot de discador_usuarios (papelDoOperador) vê a visão
      // total do lead (CPF + telefone em claro); atendente/desconhecido -> 403.
      // A conta de serviço do mobile (admin) é gestor no seed (D-06), então o
      // gate funciona sem env extra (substitui DISCADOR_LEAD_BROWSE). A logica de
      // validacao/resolucao vive em clickup.ts (choke point) — aqui so o wiring
      // HTTP. LGPD: o gestor autenticado PODE ver CPF/telefone, mas os logs NUNCA
      // levam PII (console.error só mensagem generica, nunca telefone/CPF/taskId).
      {
        // Rota 1 — enumeracao (resumo) da Lista 01: telefone SEMPRE mascarado,
        // nunca CPF, filtro `q` server-side, paginacao por cursor (page opaca).
        path: '/api/discador/leads',
        method: 'GET',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          if (papelDoOperador(sess.usuario) !== 'gestor') return c.json({ erro: 'Acesso restrito a gestor' }, 403);
          const q = c.req.query('q') || undefined;
          const cursor = c.req.query('cursor');
          const limit = Number(c.req.query('limit')) || 50;
          const recorteReq = c.req.query('recorte') || 'todos';
          const recorte = (['romero', 'andressa', 'militante', 'sem-contato'].includes(recorteReq)
            ? recorteReq
            : 'todos') as RecorteEspelho;

          // ESPELHO primeiro (u10): busca/recorte/paginacao/TOTAL exato em ms no
          // Postgres. cursor do espelho = "e<offset>" (namespace proprio, pra nao
          // colidir com o cursor de PAGINA do ClickUp no fallback). Page 0 (sem
          // cursor) sonda o espelho; usa se POPULADO (total>0). Vazio/ausente/404
          // -> cai no ClickUp (degrada, nunca quebra).
          const ehCursorEspelho = typeof cursor === 'string' && cursor.startsWith('e');
          if (!cursor || ehCursorEspelho) {
            try {
              const offset = ehCursorEspelho ? Number(cursor.slice(1)) || 0 : 0;
              const esp = await listarLeadsEspelho({ q, recorte, offset, limit });
              if (esp && (esp.total > 0 || ehCursorEspelho)) {
                const carregado = offset + esp.leads.length;
                const proximo = carregado < esp.total ? 'e' + carregado : undefined;
                return c.json({ leads: esp.leads, cursor: proximo, total: esp.total });
              }
            } catch (e) {
              console.error('[discador] espelho indisponivel, fallback ClickUp:', e instanceof Error ? e.message : String(e));
            }
          }

          // FALLBACK: ClickUp ao vivo (espelho ainda nao populado). cursor = PAGINA.
          // O recorte so existe no espelho — neste caminho a UI filtra client-side
          // (comportamento antigo). q server-side por pagina.
          const page = Number(cursor) || 0;
          try {
            // limit FIXO 100 aqui = tamanho da pagina do ClickUp (NAO o `limit` da
            // API): cortar abaixo de 100 pularia os leads 51-100 de cada pagina (u9).
            const r = await listarLeadsResumo({ page, q, limit: 100 });
            if (page === 0 && !q) {
              try {
                const total = await contarLeadsDaLista();
                return c.json({ ...r, total });
              } catch {
                /* total e opcional — degrada pro count carregado */
              }
            }
            return c.json(r);
          } catch (e) {
            // LGPD: nunca logar PII — so a mensagem generica de erro.
            console.error('[discador] erro ao listar leads:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao carregar os leads' }, 502);
          }
        },
      },
      {
        // Números do DASHBOARD do gestor (u10): cadastros na base (task_count do
        // ClickUp, barato) + votos confirmados/apoiadores (contagem no espelho).
        // `populado:false` = espelho ainda não backfillado -> a UI mostra "—".
        path: '/api/discador/painel-numeros',
        method: 'GET',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          if (papelDoOperador(sess.usuario) !== 'gestor') return c.json({ erro: 'Acesso restrito a gestor' }, 403);
          const [cadastros, votos] = await Promise.all([
            contarLeadsDaLista().catch(() => null),
            contarVotosEspelho().catch(() => ({ populado: false, romero: 0, andressa: 0, apoiadores: 0 })),
          ]);
          return c.json({
            cadastros,
            votosPopulados: votos.populado,
            votosRomero: votos.romero,
            votosAndressa: votos.andressa,
            apoiadores: votos.apoiadores,
          });
        },
      },
      {
        // Rota 2 — detalhe do lead: telefone EM CLARO (operador disca), nunca
        // CPF; valida a lista (validarLeadDaLista01, anti-IDOR) dentro do helper.
        path: '/api/discador/lead/:leadTaskId',
        method: 'GET',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          if (papelDoOperador(sess.usuario) !== 'gestor') return c.json({ erro: 'Acesso restrito a gestor' }, 403);
          const leadTaskId = c.req.param('leadTaskId');
          try {
            const detalhe = await lerLeadDetalhe(leadTaskId);
            return c.json(detalhe);
          } catch (e) {
            console.error('[discador] erro ao ler detalhe do lead:', e instanceof Error ? e.message : String(e));
            const msg = e instanceof Error ? e.message : String(e);
            const naoEncontrado = msg.includes('nao encontrada') || msg.includes('nao e um Lead da Lista 01');
            return naoEncontrado
              ? c.json({ erro: 'Lead não encontrado' }, 404)
              : c.json({ erro: 'Erro ao carregar o lead' }, 502);
          }
        },
      },
      {
        // Rota 3 — grava voto(s) no lead. Guard Lista 01 (validarLeadDaLista01)
        // ANTES de escrever (anti-IDOR de escrita); whitelist estrita de valores.
        path: '/api/discador/lead/:leadTaskId/voto',
        method: 'POST',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          if (papelDoOperador(sess.usuario) !== 'gestor') return c.json({ erro: 'Acesso restrito a gestor' }, 403);
          const leadTaskId = c.req.param('leadTaskId');
          const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
          const normalizar = (v: unknown): 'sim' | 'nao' | 'naoDeclarou' | undefined =>
            v === 'sim' || v === 'nao' || v === 'naoDeclarou' ? v : undefined;
          const romero = normalizar(body.romero);
          const andressa = normalizar(body.andressa);
          if (!romero && !andressa) {
            // Nada valido selecionado — no-op idempotente (nao toca o ClickUp).
            return c.json({ status: 'ok', semAlteracao: true });
          }
          try {
            // Guard anti-IDOR de escrita: a task tem que ser da Lista 01 ANTES
            // de gravar qualquer voto (definirVotoLeadCampo escreve por taskId cru).
            await validarLeadDaLista01(leadTaskId);
            if (romero) await definirVotoLeadCampo(leadTaskId, 'romero', romero);
            if (andressa) await definirVotoLeadCampo(leadTaskId, 'andressa', andressa);
            // Write-through no espelho (u10): o voto aparece NA HORA na Base. Loga-e-
            // segue — nunca derruba o voto (o ClickUp, fonte da verdade, ja gravou).
            try {
              const patch: { romero?: string; andressa?: string } = {};
              if (romero) patch.romero = romero;
              if (andressa) patch.andressa = andressa;
              await atualizarVotoEspelho(leadTaskId, patch);
            } catch (e) {
              console.error('[espelho] write-through do voto falhou (segue):', e instanceof Error ? e.message : String(e));
            }
            return c.json({ status: 'ok' });
          } catch (e) {
            console.error('[discador] erro ao gravar voto do lead:', e instanceof Error ? e.message : String(e));
            const msg = e instanceof Error ? e.message : String(e);
            const naoEncontrado = msg.includes('nao encontrada') || msg.includes('nao e um Lead da Lista 01');
            return naoEncontrado
              ? c.json({ erro: 'Lead não encontrado' }, 404)
              : c.json({ erro: 'Erro ao gravar o voto' }, 502);
          }
        },
      },
      {
        // Rota 4 — anotacao (comentario append-only) no lead. Guard Lista 01
        // ANTES de comentar (anti-IDOR); comentario nunca sobrescreve a
        // observacao consolidada (maquina-owned) — decisao do plano B1.
        path: '/api/discador/lead/:leadTaskId/anotacao',
        method: 'POST',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          if (papelDoOperador(sess.usuario) !== 'gestor') return c.json({ erro: 'Acesso restrito a gestor' }, 403);
          const leadTaskId = c.req.param('leadTaskId');
          const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
          const texto = String(body.texto || '').trim();
          if (!texto) return c.json({ erro: 'texto obrigatório' }, 400);
          try {
            // Guard anti-IDOR de escrita ANTES de comentar (comentarTask escreve
            // por taskId cru, sem validar a lista).
            await validarLeadDaLista01(leadTaskId);
            await comentarTask(leadTaskId, texto);
            return c.json({ status: 'ok' });
          } catch (e) {
            console.error('[discador] erro ao anotar no lead:', e instanceof Error ? e.message : String(e));
            const msg = e instanceof Error ? e.message : String(e);
            const naoEncontrado = msg.includes('nao encontrada') || msg.includes('nao e um Lead da Lista 01');
            return naoEncontrado
              ? c.json({ erro: 'Lead não encontrado' }, 404)
              : c.json({ erro: 'Erro ao salvar a anotação' }, 502);
          }
        },
      },
      {
        // Rota — "Ligar para QUALQUER lead" (quick-260815-r3): cria uma Ligação
        // AVULSA para o lead da Lista 01 e a ATRIBUI ao operador logado, depois
        // devolve o taskId pro discador abrir a chamada exata (deep-link &task).
        // Gate de PAPEL gestor (mesma visão total das rotas 1-4). O assignee vem
        // SEMPRE de assigneeDoOperador(sess.usuario), NUNCA do body — e é
        // obrigatório: sem dono, o GET /ligacao/:taskId (ownership CR-01) daria
        // 404. Guard anti-IDOR (validarLeadDaLista01) reaproveita a task lida pra
        // extrair o telefone. LGPD: telefone nunca é logado (só mensagem genérica).
        path: '/api/discador/lead/:leadTaskId/ligar',
        method: 'POST',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          if (papelDoOperador(sess.usuario) !== 'gestor') return c.json({ erro: 'Acesso restrito a gestor' }, 403);
          const assignee = assigneeDoOperador(sess.usuario);
          if (!assignee) return c.json({ erro: 'Operador sem mapeamento no ClickUp' }, 409);
          const leadTaskId = c.req.param('leadTaskId');
          try {
            // validarLeadDaLista01 é o guard anti-IDOR E devolve a task já lida —
            // reaproveita pra ler o telefone sem um segundo GET ao ClickUp.
            const task = await validarLeadDaLista01(leadTaskId);
            const telefone = valorCampoLead(task, CAMPOS_LEADS.TELEFONE);
            if (!telefone) return c.json({ erro: 'Lead sem telefone' }, 422);
            const { id } = await criarLigacaoAvulsa(telefone, assignee);
            return c.json({ taskId: id });
          } catch (e) {
            // LGPD: nunca logar telefone/CPF — só a mensagem genérica de erro.
            console.error('[discador] erro ao criar ligação para o lead:', e instanceof Error ? e.message : String(e));
            const msg = e instanceof Error ? e.message : String(e);
            const naoEncontrado = msg.includes('nao encontrada') || msg.includes('nao e um Lead da Lista 01');
            return naoEncontrado
              ? c.json({ erro: 'Lead não encontrado' }, 404)
              : c.json({ erro: 'Erro ao iniciar a ligação' }, 502);
          }
        },
      },
      {
        // Rota 5 — timeline de ligacoes do lead da Ligacao (Lista 02) do
        // operador. SEM browse-gate: e IDOR-safe por ownership (assignee =
        // assigneeDoOperador(sess.usuario), NUNCA do body/query) + a validacao
        // CR-01 de validarLigacaoDoOperador dentro do helper.
        path: '/api/discador/timeline/:taskId',
        method: 'GET',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          const assignee = assigneeDoOperador(sess.usuario);
          if (!assignee) return c.json({ erro: 'Ligação não encontrada' }, 404);
          const taskId = c.req.param('taskId');
          try {
            const timeline = await lerTimelineDaLigacao(taskId, assignee);
            return c.json({ timeline });
          } catch (e) {
            console.error('[discador] erro ao carregar timeline:', e instanceof Error ? e.message : String(e));
            const msg = e instanceof Error ? e.message : String(e);
            const naoAutorizada =
              msg.includes('nao encontrada') ||
              msg.includes('nao e uma Ligacao da Lista 02') ||
              msg.includes('nao pertence ao operador');
            return naoAutorizada
              ? c.json({ erro: 'Ligação não encontrada' }, 404)
              : c.json({ erro: 'Erro ao carregar a timeline' }, 502);
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
            // Checagem sincrona de autorizacao (CR-01/IDOR) ANTES de
            // enfileirar — Fase 08 Plano 04, follow-up de verificacao. Sem
            // isto, um taskId invalido/de outro operador responderia 200 na
            // hora (D-07a e assincrono) e so falharia depois, em silencio,
            // via retry+DLQ dentro do worker — regressao da UX/seguranca de
            // 404 imediato que a gravacao sincrona de antes garantia. Mesma
            // funcao que salvarVotoLead usa internamente (validarLigacaoDoOperador,
            // clickup.ts): LANCA com as mesmas 3 mensagens que o catch abaixo
            // ja mapeia pra 404 — nenhuma logica nova de erro. Custo: uma
            // leitura a mais via fetchClickUp (ja rate-limitada, Plano 01);
            // salvarVotoLead valida de novo dentro do job por seguranca (o
            // assignee/taskId nao mudam entre as duas chamadas na mesma
            // requisicao).
            await validarLigacaoDoOperador(taskId, assignee);
            // D-07a: enfileira o sync (worker espelha no ClickUp em <60s,
            // consistencia eventual) e responde na hora; sem Redis ou se o
            // enqueue falhar em runtime, cai no fallback inline — MESMA
            // gravacao sincrona de hoje (processarSyncClickupJob propaga o
            // throw de salvarVotoLead, WR-03 — o catch abaixo mapeia
            // autz/infra em qualquer um dos dois caminhos).
            const dados = { taskId, assigneeId: assignee, voto };
            const { enfileirado } = await enfileirarSyncClickup(dados);
            if (!enfileirado) {
              await processarSyncClickupJob(dados);
            }
            // D-07b (read-your-writes): aquece a fila cacheada DO OPERADOR
            // com o resultado recem-gravado, na hora — sem esperar o ClickUp
            // espelhar (o sync e ASSINCRONO quando enfileirado, janela
            // <60s; invalidar+refetch leria o estado pre-voto ainda no
            // ClickUp). buscarFilaLigacoes ja exclui a Ligacao da fila por
            // status "em processamento" (setado no /ligando, Task 1) — nao
            // ha campo de resultado em ItemFila pra mesclar, entao `null`
            // remove a task da fila acionavel do operador (read-your-writes
            // "sumiu da minha fila"; idempotente mesmo se ja tiver sido
            // removida). Never-throws, no-op sem Redis (SC5) — fica fora do
            // caminho critico da resposta, nunca transforma um sucesso em
            // erro. Por operador (D-04): so a fila de `assignee` (resolvido
            // por assigneeDoOperador(sess.usuario) acima, nunca do body).
            await aquecerFilaCache(assignee, taskId, null);
            // temLead so era conhecido no caminho sincrono de hoje
            // (retorno de salvarVotoLead); processarSyncClickupJob (usado
            // tanto pelo worker quanto no fallback inline) nao o expoe, e o
            // frontend (web/app.js) nunca leu esse campo da resposta do
            // POST /voto (so o HTTP status) — omitido em ambos os caminhos.
            return c.json({ status: 'ok' });
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

      // ============ API AUDIOS (canal de envio Evolution API) — Fase 12 Plano 03 ============
      // TODA rota abaixo passa pelo gate romero-only (sessaoRomero): 401 sem
      // sessao valida, 403 pra qualquer autenticado != 'romero' (ENVIO-07,
      // T-12-03-E1) — resolvido ANTES de qualquer efeito, mesmo padrao do
      // bloco GESTAO DE OPERADORES acima (sessaoGestor).
      {
        // Lista os leads que NUNCA tiveram Ligação criada (Lista 01 menos
        // Lista 02, ENVIO-03) + origens distintas pros chips (ENVIO-04).
        path: '/api/discador/audios',
        method: 'GET',
        handler: async (c) => {
          const gate = await sessaoRomero(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          try {
            const { leads, origens } = await buscarLeadsNuncaLigados();
            return c.json({ leads, origens });
          } catch (e) {
            console.error('[discador] erro ao buscar leads nunca-ligados:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao carregar os leads' }, 502);
          }
        },
      },
      {
        // Estado real da instância dedicada Evolution — fonte do banner de
        // conexão (D-08): o banner NUNCA finge conectado. Uma falha na
        // consulta também é reportada como desconectado (nunca 200 mascarando).
        path: '/api/discador/audios/status',
        method: 'GET',
        handler: async (c) => {
          const gate = await sessaoRomero(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          try {
            const { conectado } = await statusInstancia();
            return c.json({ conectado });
          } catch (e) {
            console.error('[discador] erro ao consultar status da instância Evolution:', e instanceof Error ? e.message : String(e));
            // D-08: o banner reflete estado REAL — falha de consulta vira
            // "desconectado" (200 com conectado:false), nunca 200 "conectado".
            return c.json({ conectado: false }, 200);
          }
        },
      },
      {
        // Envia um áudio (base64) via Evolution pro telefone do lead, throttled
        // (evolution.ts, D-06), e registra na Lista Audios (best-effort, WR-03).
        // Guard anti-IDOR (validarLeadDaLista01) ANTES de resolver telefone —
        // mesmo padrão de /lead/:leadTaskId/ligar. Falha do envio (sessão fora/
        // HTTP erro) vira resposta NÃO-2xx explícita — nunca 200 silencioso
        // (D-08, SC5). `enviadoPor` vem SEMPRE de gate.usuario (token), nunca do
        // body do cliente (T-12-03-S1).
        path: '/api/discador/audios/:leadId/enviar',
        method: 'POST',
        handler: async (c) => {
          const gate = await sessaoRomero(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          const leadId = c.req.param('leadId');
          const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
          const audioBase64 = String(body.audioBase64 || '');
          const mimetype = body.mimetype != null ? String(body.mimetype) : undefined;
          if (!audioBase64) return c.json({ erro: 'audioBase64 obrigatório' }, 400);
          let telefoneE164: string;
          let idLeadGhl = '';
          try {
            // validarLeadDaLista01 é o guard anti-IDOR E devolve a task já lida
            // — reaproveita pra ler o telefone sem um segundo GET ao ClickUp.
            const task = await validarLeadDaLista01(leadId);
            const telefoneRaw = valorCampoLead(task, CAMPOS_LEADS.TELEFONE);
            const e164 = telefoneRaw ? normalizarTelefoneE164(telefoneRaw) : null;
            if (!e164) return c.json({ erro: 'Lead sem telefone válido' }, 422);
            telefoneE164 = e164;
            idLeadGhl = valorCampoLead(task, CAMPOS_LEADS.ID_LEAD_GHL);
          } catch (e) {
            console.error('[discador] erro ao resolver lead pro envio de áudio:', e instanceof Error ? e.message : String(e));
            const msg = e instanceof Error ? e.message : String(e);
            const naoEncontrado = msg.includes('nao encontrada') || msg.includes('nao e um Lead da Lista 01');
            return naoEncontrado
              ? c.json({ erro: 'Lead não encontrado' }, 404)
              : c.json({ erro: 'Erro ao carregar o lead' }, 502);
          }
          try {
            // Pré-check (quick 260818-mv2): checa o número na Evolution ANTES
            // de gastar throttle/rate-limit num envio que nunca vai chegar.
            // Só marca "sem WhatsApp" quando a Evolution AFIRMA exists===false
            // — erro de rede/HTTP cai no catch abaixo, MESMO tratamento de
            // "desconectado" de hoje (nunca marca o lead por ambiguidade).
            const existe = await numeroExisteNoWhatsapp(telefoneE164);
            if (!existe) {
              await marcarLeadSemWhatsapp({
                leadTaskId: leadId,
                idLeadGhl,
                telefone: telefoneE164,
                usuario: gate.usuario,
              });
              return c.json({ status: 'sem_whatsapp' });
            }
          } catch (e) {
            // LGPD: nunca logar telefone/CPF em claro — só a mensagem/classe.
            console.error('[discador] falha no pré-check de WhatsApp:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'envio_falhou', desconectado: true }, 502);
          }
          try {
            // enviarAudio já passa pelo rate limiter interno (D-06) e LANÇA em
            // falha de rede/HTTP/sessão fora — nunca sucesso silencioso (D-08).
            await enviarAudio(telefoneE164, audioBase64, mimetype);
          } catch (e) {
            // LGPD: nunca logar telefone/CPF/audioBase64 em claro — só a
            // mensagem/classe do erro.
            console.error('[discador] falha ao enviar áudio via Evolution:', e instanceof Error ? e.message : String(e));
            // Falha ALTA (D-08): nunca 200 aqui — a UI traduz `desconectado`
            // pro aviso explícito de sessão fora/erro de envio.
            return c.json({ erro: 'envio_falhou', desconectado: true }, 502);
          }
          // Registro best-effort na Lista Audios (WR-03) — o envio (efeito
          // primário) já aconteceu; uma falha aqui nunca desfaz/mascara o envio.
          // enviadoPor vem do TOKEN (gate.usuario), nunca do body do cliente.
          await registrarEnvioAudio({
            telefone: telefoneE164,
            enviadoPor: gate.usuario,
            // WR-03/IN-03: extensão saneada — o recorder produz
            // `audio/webm;codecs=opus`, então tira os parâmetros `;codecs=...`
            // pra não gravar `audio-<ts>.webm;codecs=opus` (extensão malformada).
            audioRef: `audio-${Date.now()}${mimetype ? `.${(mimetype.split('/')[1] || '').split(';')[0] || 'bin'}` : ''}`,
            leadTaskId: leadId,
          });
          return c.json({ status: 'ok' });
        },
      },

      // ============ API ADMIN (painel operacional) — Fase 10, OBS-01/02/D-02 ============
      {
        // Mesmo shape de /api/discador/config: verificarToken -> 401 sem
        // sessao valida, 403 quando o papel nao e gestor (mesmo gate das rotas
        // de lead — o painel de metricas e visao de gestor). Retorna so
        // o MetricasSnapshot agregado (numeros) + os thresholds configurados
        // (T-10-05-I1: NUNCA telefone/CPF/voto) — o front usa os thresholds
        // pra decidir accent/destructive sem hardcode.
        path: '/api/admin/metricas',
        method: 'GET',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          if (papelDoOperador(sess.usuario) !== 'gestor') return c.json({ erro: 'Acesso restrito a gestor' }, 403);
          const m = await lerMetricas();
          return c.json({
            ...m,
            thresholds: {
              fila: METRICAS_FILA_ALERTA,
              erroTaxa: METRICAS_ERRO_TAXA_ALERTA,
              contagem429: METRICAS_429_ALERTA,
            },
          });
        },
      },

      // ============ GESTAO DE OPERADORES (painel admin) — Fase 11 Plano 04 ============
      // TODA rota abaixo passa pelo gate de gestor (sessaoGestor): 401 sem sessao valida,
      // 403 sem papel 'gestor' (T-11-04-E1) — resolvido ANTES de qualquer efeito. Nenhuma
      // resposta inclui senha_hash/senha_salt (T-11-04-I1).
      {
        // Lista os operadores (shape publico, sem hash) para a tela de gestao.
        path: '/api/admin/usuarios',
        method: 'GET',
        handler: async (c) => {
          const gate = await sessaoGestor(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          try {
            const usuarios = await listarUsuarios();
            return c.json({ usuarios });
          } catch (e) {
            console.error('[admin] erro ao listar usuarios:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao carregar usuarios' }, 502);
          }
        },
      },
      {
        // Cria um operador novo. D-07: a senha inicial e definida pelo gestor
        // (nao ha fluxo de convite/self-signup).
        path: '/api/admin/usuarios',
        method: 'POST',
        handler: async (c) => {
          const gate = await sessaoGestor(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
          const usuario = String(body.usuario || '').trim();
          const senha = String(body.senha || '');
          const papel = body.papel;
          if (!usuario || !senha || (papel !== 'gestor' && papel !== 'atendente')) {
            return c.json({ erro: 'Campos usuario/senha/papel (gestor|atendente) sao obrigatorios' }, 400);
          }
          // Exclusividade device↔operador: um número Wavoip é de UM operador só.
          const deviceNovo = body.wavoip_device_id != null ? String(body.wavoip_device_id) : '';
          if (deviceNovo) {
            const dono = donoDoDevice(deviceNovo);
            if (dono) return c.json({ erro: `Este número já está associado ao operador "${dono}". Libere lá primeiro.` }, 409);
          }
          try {
            const criado = await criarUsuario({
              usuario,
              senha,
              papel,
              clickup_member_id: body.clickup_member_id != null ? String(body.clickup_member_id) : null,
              wavoip_device_id: body.wavoip_device_id != null ? String(body.wavoip_device_id) : null,
            });
            await recarregarUsuarios();
            return c.json({ usuario: criado }, 201);
          } catch (e) {
            console.error('[admin] erro ao criar usuario:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao criar usuario' }, 502);
          }
        },
      },
      {
        // Atualiza papel/vinculos e/ou reseta a senha (D-07: reset do gestor) de um operador.
        path: '/api/admin/usuarios/:id',
        method: 'PATCH',
        handler: async (c) => {
          const gate = await sessaoGestor(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          const id = c.req.param('id');
          const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
          // Exclusividade device↔operador (ignora o próprio operador em edição).
          if ('wavoip_device_id' in body && body.wavoip_device_id != null) {
            const deviceNovo = String(body.wavoip_device_id);
            if (deviceNovo) {
              const dono = donoDoDevice(deviceNovo, id);
              if (dono) return c.json({ erro: `Este número já está associado ao operador "${dono}". Libere lá primeiro.` }, 409);
            }
          }
          try {
            if (typeof body.senha === 'string' && body.senha) {
              await atualizarSenha(id, body.senha);
            }
            const campos: Record<string, unknown> = {};
            if (body.papel === 'gestor' || body.papel === 'atendente') campos.papel = body.papel;
            if ('clickup_member_id' in body) campos.clickup_member_id = body.clickup_member_id != null ? String(body.clickup_member_id) : null;
            if ('wavoip_device_id' in body) campos.wavoip_device_id = body.wavoip_device_id != null ? String(body.wavoip_device_id) : null;
            if (Object.keys(campos).length > 0) {
              await atualizarUsuario(id, campos as Parameters<typeof atualizarUsuario>[1]);
            }
            await recarregarUsuarios();
            return c.json({ status: 'ok' });
          } catch (e) {
            console.error('[admin] erro ao atualizar usuario:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao atualizar usuario' }, 502);
          }
        },
      },
      {
        // Remove um operador. Guarda anti-lockout (T-11-04-D1): recusa remover
        // o UNICO gestor restante.
        path: '/api/admin/usuarios/:id',
        method: 'DELETE',
        handler: async (c) => {
          const gate = await sessaoGestor(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          const id = c.req.param('id');
          try {
            const usuarios = await listarUsuarios();
            const alvo = usuarios.find((u) => u.id === id);
            const gestores = usuarios.filter((u) => u.papel === 'gestor');
            if (alvo && alvo.papel === 'gestor' && gestores.length <= 1) {
              return c.json({ erro: 'Nao e possivel remover o unico gestor' }, 409);
            }
            await removerUsuario(id);
            await recarregarUsuarios();
            return c.json({ status: 'ok' });
          } catch (e) {
            console.error('[admin] erro ao remover usuario:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao remover usuario' }, 502);
          }
        },
      },
      {
        // Dropdown de membros ClickUp (D-03) para o vinculo clickup_member_id.
        path: '/api/admin/clickup-membros',
        method: 'GET',
        handler: async (c) => {
          const gate = await sessaoGestor(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          try {
            const membros = await listarMembrosWorkspace();
            return c.json({ membros });
          } catch (e) {
            console.error('[admin] erro ao listar membros ClickUp:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao carregar membros ClickUp' }, 502);
          }
        },
      },
      {
        // Dropdown de devices Wavoip (D-04) para o vinculo wavoip_device_id —
        // deviceId+numero SOMENTE, nunca o token (T-11-03-I1).
        path: '/api/admin/devices',
        method: 'GET',
        handler: async (c) => {
          const gate = await sessaoGestor(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          try {
            const devices = inventarioPublico();
            return c.json({ devices });
          } catch (e) {
            console.error('[admin] erro ao listar devices:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao carregar devices' }, 500);
          }
        },
      },
      {
        // Auto-descoberta Wavoip: lista TODOS os aparelhos da conta (nome/numero/
        // status) + se o webhook de prod já está gravado nos conectados. Só
        // gestor. LGPD: número sai pro dono autenticado, nunca a log.
        path: '/api/admin/wavoip/dispositivos',
        method: 'GET',
        handler: async (c) => {
          const gate = await sessaoGestor(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          if (!wavoipApiConfigurada()) return c.json({ naoConfig: true, dispositivos: [], autoWebhook: false });
          try {
            const dispositivos = await listarDispositivosWavoip();
            const alvo = urlWebhookProd();
            // Checa o webhook SÓ dos conectados (read-only), com throttle leve.
            if (alvo) {
              for (const d of dispositivos) {
                if (!d.conectado) continue;
                try {
                  d.webhookOk = webhookBate(await lerWebhookDispositivo(d.id), alvo);
                } catch {
                  d.webhookOk = null;
                }
                await new Promise((r) => setTimeout(r, 60));
              }
            }
            return c.json({ dispositivos, autoWebhook: Boolean(alvo) });
          } catch (e) {
            console.error('[admin] erro ao listar dispositivos Wavoip:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao consultar a Wavoip' }, 502);
          }
        },
      },
      {
        // Chamadas por número (métricas Fase 1): tabela device-a-device com
        // status ao vivo, operador dono, chamadas de HOJE (total/atendidas/não)
        // e o ACUMULADO (`calls_made` da Wavoip). Só gestor. Usa o inventário
        // vivo CACHEADO (garantirInventarioWavoip) — barato de pollar; a Wavoip
        // só é batida no TTL. LGPD: número sai pro gestor, nunca a log.
        path: '/api/admin/chamadas-por-numero',
        method: 'GET',
        handler: async (c) => {
          const gate = await sessaoGestor(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          if (!wavoipApiConfigurada()) return c.json({ naoConfig: true, numeros: [] });
          try {
            await garantirInventarioWavoip();
            const devices = snapshotDevicesWavoip();
            const hoje = await lerChamadasDevicesHoje();
            const donos = donosDevices();
            const numeros = devices.map((d) => {
              const h = hoje[d.id] ?? { total: 0, atendidas: 0, nao: 0 };
              // "hoje" é DERIVADO (atendidas + não) — nunca diverge do detalhe.
              return { ...d, operador: donos[d.id] ?? null, hoje: { total: h.atendidas + h.nao, atendidas: h.atendidas, nao: h.nao } };
            });
            // conectados primeiro; depois quem tem mais chamadas hoje
            numeros.sort((a, b) => (b.conectado ? 1 : 0) - (a.conectado ? 1 : 0) || b.hoje.total - a.hoje.total);
            // Órfãos: chamadas de hoje atribuídas a um id fora do inventário (ex.:
            // operador sem número associado → bucket ''). Não somem — viram UMA
            // linha, pra o "hoje" total do painel bater com o que aconteceu.
            const conhecidos = new Set(devices.map((d) => d.id));
            let orfAt = 0;
            let orfNao = 0;
            for (const [id, h] of Object.entries(hoje)) {
              if (!conhecidos.has(id)) {
                orfAt += h.atendidas;
                orfNao += h.nao;
              }
            }
            if (orfAt + orfNao > 0) {
              numeros.push({
                id: '',
                nome: 'Sem número associado',
                numero: '',
                status: 'closed',
                conectado: false,
                callsMade: 0,
                operador: null,
                hoje: { total: orfAt + orfNao, atendidas: orfAt, nao: orfNao },
              });
            }
            return c.json({ numeros });
          } catch (e) {
            console.error('[admin] erro em chamadas-por-numero:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao montar chamadas por número' }, 502);
          }
        },
      },
      {
        // Operação ao vivo (Fase 2): quem está online AGORA e o que faz (ocioso
        // / em chamada), com o número de cada um. Só gestor. Fontes degradáveis
        // (listar* nunca lançam). LGPD: só usuário + número — nunca telefone/CPF.
        path: '/api/admin/operacao',
        method: 'GET',
        handler: async (c) => {
          const gate = await sessaoGestor(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          try {
            const [online, emChamada] = await Promise.all([listarAtendentesOnline(), listarEmChamada()]);
            const onlineSet = new Set(online);
            const emChamadaSet = new Set(emChamada);
            await garantirInventarioWavoip();
            const numById = new Map(snapshotDevicesWavoip().map((d) => [d.id, d.numero] as [string, string]));
            const snap = snapshotUsuarios();
            const operadores: Array<{ usuario: string; papel: string; numero: string; online: boolean; emChamada: boolean; status: string }> = [];
            for (const [usuario, reg] of snap) {
              const on = onlineSet.has(usuario);
              const call = emChamadaSet.has(usuario);
              if (!on && !call) continue; // só quem está online ou em chamada
              const devId = reg.wavoip_device_id || '';
              operadores.push({
                usuario,
                papel: reg.papel,
                numero: devId ? (numById.get(devId) ?? '') : '',
                online: on,
                emChamada: call,
                status: call ? 'em_chamada' : 'online',
              });
            }
            operadores.sort(
              (a, b) =>
                (b.emChamada ? 1 : 0) - (a.emChamada ? 1 : 0) ||
                (b.online ? 1 : 0) - (a.online ? 1 : 0) ||
                a.usuario.localeCompare(b.usuario),
            );
            return c.json({ operadores, resumo: { online: onlineSet.size, emChamada: emChamadaSet.size } });
          } catch (e) {
            console.error('[admin] erro em operacao:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao montar operação ao vivo' }, 502);
          }
        },
      },
      {
        // Grava o webhook de prod nos aparelhos CONECTADOS que ainda não têm.
        // Só gestor. Idempotente (só escreve o que falta). Nunca toca em
        // não-conectado, então não mexe em reserva/hibernando.
        path: '/api/admin/wavoip/webhooks/sincronizar',
        method: 'POST',
        handler: async (c) => {
          const gate = await sessaoGestor(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          if (!autoWebhookConfigurado()) return c.json({ erro: 'WAVOIP_WEBHOOK_URL não configurada no servidor' }, 400);
          try {
            const dispositivos = await listarDispositivosWavoip();
            const alvo = urlWebhookProd();
            let gravados = 0;
            let jaOk = 0;
            let falhas = 0;
            for (const d of dispositivos) {
              if (!d.conectado) continue;
              try {
                if (webhookBate(await lerWebhookDispositivo(d.id), alvo)) jaOk++;
                else {
                  await configurarWebhookDispositivo(d.id);
                  gravados++;
                }
              } catch {
                falhas++;
              }
              await new Promise((r) => setTimeout(r, 80));
            }
            return c.json({ status: 'ok', gravados, jaOk, falhas });
          } catch (e) {
            console.error('[admin] erro ao sincronizar webhooks Wavoip:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao sincronizar webhooks' }, 502);
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
            // Fecha a 4a etapa de D-06 (10-05): conta o erro da etapa
            // 'webhook' pra taxaErroPorEtapa do painel/alertas. Nunca lanca —
            // nao muda em nada o desfecho existente do catch.
            registrarErroEtapa('webhook');
            try { await marcarEventoWebhook(eventoDuravelId, 'erro', String(erro)); }
            catch (e2) { console.error('[wavoip] falha ao marcar evento com erro:', e2); }
            return c.json({ status: 'erro', mensagem: String(erro) }, 500);
          }
        },
      },
    ],
  },
});
