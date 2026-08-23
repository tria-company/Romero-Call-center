import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';

// Config: credenciais GHL + token do webhook Wavoip (transcricao das calls).
// O token do device Wavoip (SDK do navegador) agora e resolvido por usuario
// via dispositivos.ts (DEVICE-01, Fase 07 Plano 01) — nao mais um unico
// WAVOIP_DEVICE_TOKEN global importado aqui.
import {
  WAVOIP_WEBHOOK_TOKEN,
  DISCADOR_PANEL_URL,
  // Alerta de queda do chip (2026-08-19): nome da instância PRINCIPAL (filtra
  // o connection.update dela) + cooldown anti-flap do aviso no grupo.
  EVOLUTION_INSTANCE,
  ALERTA_QUEDA_COOLDOWN_MS,
  // Inbound → fila (2026-08-19): dedupe por telefone direto na Lista 02.
  CLICKUP_LIST_LIGACOES,
  // Fase B (Phase 19, 19-07): flag por-agregado da inversão Supabase-fonte-
  // da-verdade (default 'clickup', flip só no 19-10) + nomes das RPCs do
  // Caminho B (Portão 1) que as rotas de escrita chamam via comOutboxRpc
  // quando FONTE_LIGACOES='supabase'.
  FONTE_LIGACOES,
  SUPABASE_RPC_INICIAR_LIGACAO,
  SUPABASE_RPC_REGISTRAR_DESFECHO,
  SUPABASE_RPC_PULAR_LIGACAO,
  SUPABASE_RPC_CRIAR_LIGACAO_AVULSA,
  // 19-08: RPC do voto (SoT leads.confirmou_* + ledger votos_ligacao + outbox
  // na mesma tx) — /voto (caminho ligação) e /lead/:id/voto (caminho lead,
  // regra determinística p_ligacao_id=null) consomem a MESMA RPC.
  SUPABASE_RPC_REGISTRAR_VOTO,
  // Fase C (Phase 20, 20-05): flag por-agregado 'audios' (default 'clickup',
  // flip só no 20-08) + nomes das RPCs do Caminho B que as 2 rotas de escrita
  // de áudio/mensagem chamam via comOutboxRpc quando FONTE_AUDIOS='supabase'.
  FONTE_AUDIOS,
  SUPABASE_RPC_REGISTRAR_ENVIO_AUDIO,
  SUPABASE_RPC_REGISTRAR_MENSAGEM_TEXTO,
  // Fase C (Phase 20, 20-07): flag do agregado 'notas' (default 'clickup',
  // flip só no 20-08) + nome da RPC de anotação + tabela do espelho de leads
  // (resolução best-effort de lead_id numérico p/ registrar_anotacao — notas
  // não tem trigger de auto-resolução como ligacoes/audios_envios, 22_fundacao).
  FONTE_NOTAS,
  SUPABASE_RPC_REGISTRAR_ANOTACAO,
  SUPABASE_TABLE_LEADS_ESPELHO,
  // Quick 260823-h1s: flag do agregado 'leads' (default 'clickup') pro
  // caminho de CRIAÇÃO de lead nativo — POST /api/discador/lead. Débito
  // pré-flip (dreno) documentado em sql/escala/27_rpc_criar_lead.sql;
  // nenhum flip acontece nesta quick task.
  FONTE_LEADS,
} from './config';
// Helper transacional único do Caminho B (Portão 1, Fase 18/19): toda
// mutação de `ligacoes` sob FONTE_LIGACOES='supabase' vira UMA chamada
// `comOutboxRpc(nomeRpc, args)` — mutação + INSERT no outbox no MESMO corpo
// plpgsql (both-or-neither). Ver src/mastra/outbox-rpc.ts.
import { comOutboxRpc } from './outbox-rpc.ts';
// Normalização de telefone (19-01) — usada pela avulsa (Task 2) pra montar
// p_telefone_canonico/p_telefone_variantes da RPC criar_ligacao_avulsa.
import { canonizarTelefone, variantesTelefone } from './telefone-canonico.ts';

// Auth do PWA discador (login por closer, token HMAC sem estado).
import { verificarCredenciais, emitirToken, verificarToken, tokenDoHeader } from './discador-auth';
// Fase A espelho (17-03, MODELO-06/PORTAO-03): validação do mapa de field-ids
// ClickUp no boot (uma única autoridade, R8) + healthcheck de boot das
// tabelas novas do espelho (SELECT+escrita, R11) — disparados 1x no boot
// abaixo, mesmo molde fire-and-forget não-fatal de semearUsuariosSeVazio.
import { carregarEValidarCampoMapa, DivergenciaCampoMapa } from './campo-mapa.ts';
import { healthcheckEspelho } from './boot-espelho.ts';
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
  // quick-260822-rr6 (R6/D-06): anotação aditiva na Ligação (caminho "atendeu"
  // do retorno tel:) — ISOLADA de registrarDesfecho/FONTE_LIGACOES.
  anotarLigacao,
  // quick-260822-rr6 (R9): tag "super-fa" no LEAD ligado a uma Ligação — mesma
  // isolação de anotarLigacao.
  marcarLeadSuperFa,
  // Quick 260822-tdj: resolve o lead_task_id (best-effort, aceitável null)
  // pra compor a AnotacaoLigacaoRow gravada no Supabase.
  resolverLeadDaLigacao,
  // Pular contato (2026-08-19): fecha a Ligação com motivo do Romero — mesmos
  // primitivos do desfecho (metadados + comentário + fechar), semântica própria.
  gravarMetadadosLigacao,
  fecharLigacao,
  // Inbound → fila (2026-08-19): quem manda mensagem ganha Ligação; LEAD_REL
  // da task recém-criada propaga o vínculo pro mapa/DB de mensagens; o dedupe
  // usa listarTasks com filtro server-side por TELEFONE.
  CAMPOS_LIGACOES,
  listarTasks,
  listarTasksComRetry,
  fecharLigacoesDuplicadas,
  identidadeDaLigacao,
  // quick-260815-r3: "Ligar" na ficha cria uma Ligação avulsa ATRIBUÍDA ao
  // operador (deep-link do discador). valorCampoLead/CAMPOS_LEADS leem o
  // telefone do lead pra criar a avulsa (choke point de leitura de campo).
  criarLigacaoAvulsa,
  valorCampoLead,
  CAMPOS_LEADS,
  // Fase B (Phase 19, 19-07 Task 3): correlação de fallback do webhook por
  // telefone (caminho ClickUp, sob FONTE_LIGACOES='clickup') — o par
  // Supabase (buscarLigacaoAbertaPorTelefoneSupabase, multi-candidato ±9º)
  // vem do import de './supabase' abaixo.
  buscarLigacaoAbertaPorTelefone,
  // Canal de envio Evolution API + Lista de Áudios (Fase 12 Plano 03,
  // ENVIO-01/02/03/06): a rota GET usa a versão CACHEADA (quick 260818-perf:
  // varredura ~8-30s + poll de 30s do painel = cache stale-while-revalidate);
  // registrarEnvioAudio vem do Plano 02; normalizarTelefoneE164 resolve o
  // E.164 do lead antes de chamar evolution.enviarAudio.
  buscarLeadsNuncaLigadosCacheado,
  registrarEnvioAudio,
  normalizarTelefoneE164,
  // quick 260818-mv2: pré-check de WhatsApp ANTES do envio de áudio — marca
  // o lead "Sem WhatsApp" (comenta + Ligação fechada) sem tocar em
  // buscarLeadsNuncaLigados.
  marcarLeadSemWhatsapp,
  // Histórico de envios por lead (Lista 03) — bolhas persistentes da conversa.
  listarEnviosAudioDoLead,
  // Fase 13 (fatia 1): escrita da transcrição/resposta na Lista 03 + leitura
  // do anexo de áudio do registro (mídia do fallback da conversa).
  setCustomField,
  CAMPOS_AUDIOS,
  lerTask,
  // Fase 13 (fatia 2): chat de texto + selo Ligar/Não ligar/Sem conversa.
  registrarMensagemTexto,
  mapaConversaPorLead,
  type ResumoConversaLead,
} from './clickup';
// Cache resiliente do detalhe do lead (quick 260819-v2a, espelho de
// filaMem/buscarFilaResiliente acima): stale-while-revalidate + dedup em-voo
// num módulo folha próprio (não em index.ts) para `gerar-dossie.ts` poder
// invalidar sem criar ciclo de import com este arquivo. `lerLeadDetalhe`
// (importado acima, de './clickup') continua sendo o reader default por
// dentro do novo módulo.
import { lerLeadDetalheResiliente, lerLeadDossieResiliente, derrubarLeadDetalheMem } from './lead-detalhe-cache.ts';
import { regenerarDossieDoLead } from './gerar-dossie.ts';
// Client Evolution API (Fase 12 Plano 01, D-06/D-08): choke-point único de
// envio/status — enviarAudio LANÇA em falha (nunca 200 silencioso).
// numeroExisteNoWhatsapp (quick 260818-mv2): pré-check ANTES de enviarAudio.
import {
  enviarAudio,
  statusInstancia,
  numeroExisteNoWhatsapp,
  EvolutionThrottleError,
  // Fase 13 (fatia 1, quick 260818): conversa por POLLING direto da instância
  // (sem webhook) + download de mídia pras bolhas/transcrição.
  listarMensagensDaConversa,
  baixarAudioMensagem,
  // Fase 13 (fatia 2): chat de texto.
  enviarTexto,
  // Alerta de queda do chip (2026-08-19): posta no grupo de operação via a
  // instância de ALERTA — caminho independente do chip principal.
  enviarAlertaGrupo,
} from './evolution.ts';
// Fase 13: transcrição das mensagens de voz (mesmo Deepgram das calls, D-07).
import { transcreverBuffer } from './deepgram.ts';
// Fase 13 (fatia 2): avaliação "ligar ou não ligar" da resposta do lead —
// mesmo LLM Azure dos 3 agentes do projeto.
import { chamarLLM } from './llm.ts';

/* Fase 13 (fatia 1) — caches em memória do processo (1 instância, mesmo
   racional do cache do lote): transcrição por MENSAGEM (id estável na
   Evolution; nunca re-transcreve o mesmo áudio) e contagem de resposta já
   persistida por LEAD (evita reescrever a Lista 03 a cada poll da conversa). */
const transcricaoPorMensagem = new Map<string, string | null>();
const respostaPersistidaPorLead = new Map<string, number>();
/* Telefone já VALIDADO por lead (cache 5 min): o guard anti-IDOR
   (validarLeadDaLista01) custa um GET no ClickUp e a conversa é POLLADA a cada
   10s — valida na 1ª abertura e reusa o resultado nos polls seguintes. A
   propriedade de segurança se mantém: só entra no cache o que JÁ passou pelo
   guard; a membresia na Lista 01 não muda no meio de uma conversa aberta. */
const telefonePorLeadCache = new Map<string, { e164: string; em: number }>();
const TTL_TELEFONE_LEAD_MS = 300_000;

/* Fase 13 (fatia 3, LOCAL-FIRST): recepção por WEBHOOK — a Evolution posta
   cada mensagem recebida aqui (no local via túnel cloudflared; na produção,
   direto na URL do VPS). Supre o cofre mudo do servidor Evolution: as
   mensagens do LEAD ficam em memória (últimas 500) e alimentam a conversa, a
   transcrição, a avaliação (debounce 60s) e o selo. Áudio chega base64
   (webhook configurado com base64:true) e é transcrito na chegada. */
type MensagemRecebidaWebhook = {
  id: string;
  ts: number;
  tipo: 'texto' | 'audio' | 'outro';
  texto: string | null;
  transcricao: string | null;
  /** dígitos dos jids candidatos (remoteJid/senderPn/participantPn) — casados
   *  contra o telefone do lead com tolerância ao nono dígito. */
  digitos: string[];
  midiaBase64: string | null;
  midiaMime: string | null;
};
const recebidasWebhook: MensagemRecebidaWebhook[] = [];
/** Últimos eventos BRUTOS (ring de 5) — inspeção de formato via rota token-gated. */
const ultimosEventosWebhook: unknown[] = [];
/** Alerta de queda do chip (2026-08-19): carimbo do último aviso (cooldown
 *  anti-flap) + se a queda em aberto já foi anunciada — o 'open' seguinte
 *  posta a volta UMA vez. Estado por processo (perde no restart, aceitável:
 *  no pior caso re-avisa uma queda antiga respeitando o cooldown). */
let ultimoAlertaQuedaTs = 0;
let quedaAlertada = false;
/** Alerta de queda de device de ATENDENTE (Quick 260819-p1r): estado de
 *  edge-trigger por-device (decidirAlertaQuedaDevice, alerta-queda-device.ts)
 *  alimentado pelo branch DEVICE do webhook Wavoip. RESSALVA — mesma
 *  limitação do estado anti-flap do chip acima: este Map vive em memória
 *  POR-RÉPLICA/processo (perde no restart; em multi-réplica cada réplica tem
 *  seu próprio estado e pode duplicar o alerta de uma mesma queda — o
 *  cooldown limita a repetição, mas não elimina entre réplicas distintas).
 *  Resolver de vez pediria estado compartilhado (Redis) — fica pra depois. */
const estadoAlertaDevice = new Map<string, EstadoDeviceAlerta>();
/** INBOUND → FILA (2026-08-19, pedido do gestor): "se uma pessoa mandar
 *  mensagem para o número, tem que aparecer na tela" — mensagem recebida sem
 *  Ligação ABERTA do Romero pra aquele telefone cria uma avulsa na hora
 *  (criarLigacaoAvulsa acha e vincula o LEAD da base pelo telefone via filtro
 *  server-side → dossiê/histórico/chat funcionam) e a linha entra na lista no
 *  próximo refresh. Mutex por telefone + cooldown seguram rajadas; grupos/
 *  newsletters nunca chegam aqui (filtro do webhook). Nunca lança. */
const criandoInbound = new Set<string>();
const ultimoInboundTs = new Map<string, number>();
const COOLDOWN_INBOUND_MS = 10 * 60_000;
/** Telefones com uma re-tentativa de inbound AGENDADA (dedup ficou inconclusivo
 *  porque o ClickUp abortou). Serve de guard single-flight: enquanto houver um
 *  retry pendente, novos inbounds do mesmo número não abrem uma segunda cadeia
 *  (que poderia criar uma 2ª avulsa). Valor = nº da próxima tentativa. */
const inboundAdiados = new Map<string, number>();
const INBOUND_MAX_TENTATIVAS = 3;
const INBOUND_RETRY_DELAY_MS = 90_000;
async function garantirLigacaoInbound(
  telefoneCanon: string,
  telefoneBruto: string,
  tentativa = 0,
): Promise<void> {
  if (!telefoneCanon || !telefoneBruto) return;
  const agora = Date.now();
  if (criandoInbound.has(telefoneCanon)) return;
  // Já há um retry AGENDADO pra este número? Deixa a cadeia pendente resolver —
  // não abre uma segunda (que poderia criar uma 2ª avulsa). O próprio retry
  // (setTimeout) limpa este guard antes de reexecutar, então não trava pra sempre.
  if (tentativa === 0 && inboundAdiados.has(telefoneCanon)) return;
  if (agora - (ultimoInboundTs.get(telefoneCanon) ?? 0) < COOLDOWN_INBOUND_MS) return;
  criandoInbound.add(telefoneCanon);
  try {
    const assignee = assigneeDoOperador('romero');
    if (!assignee) return;
    // dedupe: alguma Ligação ABERTA com esse telefone? Filtro SERVER-SIDE por
    // TELEFONE (± nono dígito) — barato e independente do tamanho da fila.
    // CRÍTICO (2026-08-20, caso Maria do Monte): distinguir "não achou" de "não
    // consegui verificar". Antes, um abort do ClickUp caía no mesmo caminho de
    // "não existe" e criava uma avulsa DUPLICADA da mesma pessoa. Agora:
    //  - achou            → já tem Ligação, não cria (dedup positivo);
    //  - conclusivo+vazio → verificou e não existe, cria com segurança;
    //  - inconclusivo     → o ClickUp não respondeu; ADIA e tenta de novo (a
    //                       mensagem já está persistida — ninguém se perde),
    //                       só criando como último recurso após esgotar.
    const d = telefoneBruto.replace(/\D/g, '');
    const comPais = d.length >= 12 ? d : `55${d}`;
    const cands = new Set<string>([`+${comPais}`]);
    if (comPais.length === 12) cands.add(`+${comPais.slice(0, 4)}9${comPais.slice(4)}`);
    if (comPais.length === 13 && comPais[4] === '9') cands.add(`+${comPais.slice(0, 4)}${comPais.slice(5)}`);
    // Retry por candidato + tolerância por candidato: se UM aborta e o outro
    // responde, o que respondeu ainda conta (antes o Promise.all inteiro rejeitava).
    // null = este candidato não pôde ser verificado nem após o retry.
    const rs = await Promise.all(
      [...cands].map((v) =>
        listarTasksComRetry(CLICKUP_LIST_LIGACOES, {
          includeClosed: false,
          customFields: [{ field_id: CAMPOS_LIGACOES.TELEFONE, operator: '=', value: v }],
        })
          .then((r) => r.tasks)
          .catch(() => null),
      ),
    );
    const achou = rs.some((r) => r !== null && r.length > 0);
    const conclusivo = rs.every((r) => r !== null); // todos os candidatos responderam
    if (achou) {
      ultimoInboundTs.set(telefoneCanon, agora);
      inboundAdiados.delete(telefoneCanon);
      return;
    }
    if (!conclusivo) {
      // O ClickUp não confirmou "não existe" — não cria às cegas.
      if (tentativa < INBOUND_MAX_TENTATIVAS) {
        inboundAdiados.set(telefoneCanon, tentativa + 1);
        console.warn(
          `[webhook] inbound: dedupe inconclusivo (ClickUp instável) — adiando ${Math.round(INBOUND_RETRY_DELAY_MS / 1000)}s, tentativa ${tentativa + 1}/${INBOUND_MAX_TENTATIVAS}`,
        );
        setTimeout(() => {
          inboundAdiados.delete(telefoneCanon);
          void garantirLigacaoInbound(telefoneCanon, telefoneBruto, tentativa + 1);
        }, INBOUND_RETRY_DELAY_MS);
        return; // NÃO cria, NÃO seta cooldown (a cadeia adiada decide)
      }
      // Esgotou: cria mesmo assim (fail-open de ÚLTIMO recurso, agora após um
      // atraso real — não na primeira falha). Preserva "nunca perder a pessoa".
      console.warn(
        `[webhook] inbound: dedupe seguiu inconclusivo após ${INBOUND_MAX_TENTATIVAS} tentativas — criando (fail-open de último recurso)`,
      );
      inboundAdiados.delete(telefoneCanon);
    }
    const { id } = await criarLigacaoAvulsa(telefoneBruto, assignee);
    ultimoInboundTs.set(telefoneCanon, agora);
    await invalidarFilaCache(assignee);
    derrubarFilaMem(assignee);
    // propaga o vínculo (se criarLigacaoAvulsa achou o lead): mapa em memória
    // pro restante do pipeline + lead_task_id retroativo nas mensagens do DB.
    let leadId = '';
    try {
      const task = await lerTask(id);
      const rel = task?.custom_fields?.find((c) => c.id === CAMPOS_LIGACOES.LEAD_REL)?.value;
      leadId = Array.isArray(rel) && rel[0] ? String((rel[0] as { id?: unknown })?.id ?? rel[0]) : '';
      if (leadId) {
        leadPorTelefone.set(telefoneCanon, leadId);
        void vincularLeadMensagensWhatsapp(telefoneCanon, leadId).catch(() => {});
      }
    } catch {
      /* vínculo é best-effort — a task já existe e a linha vai aparecer */
    }
    // LGPD: nunca logar o telefone — só o id da task criada.
    console.log(`[webhook] inbound sem Ligação aberta → task ${id} criada (lead ${leadId ? 'vinculado' : 'não encontrado'})`);
  } catch (e) {
    console.warn('[webhook] inbound: falha ao criar a Ligação:', e instanceof Error ? e.message : String(e));
  } finally {
    criandoInbound.delete(telefoneCanon);
  }
}
/** telefone canônico (dígitos sem nono) → leadTaskId — populado pelos handlers
 *  de lista/conversa; permite ao WEBHOOK achar o lead pra avaliar. */
const leadPorTelefone = new Map<string, string>();
function telefoneCanonico(x: string): string {
  const d = x.replace(/\D/g, '');
  return d.length === 13 && d[4] === '9' ? d.slice(0, 4) + d.slice(5) : d;
}
/** timers de avaliação por telefone: cada mensagem nova REARMA o timer pra
 *  60s após a ÚLTIMA mensagem (pedido do gestor: esperar o lead terminar). */
const timerAvaliacaoPorTelefone = new Map<string, ReturnType<typeof setTimeout>>();
function agendarAvaliacaoPorTelefone(digitos: string[], tsMensagem: number): void {
  for (const dg of digitos) {
    const canon = telefoneCanonico(dg);
    if (!canon) continue;
    const anterior = timerAvaliacaoPorTelefone.get(canon);
    if (anterior) clearTimeout(anterior);
    // se o evento já chegou velho (ts antigo), avalia quase na hora
    const atraso = Math.max(1_000, AVALIACAO_DEBOUNCE_MS + 1_000 - (Date.now() - tsMensagem));
    timerAvaliacaoPorTelefone.set(
      canon,
      setTimeout(() => {
        timerAvaliacaoPorTelefone.delete(canon);
        void (async () => {
          // lead: índice em memória primeiro; depois o DB (mensagens já
          // vinculadas sobrevivem a restart — o índice em memória zera).
          let leadId = leadPorTelefone.get(canon) ?? null;
          if (!leadId) leadId = await buscarLeadPorTelefoneWhatsapp(canon);
          if (!leadId) return; // lead nunca visto — a próxima lista/conversa resolve
          leadPorTelefone.set(canon, leadId);
          // mensagens do lead: DB (completo, sobrevive a restart) com fallback
          // no ring em memória (Supabase fora/no-op).
          let doLead: Array<{ ts: number; texto: string | null; transcricao: string | null }> = [];
          try {
            const rows = await listarMensagensWhatsapp({ leadTaskId: leadId, telefoneCanonico: canon });
            if (rows) {
              doLead = rows
                .filter((r) => !r.de_nos && r.tipo !== 'outro')
                .map((r) => ({ ts: Date.parse(r.ts) || 0, texto: r.texto ?? null, transcricao: r.transcricao ?? null }));
            }
          } catch (e) {
            console.warn('[webhook] leitura das mensagens pra avaliação falhou:', e instanceof Error ? e.message : String(e));
          }
          if (doLead.length === 0) {
            doLead = recebidasWebhook
              .filter((m) => m.digitos.some((x) => telefoneCanonico(x) === canon))
              .map((m) => ({ ts: m.ts, texto: m.texto, transcricao: m.transcricao }));
          }
          void avaliarConversaComDebounce(leadId, doLead);
        })();
      }, atraso),
    );
  }
}

/** Remove rótulos "Falante N:" das transcrições (pedido do gestor 2026-08-19)
 *  — o fluxo de áudios do WhatsApp não tem papéis pra rotular; transcrições
 *  antigas gravadas com o rótulo saem limpas na leitura. */
function limparRotuloFalante(t: string | null): string | null {
  if (!t) return t;
  const limpo = t.replace(/Falante \d+:\s*/g, '').trim();
  return limpo || null;
}

/** Comparação de telefones com tolerância ao nono dígito BR (mesma régua do
 *  telefonesIguais do clickup.ts, replicada aqui só sobre dígitos). */
function mesmoTelefoneDigitos(a: string, b: string): boolean {
  const dig = (x: string) => x.replace(/\D/g, '');
  const semNono = (d: string) => (d.length === 13 && d[4] === '9' ? d.slice(0, 4) + d.slice(5) : d);
  const A = dig(a);
  const B = dig(b);
  return !!A && !!B && (A === B || semNono(A) === semNono(B));
}

/* Selo da lista (Fase 13; FUNIL de 5 etapas — pedido do gestor 2026-08-19):
   - enviar_audio: etapa inicial, nada enviado ainda → a ação é mandar o áudio.
   - aguardando: o áudio JÁ foi enviado, esperando a resposta do lead.
   - indefinido: o lead respondeu, mas a resposta é NEUTRA — o Romero decide.
   - ligar / nao_ligar: a resposta deixa claro o desfecho.
   Heurística EXPLÍCITA de fallback (recusa por palavra-chave); a análise IA
   (Azure) é a fonte principal. Cache 5min da passada na Lista 03. */
const RECUSA_RE =
  /\b(n[aã]o\s+(quero|liga|ligue|me\s+ligue|tenho\s+interesse|perturb)|pare|para\s+de|remov[ae]|descadastr|sai\s+fora|nunca\s+mais|bloquea|denunci)\b/i;
type StatusConversaLead = { status: 'ligar' | 'nao_ligar' | 'indefinido' | 'aguardando' | 'enviar_audio'; motivo: string };

/* Avaliação da conversa (pedido do gestor 2026-08-19): TODA mensagem nova do
   lead reavalia o selo, mas com DEBOUNCE de 60s desde a ÚLTIMA mensagem — dá
   tempo do lead terminar de mandar tudo antes da avaliação completa. LLM
   (Azure, `chamarLLM`) decide ligar/não-ligar + motivo; a heurística RECUSA_RE
   é o fallback quando o LLM falha. Resultado fica em memória (fresco) E
   persistido em ANALISE_IA no registro mais recente da Lista 03 (sobrevive a
   restart — `mapaConversaPorLead` lê de volta). */
const AVALIACAO_DEBOUNCE_MS = 60_000;
type DecisaoIA = 'ligar' | 'nao_ligar' | 'indefinido';
const avaliacaoPorLead = new Map<string, { paraContagem: number; status: DecisaoIA; motivo: string }>();
const avaliacaoEmVooPorLead = new Set<string>();

async function avaliarConversaComDebounce(
  leadId: string,
  doLead: Array<{ ts: number; texto: string | null; transcricao: string | null }>,
): Promise<void> {
  if (doLead.length === 0) return;
  const ultimaTs = doLead[doLead.length - 1].ts;
  if (Date.now() - ultimaTs < AVALIACAO_DEBOUNCE_MS) return; // lead ainda pode estar digitando
  const atual = avaliacaoPorLead.get(leadId);
  if (atual && atual.paraContagem === doLead.length) return; // este lote já foi avaliado
  if (avaliacaoEmVooPorLead.has(leadId)) return;
  avaliacaoEmVooPorLead.add(leadId);
  try {
    const corpo = doLead
      .map((m) => (limparRotuloFalante(m.transcricao) ?? m.texto ?? '').trim())
      .filter(Boolean)
      .join('\n');
    // Heurística de fallback: só a recusa explícita vira 'nao_ligar'; qualquer
    // outra resposta fica 'indefinido' (o LLM abaixo é quem decide 'ligar').
    let status: DecisaoIA = corpo && RECUSA_RE.test(corpo) ? 'nao_ligar' : 'indefinido';
    let motivo = corpo ? `"${corpo.slice(0, 90)}"` : 'Respondeu';
    try {
      const bruto = await chamarLLM(
        `Mensagens do lead:\n"""\n${corpo.slice(0, 1500)}\n"""`,
        'Você avalia a resposta de um lead numa campanha de contato por WhatsApp e classifica se vale a pena LIGAR pra essa pessoa agora. Responda APENAS um JSON {"decisao": "ligar" | "nao_ligar" | "indefinido", "motivo": string}. Use "ligar" quando a resposta demonstra interesse/abertura clara; "nao_ligar" quando recusa, pede pra parar ou demonstra hostilidade; "indefinido" quando a resposta é NEUTRA/ambígua e um humano precisa decidir. "motivo" = frase curta (máx. 80 caracteres, português) explicando a decisão pro operador.',
      );
      const m = bruto.match(/\{[\s\S]*\}/);
      const j = m ? (JSON.parse(m[0]) as { decisao?: string; motivo?: string }) : null;
      if (j && (j.decisao === 'ligar' || j.decisao === 'nao_ligar' || j.decisao === 'indefinido')) {
        status = j.decisao;
        if (j.motivo) motivo = String(j.motivo).slice(0, 120);
      }
    } catch (e) {
      console.warn('[discador] avaliação LLM falhou (mantendo heurística):', e instanceof Error ? e.message : String(e));
    }
    avaliacaoPorLead.set(leadId, { paraContagem: doLead.length, status, motivo });
    try {
      // Fase C (20-05): NÃO ramificar por FONTE_AUDIOS — grava ANALISE_IA no
      // ClickUp por `ultimo.taskId`; sob supabase o id local de
      // `audios_envios` não é o clickup_task_id (mesmo débito documentado
      // abaixo, na persistência de resposta de /conversa).
      const envios = await listarEnviosAudioDoLead(leadId);
      const ultimo = envios[envios.length - 1];
      if (ultimo?.taskId) {
        const rotulo = status === 'ligar' ? 'LIGAR' : status === 'nao_ligar' ? 'NÃO LIGAR' : 'INDEFINIDO';
        await setCustomField(ultimo.taskId, CAMPOS_AUDIOS.ANALISE_IA, `${rotulo} — ${motivo}`);
      }
    } catch (e) {
      console.warn('[discador] persistência da análise falhou:', e instanceof Error ? e.message : String(e));
    }
  } finally {
    avaliacaoEmVooPorLead.delete(leadId);
  }
}

function statusConversaDe(leadId: string, resumo?: ResumoConversaLead): StatusConversaLead {
  // 1º a avaliação fresca em memória; 2º a persistida (ANALISE_IA); 3º regras.
  const aval = avaliacaoPorLead.get(leadId);
  if (aval) return { status: aval.status, motivo: aval.motivo };
  if (resumo?.analise) {
    // rótulo persistido em ANALISE_IA: "INDEFINIDO — …" / "NÃO LIGAR — …" / "LIGAR — …"
    const motivo = resumo.analise.replace(/^(NÃO LIGAR|LIGAR|INDEFINIDO)\s*—\s*/, '');
    const status: StatusConversaLead['status'] = resumo.analise.startsWith('NÃO LIGAR')
      ? 'nao_ligar'
      : resumo.analise.startsWith('INDEFINIDO')
        ? 'indefinido'
        : 'ligar';
    return { status, motivo };
  }
  // funil: nada enviado → "Enviar áudio"; enviado sem resposta → "Aguardando".
  if (!resumo || resumo.envios === 0) return { status: 'enviar_audio', motivo: 'Nenhum contato ainda' };
  if (!resumo.temResposta) return { status: 'aguardando', motivo: 'Áudio enviado — aguardando resposta' };
  // respondeu, mas sem avaliação IA: recusa explícita → não ligar; senão indefinido.
  if (resumo.respostaTexto && RECUSA_RE.test(resumo.respostaTexto)) {
    return { status: 'nao_ligar', motivo: `"${resumo.respostaTexto.slice(0, 90)}"` };
  }
  return {
    status: 'indefinido',
    motivo: resumo.respostaTexto ? `"${resumo.respostaTexto.slice(0, 90)}"` : 'Respondeu — Romero decide',
  };
}
/* ===== DOSSIÊ GARANTIDO NA FILA (2026-08-20) =====
   Pedido do gestor: "todo lead do Romero tem que ter dossiê quando ele for
   ligar". Três peças:
   1. `temDossiePorLead` — conhecimento em memória (classificado pela varredura
      e pelas leituras de ficha) que alimenta a ORDENAÇÃO da fila: quem TEM
      dossiê vai pro topo; quem não tem afunda enquanto o dossiê é gerado.
   2. `varrerDossiesDaFila` — background: classifica a fila (leitura leve,
      cacheada) e gera os que faltam UM POR VEZ, na ordem em que o operador
      vai chegar neles, com pausa entre gerações — invisível pra quem opera
      (nada de rajada no ClickUp/LLM).
   3. `gerarDossieSobDemanda` — abriu uma ficha sem dossiê → gera fire-and-
      forget (single-flight + cooldown), pro caso de lead fora da fila.
   LGPD: só leadTaskId/contagens em log — nunca nome/telefone/CPF. */
const temDossiePorLead = new Map<string, boolean>();
const dossieEmGeracao = new Set<string>();
const dossieUltimaTentativa = new Map<string, number>();
const DOSSIE_COOLDOWN_MS = 30 * 60_000;
const DOSSIE_PAUSA_ENTRE_GERACOES_MS = 5_000;
let varreduraDossieAtiva = false;
let ultimaVarreduraDossieTs = 0;

function podeTentarDossie(leadTaskId: string): boolean {
  if (!leadTaskId || dossieEmGeracao.has(leadTaskId)) return false;
  return Date.now() - (dossieUltimaTentativa.get(leadTaskId) ?? 0) >= DOSSIE_COOLDOWN_MS;
}

async function gerarDossieDoLeadGuardado(leadTaskId: string): Promise<boolean> {
  dossieEmGeracao.add(leadTaskId);
  dossieUltimaTentativa.set(leadTaskId, Date.now());
  try {
    const md = await regenerarDossieDoLead(leadTaskId);
    if (md && md.trim() !== '') {
      temDossiePorLead.set(leadTaskId, true);
      console.log(`[dossie] gerado em background: lead ${leadTaskId} (${md.length} chars)`);
      return true;
    }
    return false;
  } catch (e) {
    console.warn(`[dossie] geração falhou (lead ${leadTaskId}):`, e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    dossieEmGeracao.delete(leadTaskId);
  }
}

function gerarDossieSobDemanda(leadTaskId: string): void {
  if (!podeTentarDossie(leadTaskId)) return;
  void gerarDossieDoLeadGuardado(leadTaskId);
}

async function varrerDossiesDaFila(leadIds: string[]): Promise<void> {
  if (varreduraDossieAtiva || Date.now() - ultimaVarreduraDossieTs < 60_000) return;
  varreduraDossieAtiva = true;
  ultimaVarreduraDossieTs = Date.now();
  try {
    // Passo 1 — classifica (leitura LEVE, cacheada 3min): alimenta a ordenação.
    console.log(`[dossie] varredura: classificando ${leadIds.length} lead(s) da fila…`);
    const sem: string[] = [];
    let erros = 0;
    for (const id of leadIds) {
      if (!id || temDossiePorLead.get(id) === true) continue;
      try {
        const det = await lerLeadDossieResiliente(id);
        const tem = (det.dossie ?? '').trim() !== '';
        temDossiePorLead.set(id, tem);
        if (!tem) sem.push(id);
      } catch {
        erros++; // lead problemático não trava a varredura — mas CONTA no resumo
      }
    }
    // resumo SEMPRE (2026-08-20): sem isto, uma varredura 100% falha terminava
    // muda e ninguém sabia se rodou, travou ou abortou.
    console.log(`[dossie] varredura: ${sem.length} sem dossiê, ${erros} erro(s) de leitura`);
    if (sem.length === 0) return;
    console.log(`[dossie] gerando 1 por vez na ordem da fila (pausa ${DOSSIE_PAUSA_ENTRE_GERACOES_MS / 1000}s)`);
    // Passo 2 — gera DEVAGAR, na ordem em que o operador vai chegar neles.
    let gerados = 0;
    for (const id of sem) {
      if (!podeTentarDossie(id)) continue;
      if (await gerarDossieDoLeadGuardado(id)) gerados++;
      await new Promise((r) => setTimeout(r, DOSSIE_PAUSA_ENTRE_GERACOES_MS));
    }
    // fim SEMPRE logado (mesmo racional do resumo da classificação).
    console.log(`[dossie] varredura concluída: ${gerados}/${sem.length} gerado(s)`);
  } finally {
    varreduraDossieAtiva = false;
  }
}

let cacheStatusConversa: { mapa: Map<string, ResumoConversaLead>; em: number } | null = null;
async function mapaConversaCacheado(): Promise<Map<string, ResumoConversaLead> | null> {
  // 60s→5min (2026-08-19): mesmo racional do TTL do lote — menos varreduras da
  // Lista 03 por hora; o selo fresco continua vindo do avaliacaoPorLead em memória.
  if (cacheStatusConversa && Date.now() - cacheStatusConversa.em < 300_000) return cacheStatusConversa.mapa;
  try {
    const mapa = await mapaConversaPorLead();
    cacheStatusConversa = { mapa, em: Date.now() };
    return mapa;
  } catch (e) {
    console.warn('[discador] mapa de conversa falhou (selo fica neutro):', e instanceof Error ? e.message : String(e));
    return cacheStatusConversa?.mapa ?? null; // fail-open: lista sai sem selo
  }
}

// Cache-aside da fila (Fase 08 Plano 02/04, CACHE-04): /ligando invalida/
// remove a task recem-iniciada do cache POR OPERADOR (D-04) — iniciarLigacao
// ja escreve no ClickUp de forma SINCRONA, entao so precisa espelhar esse
// efeito no cache. /voto usa aquecerFilaCache (D-07b, read-your-writes) —
// evento SEPARADO, o sync ao ClickUp e ASSINCRONO (janela <60s).
import { removerDaFilaCache, invalidarFilaCache, aquecerFilaCache } from './cache-fila.ts';

/* FILA RESILIENTE (2026-08-19 — "parar de dar 502 por causa do ClickUp"):
   cache POR OPERADOR em memória com stale-while-revalidate. Fresca por 20s
   (cada cliente sonda a cada 4-30s — o grosso das leituras deixa de bater no
   ClickUp), e quando o ClickUp falha/aborta serve a ÚLTIMA CÓPIA BOA em vez
   de estourar 502 na tela do operador. Falha alta (WR-03) só quando NUNCA
   houve cópia (primeiro load do processo). pular/desfecho/inbound derrubam a
   cópia do operador (read-your-writes). Complementa o cache Redis — este é o
   colchão do processo, existe mesmo sem Redis. */
const filaMem = new Map<string, { fila: Awaited<ReturnType<typeof buscarFilaLigacoes>>; em: number }>();
const TTL_FILA_MEM_MS = 20_000;
function derrubarFilaMem(assignee: string): void {
  filaMem.delete(assignee);
}
async function buscarFilaResiliente(assignee: string): Promise<Awaited<ReturnType<typeof buscarFilaLigacoes>>> {
  const copia = filaMem.get(assignee);
  if (copia && Date.now() - copia.em < TTL_FILA_MEM_MS) return copia.fila;
  try {
    const fila = await buscarFilaLigacoes(assignee);
    filaMem.set(assignee, { fila, em: Date.now() });
    return fila;
  } catch (e) {
    if (copia) {
      console.warn(
        `[discador] fila do ClickUp falhou — servindo cópia de ${Math.round((Date.now() - copia.em) / 1000)}s atrás:`,
        e instanceof Error ? e.message : String(e),
      );
      return copia.fila;
    }
    throw e;
  }
}
// Sync assincrono do voto pos-ligacao (Fase 08 Plano 03, CACHE-03/D-07a):
// /voto enfileira o job (worker espelha no ClickUp em <60s) com fallback
// inline (processarSyncClickupJob) sem Redis (SC5).
import { enfileirarSyncClickup, enfileirarDrenoOutbox } from './fila.ts';
import { processarSyncClickupJob } from './sync-clickup.ts';
// Kick do dreno do outbox (ESCRITA-02, Fase B Plano 03/07): fallback INLINE
// quando enfileirarDrenoOutbox devolve { enfileirado:false } (sem Redis) —
// mesmo padrão de processarSyncClickupJob acima, nunca fire-and-forget
// (T-19-07-Av).
import { processarDrenoOutboxJob } from './drenar-outbox.ts';

// ============ Fase B (Phase 19, 19-07) — helpers do Caminho B para as rotas de escrita de `ligacoes` ============
//
// posCommitLigacao: read-your-writes NO COMMIT LOCAL (as MESMAS invalidações
// que /desfecho já faz — removerDaFilaCache/invalidarFilaCache/
// derrubarFilaMem, no-op sem Redis, nunca lançam) + kick do dreno do outbox
// CHECANDO o retorno — mesmo padrão de enfileirarSyncClickup/
// processarSyncClickupJob já usado em /voto (linhas abaixo). NUNCA
// fire-and-forget: sem Redis (dev/homolog) o dreno roda INLINE aqui, senão o
// outbox nunca drenaria (T-19-07-Av, R12/decisão 9). O `.catch` é
// best-effort — a linha do outbox já foi persistida (a RPC gravou na MESMA
// tx da mutação) e será drenada no próximo kick/worker mesmo se o inline
// falhar aqui; nunca transforma um sucesso da RPC (a mutação já commitou)
// em erro HTTP da rota.
async function posCommitLigacao(assignee: string, ligacaoId: number): Promise<void> {
  await removerDaFilaCache(assignee, String(ligacaoId));
  await invalidarFilaCache(assignee);
  derrubarFilaMem(assignee);
  const { enfileirado } = await enfileirarDrenoOutbox({ aggregateId: ligacaoId });
  if (!enfileirado) {
    await processarDrenoOutboxJob(ligacaoId).catch((e) => {
      console.error(
        '[dreno] inline pós-commit falhou (best-effort — a linha do outbox já foi persistida, drena depois):',
        e instanceof Error ? e.message : String(e),
      );
    });
  }
}

// ============ Fase C (Phase 20, 20-05) — helper análogo pro agregado 'audio' ============
//
// posCommitEnvioAudio: MESMO padrão CHECADO de posCommitLigacao acima — kick
// do dreno do outbox do registro de áudio/mensagem (audios_envios) logo após
// o commit local (a RPC registrar_envio_audio/registrar_mensagem_texto já
// gravou o agregado + a linha do outbox na MESMA tx). Sem invalidação de
// cache de fila (audios não usa filaMem/cache-fila — isso é só de `ligacoes`).
// NUNCA fire-and-forget: sem Redis o dreno roda INLINE aqui (T-19-07-Av,
// mesma decisão 9 aplicada ao novo agregado).
async function posCommitEnvioAudio(audioId: number): Promise<void> {
  const { enfileirado } = await enfileirarDrenoOutbox({ aggregateId: audioId });
  if (!enfileirado) {
    await processarDrenoOutboxJob(audioId).catch((e) => {
      console.error(
        '[dreno] inline envio-áudio pós-commit falhou (best-effort — a linha do outbox já foi persistida, drena depois):',
        e instanceof Error ? e.message : String(e),
      );
    });
  }
}

// ============ Fase C (Phase 20, 20-07) — helper análogo pro agregado 'nota' ============
//
// posCommitAnotacao: MESMO padrão CHECADO de posCommitLigacao/posCommitEnvioAudio
// — kick do dreno do outbox da linha 'comentar' (não-bloqueante, R6) logo após
// o commit local (registrar_anotacao já gravou `notas` + a linha do outbox na
// MESMA tx). Sem invalidação de cache de fila (notas não usa filaMem/cache-fila).
// NUNCA fire-and-forget: sem Redis o dreno roda INLINE aqui (T-19-07-Av).
async function posCommitAnotacao(notaId: number): Promise<void> {
  const { enfileirado } = await enfileirarDrenoOutbox({ aggregateId: notaId });
  if (!enfileirado) {
    await processarDrenoOutboxJob(notaId).catch((e) => {
      console.error(
        '[dreno] inline anotacao pós-commit falhou (best-effort — a linha do outbox já foi persistida, drena depois):',
        e instanceof Error ? e.message : String(e),
      );
    });
  }
}

// ============ Quick 260823-h1s — helper análogo pro agregado 'lead' (criação) ============
//
// posCommitCriarLead: MESMO padrão CHECADO de posCommitAnotacao/
// posCommitEnvioAudio acima — kick do dreno do outbox da linha
// aggregate='lead'/op='criar_task' logo após o commit local (criar_lead já
// gravou discador_leads_espelho + a linha do outbox na MESMA tx). Sem
// invalidação de cache de fila (leads não usa filaMem/cache-fila). NUNCA
// fire-and-forget: sem Redis o dreno roda INLINE aqui (T-19-07-Av). A
// criação EFETIVA da task na Lista 01 a partir desta linha de outbox depende
// do débito pré-flip do dreno (ver rodapé de sql/escala/27_rpc_criar_lead.sql)
// — o kick só garante que o dreno TENTA processar a linha assim que existir.
async function posCommitCriarLead(leadId: number): Promise<void> {
  const { enfileirado } = await enfileirarDrenoOutbox({ aggregateId: leadId });
  if (!enfileirado) {
    await processarDrenoOutboxJob(leadId).catch((e) => {
      console.error(
        '[dreno] inline criar-lead pós-commit falhou (best-effort — a linha do outbox já foi persistida, drena depois):',
        e instanceof Error ? e.message : String(e),
      );
    });
  }
}

/**
 * Reconhece um erro de NEGÓCIO lançado por `comOutboxRpc` (RAISE da RPC —
 * ligação inexistente / não pertence ao operador, sempre um 4xx do
 * PostgREST) — `outbox-rpc.ts` NUNCA expõe o corpo/mensagem original da RPC
 * (WR-03/LGPD), só o status HTTP na própria mensagem de erro (formato fixo
 * `[outbox-rpc] HTTP <status> ao chamar RPC <nome>`). Usado pra OR-ar nos
 * MESMOS checks `naoAutorizada` que os catches abaixo já fazem pro caminho
 * ClickUp: 4xx vira 404 (IDOR-safe, não revela qual dos dois motivos);
 * 5xx/falha de rede (mensagem não bate o padrão) devolve `false` — cai no
 * 502 default de cada catch. Inócuo pro caminho ClickUp (suas mensagens de
 * erro nunca começam com `[outbox-rpc]`).
 */
function ehErroRpcNaoAutorizado(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/^\[outbox-rpc\] HTTP (\d+) ao chamar RPC/);
  if (!m) return false;
  const status = Number(m[1]);
  return status >= 400 && status < 500;
}

/**
 * Correlação de FALLBACK do webhook Wavoip por telefone (LEITURA-05, Fase B
 * 19-07 Task 3) — usada quando a correlação em memória (call_id→telefone,
 * `guardarCorrelacao`/`lerCorrelacao` abaixo) não tem a entrada
 * (restart/TTL expirado). Ramifica por `FONTE_LIGACOES`: 'supabase' chama
 * `buscarLigacaoAbertaPorTelefoneSupabase` (multi-candidato ±9º dígito,
 * 19-05 — devolve o id LOCAL da Ligação); 'clickup' (default) chama a
 * função atual de clickup.ts (varre a página 0 de Ligações abertas —
 * devolve o `taskId` do ClickUp). `null` = nenhuma Ligação aberta casou
 * (resultado legítimo, distinto de erro de infra — ambas as funções
 * LANÇAM em falha de rede/config, WR-03). NUNCA loga telefone (LGPD).
 *
 * CALL SITES: nenhum em index.ts ainda — os 3 pontos que hoje chamam
 * `buscarLigacaoAbertaPorTelefone` diretamente (correlação de falha
 * terminal / RECORD) vivem em `processador.ts`
 * (`processarFalhaTerminalJob`/`processarRecordJob`, linhas ~356/496/678),
 * cujo wiring atrás da flag é o plano **19-08** (owner de processador.ts —
 * FORA DE ESCOPO tocar aqui, conforme o próprio 19-07-PLAN.md). Esta função
 * fica exportada e pronta pro 19-08 trocar as 3 chamadas diretas por ela.
 */
export async function resolverLigacaoAbertaPorTelefone(telefone: string): Promise<string | null> {
  return FONTE_LIGACOES === 'supabase'
    ? buscarLigacaoAbertaPorTelefoneSupabase(telefone)
    : buscarLigacaoAbertaPorTelefone(telefone);
}

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
  type RecorteEspelho,
  // Fase 13: conversa WhatsApp persistida (read-model + durabilidade do webhook Evolution)
  salvarMensagemWhatsapp,
  atualizarMensagemWhatsapp,
  listarMensagensWhatsapp,
  buscarMidiaMensagemWhatsapp,
  vincularLeadMensagensWhatsapp,
  buscarLeadPorTelefoneWhatsapp,
  ultimasMensagensWhatsapp,
  marcarMensagensLidas,
  // Sinal de novidade (2026-08-19): ts da última mensagem persistida — o app
  // sonda a cada ~4s e recarrega lista/conversa na hora quando muda.
  ultimoTsMensagens,
  // Fase B (Phase 19, 19-05/19-07): leitura direta de `ligacoes` sob
  // FONTE_LIGACOES='supabase' — lerLigacaoSupabase valida existência/
  // ownership/"já concluída" com as MESMAS 3 mensagens que os catches abaixo
  // já mapeiam (404/409), e devolve o telefone (pra guardarTaskAtiva em
  // /ligando); buscarLigacaoAbertaPorTelefoneSupabase é a correlação
  // multi-candidato ±9º do webhook (Task 3 — export pronto pro wiring do
  // 19-08 em processador.ts).
  lerLigacaoSupabase,
  buscarLigacaoAbertaPorTelefoneSupabase,
  // Fase B (Phase 19, 19-09): LEITURA de `ligacoes` do Supabase atrás de
  // FONTE_LIGACOES — fila do operador (id local como taskId, LEITURA-01),
  // timeline por lead (LEITURA-03) e resolução do lead a partir da ligação
  // (para a timeline de /timeline). Contrato de resposta idêntico ao ClickUp.
  buscarFilaSupabase,
  buscarLigacoesDoLeadSupabase,
  resolverLeadDaLigacaoSupabase,
  // Quick 260823-kwu: resolução do nome real do lead (via discador_leads_
  // espelho por clickup_task_id) na fila de áudios sob FONTE_LIGACOES=
  // supabase — paridade com o ramo ClickUp (lerTask), sem o qual a fila
  // Supabase mostraria o telefone cru como nome.
  lerNomeLeadEspelho,
  // Quick 260823: dossiê 360° do lead a partir do Supabase (coluna `dossie`
  // do espelho) sob FONTE_LIGACOES=supabase — espelho de clickup.ts::
  // lerContextoLead, resolve o lead pela Ligação local (id numérico).
  lerContextoLeadSupabase,
  // Quick 260822-tdj: escrita dupla best-effort dos campos estruturados do
  // retorno de ligação (rotas /anotacao e /super-fa) — inserirAnotacaoLigacao
  // grava em anotacoes_ligacao, marcarSuperFaEspelho seta
  // discador_leads_espelho.super_fa. Ambas LANÇAM em erro; o caller nas
  // rotas abaixo faz try/catch e loga-e-segue (nunca quebra o fluxo ClickUp).
  inserirAnotacaoLigacao,
  marcarSuperFaEspelho,
  // Fase C (Phase 20, 20-04/20-05): LEITURAS de áudios/conversa atrás de
  // FONTE_AUDIOS — mesmo contrato JSON das funções ClickUp que substituem
  // (buscarLeadsNuncaLigados/mapaConversaPorLead/listarEnviosAudioDoLead),
  // sem cruzar as 3 listas do ClickUp (LEITURA-04).
  buscarLeadsNuncaLigadosSupabase,
  mapaConversaPorLeadSupabase,
  listarEnviosAudioDoLeadSupabase,
  // Fase C (Phase 20, 20-04/20-07): comentários (`notas`, aggregate='lead')
  // do detalhe do lead atrás de FONTE_NOTAS + leitura genérica de tabela
  // (listarTabela) reusada pra resolver o lead_id numérico best-effort na
  // escrita (registrar_anotacao não tem trigger de auto-resolução).
  listarNotasDoLeadSupabase,
  type NotaLeadSupabase,
  listarTabela,
  // Quick 260823-h1s: criação de lead nativo (Fase C, Caminho B) — thin
  // wrapper sobre comOutboxRpc(SUPABASE_RPC_CRIAR_LEAD); INSERT no espelho +
  // outbox 'lead'/'criar_task' na mesma tx (sql/escala/27_rpc_criar_lead.sql).
  criarLeadSupabase,
} from './supabase';
import {
  cadastrosComCache,
  votosComCache,
  ligacoesComCache,
  campanhaComCache,
  CHAVE_CAMPANHA,
  idadeCacheSegundos,
  CHAVE_CADASTROS,
  CHAVE_VOTOS,
  CHAVE_LIGACOES,
  // Fase B (Phase 19, 19-09): agregados SQL do Supabase (LEITURA-02) — MESMO
  // shape de campanhaComCache/ligacoesComCache, porém de UM agregado sobre
  // `ligacoes` (sem paginar a Lista 02). Servem /campanha e /painel-numeros
  // sob FONTE_LIGACOES='supabase'.
  resumoCampanhaSupabase,
  resumoLigacoesSupabase,
} from './painel-dados.ts';
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
  // A5 (Pacote A / incidente 2026-08-22): teto o refresh do inventário no
  // caminho crítico de discagem (aquecerInventarioWavoip) + refresh
  // periódico de background que desacopla o invCache de bater na API só
  // quando /config passa por ele.
  aquecerInventarioWavoip,
  iniciarRefreshInventarioWavoip,
} from './wavoip-api.ts';
// Alerta de degradação de device (A2, Pacote A / incidente 2026-08-22):
// dispara fire-and-forget quando /config resolve modo 'global'/'indisponivel'.
import { alertarDeviceDegradado } from './alertas.ts';

// Máscara de telefone (D-09/OBS-03, fonte única) — usada na mensagem de
// alerta de queda de device do atendente (Quick 260819-p1r), nunca o número
// em claro. decidirAlertaQuedaDevice/EstadoDeviceAlerta: função PURA de
// edge-trigger (queda->grupo, alerta-queda-device.ts) reusada no branch
// DEVICE do webhook Wavoip abaixo.
import { mascararTelefone } from './mascarar.ts';
import { decidirAlertaQuedaDevice, type EstadoDeviceAlerta } from './alerta-queda-device.ts';

/**
 * WR-01: classifica uma falha de envio de áudio pro cliente SEM colapsar todo
 * erro em "desconectado". `enviarAudio`/pré-check lançam em três casos
 * distintos: (a) throttle do rate limiter segurando o ritmo (D-06 funcionando
 * — NÃO é sessão fora), (b) falha transiente de rede/HTTP 5xx (retry neutro)
 * e (c) sessão genuinamente fechada. Só afirma `desconectado: true` — que a UI
 * traduz pro aviso "reconecte o WhatsApp" — quando o status REAL confirma a
 * sessão fechada; caso contrário devolve um erro neutro que cai no retry
 * ("O envio falhou, toque para tentar de novo"). O probe de status é isento
 * do throttle (WR-02), então não gasta budget de envio. Fail-closed preservado:
 * na dúvida (probe também falha) NUNCA afirma "desconectado" — mas também
 * nunca reporta sucesso; sempre um não-2xx.
 */
async function classificarFalhaEnvioAudio(e: unknown): Promise<{ erro: string; desconectado?: true }> {
  // IN-03: classifica o throttle pelo TIPO do erro (marca estável vinda do
  // evolution.ts), não pela substring da mensagem. Mantém o casamento por texto
  // só como fallback defensivo — se o throttle chegar re-embrulhado por algum
  // caminho, ainda cai no ramo neutro correto (retry), nunca em "desconectado".
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof EvolutionThrottleError || msg.includes('throttle')) return { erro: 'throttle' };
  try {
    const { conectado } = await statusInstancia();
    if (!conectado) return { erro: 'envio_falhou', desconectado: true };
  } catch {
    // Probe de status também falhou — ambíguo. Nunca afirma "desconectado"
    // sem confirmação; devolve erro neutro (retry).
  }
  return { erro: 'envio_falhou' };
}

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

// Boot (Fase A espelho, 17-03/MODELO-06): valida as constantes CAMPOS_*/
// OPCOES_* (clickup.ts) contra `get_custom_fields` do ClickUp — uma única
// autoridade (R8). ClickUp inalcançável já degrada (warn+skip) DENTRO de
// carregarEValidarCampoMapa — só chega aqui uma DivergenciaCampoMapa
// GENUÍNA (campo/opção reamente divergente), que FALHA ALTO o processo
// (MODELO-06: nunca segue silencioso, o caminho reverso futuro derrubaria
// valor). Qualquer outro erro inesperado é só-log, não derruba o boot.
void carregarEValidarCampoMapa().catch((e) => {
  if (e instanceof DivergenciaCampoMapa) {
    console.error('[boot] DIVERGÊNCIA no mapa de field-ids ClickUp — falha alto (MODELO-06):', e.message);
    process.exit(1);
  }
  console.error(
    '[boot] erro inesperado ao carregar/validar o mapa de field-ids (nao-fatal):',
    e instanceof Error ? e.message : String(e),
  );
});

// Boot (Fase A espelho, 17-03/PORTAO-03): healthcheck SELECT+escrita das
// tabelas novas do espelho (ligacoes/audios_envios/clickup_outbox/
// clickup_campo_mapa/notas) — NUNCA derruba o boot (degradação graciosa);
// só registra o resultado. Enquanto uma tabela não estiver visível+
// escrevível, o fallback 404->ClickUp já existente no código segue intacto
// (nenhuma rota muda nesta fase).
void healthcheckEspelho().catch((e) => {
  console.error('[boot-espelho] healthcheck falhou (nao-fatal):', e instanceof Error ? e.message : String(e));
});

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
            // Fase B (19-09): sob FONTE_LIGACOES='supabase' a fila vem de um
            // SELECT filtrado em `ligacoes` (por `operador` = login, id LOCAL
            // como taskId — LEITURA-01), NUNCA da listagem geral da Lista 02
            // (que caiu no incidente que motivou a inversão). A resiliência
            // (buscarFilaResiliente) era do ClickUp; o Supabase é a própria
            // fonte, então não passa por ela. Caminho 'clickup' (fallback)
            // intacto.
            if (FONTE_LIGACOES === 'supabase') {
              const fila = await buscarFilaSupabase(sess.usuario);
              return c.json({ fila });
            }
            // resiliente: fresca por 20s; ClickUp fora → última cópia boa.
            const fila = await buscarFilaResiliente(assignee);
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
            // Fase B (19-09): sob FONTE_LIGACOES='supabase' o detalhe/script
            // vem de um SELECT direto em `ligacoes` por id LOCAL (LEITURA-03),
            // com os MESMOS 3 guards CR-01 de lerLigacao (não encontrada / não
            // pertence ao operador / já concluída) — as mensagens de erro de
            // lerLigacaoSupabase casam os catches abaixo (404/409), então o
            // tratamento de erro não muda. Caminho 'clickup' (fallback) intacto.
            if (FONTE_LIGACOES === 'supabase') {
              const ligacaoId = Number(taskId);
              if (!Number.isFinite(ligacaoId)) {
                return c.json({ erro: 'Ligação não encontrada' }, 404);
              }
              const ligacao = await lerLigacaoSupabase(ligacaoId, sess.usuario);
              return c.json({ ligacao });
            }
            const ligacao = await lerLigacao(taskId, assignee);
            return c.json({ ligacao });
          } catch (e) {
            console.error('[discador] erro ao ler ligacao:', e);
            // Task inexistente, fora da Lista 02 ou de outro operador ->
            // 404 identico (nao revela se a task existe, so que "nao e
            // sua"). Erro de infra/rede do ClickUp continua 502.
            const msg = e instanceof Error ? e.message : String(e);
            // Concluida e um caso distinto (a task E do operador): o cliente
            // mostra o aviso e NAO auto-disca (deep-link auto=1 velho).
            if (msg.includes('ja foi concluida')) {
              return c.json({ erro: 'Ligação já concluída', concluida: true }, 409);
            }
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
        // Fase B (19-07): sob FONTE_LIGACOES='supabase' grava via
        // comOutboxRpc(SUPABASE_RPC_INICIAR_LIGACAO) — taskId vira o id
        // LOCAL de `ligacoes` (p_ligacao_id); caminho 'clickup' (fallback)
        // é o código atual, intacto.
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
            if (FONTE_LIGACOES === 'supabase') {
              // taskId = id LOCAL de `ligacoes` (contrato 19-05/19-09).
              const ligacaoId = Number(taskId);
              if (!Number.isFinite(ligacaoId)) {
                return c.json({ erro: 'Ligação não encontrada' }, 404);
              }
              // Valida existência/ownership/"já concluída" ANTES da RPC —
              // lerLigacaoSupabase lança com as MESMAS 3 mensagens que o
              // catch abaixo já mapeia (404/409, mesmo guard de
              // iniciarLigacao/tarefaConcluida no caminho ClickUp) e devolve
              // o telefone (guardarTaskAtiva não vem da RPC — o retorno dela
              // é só {ligacao_id, outbox_inseridos}).
              const detalhe = await lerLigacaoSupabase(ligacaoId, sess.usuario);
              await comOutboxRpc(SUPABASE_RPC_INICIAR_LIGACAO, {
                p_ligacao_id: ligacaoId,
                p_operador: sess.usuario,
                p_assignee_clickup_id: Number(assignee) || undefined,
              });
              if (detalhe.telefone) await guardarTaskAtiva(detalhe.telefone, taskId, deviceId);
              marcarEmChamada(sess.usuario);
              // Read-your-writes no commit local + kick do dreno (checado,
              // fallback inline sem Redis) — T-19-07-Ti/Av.
              await posCommitLigacao(assignee, ligacaoId);
              return c.json({ status: 'ok' });
            }
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
            // erro de infra do ClickUp/RPC -> 502.
            const msg = e instanceof Error ? e.message : String(e);
            // Concluida: nao recarimba INICIO nem conta como tentativa.
            if (msg.includes('ja foi concluida')) {
              return c.json({ erro: 'Ligação já concluída', concluida: true }, 409);
            }
            const naoAutorizada =
              msg.includes('nao encontrada') ||
              msg.includes('nao e uma Ligacao da Lista 02') ||
              msg.includes('nao pertence ao operador') ||
              ehErroRpcNaoAutorizado(e);
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
          // u-v13: rastro estruturado best-effort em anotacoes_ligacao pro
          // fluxo WhatsApp (o fluxo tel já grava a própria linha via
          // /anotacao — quick tdj — daí o guard "[tel" abaixo). AUTOCONTIDO:
          // nunca lança, nunca muda o status HTTP; roda DEPOIS do sucesso do
          // caminho principal, nos dois ramos FONTE_LIGACOES (T-v13-01/02/03/04).
          const gravarAnotacaoDesfecho = async () => {
            try {
              if (String(body.observacao || '').includes('[tel')) return;
              let resultadoAnotacao: string;
              let observacaoAnotacao: string | null;
              if (resultado === 'recusou') {
                resultadoAnotacao = 'recusou';
                observacaoAnotacao = motivo?.observacao
                  ? `Recusada pelo lead — ${motivo.observacao}`
                  : 'Recusada pelo lead';
              } else if (resultado === 'nao_atendida') {
                if (motivo?.categoria) {
                  resultadoAnotacao = 'nao_atendida';
                  observacaoAnotacao = `${motivo.categoria}${motivo.observacao ? ' — ' + motivo.observacao : ''}`;
                } else {
                  // recarimbo sem motivo (retentativa, não-terminal) —
                  // distinguível do "não atendeu com motivo".
                  resultadoAnotacao = 'nao_atendida_retentativa';
                  observacaoAnotacao = null;
                }
              } else {
                resultadoAnotacao = 'atendida';
                observacaoAnotacao = motivo?.observacao ?? null;
              }
              await inserirAnotacaoLigacao({
                ligacao_task_id: taskId,
                lead_task_id: null,
                operador: sess.usuario,
                canal: 'whatsapp',
                resultado: resultadoAnotacao,
                observacao: observacaoAnotacao,
                classificacao: null,
                demanda: null,
                apos_whatsapp: null,
                super_fa: null,
              });
            } catch (eSupabase) {
              // LGPD: nunca logar taskId/telefone/observacao — só a mensagem
              // genérica (mesmo padrão do best-effort de /anotacao).
              console.error(
                '[discador] falha best-effort ao gravar anotacao de desfecho no Supabase:',
                eSupabase instanceof Error ? eSupabase.message : String(eSupabase),
              );
            }
          };
          try {
            if (FONTE_LIGACOES === 'supabase') {
              const ligacaoId = Number(taskId);
              if (!Number.isFinite(ligacaoId)) return c.json({ erro: 'Ligação não encontrada' }, 404);
              if (resultado === 'atendida') {
                // Fase B (débito documentado no SUMMARY 19-07): não fecha
                // (mesmo comportamento do caminho ClickUp — 'atendida' NÃO é
                // terminal aqui, quem tira da fila é o desfecho seguinte).
                // O caminho ClickUp move a task pra OPER_STATUS_EM_PROCESSAMENTO
                // (status nativo, não mapeado no enum de `ligacoes` ainda) —
                // sem RPC de status parcial nesta fase, a Ligação permanece
                // 'aberta' no Supabase até o desfecho terminal.
              } else if (resultado === 'nao_atendida' && !motivo?.categoria) {
                // Sem motivo (cliente legado): só recarimba a última
                // tentativa — reusa iniciar_ligacao (MESMO efeito de
                // setCustomField(INICIO) no caminho ClickUp), NÃO fecha, a
                // Ligação PERMANECE na fila (buscarFilaSupabase reordena por
                // `inicio`).
                await comOutboxRpc(SUPABASE_RPC_INICIAR_LIGACAO, {
                  p_ligacao_id: ligacaoId,
                  p_operador: sess.usuario,
                  p_assignee_clickup_id: Number(assignee) || undefined,
                });
              } else {
                // 'recusou' OU 'nao_atendida' com motivo — TERMINAL: fecha +
                // fecha duplicatas do lead + outbox, tudo na MESMA tx da RPC
                // (a RPC já reconcilia duplicatas — não chamar
                // fecharLigacoesDuplicadas aqui, T-19-07-Ti).
                const motivoFalha = resultado === 'recusou' ? 'Recusada pelo lead' : String(motivo?.categoria || '');
                await comOutboxRpc(SUPABASE_RPC_REGISTRAR_DESFECHO, {
                  p_ligacao_id: ligacaoId,
                  p_resultado: resultado,
                  p_atendeu: false,
                  p_motivo_falha: motivoFalha,
                  p_fim: new Date().toISOString(),
                  p_duracao_seg: motivo?.duracao ?? null,
                });
                // Débito documentado (SUMMARY 19-07): o comentário multi-linha
                // (categoria/observação/duração/quem ligou/linha) do caminho
                // ClickUp NÃO é enfileirado aqui — registrar_desfecho (Phase
                // 18) só grava a coluna motivo_falha, não insere outbox
                // 'comentar' (diferente de pular_ligacao, 19-02). A
                // informação persiste na coluna (telemetria); o comentário
                // legível no ClickUp fica pra um plano futuro se necessário.
              }
              registrarChamadaDevice(deviceIdDoUsuario(sess.usuario) || '', resultado === 'atendida' ? 'atendida' : 'nao');
              limparEmChamada(sess.usuario);
              // Read-your-writes no commit local + kick do dreno (checado,
              // fallback inline) — no-op seguro quando 'atendida' não gravou
              // nada no outbox (processarDrenoOutboxJob relê 0 linhas).
              await posCommitLigacao(assignee, ligacaoId);
              await gravarAnotacaoDesfecho();
              return c.json({ status: 'ok' });
            }
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
            derrubarFilaMem(assignee);
            await gravarAnotacaoDesfecho();
            return c.json({ status: 'ok' });
          } catch (e) {
            // LGPD: nunca logar telefone/CPF/taskId em claro — so a mensagem
            // generica de erro (mesmo padrao de /ligando).
            console.error('[discador] erro ao registrar desfecho:', e);
            const msg = e instanceof Error ? e.message : String(e);
            const naoAutorizada =
              msg.includes('nao encontrada') ||
              msg.includes('nao e uma Ligacao da Lista 02') ||
              msg.includes('nao pertence ao operador') ||
              ehErroRpcNaoAutorizado(e);
            return naoAutorizada
              ? c.json({ erro: 'Ligação não encontrada' }, 404)
              : c.json({ erro: 'Erro ao registrar desfecho' }, 502);
          }
        },
      },
      {
        // ANOTAÇÃO na Ligação (quick-260822-rr6, R6/D-06): rota ADITIVA e
        // ISOLADA — o caminho "atendeu" do retorno tel: usa isto pra persistir
        // classificação/demanda/observação num comentário (registrarDesfecho
        // ignora observação em 'atendida'; a anotação do LEAD é gestor-only).
        // NUNCA muda status/fecha/grava custom field; NÃO toca
        // registrarDesfecho nem a ramificação FONTE_LIGACOES. Débito
        // documentado (SUMMARY do quick): comentário ClickUp funciona
        // PRÉ-FLIP; PÓS-FLIP (supabase) não é relido.
        //
        // Quick-260822-tdj: aceita também os campos ESTRUTURADOS (além de
        // `texto`) e grava uma escrita DUPLA best-effort em
        // `anotacoes_ligacao` (Supabase) — nunca substitui o comentário
        // ClickUp, só soma dado queryável. `texto` deixa de ser obrigatório
        // quando há ao menos um campo estruturado (o caminho "não atendeu"
        // chama sem texto, só pra persistir os campos — o comentário dele já
        // sai pelo /desfecho).
        path: '/api/discador/ligacao/:taskId/anotacao',
        method: 'POST',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          const assignee = assigneeDoOperador(sess.usuario);
          if (!assignee) return c.json({ erro: 'Ligação não encontrada' }, 404);
          const taskId = c.req.param('taskId');
          const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
          const texto = String(body.texto || '').trim().slice(0, 500);
          const classificacao = typeof body.classificacao === 'string' ? body.classificacao.trim() || undefined : undefined;
          const demanda = typeof body.demanda === 'string' ? body.demanda.trim() || undefined : undefined;
          const observacao = typeof body.observacao === 'string' ? body.observacao.trim() || undefined : undefined;
          const canal = typeof body.canal === 'string' ? body.canal.trim() || undefined : undefined;
          const aposWhatsapp = typeof body.aposWhatsapp === 'boolean' ? body.aposWhatsapp : undefined;
          const resultado = typeof body.resultado === 'string' ? body.resultado.trim() || undefined : undefined;
          const superFa = typeof body.superFa === 'boolean' ? body.superFa : undefined;
          const temEstruturado =
            classificacao !== undefined ||
            demanda !== undefined ||
            observacao !== undefined ||
            canal !== undefined ||
            aposWhatsapp !== undefined ||
            resultado !== undefined ||
            superFa !== undefined;
          if (!texto && !temEstruturado) return c.json({ erro: 'texto obrigatório' }, 400);
          try {
            if (texto) {
              await anotarLigacao(taskId, assignee, texto);
            } else {
              // Sem texto: ainda assim exige o guard IDOR (assignee sempre da
              // sessão, nunca do body) ANTES de qualquer escrita no Supabase.
              await validarLigacaoDoOperador(taskId, assignee);
            }
            // Escrita Supabase best-effort — DEPOIS do fluxo ClickUp (que já
            // validou ownership acima). Falha aqui NUNCA quebra a resposta
            // 200: só loga (LGPD-safe) e segue.
            try {
              const leadTaskId = await resolverLeadDaLigacao(taskId).catch(() => null);
              await inserirAnotacaoLigacao({
                ligacao_task_id: taskId,
                lead_task_id: leadTaskId,
                operador: sess.usuario,
                classificacao: classificacao ?? null,
                demanda: demanda ?? null,
                observacao: observacao ?? null,
                canal: canal ?? null,
                apos_whatsapp: aposWhatsapp ?? null,
                super_fa: superFa ?? null,
                resultado: resultado ?? null,
              });
            } catch (eSupabase) {
              // LGPD: nunca logar taskId/telefone/texto — só a mensagem genérica.
              console.error(
                '[discador] falha best-effort ao gravar anotacao estruturada no Supabase:',
                eSupabase instanceof Error ? eSupabase.message : String(eSupabase),
              );
            }
            return c.json({ status: 'ok' });
          } catch (e) {
            // LGPD: nunca logar taskId/texto/telefone — só a mensagem genérica.
            console.error('[discador] erro ao anotar ligação:', e instanceof Error ? e.message : String(e));
            const msg = e instanceof Error ? e.message : String(e);
            const naoAutorizada =
              msg.includes('nao encontrada') ||
              msg.includes('nao e uma Ligacao da Lista 02') ||
              msg.includes('nao pertence ao operador');
            return naoAutorizada
              ? c.json({ erro: 'Ligação não encontrada' }, 404)
              : c.json({ erro: 'Erro ao registrar anotação' }, 502);
          }
        },
      },
      {
        // SUPER-FÃ (quick-260822-rr6, R9): tag PERMANENTE "super-fa" no LEAD
        // ligado a esta Ligação (Lista 01) — rota ADITIVA e ISOLADA, mesmo
        // padrão de /anotacao. NUNCA muda status/fecha/grava custom field na
        // Ligação; NÃO toca registrarDesfecho nem FONTE_LIGACOES. Sem lead
        // resolvido -> 200 com aviso (não falha o fluxo — o marcador
        // "[super-fa]" no comentário da Ligação segue via /anotacao,
        // reusado pelo cliente independente desta rota).
        path: '/api/discador/ligacao/:taskId/super-fa',
        method: 'POST',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          const assignee = assigneeDoOperador(sess.usuario);
          if (!assignee) return c.json({ erro: 'Ligação não encontrada' }, 404);
          const taskId = c.req.param('taskId');
          try {
            const r = await marcarLeadSuperFa(taskId, assignee);
            if (!r.temLead) {
              return c.json({ status: 'ok', temLead: false, aviso: 'Ligação sem lead vinculado — nada marcado.' });
            }
            // Espelho Supabase best-effort (quick-260822-tdj): a tag ClickUp
            // acima é autoritativa; falha aqui NUNCA quebra a resposta 200.
            if (r.leadTaskId) {
              try {
                await marcarSuperFaEspelho(r.leadTaskId);
              } catch (eSupabase) {
                // LGPD: nunca logar taskId/telefone — só a mensagem genérica.
                console.error(
                  '[discador] falha best-effort ao marcar super-fa no espelho Supabase:',
                  eSupabase instanceof Error ? eSupabase.message : String(eSupabase),
                );
              }
            }
            return c.json({ status: 'ok', temLead: true });
          } catch (e) {
            // LGPD: nunca logar taskId/telefone — só a mensagem genérica.
            console.error('[discador] erro ao marcar super-fã:', e instanceof Error ? e.message : String(e));
            const msg = e instanceof Error ? e.message : String(e);
            const naoAutorizada =
              msg.includes('nao encontrada') ||
              msg.includes('nao e uma Ligacao da Lista 02') ||
              msg.includes('nao pertence ao operador');
            return naoAutorizada
              ? c.json({ erro: 'Ligação não encontrada' }, 404)
              : c.json({ erro: 'Erro ao marcar super-fã' }, 502);
          }
        },
      },
      {
        // PULAR CONTATO (pedido 2026-08-19; aberto a TODOS os operadores
        // 2026-08-19 à noite — "vai ser usado para todos"): tira a Ligação da
        // fila explicando o MOTIVO, sem precisar discar. Mesmos primitivos do
        // desfecho (validar → metadados → comentário → fechar) com semântica
        // própria: MOTIVO_FALHA='Pulado' (contável em relatório) e comentário
        // "⏭️ Contato pulado" com a frase do operador. Gate: QUALQUER operador
        // logado — o anti-IDOR é o validarLigacaoDoOperador (CR-01, mesma
        // régua de /desfecho): cada um só pula a PRÓPRIA Ligação. Chamada pela
        // lista de áudios do Romero E pela fila clássica dos atendentes.
        path: '/api/discador/audios/pular',
        method: 'POST',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          registrarPresenca(sess.usuario);
          const assignee = assigneeDoOperador(sess.usuario);
          if (!assignee) return c.json({ erro: 'Ligação não encontrada' }, 404);
          const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
          const taskId = String(body.taskId || '');
          const motivo = String(body.motivo || '').trim().slice(0, 500);
          if (!taskId) return c.json({ erro: 'taskId obrigatório' }, 400);
          if (!motivo) return c.json({ erro: 'motivo obrigatório' }, 400);
          try {
            if (FONTE_LIGACOES === 'supabase') {
              const ligacaoId = Number(taskId);
              if (!Number.isFinite(ligacaoId)) return c.json({ erro: 'Ligação não encontrada' }, 404);
              // A RPC faz TUDO na mesma tx: fecha a principal (resultado
              // 'pulado') + fecha duplicatas do lead + outbox ('fechar'
              // bloqueante + 'comentar' não-bloqueante com o motivo,
              // sql/escala/15_rpc_pular_ligacao.sql) — não chamar
              // fecharLigacoesDuplicadas aqui (T-19-07-Ti).
              await comOutboxRpc(SUPABASE_RPC_PULAR_LIGACAO, {
                p_ligacao_id: ligacaoId,
                p_operador: sess.usuario,
                p_motivo: motivo,
              });
              // posCommitLigacao já faz a MESMA eviction (removerDaFilaCache/
              // invalidarFilaCache/derrubarFilaMem) + o kick do dreno
              // checado (fallback inline).
              await posCommitLigacao(assignee, ligacaoId);
              return c.json({ status: 'ok' });
            }
            const taskPulada = await validarLigacaoDoOperador(taskId, assignee);
            await gravarMetadadosLigacao(taskId, { atendeu: false, motivoFalha: 'Pulado' });
            // LGPD: só a frase do operador + login — nunca telefone/CPF.
            try {
              await comentarTask(taskId, `⏭️ Contato pulado\n📝 ${motivo}\n👤 ${sess.usuario}`);
            } catch (e) {
              console.warn('[discador] pular: comentário falhou (segue fechando):', e instanceof Error ? e.message : String(e));
            }
            await fecharLigacao(taskId);
            // reconciliação (2026-08-20): pulou = decisão terminal sobre a
            // PESSOA — outras Ligações abertas dela saem da fila também.
            {
              const { leadId, telefone } = identidadeDaLigacao(taskPulada);
              void fecharLigacoesDuplicadas(taskId, leadId, telefone);
            }
            // mesma eviction do desfecho (D-04/D-03): a linha some da fila no
            // próximo fetch, sem esperar TTL. No-op sem Redis, nunca lança.
            await removerDaFilaCache(assignee, taskId);
            await invalidarFilaCache(assignee);
            derrubarFilaMem(assignee);
            return c.json({ status: 'ok' });
          } catch (e) {
            console.error('[discador] erro ao pular contato:', e instanceof Error ? e.message : String(e));
            const msg = e instanceof Error ? e.message : String(e);
            const naoAutorizada =
              msg.includes('nao encontrada') ||
              msg.includes('nao e uma Ligacao da Lista 02') ||
              msg.includes('nao pertence ao operador') ||
              ehErroRpcNaoAutorizado(e);
            return naoAutorizada
              ? c.json({ erro: 'Ligação não encontrada' }, 404)
              : c.json({ erro: 'Erro ao pular o contato' }, 502);
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
          // env/pool/global como sempre. A5 (Pacote A / incidente 2026-08-22):
          // aquecerInventarioWavoip tem teto ~2.5s — se a API Wavoip travar, a
          // corrida perdedora segue em background (nunca bloqueia esta rota).
          await aquecerInventarioWavoip();
          const cfg = resolverConfigDoUsuario(sess.usuario);
          // A2 (Pacote A / incidente 2026-08-22): alerta o gestor quando o
          // operador cai em modo degradado (chip orfao global ou device
          // dedicado sem token resolvivel) — fire-and-forget, nunca bloqueia
          // a resposta; cooldown/no-PII dentro de alertarDeviceDegradado.
          if (cfg.modo === 'global' || cfg.modo === 'indisponivel') {
            void alertarDeviceDegradado(sess.usuario, cfg.modo, cfg.deviceId);
          }
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
          // A5: teto ~2.5s (aquecerInventarioWavoip) — nunca trava o lease.
          await aquecerInventarioWavoip();
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
            // Fase B/C: sob FONTE_LIGACOES='supabase' o `taskId` é o id LOCAL
            // numérico da Ligação e o dossiê vem da coluna `dossie` do espelho
            // (não da descrição da task ClickUp, que pode nem existir para leads
            // criados direto no banco). Mesmo shape {temLead,contexto}.
            if (FONTE_LIGACOES === 'supabase') {
              const contexto = await lerContextoLeadSupabase(Number(taskId), sess.usuario);
              return c.json(contexto);
            }
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
        // Central de Campanha — producao diaria, ranking de telefonistas e taxa de
        // atendimento, agregados da Lista 02 LIGACOES (painel-dados.ts).
        //
        // A tela existia desde 15/08 mostrando "sem dados" por decisao: o commit 93c0a31
        // trocou a leitura de um reais.json estatico por `const real = VAZIO`, com a nota
        // "sem telemetria ao vivo". Esta rota e a telemetria que faltava.
        //
        // Gate de gestor (mesma visao das outras rotas do painel). Somente leitura.
        path: '/api/discador/campanha',
        method: 'GET',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          if (papelDoOperador(sess.usuario) !== 'gestor') return c.json({ erro: 'Acesso restrito a gestor' }, 403);
          try {
            // Dois caches distintos: a Lista 02 (produção/ranking/motivos) e os votos do
            // ClickUp (intenção/cidade). Em paralelo, e cada um degrada sozinho — voto
            // fora do ar não derruba os cards de ligação, que são a maior parte da tela.
            // Fase B (19-09): sob FONTE_LIGACOES='supabase' a fonte de campanha
            // (produção/ranking/motivos) vira o agregado SQL resumoCampanhaSupabase
            // (MESMO shape, sem paginar a Lista 02 — LEITURA-02); os votos de
            // intenção/cidade seguem por votosComCache (inalterado). Caminho
            // 'clickup' (campanhaComCache) intacto. O degradar-sozinho é preservado.
            const [rCamp, rVotos] = await Promise.allSettled([
              FONTE_LIGACOES === 'supabase' ? resumoCampanhaSupabase() : campanhaComCache(),
              votosComCache(),
            ]);
            if (rVotos.status === 'rejected') {
              console.error('[painel] votos indisponiveis na campanha:', rVotos.reason instanceof Error ? rVotos.reason.message : String(rVotos.reason));
            }
            if (rCamp.status === 'rejected') throw rCamp.reason;
            const r = rCamp.value;
            const v = rVotos.status === 'fulfilled' ? rVotos.value : null;
            return c.json({
              ...r,
              // Ausentes quando a leitura de voto falha: a UI cai em "sem dados" nesses
              // dois cards em vez de desenhar zero, que aqui seria afirmação falsa.
              intencao: v?.intencao ?? [],
              votosPorCidade: v?.votosPorCidade ?? [],
              idadeS: idadeCacheSegundos(CHAVE_CAMPANHA),
            });
          } catch (e) {
            console.error('[painel] campanha indisponivel:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao carregar os numeros da campanha' }, 502);
          }
        },
      },
      {
        // Números do DASHBOARD do gestor — lidos AO VIVO da fonte correta (painel-dados.ts).
        //
        // Antes (diagnóstico de 18/08/2026) os três números vinham da fonte errada:
        //   cadastros -> task_count da Lista 01 (100.007), ignorando as 224.542 pessoas
        //                de users_romero; 124.535 pessoas nunca apareciam no painel.
        //   votos     -> espelho `discador_leads_espelho`, um snapshot único de 17/08 15:30
        //                (todas as linhas com o mesmo `atualizado_em`). Voto novo não aparecia.
        //   ligações  -> NÃO EXISTIAM. Nenhuma rota do painel lia a Lista 02, embora ela
        //                tivesse 167 ligações (145 em 24h, 62 atendidas, 25 analisadas).
        //
        // Agora: cadastros do Postgres, votos e ligações do ClickUp ao vivo. Cada bloco
        // degrada sozinho (`Promise.allSettled`) — uma fonte fora do ar não derruba o
        // painel inteiro, e a UI mostra "—" só no número afetado. Nada aqui escreve.
        path: '/api/discador/painel-numeros',
        method: 'GET',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          if (papelDoOperador(sess.usuario) !== 'gestor') return c.json({ erro: 'Acesso restrito a gestor' }, 403);

          // Fase B (19-09): sob FONTE_LIGACOES='supabase' o bloco `ligacoes`
          // vira o agregado SQL resumoLigacoesSupabase (MESMO shape, sem
          // paginar a Lista 02 — LEITURA-02). Cadastros (Postgres) e votos
          // (ClickUp/espelho) seguem inalterados. Caminho 'clickup'
          // (ligacoesComCache) intacto; cada bloco degrada sozinho.
          const [rCad, rVotos, rLig] = await Promise.allSettled([
            cadastrosComCache(),
            votosComCache(),
            FONTE_LIGACOES === 'supabase' ? resumoLigacoesSupabase() : ligacoesComCache(),
          ]);
          if (rCad.status === 'rejected') console.error('[painel] cadastros indisponivel:', rCad.reason instanceof Error ? rCad.reason.message : String(rCad.reason));
          if (rVotos.status === 'rejected') console.error('[painel] votos indisponivel:', rVotos.reason instanceof Error ? rVotos.reason.message : String(rVotos.reason));
          if (rLig.status === 'rejected') console.error('[painel] ligacoes indisponivel:', rLig.reason instanceof Error ? rLig.reason.message : String(rLig.reason));

          const cadastros = rCad.status === 'fulfilled' ? rCad.value : null;
          const votos = rVotos.status === 'fulfilled' ? rVotos.value : null;
          const lig = rLig.status === 'fulfilled' ? rLig.value : null;

          return c.json({
            // cadastros agora é a BASE (Postgres), não a Lista 01 do ClickUp
            cadastros,
            cadastrosFonte: 'banco',
            cadastrosIdadeS: idadeCacheSegundos(CHAVE_CADASTROS),

            // `votosPopulados` mantido para compatibilidade com a UI atual: agora significa
            // "consegui ler os votos do ClickUp", não "o espelho foi backfillado".
            votosPopulados: votos !== null,
            votosRomero: votos?.romero ?? 0,
            votosAndressa: votos?.andressa ?? 0,
            apoiadores: votos?.apoiadores ?? 0,
            votosParcial: votos?.parcial ?? false,
            votosIdadeS: idadeCacheSegundos(CHAVE_VOTOS),

            // bloco novo — o registro das ligações que o painel nunca mostrou
            ligacoes: lig
              ? {
                  total: lig.total,
                  hoje: lig.hoje,
                  atendidasHoje: lig.atendidasHoje,
                  naoAtendidasHoje: lig.naoAtendidasHoje,
                  // Sem este campo o Início dividia as atendidas pelo TOTAL do dia, e a
                  // Central pelas que TÊM desfecho — duas "taxas de atendimento" com o
                  // mesmo nome e resultados a 23x de distância (medido em 19/08: 1% contra
                  // 23%). Publicar o denominador honesto aqui é o que deixa as duas telas
                  // fazerem a MESMA conta.
                  semDesfechoHoje: lig.semDesfechoHoje,
                  atendidasTotal: lig.atendidasTotal,
                  comGravacao: lig.comGravacao,
                  comTranscricao: lig.comTranscricao,
                  comAnaliseIa: lig.comAnaliseIa,
                  ultimaEm: lig.ultimaEm,
                  parcial: lig.parcial,
                }
              : null,
            ligacoesIdadeS: idadeCacheSegundos(CHAVE_LIGACOES),
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
            // Fase B (19-09): sob FONTE_LIGACOES='supabase' a rota deixa de
            // depender da listagem frágil da Lista 02 LIGACOES (buscarLigacoesDoLead,
            // que caiu no incidente que motivou a inversão). A Lista 01 LEADS
            // segue ClickUp-autoritativa nesta fase (a escrita de leads é Phase
            // 20), então ficha + dossiê vêm do reader resiliente na variante
            // LEVE (GET /task único da Lista 01 + descrição/dossiê — NUNCA a
            // listagem da Lista 02). A TIMELINE de `ligacoes` é a parte que
            // inverte pro Supabase (LEITURA-03).
            // NOTA (débito p/ 19-10/Phase 20): sem `ligacoes.lead_id` numérico
            // materializado (idem /timeline), a timeline do detalhe degrada
            // para vazia sob supabase — a ficha/dossiê seguem completos e o
            // contrato { lead, dossie, timeline } é preservado. Caminho
            // 'clickup' (lerLeadDetalheResiliente/lerLeadDossieResiliente) intacto.
            // Fase C (20-07): sob FONTE_NOTAS='supabase' os comentários do
            // lead (`notas`, aggregate='lead') são servidos ADITIVAMENTE
            // aqui — o caminho ClickUp NUNCA teve uma leitura de comentários
            // (lerLeadDetalhe só lê a description como dossiê; comentarTask é
            // write-only), então o campo `notas` só existe sob supabase
            // (contrato preservado: nunca remove/troca um campo existente).
            // Em paralelo com o detalhe (Promise.allSettled, mesmo padrão de
            // /campanha e /painel-numeros) — a leitura de notas degrada
            // sozinha (T-20-07-Deg): erro vira comentários vazios, NUNCA
            // derruba o detalhe. LGPD: corpo da nota nunca logado.
            const [rDetalhe, rNotas] = await Promise.allSettled([
              FONTE_LIGACOES === 'supabase' || c.req.query('leve') === '1'
                ? lerLeadDossieResiliente(leadTaskId)
                : lerLeadDetalheResiliente(leadTaskId),
              FONTE_NOTAS === 'supabase' ? listarNotasDoLeadSupabase(leadTaskId) : Promise.resolve(null),
            ]);
            if (rDetalhe.status === 'rejected') throw rDetalhe.reason;
            const detalhe = rDetalhe.value;
            if (rNotas.status === 'rejected') {
              console.warn(
                '[discador] leitura das notas do lead falhou — comentários vazios (detalhe segue servido):',
                rNotas.reason instanceof Error ? rNotas.reason.message : String(rNotas.reason),
              );
            }
            const notas: NotaLeadSupabase[] | null = rNotas.status === 'fulfilled' ? rNotas.value : [];
            // conhecimento pra ordenação da fila + geração sob demanda:
            // abriu ficha sem dossiê → gera em background (single-flight).
            const temDossie = (detalhe.dossie ?? '').trim() !== '';
            temDossiePorLead.set(leadTaskId, temDossie);
            if (!temDossie) gerarDossieSobDemanda(leadTaskId);
            return c.json(FONTE_NOTAS === 'supabase' ? { ...detalhe, notas: notas ?? [] } : detalhe);
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
            if (FONTE_LIGACOES === 'supabase') {
              // REGRA DETERMINÍSTICA TRAVADA (R12, nunca condicional a "se
              // houver ligação"): esta rota é sobre o LEAD, sem ligação em
              // curso — SEMPRE p_ligacao_id=null + p_lead_clickup_task_id. A
              // RPC resolve o lead em discador_leads_espelho, grava a SoT
              // (leads.confirmou_*) + o ledger (votos_ligacao com
              // ligacao_task_id='lead:'||lead_id, referência determinística)
              // + o outbox set_campo, tudo na MESMA tx. /voto (acima) e esta
              // rota consomem a MESMA RPC — sem ramo condicional.
              await comOutboxRpc(SUPABASE_RPC_REGISTRAR_VOTO, {
                p_operador: sess.usuario,
                p_ligacao_id: null,
                p_lead_clickup_task_id: leadTaskId,
                p_romero: romero ?? null,
                p_andressa: andressa ?? null,
              });
              // Read-your-writes (T-v2a-02): a próxima leitura do detalhe vem fresca.
              derrubarLeadDetalheMem(leadTaskId);
              return c.json({ status: 'ok' });
            }
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
            // Read-your-writes (T-v2a-02): a próxima leitura do detalhe vem fresca.
            derrubarLeadDetalheMem(leadTaskId);
            return c.json({ status: 'ok' });
          } catch (e) {
            console.error('[discador] erro ao gravar voto do lead:', e instanceof Error ? e.message : String(e));
            const msg = e instanceof Error ? e.message : String(e);
            const naoEncontrado =
              msg.includes('nao encontrada') || msg.includes('nao e um Lead da Lista 01') || ehErroRpcNaoAutorizado(e);
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
            // Guard anti-IDOR de escrita ANTES de comentar (comOutboxRpc/
            // comentarTask escrevem por taskId cru, sem validar a lista).
            await validarLeadDaLista01(leadTaskId);
            if (FONTE_NOTAS === 'supabase') {
              // Fase C (20-07): registrar_anotacao grava `notas`
              // (aggregate='lead') + enfileira 'comentar' (não-bloqueante) no
              // outbox NA MESMA tx — nunca mais um comentarTask síncrono
              // direto. p_lead_id é resolvido BEST-EFFORT via o espelho
              // (id numérico materializado no 20-01/22_fundacao_fase_c.sql):
              // `notas` NÃO tem trigger de auto-resolução (diferente de
              // ligacoes/audios_envios, que têm lead_clickup_task_id) — sem
              // resolver aqui, a leitura (listarNotasDoLeadSupabase, filtro
              // aggregate_id=eq.<leadId>) NUNCA encontraria a nota. Falha na
              // resolução (rede/config) não aborta a escrita — grava com
              // aggregate_id=null (débito: nota fica órfã de leitura, caso raro).
              let leadId: number | null = null;
              try {
                const rows = await listarTabela(SUPABASE_TABLE_LEADS_ESPELHO, {
                  select: 'id',
                  filtros: { clickup_task_id: `eq.${leadTaskId}` },
                  limit: 1,
                });
                const idRaw = (rows[0] as { id?: number } | undefined)?.id;
                leadId = idRaw !== undefined && idRaw !== null ? Number(idRaw) : null;
              } catch (e) {
                console.warn(
                  '[discador] resolução do lead_id p/ registrar_anotacao falhou — grava com aggregate_id=null:',
                  e instanceof Error ? e.message : String(e),
                );
              }
              const r = await comOutboxRpc<{ nota_id: number; outbox_inseridos: number }>(
                SUPABASE_RPC_REGISTRAR_ANOTACAO,
                {
                  p_aggregate: 'lead',
                  p_lead_id: leadId,
                  p_clickup_task_id: leadTaskId,
                  p_autor: sess.usuario,
                  p_corpo: texto,
                },
              );
              await posCommitAnotacao(r.nota_id);
            } else {
              await comentarTask(leadTaskId, texto);
            }
            // Read-your-writes (T-v2a-02): a próxima leitura do detalhe vem fresca.
            derrubarLeadDetalheMem(leadTaskId);
            return c.json({ status: 'ok' });
          } catch (e) {
            console.error('[discador] erro ao anotar no lead:', e instanceof Error ? e.message : String(e));
            const msg = e instanceof Error ? e.message : String(e);
            const naoEncontrado =
              msg.includes('nao encontrada') || msg.includes('nao e um Lead da Lista 01') || ehErroRpcNaoAutorizado(e);
            return naoEncontrado
              ? c.json({ erro: 'Lead não encontrado' }, 404)
              : c.json({ erro: 'Erro ao salvar a anotação' }, 502);
          }
        },
      },
      {
        // Rota — criação de LEAD NATIVO (quick 260823-h1s, Fase C): sob
        // FONTE_LEADS='supabase', cria o lead direto no Supabase (criar_lead
        // RPC, Caminho B) + enfileira a criação da task na Lista 01 no
        // outbox (débito pré-flip do dreno documentado em
        // sql/escala/27_rpc_criar_lead.sql). Sob FONTE_LEADS='clickup'
        // (default), não há caminho equivalente no ClickUp — 501.
        path: '/api/discador/lead',
        method: 'POST',
        handler: async (c) => {
          const sess = verificarToken(tokenDoHeader(c.req.header('Authorization')));
          if (!sess) return c.json({ status: 'unauthorized' }, 401);
          if (papelDoOperador(sess.usuario) !== 'gestor') return c.json({ erro: 'Acesso restrito a gestor' }, 403);
          const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
          const nome = String(body.nome || '').trim();
          const telefone = String(body.telefone || '').trim();
          if (!nome || !telefone) return c.json({ erro: 'nome e telefone obrigatórios' }, 400);

          if (FONTE_LEADS === 'supabase') {
            const canonico = canonizarTelefone(telefone);
            if (!canonico) return c.json({ erro: 'telefone inválido' }, 422);
            try {
              // Campos opcionais lidos defensivamente — NUNCA confia no shape do body.
              const cpf = body.cpf !== undefined && body.cpf !== null ? String(body.cpf) : undefined;
              const bairro = body.bairro !== undefined && body.bairro !== null ? String(body.bairro) : undefined;
              const cidade = body.cidade !== undefined && body.cidade !== null ? String(body.cidade) : undefined;
              const dossie = body.dossie !== undefined && body.dossie !== null ? String(body.dossie) : undefined;
              const origem = body.origem !== undefined && body.origem !== null ? String(body.origem) : undefined;
              const idSupabase =
                body.idSupabase !== undefined && body.idSupabase !== null ? String(body.idSupabase) : undefined;
              const tags = Array.isArray(body.tags) ? body.tags.map((t) => String(t)) : undefined;
              const militante = typeof body.militante === 'boolean' ? body.militante : undefined;
              const superFa = typeof body.superFa === 'boolean' ? body.superFa : undefined;
              const elegivel = typeof body.elegivel === 'boolean' ? body.elegivel : undefined;
              const score = typeof body.score === 'number' ? body.score : undefined;

              const r = await criarLeadSupabase({
                nome,
                telefone,
                cpf,
                bairro,
                cidade,
                dossie,
                tags,
                militante,
                superFa,
                elegivel,
                score,
                idSupabase,
                origem,
              });
              await posCommitCriarLead(r.lead_id);
              return c.json({ status: 'ok', lead_id: r.lead_id, id_supabase: r.id_supabase });
            } catch (e) {
              // Log genérico, NUNCA PII (LGPD) — nunca cita nome/telefone/cpf.
              console.error('[discador] erro ao criar o lead:', e instanceof Error ? e.message : String(e));
              return c.json({ erro: 'Erro ao criar o lead' }, 502);
            }
          } else {
            // FONTE_LEADS === 'clickup' (default) — não há caminho equivalente
            // de criação nativa de lead no ClickUp neste código.
            return c.json({ erro: 'Criação nativa de lead disponível apenas sob FONTE_LEADS=supabase' }, 501);
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
            // Continua ClickUp-autoritativo nesta fase (o lead vive na Lista
            // 01 — a inversão da Lista 01 é fora de escopo, Phase 20).
            const task = await validarLeadDaLista01(leadTaskId);
            const telefone = valorCampoLead(task, CAMPOS_LEADS.TELEFONE);
            if (!telefone) return c.json({ erro: 'Lead sem telefone' }, 422);
            if (FONTE_LIGACOES === 'supabase') {
              const canonico = canonizarTelefone(telefone);
              if (!canonico) return c.json({ erro: 'Lead com telefone inválido' }, 422);
              const variantes = variantesTelefone(telefone);
              // DEDUP AUTORITATIVO por rowcount (MODELO-02/R3, 19-02): a RPC
              // decide criada-vs-existia pelo UNIQUE parcial
              // (telefone_canonico, status='aberta') — nunca por guarda em
              // memória de processo.
              const r = await comOutboxRpc<{ ligacao_id: number; criada: boolean; outbox_inseridos: number }>(
                SUPABASE_RPC_CRIAR_LIGACAO_AVULSA,
                {
                  p_telefone_canonico: canonico,
                  p_telefone_variantes: variantes,
                  p_operador: sess.usuario,
                  p_assignee_clickup_id: Number(assignee) || undefined,
                  p_lead_id: null,
                  p_lead_clickup_task_id: leadTaskId,
                },
              );
              // Só kicka o dreno quando CRIOU (rowcount=1) — evita
              // re-enfileirar 'criar_task' (duplicaria a task no ClickUp)
              // quando a ligação já existia (T-19-07-Ti). Mesmo padrão
              // checado enfileirado→inline de posCommitLigacao.
              if (r.criada) {
                const { enfileirado } = await enfileirarDrenoOutbox({ aggregateId: r.ligacao_id });
                if (!enfileirado) {
                  await processarDrenoOutboxJob(r.ligacao_id).catch((e) => {
                    console.error(
                      '[dreno] inline avulsa pós-commit falhou (best-effort — linha já persistida):',
                      e instanceof Error ? e.message : String(e),
                    );
                  });
                }
              }
              return c.json({ taskId: String(r.ligacao_id) });
            }
            const { id } = await criarLigacaoAvulsa(telefone, assignee);
            return c.json({ taskId: id });
          } catch (e) {
            // LGPD: nunca logar telefone/CPF — só a mensagem genérica de erro.
            console.error('[discador] erro ao criar ligação para o lead:', e instanceof Error ? e.message : String(e));
            const msg = e instanceof Error ? e.message : String(e);
            const naoEncontrado =
              msg.includes('nao encontrada') || msg.includes('nao e um Lead da Lista 01') || ehErroRpcNaoAutorizado(e);
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
            // Fase B (19-09): sob FONTE_LIGACOES='supabase' a timeline vem de
            // `ligacoes` (LEITURA-03) — resolve o lead da Ligação por id LOCAL
            // (resolverLeadDaLigacaoSupabase) e lê o histórico com o guard por
            // operador (buscarLigacoesDoLeadSupabase valida que alguma Ligação
            // do lead pertence ao operador — IDOR-safe), montando o MESMO shape
            // que lerTimelineDaLigacao. NUNCA toca GET /list/{02}/task.
            // NOTA (débito p/ 19-10/Phase 20): `ligacoes.lead_id` (FK numérica)
            // ainda não é materializado nesta fase (ver LigacaoEspelhoRow em
            // supabase.ts) — enquanto for null, buscarLigacoesDoLeadSupabase
            // (que filtra por lead_id) devolve timeline vazia; a rota degrada
            // (contrato preservado), não quebra. Caminho 'clickup' intacto.
            if (FONTE_LIGACOES === 'supabase') {
              const ligacaoId = Number(taskId);
              if (!Number.isFinite(ligacaoId)) return c.json({ erro: 'Ligação não encontrada' }, 404);
              const ref = await resolverLeadDaLigacaoSupabase(ligacaoId);
              const timeline =
                ref && ref.leadId !== null
                  ? await buscarLigacoesDoLeadSupabase(ref.leadId, sess.usuario)
                  : [];
              return c.json({ timeline });
            }
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
            if (FONTE_LIGACOES === 'supabase') {
              // taskId = id LOCAL de `ligacoes` (contrato 19-05/19-09), a
              // MESMA convenção de /ligando e /desfecho acima. Caminho
              // LIGAÇÃO — p_ligacao_id não-nulo: registrar_voto resolve
              // lead/operador pela linha (guard anti-IDOR embutido: RAISE se
              // a ligação pertence a outro operador) e grava a SoT
              // (leads.confirmou_*) + o ledger (votos_ligacao, ledger key =
              // a própria ligação) + o outbox set_campo, tudo na MESMA tx.
              const ligacaoId = Number(taskId);
              if (!Number.isFinite(ligacaoId)) return c.json({ erro: 'Ligação não encontrada' }, 404);
              await comOutboxRpc(SUPABASE_RPC_REGISTRAR_VOTO, {
                p_ligacao_id: ligacaoId,
                p_operador: sess.usuario,
                p_romero: voto.romero ?? null,
                p_andressa: voto.andressa ?? null,
              });
              // Read-your-writes no commit local (SC2 — o painel deriva do
              // commit, não do drain) + kick do dreno checado (fallback
              // inline sem Redis) — mesmo helper de /ligando/desfecho/pular.
              await posCommitLigacao(assignee, ligacaoId);
              return c.json({ status: 'ok' });
            }
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
            // `operador` viaja junto pro job poder ATRIBUIR a declaração a quem a colheu
            // (votos_ligacao). Esta rota sempre soube quem marcou — usava `sess.usuario` só
            // para autorizar e descartava, e era por isso que o ranking publicava 0 votos.
            const dados = { taskId, assigneeId: assignee, voto, operador: sess.usuario };
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
              msg.includes('nao pertence ao operador') ||
              ehErroRpcNaoAutorizado(e);
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
            // Fase C (20-05): sob FONTE_AUDIOS='supabase' a lista vem do
            // anti-join lead_id (LEITURA-04) em vez da varredura cruzada de 3
            // listas do ClickUp. MESMO shape { leads, origens } — origens
            // sempre [] sob supabase (débito de schema, 20-04). Caminho
            // 'clickup' (default) intacto.
            const { leads, origens } =
              FONTE_AUDIOS === 'supabase' ? await buscarLeadsNuncaLigadosSupabase() : await buscarLeadsNuncaLigadosCacheado();
            // Selo por lead (Fase 13 fatia 2): agrega a Lista 03 (cache 60s);
            // falha do mapa NÃO derruba a lista (selo sai neutro). Sob
            // supabase: mesma leitura de audios_envios (20-04), mesmo
            // fail-open (selo neutro) — mapaConversaPorLeadSupabase LANÇA em
            // erro de infra (WR-03), o handler decide degradar aqui.
            const mapa =
              FONTE_AUDIOS === 'supabase'
                ? await mapaConversaPorLeadSupabase().catch((e) => {
                    console.warn(
                      '[discador] mapa de conversa (supabase) falhou (selo fica neutro):',
                      e instanceof Error ? e.message : String(e),
                    );
                    return null;
                  })
                : await mapaConversaCacheado();
            // Última mensagem por lead (2026-08-19): ordena como WhatsApp (quem
            // falou por último no topo) + bolinha de "esperando resposta".
            // Falha aqui só tira a ordenação — nunca derruba a lista.
            const ultimas = await ultimasMensagensWhatsapp().catch((e) => {
              console.warn('[discador] últimas mensagens indisponíveis:', e instanceof Error ? e.message : String(e));
              return null;
            });
            // índice telefone→lead pro webhook conseguir avaliar sem conversa aberta
            for (const l of leads) leadPorTelefone.set(telefoneCanonico(l.telefone), l.leadTaskId);
            const leadsComStatus = leads.map((l) => ({
              ...l,
              conversa: statusConversaDe(l.leadTaskId, mapa?.get(l.leadTaskId)),
              ultima:
                ultimas?.porLead.get(l.leadTaskId) ??
                ultimas?.porTelefone.get(telefoneCanonico(l.telefone)) ??
                null,
            }));
            // sort estável do V8: quem tem conversa sobe (mais recente primeiro);
            // quem não tem mantém a ordem da varredura.
            leadsComStatus.sort((a, b) => (b.ultima?.ts ?? 0) - (a.ultima?.ts ?? 0));
            return c.json({ leads: leadsComStatus, origens });
          } catch (e) {
            console.error('[discador] erro ao buscar leads nunca-ligados:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao carregar os leads' }, 502);
          }
        },
      },
      {
        // FILA DO ROMERO como lista de áudios (pedido do gestor 2026-08-19):
        // "a fila de ligações É a lista de áudios" — cada task de Ligação
        // criada pra ele vira uma linha com chat/áudio/ligação. Mesmo shape do
        // GET /audios (selo do funil + última mensagem), MAIS `ligacaoTaskId`
        // (a Ligação existente — o botão de ligar usa ela direto, sem criar
        // avulsa). Sem itens sem leadTaskId não há conversa — ficam de fora.
        path: '/api/discador/audios/fila',
        method: 'GET',
        handler: async (c) => {
          const gate = await sessaoRomero(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          const assignee = assigneeDoOperador(gate.usuario);
          if (!assignee) return c.json({ leads: [], semMapeamento: true });
          try {
            // Quick 260823-kwu: a fila agora ramifica por FONTE_LIGACOES
            // (paridade com GET /api/discador/fila, 19-09) — sob
            // 'supabase' lê buscarFilaSupabase(gate.usuario) (operador =
            // LOGIN, não assignee); senão mantém buscarFilaResiliente
            // (assignee), resiliente/fresca por 20s, ClickUp fora → última
            // cópia boa. O selo de conversa (Lista 03/audios_envios) segue
            // ramificando à parte por FONTE_AUDIOS, logo abaixo.
            const fila =
              FONTE_LIGACOES === 'supabase'
                ? await buscarFilaSupabase(gate.usuario)
                : await buscarFilaResiliente(assignee);
            const mapa =
              FONTE_AUDIOS === 'supabase'
                ? await mapaConversaPorLeadSupabase().catch((e) => {
                    console.warn(
                      '[discador] mapa de conversa (supabase) falhou (selo fica neutro, fila):',
                      e instanceof Error ? e.message : String(e),
                    );
                    return null;
                  })
                : await mapaConversaCacheado();
            const ultimas = await ultimasMensagensWhatsapp().catch((e) => {
              console.warn('[discador] últimas mensagens indisponíveis (fila):', e instanceof Error ? e.message : String(e));
              return null;
            });
            const leads = await Promise.all(
              fila.map(async (i) => {
                const leadTaskId = i.leadTaskId ?? '';
                if (leadTaskId) leadPorTelefone.set(telefoneCanonico(i.telefone), leadTaskId);
                // o nome da task vem "Ligação — <lead>"; avulsas vêm nomeadas
                // pelo TELEFONE — nesses casos resolve o nome real no lead.
                // prefixo com travessão (lote) OU hífen simples (manuais: "Ligação - Levi")
                let nome = i.nome.replace(/^Ligação( avulsa)?\s*[—-]\s*/i, '');
                if (leadTaskId && /^\+?\d[\d\s()-]*$/.test(nome)) {
                  try {
                    // Quick 260823-kwu: sob FONTE_LIGACOES=supabase resolve
                    // pelo espelho (nunca ClickUp); ramo clickup inalterado.
                    if (FONTE_LIGACOES === 'supabase') {
                      const doLead = await lerNomeLeadEspelho(leadTaskId);
                      if (doLead) nome = doLead;
                    } else {
                      const task = await lerTask(leadTaskId);
                      const doLead = task ? valorCampoLead(task as Parameters<typeof valorCampoLead>[0], CAMPOS_LEADS.NOME) : '';
                      if (doLead) nome = doLead;
                    }
                  } catch {
                    /* mantém o telefone como nome — melhor que quebrar a lista */
                  }
                }
                return {
                  leadTaskId,
                  ligacaoTaskId: i.taskId,
                  nome,
                  telefone: i.telefone,
                  origem: '',
                  // sem lead vinculado NÃO há conversa/chat — a linha entra
                  // mesmo assim (a fila do Romero é TODA mostrada; sumir task
                  // era o bug de 2026-08-19) e vira ligação direta no toque.
                  conversa: leadTaskId
                    ? statusConversaDe(leadTaskId, mapa?.get(leadTaskId))
                    : { status: 'enviar_audio' as const, motivo: 'Sem lead vinculado' },
                  ultima: leadTaskId
                    ? (ultimas?.porLead.get(leadTaskId) ??
                       ultimas?.porTelefone.get(telefoneCanonico(i.telefone)) ??
                       null)
                    : (ultimas?.porTelefone.get(telefoneCanonico(i.telefone)) ?? null),
                };
              }),
            );
            // mesma régua da lista de áudios: quem falou por último no topo;
            // sem mensagem, mantém a prioridade da fila (sort estável).
            leads.sort((a, b) => (b.ultima?.ts ?? 0) - (a.ultima?.ts ?? 0));
            // DOSSIÊ PRIMEIRO (pedido 2026-08-20): quem TEM dossiê sobe — o
            // Romero liga com contexto; quem não tem afunda enquanto a
            // varredura gera em background. Sort ESTÁVEL: dentro de cada
            // grupo vale a ordem acima (quem falou por último). Lead ainda
            // não classificado conta como "sem" até a varredura aprender.
            leads.sort(
              (a, b) =>
                Number(temDossiePorLead.get(b.leadTaskId) === true) -
                Number(temDossiePorLead.get(a.leadTaskId) === true),
            );
            // dispara a varredura (no-op se já rodou há <60s ou está ativa)
            void varrerDossiesDaFila(leads.map((l) => l.leadTaskId).filter(Boolean));
            return c.json({ leads, origens: [] });
          } catch (e) {
            console.error('[discador] erro na fila de áudios:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao carregar a fila' }, 502);
          }
        },
      },
      {
        // SINAL DE NOVIDADE (2026-08-19, "tenho que dar F5 pra aparecer"): o
        // app sonda a cada ~4s; quando o ts da última mensagem persistida
        // muda, ele recarrega lista/conversa NA HORA — sem esperar o poll de
        // 30s. 1 query de 1 linha no Supabase; erro degrada pra {ultimoTs:0}
        // (os polls pesados continuam sendo o fallback).
        path: '/api/discador/audios/novidades',
        method: 'GET',
        handler: async (c) => {
          const gate = await sessaoRomero(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          try {
            return c.json({ ultimoTs: await ultimoTsMensagens() });
          } catch (e) {
            console.warn('[discador] novidades indisponíveis:', e instanceof Error ? e.message : String(e));
            return c.json({ ultimoTs: 0 });
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
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[discador] falha no pré-check de WhatsApp:', msg);
            // WR-01: mesma classificação do envio — throttle/transiente NÃO é
            // sessão fora; só afirma `desconectado` com status REAL confirmando.
            return c.json(await classificarFalhaEnvioAudio(e), 502);
          }
          try {
            // enviarAudio já passa pelo rate limiter interno (D-06) e LANÇA em
            // falha de rede/HTTP/sessão fora — nunca sucesso silencioso (D-08).
            await enviarAudio(telefoneE164, audioBase64, mimetype);
          } catch (e) {
            // LGPD: nunca logar telefone/CPF/audioBase64 em claro — só a
            // mensagem/classe do erro.
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[discador] falha ao enviar áudio via Evolution:', msg);
            // Falha ALTA (D-08): nunca 200 aqui. WR-01: NÃO colapsa todo erro em
            // `desconectado` — throttle (D-06 segurando) e transientes viram erro
            // neutro (retry); só afirma `desconectado` com status REAL confirmando
            // sessão fora, pra não instruir "reconecte o WhatsApp" à toa.
            return c.json(await classificarFalhaEnvioAudio(e), 502);
          }
          // Fase C (20-05): sob FONTE_AUDIOS='supabase' o ENVIO PRIMÁRIO
          // (Evolution API, acima) já aconteceu IDÊNTICO — só o REGISTRO na
          // Lista 03 troca de registrarEnvioAudio (ClickUp direto) por
          // comOutboxRpc(SUPABASE_RPC_REGISTRAR_ENVIO_AUDIO, ...): grava
          // audios_envios + enfileira criar_task no MESMO tx, depois kicka o
          // dreno (posCommitEnvioAudio, padrão CHECADO do 19-07). Best-effort
          // (WR-03) — falha aqui nunca desfaz/mascara o envio já feito.
          if (FONTE_AUDIOS === 'supabase') {
            const canonico = canonizarTelefone(telefoneE164);
            let audioId: number | null = null;
            try {
              const r = await comOutboxRpc<{ audio_id: number; outbox_inseridos: number }>(
                SUPABASE_RPC_REGISTRAR_ENVIO_AUDIO,
                {
                  p_lead_clickup_task_id: leadId,
                  p_lead_id: null,
                  p_telefone_canonico: canonico,
                  p_enviado_por: gate.usuario,
                  // DÉBITO (fora do escopo — files_modified deste plano é só
                  // index.ts): upload do binário pro Supabase Storage ainda
                  // não existe; sem midia_ref a RPC não enfileira a linha
                  // 'anexar' — o registro na Lista 03, quando drenado, sai
                  // sem o áudio anexado (ver 20-05-SUMMARY.md).
                  p_midia_ref: null,
                  p_transcricao: null,
                },
              );
              audioId = r.audio_id;
            } catch (e) {
              console.warn(
                '[discador] registrar_envio_audio (supabase) falhou — envio já feito, registro não persistido:',
                e instanceof Error ? e.message : String(e),
              );
            }
            if (audioId !== null) {
              await posCommitEnvioAudio(audioId);
              const idRegistro = `registro-${audioId}`;
              // Conversa persistida — mesma lógica do caminho ClickUp abaixo.
              void salvarMensagemWhatsapp({
                id: idRegistro,
                lead_task_id: leadId,
                telefone_canonico: telefoneCanonico(telefoneE164),
                de_nos: true,
                ts: new Date().toISOString(),
                tipo: 'audio',
                midia_base64: audioBase64,
                midia_mime: mimetype ?? 'audio/webm',
              }).catch((e) =>
                console.warn('[discador] persistência do envio falhou:', e instanceof Error ? e.message : String(e)),
              );
              void (async () => {
                try {
                  const texto = await transcreverBuffer(Buffer.from(audioBase64, 'base64'), mimetype);
                  // DÉBITO: sem RPC de UPDATE pra transcricao_audio em
                  // audios_envios ainda — persiste só no read-model da
                  // conversa (mensagens_whatsapp, já Supabase); NÃO chama
                  // setCustomField (idRegistro aqui é o id LOCAL de
                  // audios_envios, não um clickup_task_id).
                  if (texto) await atualizarMensagemWhatsapp(idRegistro, { transcricao: texto });
                } catch (e) {
                  console.warn('[discador] transcrição do áudio enviado falhou:', e instanceof Error ? e.message : String(e));
                }
              })();
            }
            return c.json({ status: 'ok' });
          }
          // Registro best-effort na Lista Audios (WR-03) — o envio (efeito
          // primário) já aconteceu; uma falha aqui nunca desfaz/mascara o envio.
          // enviadoPor vem do TOKEN (gate.usuario), nunca do body do cliente.
          const registro = await registrarEnvioAudio({
            telefone: telefoneE164,
            enviadoPor: gate.usuario,
            // WR-03/IN-03: extensão saneada — o recorder produz
            // `audio/webm;codecs=opus`, então tira os parâmetros `;codecs=...`
            // pra não gravar `audio-<ts>.webm;codecs=opus` (extensão malformada).
            audioRef: `audio-${Date.now()}${mimetype ? `.${(mimetype.split('/')[1] || '').split(';')[0] || 'bin'}` : ''}`,
            leadTaskId: leadId,
            // O áudio REAL vira anexo na task da Lista 03 (campo "Áudio" é
            // attachment) — insumo da transcrição/análise (Fase 13).
            audioBase64,
            mimetype,
          });
          if (registro?.id) {
            const idRegistro = registro.id;
            // Conversa persistida (sql/escala/03): o envio entra no read-model na
            // hora, COM a mídia — a conversa e o ▶ ficam instantâneos e sobrevivem
            // a restart. id `registro-<taskId>` casa com a rota de mídia.
            void salvarMensagemWhatsapp({
              id: `registro-${idRegistro}`,
              lead_task_id: leadId,
              telefone_canonico: telefoneCanonico(telefoneE164),
              de_nos: true,
              ts: new Date().toISOString(),
              tipo: 'audio',
              midia_base64: audioBase64,
              midia_mime: mimetype ?? 'audio/webm',
            }).catch((e) =>
              console.warn('[discador] persistência do envio falhou:', e instanceof Error ? e.message : String(e)),
            );
            // Fase 13 (fatia 1): transcreve o áudio ENVIADO em FUNDO e grava
            // TRANSCRICAO_AUDIO na task do registro — fire-and-forget: não
            // atrasa a resposta do envio; falha só avisa (best-effort).
            void (async () => {
              try {
                const texto = await transcreverBuffer(Buffer.from(audioBase64, 'base64'), mimetype);
                if (texto) {
                  await Promise.allSettled([
                    setCustomField(idRegistro, CAMPOS_AUDIOS.TRANSCRICAO_AUDIO, texto),
                    atualizarMensagemWhatsapp(`registro-${idRegistro}`, { transcricao: texto }),
                  ]);
                }
              } catch (e) {
                console.warn('[discador] transcrição do áudio enviado falhou:', e instanceof Error ? e.message : String(e));
              }
            })();
          }
          return c.json({ status: 'ok' });
        },
      },
      {
        // Fase 13 (fatia 2): envia uma mensagem de TEXTO pro lead — o painel
        // vira chat de verdade. Mesmo esqueleto do envio de áudio: gate romero,
        // guard anti-IDOR, pré-check de WhatsApp, throttle, registro na Lista
        // 03 (best-effort) — o texto fica salvo na description do registro.
        path: '/api/discador/audios/:leadId/mensagem',
        method: 'POST',
        handler: async (c) => {
          const gate = await sessaoRomero(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          const leadId = c.req.param('leadId');
          const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
          const texto = String(body.texto ?? '').trim();
          if (!texto) return c.json({ erro: 'texto obrigatório' }, 400);
          if (texto.length > 4096) return c.json({ erro: 'texto longo demais' }, 400);
          let telefoneE164: string;
          let idLeadGhl = '';
          try {
            const task = await validarLeadDaLista01(leadId);
            const telefoneRaw = valorCampoLead(task, CAMPOS_LEADS.TELEFONE);
            const e164 = telefoneRaw ? normalizarTelefoneE164(telefoneRaw) : null;
            if (!e164) return c.json({ erro: 'Lead sem telefone válido' }, 422);
            telefoneE164 = e164;
            idLeadGhl = valorCampoLead(task, CAMPOS_LEADS.ID_LEAD_GHL);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[discador] erro ao resolver lead pro envio de texto:', msg);
            const naoEncontrado = msg.includes('nao encontrada') || msg.includes('nao e um Lead da Lista 01');
            return naoEncontrado
              ? c.json({ erro: 'Lead não encontrado' }, 404)
              : c.json({ erro: 'Erro ao carregar o lead' }, 502);
          }
          try {
            const existe = await numeroExisteNoWhatsapp(telefoneE164);
            if (!existe) {
              await marcarLeadSemWhatsapp({ leadTaskId: leadId, idLeadGhl, telefone: telefoneE164, usuario: gate.usuario });
              return c.json({ status: 'sem_whatsapp' });
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[discador] falha no pré-check de WhatsApp (texto):', msg);
            return c.json(await classificarFalhaEnvioAudio(e), 502);
          }
          try {
            await enviarTexto(telefoneE164, texto);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[discador] falha ao enviar texto via Evolution:', msg);
            return c.json(await classificarFalhaEnvioAudio(e), 502);
          }
          // Fase C (20-05): mesmo racional de /enviar acima — o ENVIO
          // PRIMÁRIO (Evolution, acima) já aconteceu IDÊNTICO; só o REGISTRO
          // troca de registrarMensagemTexto (ClickUp direto) por
          // comOutboxRpc(SUPABASE_RPC_REGISTRAR_MENSAGEM_TEXTO, ...).
          if (FONTE_AUDIOS === 'supabase') {
            const canonico = canonizarTelefone(telefoneE164);
            let audioId: number | null = null;
            try {
              const r = await comOutboxRpc<{ audio_id: number; outbox_inseridos: number }>(
                SUPABASE_RPC_REGISTRAR_MENSAGEM_TEXTO,
                {
                  p_lead_clickup_task_id: leadId,
                  p_lead_id: null,
                  p_telefone_canonico: canonico,
                  p_enviado_por: gate.usuario,
                  p_texto: texto,
                },
              );
              audioId = r.audio_id;
            } catch (e) {
              console.warn(
                '[discador] registrar_mensagem_texto (supabase) falhou — envio já feito, registro não persistido:',
                e instanceof Error ? e.message : String(e),
              );
            }
            if (audioId !== null) {
              await posCommitEnvioAudio(audioId);
              void salvarMensagemWhatsapp({
                id: `registro-${audioId}`,
                lead_task_id: leadId,
                telefone_canonico: telefoneCanonico(telefoneE164),
                de_nos: true,
                ts: new Date().toISOString(),
                tipo: 'texto',
                texto,
              }).catch((e) =>
                console.warn('[discador] persistência do texto falhou:', e instanceof Error ? e.message : String(e)),
              );
            }
            return c.json({ status: 'ok' });
          }
          const registroTxt = await registrarMensagemTexto({ telefone: telefoneE164, enviadoPor: gate.usuario, texto, leadTaskId: leadId });
          // Conversa persistida (sql/escala/03) — mesma lógica do envio de áudio.
          void salvarMensagemWhatsapp({
            id: registroTxt?.id ? `registro-${registroTxt.id}` : `envio-txt-${leadId}-${Date.now()}`,
            lead_task_id: leadId,
            telefone_canonico: telefoneCanonico(telefoneE164),
            de_nos: true,
            ts: new Date().toISOString(),
            tipo: 'texto',
            texto,
          }).catch((e) =>
            console.warn('[discador] persistência do texto falhou:', e instanceof Error ? e.message : String(e)),
          );
          return c.json({ status: 'ok' });
        },
      },
      {
        // Histórico de envios de áudio do lead (Lista 03) — as bolhas
        // persistentes da conversa no painel. Mesmo gate romero das demais.
        path: '/api/discador/audios/:leadId/historico',
        method: 'GET',
        handler: async (c) => {
          const gate = await sessaoRomero(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          const leadId = c.req.param('leadId');
          try {
            // Fase C (20-05): sob FONTE_AUDIOS='supabase' o histórico vem de
            // `audios_envios` (LEITURA-04, 20-04) — mesmo shape
            // EnvioAudioHistorico. Caminho 'clickup' (default) intacto.
            const envios =
              FONTE_AUDIOS === 'supabase' ? await listarEnviosAudioDoLeadSupabase(leadId) : await listarEnviosAudioDoLead(leadId);
            return c.json({ envios });
          } catch (e) {
            console.error('[discador] erro no histórico de áudios:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao carregar o histórico' }, 502);
          }
        },
      },
      {
        // Fase 13 (fatia 1): a CONVERSA real do WhatsApp com o lead, lida por
        // POLLING da instância dedicada (findMessages — sem depender de
        // webhook; funciona no local e na produção). Mensagens de ÁUDIO (dos
        // DOIS lados) ganham transcrição via Deepgram, com cache por mensagem
        // (id estável) pra nunca re-transcrever no poll. A resposta do lead é
        // PERSISTIDA na Lista 03 (registro mais recente do lead: DATA_DA_
        // RESPOSTA / MENSAGENS_NA_RESPOSTA / TRANSCRICAO_RESPOSTA) em fundo,
        // best-effort, apenas quando a contagem muda (WR-03).
        path: '/api/discador/audios/:leadId/conversa',
        method: 'GET',
        handler: async (c) => {
          const gate = await sessaoRomero(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          const leadId = c.req.param('leadId');
          let telefoneE164: string;
          const cacheTel = telefonePorLeadCache.get(leadId);
          if (cacheTel && Date.now() - cacheTel.em < TTL_TELEFONE_LEAD_MS) {
            telefoneE164 = cacheTel.e164; // já passou pelo guard nesta janela
          } else {
            try {
              // Mesmo guard anti-IDOR do envio: só Leads da Lista 01.
              const task = await validarLeadDaLista01(leadId);
              const telefoneRaw = valorCampoLead(task, CAMPOS_LEADS.TELEFONE);
              const e164 = telefoneRaw ? normalizarTelefoneE164(telefoneRaw) : null;
              if (!e164) return c.json({ erro: 'Lead sem telefone válido' }, 422);
              telefoneE164 = e164;
              telefonePorLeadCache.set(leadId, { e164, em: Date.now() });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error('[discador] erro ao resolver lead pra conversa:', msg);
              const naoEncontrado = msg.includes('nao encontrada') || msg.includes('nao e um Lead da Lista 01');
              return naoEncontrado
                ? c.json({ erro: 'Lead não encontrado' }, 404)
                : c.json({ erro: 'Erro ao carregar o lead' }, 502);
            }
          }
          const canonConversa = telefoneCanonico(telefoneE164);
          leadPorTelefone.set(canonConversa, leadId);
          // Abrir/olhar a conversa = LER (pedido 2026-08-19): marca as mensagens
          // do lead como lidas — a bolinha da lista apaga no próximo refresh.
          // Best-effort: falha nunca atrapalha a leitura da conversa.
          void marcarMensagensLidas(leadId, canonConversa).catch(() => {});
          try {
            const saida: Array<{
              id: string;
              deNos: boolean;
              ts: number;
              tipo: string;
              texto: string | null;
              transcricao: string | null;
            }> = [];
            // CAMINHO RÁPIDO (sql/escala/03): a conversa persistida no Supabase —
            // envios nossos + mensagens do webhook — abre em ms e sobrevive a
            // restart (o "sumiu as conversas" de 2026-08-19). Falha de leitura
            // degrada pro caminho lento de hoje (WR-03: nunca mascara como vazio).
            let rowsDb: Awaited<ReturnType<typeof listarMensagensWhatsapp>> = null;
            try {
              rowsDb = await listarMensagensWhatsapp({ leadTaskId: leadId, telefoneCanonico: canonConversa });
            } catch (e) {
              console.warn('[discador] leitura da conversa no Supabase falhou (indo pro caminho lento):', e instanceof Error ? e.message : String(e));
            }
            if (rowsDb) {
              for (const r of rowsDb) {
                saida.push({
                  id: r.id,
                  deNos: r.de_nos,
                  ts: Date.parse(r.ts) || 0,
                  tipo: r.tipo,
                  texto: r.texto ?? null,
                  transcricao: limparRotuloFalante(r.transcricao ?? null),
                });
              }
              // Envios PRÉ-DB (o histórico antigo vive só na Lista 03): enquanto
              // não houver NENHUM envio nosso persistido — DB vazio OU só com
              // mensagens do webhook — busca os registros uma vez e backfilla;
              // desta abertura em diante a conversa inteira vem do DB (ms).
              if (!rowsDb.some((r) => r.de_nos)) {
                // Fase C (20-05): a conversa mistura audios_envios (histórico
                // de envios) com mensagens_whatsapp (já Supabase) — só a
                // fonte do histórico de envios inverte por FONTE_AUDIOS.
                const envios =
                  FONTE_AUDIOS === 'supabase' ? await listarEnviosAudioDoLeadSupabase(leadId) : await listarEnviosAudioDoLead(leadId);
                const vistosDb = new Set(saida.map((m) => m.id));
                for (const e2 of envios) {
                  const idReg = `registro-${e2.taskId}`;
                  if (vistosDb.has(idReg)) continue;
                  saida.push({
                    id: idReg,
                    deNos: true,
                    ts: e2.em,
                    tipo: e2.tipo,
                    texto: e2.texto,
                    transcricao: limparRotuloFalante(e2.transcricao),
                  });
                  void salvarMensagemWhatsapp({
                    id: idReg,
                    lead_task_id: leadId,
                    telefone_canonico: canonConversa,
                    de_nos: true,
                    ts: new Date(e2.em).toISOString(),
                    tipo: e2.tipo === 'texto' ? 'texto' : 'audio',
                    texto: e2.texto,
                    transcricao: limparRotuloFalante(e2.transcricao),
                  }).catch(() => {});
                }
              }
              // vincula ao lead as linhas do webhook que chegaram antes do vínculo
              void vincularLeadMensagensWhatsapp(canonConversa, leadId).catch(() => {});
            } else {
              // Supabase FORA (não configurado): caminho de hoje por inteiro —
              // store da Evolution → fallback registros da Lista 03.
              const mensagens = await listarMensagensDaConversa(telefoneE164);
              for (const m of mensagens) {
                let transcricao: string | null = null;
                if (m.tipo === 'audio') {
                  if (transcricaoPorMensagem.has(m.id)) {
                    transcricao = transcricaoPorMensagem.get(m.id) ?? null;
                  } else {
                    try {
                      const midia = await baixarAudioMensagem(m.id);
                      transcricao = midia
                        ? await transcreverBuffer(Buffer.from(midia.base64, 'base64'), midia.mimetype)
                        : null;
                    } catch {
                      transcricao = null; // sem transcrição ≠ sem conversa (fail-open)
                    }
                    transcricaoPorMensagem.set(m.id, transcricao);
                  }
                }
                saida.push({ ...m, transcricao: limparRotuloFalante(transcricao) });
              }
              if (saida.length === 0) {
                // FALLBACK (constatado em 2026-08-18): o servidor Evolution não
                // guarda as conversas diretas (store só com grupos) — os NOSSOS
                // envios entram direto da Lista 03 (registro + transcrição; a
                // mídia sai do anexo via /mensagem/registro-<taskId>/midia).
                // Fase C (20-05): mesma inversão do backfill acima.
                const envios =
                  FONTE_AUDIOS === 'supabase' ? await listarEnviosAudioDoLeadSupabase(leadId) : await listarEnviosAudioDoLead(leadId);
                for (const e2 of envios) {
                  saida.push({
                    id: `registro-${e2.taskId}`,
                    deNos: true,
                    ts: e2.em,
                    tipo: e2.tipo,
                    texto: e2.texto,
                    transcricao: e2.transcricao,
                  });
                }
              }
            }
            // Fatia 3: soma as mensagens RECEBIDAS pelo webhook (o lado do
            // lead que o cofre da Evolution não guarda) — dedupe por id.
            const vistos = new Set(saida.map((m) => m.id));
            for (const rec of recebidasWebhook) {
              if (vistos.has(rec.id)) continue;
              if (!rec.digitos.some((dg) => mesmoTelefoneDigitos(dg, telefoneE164))) continue;
              saida.push({ id: rec.id, deNos: false, ts: rec.ts, tipo: rec.tipo, texto: rec.texto, transcricao: rec.transcricao });
            }
            saida.sort((a, b) => a.ts - b.ts);
            const doLead = saida.filter((m) => !m.deNos);
            // Avaliação ligar/não-ligar com debounce de 60s (fire-and-forget).
            void avaliarConversaComDebounce(
              leadId,
              doLead.map((m) => ({ ts: m.ts, texto: m.texto, transcricao: m.transcricao })),
            );
            if (doLead.length > 0 && respostaPersistidaPorLead.get(leadId) !== doLead.length) {
              respostaPersistidaPorLead.set(leadId, doLead.length);
              void (async () => {
                try {
                  // NÃO ramificar por FONTE_AUDIOS aqui: setCustomField grava
                  // no ClickUp por `ultimo.taskId` — sob supabase,
                  // listarEnviosAudioDoLeadSupabase().taskId é o id LOCAL de
                  // `audios_envios` (não o clickup_task_id), então usar essa
                  // leitura aqui gravaria no id errado. Sem RPC de UPDATE
                  // pra DATA_DA_RESPOSTA/MENSAGENS_NA_RESPOSTA/
                  // TRANSCRICAO_RESPOSTA em audios_envios ainda (débito, fora
                  // do escopo de 20-03/20-05) — este write-side-effect segue
                  // ClickUp-only nos dois caminhos (mesmo racional da
                  // persistência de ANALISE_IA em avaliarConversaComDebounce).
                  const envios = await listarEnviosAudioDoLead(leadId);
                  const ultimo = envios[envios.length - 1];
                  if (!ultimo?.taskId) return;
                  const ultimaDoLead = doLead[doLead.length - 1];
                  await setCustomField(ultimo.taskId, CAMPOS_AUDIOS.DATA_DA_RESPOSTA, ultimaDoLead.ts);
                  await setCustomField(ultimo.taskId, CAMPOS_AUDIOS.MENSAGENS_NA_RESPOSTA, doLead.length);
                  const textoResp = ultimaDoLead.transcricao ?? ultimaDoLead.texto;
                  if (textoResp) await setCustomField(ultimo.taskId, CAMPOS_AUDIOS.TRANSCRICAO_RESPOSTA, textoResp);
                } catch (e) {
                  console.warn('[discador] persistência da resposta falhou:', e instanceof Error ? e.message : String(e));
                }
              })();
            }
            return c.json({ mensagens: saida });
          } catch (e) {
            console.error('[discador] erro ao ler a conversa:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao carregar a conversa' }, 502);
          }
        },
      },
      {
        // Fase 13 (fatia 3): RECEPTOR do webhook da Evolution — cada mensagem
        // que chega no número dedicado é postada aqui (túnel no local; URL do
        // VPS na produção). Autentica por token (?token= ou x-webhook-token,
        // comparado a EVOLUTION_WEBHOOK_TOKEN). Só consome messages.upsert de
        // TERCEIROS (fromMe já vira registro no envio). LGPD: nunca loga
        // telefone/corpo — só tipo/contagem.
        path: '/api/evolution/webhook',
        method: 'POST',
        handler: async (c) => {
          const esperado = process.env.EVOLUTION_WEBHOOK_TOKEN ?? '';
          const token = c.req.query('token') ?? c.req.header('x-webhook-token') ?? '';
          if (!esperado || token !== esperado) return c.json({ status: 'forbidden' }, 403);
          const body = (await c.req.json().catch(() => null)) as
            | { event?: string; data?: unknown }
            | null;
          const evento = String(body?.event ?? '').toLowerCase().replace(/_/g, '.');
          // ring de inspeção (formato real dos eventos; leitura token-gated)
          ultimosEventosWebhook.push(body);
          while (ultimosEventosWebhook.length > 5) ultimosEventosWebhook.shift();
          // ── QUEDA/VOLTA DO CHIP (2026-08-19): connection.update da instância
          // PRINCIPAL → aviso no grupo de operação via a instância de ALERTA
          // (evolution.ts) — o chip caído não anuncia a própria queda. Filtro
          // por instância: se um dia a instância de alerta apontar o webhook
          // pra cá, a queda DELA não dispara aviso (senão o aviso da queda do
          // avisador viraria loop de ruído). Fire-and-forget: o webhook nunca
          // espera nem falha por causa do alerta. ──
          if (evento.includes('connection.update')) {
            const bodyInst = (body as { instance?: unknown } | null)?.instance;
            const dadosConn = (Array.isArray(body?.data) ? body?.data[0] : body?.data) as
              | { instance?: unknown; state?: unknown }
              | undefined;
            const instancia = String(bodyInst ?? dadosConn?.instance ?? '');
            const state = String(dadosConn?.state ?? '');
            if (instancia && EVOLUTION_INSTANCE && instancia !== EVOLUTION_INSTANCE) return c.json({ ok: true });
            console.log(`[webhook] connection.update: ${state || '(sem state)'}`);
            const agora = Date.now();
            const hora = new Date(agora).toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'America/Recife',
            });
            if (state === 'close' && !quedaAlertada && agora - ultimoAlertaQuedaTs >= ALERTA_QUEDA_COOLDOWN_MS) {
              // no máx. 1 aviso de queda por janela de cooldown; enquanto a
              // queda está em aberto (quedaAlertada) não re-avisa.
              ultimoAlertaQuedaTs = agora;
              quedaAlertada = true;
              void enviarAlertaGrupo(
                `🔴 *ALERTA — chip do call center caiu* (${hora})\n\n` +
                  `A instância *${EVOLUTION_INSTANCE}* desconectou do WhatsApp. ` +
                  `Envio de áudio/mensagem e recebimento de respostas estão PARADOS.\n\n` +
                  `➡️ Reconectar: Evolution → instância ${EVOLUTION_INSTANCE} → ler o QR code de novo.`,
              );
            } else if (state === 'open' && quedaAlertada) {
              quedaAlertada = false;
              void enviarAlertaGrupo(`🟢 Chip do call center reconectado (${hora}) — instância *${EVOLUTION_INSTANCE}* de volta. Envios normalizados.`);
            }
            return c.json({ ok: true });
          }
          if (!evento.includes('messages.upsert')) return c.json({ ok: true });
          const dados = Array.isArray(body?.data) ? body?.data : [body?.data].filter(Boolean);
          for (const dBruto of dados as Array<Record<string, unknown>>) {
            const d = dBruto as {
              key?: { id?: string; fromMe?: boolean; remoteJid?: string; senderPn?: string; participantPn?: string };
              message?: { conversation?: string; extendedTextMessage?: { text?: string }; audioMessage?: { mimetype?: string }; base64?: string };
              messageType?: string;
              messageTimestamp?: number | string;
              base64?: string;
              sender?: string;
            };
            const key = d?.key ?? {};
            if (key.fromMe === true) continue; // nosso envio já vira registro
            // Só conversa DIRETA interessa: o número dedicado participa de grupos/
            // newsletters que despejam spam aqui (constatado no ring 2026-08-19 —
            // eventos "outro" eram ofertas de grupo). Grupo NUNCA é resposta de lead.
            const remoteJid = String(key.remoteJid ?? '');
            if (/@(g\.us|newsletter|broadcast)$/.test(remoteJid)) continue;
            const id = String(key.id ?? '');
            if (!id || recebidasWebhook.some((m) => m.id === id)) continue;
            const tsB = Number(d?.messageTimestamp ?? 0) || Math.floor(Date.now() / 1000);
            const ts = tsB > 1e12 ? tsB : tsB * 1000;
            const msg = d?.message ?? {};
            const texto = msg.conversation ?? msg.extendedTextMessage?.text ?? null;
            const temAudio = !!msg.audioMessage || String(d?.messageType ?? '') === 'audioMessage';
            const midiaBase64 =
              typeof msg.base64 === 'string' ? msg.base64 : typeof d?.base64 === 'string' ? d.base64 : null;
            // 10-13 dígitos = telefone BR plausível; jids @lid carregam um ID
            // interno de 14-15 dígitos que NÃO é telefone (senderPn traz o real).
            const digitos = [key.remoteJid, key.senderPn, key.participantPn, d?.sender]
              .map((x) => String(x ?? '').split('@')[0].replace(/\D/g, ''))
              .filter((x) => x.length >= 10 && x.length <= 13);
            const rec: MensagemRecebidaWebhook = {
              id,
              ts,
              tipo: temAudio ? 'audio' : texto !== null && texto !== '' ? 'texto' : 'outro',
              texto,
              transcricao: null,
              digitos: [...new Set(digitos)],
              midiaBase64,
              midiaMime: temAudio ? (msg.audioMessage?.mimetype ?? 'audio/ogg') : null,
            };
            recebidasWebhook.push(rec);
            while (recebidasWebhook.length > 500) recebidasWebhook.shift();
            // Durabilidade (sql/escala/03): a mensagem do lead sobrevive a restart
            // — o ring acima é só a janela quente. Best-effort: falha loga-e-segue,
            // o webhook nunca vira 500 por causa da persistência (WR-03).
            const canonRec = telefoneCanonico(rec.digitos[0] ?? '');
            void salvarMensagemWhatsapp({
              id,
              lead_task_id: leadPorTelefone.get(canonRec) ?? null,
              telefone_canonico: canonRec,
              de_nos: false,
              ts: new Date(ts).toISOString(),
              tipo: rec.tipo,
              texto: rec.texto,
              transcricao: null,
              midia_base64: midiaBase64,
              midia_mime: rec.midiaMime,
              bruto: dBruto,
            }).catch((e) =>
              console.warn('[webhook] persistência da mensagem falhou:', e instanceof Error ? e.message : String(e)),
            );
            if (temAudio && midiaBase64) {
              // transcreve a resposta de voz na chegada (best-effort, em fundo)
              void transcreverBuffer(Buffer.from(midiaBase64, 'base64'), rec.midiaMime ?? undefined)
                .then((t) => {
                  rec.transcricao = t;
                  if (t) {
                    void atualizarMensagemWhatsapp(id, { transcricao: t }).catch(() => {});
                  }
                })
                .catch(() => {});
            }
            // avaliação com debounce disparada PELO webhook (não depende da
            // conversa estar aberta no painel) — pedido do gestor.
            agendarAvaliacaoPorTelefone(rec.digitos, rec.ts);
            // INBOUND → FILA (2026-08-19): sem Ligação aberta pra esse
            // telefone, cria a avulsa (vínculo ao lead por telefone) — a
            // pessoa APARECE na tela do Romero. Fire-and-forget.
            void garantirLigacaoInbound(canonRec, rec.digitos[0] ?? '');
            console.log(`[webhook] mensagem recebida (${rec.tipo})`);
          }
          return c.json({ ok: true });
        },
      },
      {
        // Espião de formato (debug): últimos 5 eventos BRUTOS do webhook.
        // Token-gated (mesmo token do webhook) — uso: diagnosticar o shape
        // real dos eventos sem logar conteúdo no console (LGPD).
        path: '/api/evolution/webhook/debug',
        method: 'GET',
        handler: async (c) => {
          const esperado = process.env.EVOLUTION_WEBHOOK_TOKEN ?? '';
          const token = c.req.query('token') ?? '';
          if (!esperado || token !== esperado) return c.json({ status: 'forbidden' }, 403);
          return c.json({ eventos: ultimosEventosWebhook });
        },
      },
      {
        // Fase 13: mídia (base64) de uma mensagem de ÁUDIO da conversa —
        // alimenta o ▶ das bolhas dos dois lados. Read-only, gate romero.
        // ids `registro-<taskId>` (fallback Lista 03) tocam o ANEXO da task.
        path: '/api/discador/audios/mensagem/:mensagemId/midia',
        method: 'GET',
        handler: async (c) => {
          const gate = await sessaoRomero(c);
          if (gate.status !== 200) return c.json({ status: gate.status === 401 ? 'unauthorized' : 'forbidden' }, gate.status);
          const mensagemId = c.req.param('mensagemId');
          try {
            // mensagem recebida via WEBHOOK: a mídia já chegou base64 no evento
            const rec = recebidasWebhook.find((m) => m.id === mensagemId);
            if (rec?.midiaBase64) {
              return c.json({ base64: rec.midiaBase64, mimetype: rec.midiaMime ?? 'audio/ogg' });
            }
            // conversa persistida (sql/escala/03): mídia gravada no envio/chegada
            // — playback instantâneo mesmo depois de restart, sem baixar de fora
            const midiaDb = await buscarMidiaMensagemWhatsapp(mensagemId).catch(() => null);
            if (midiaDb) {
              return c.json({ base64: midiaDb.base64, mimetype: midiaDb.mimetype });
            }
            if (mensagemId.startsWith('registro-')) {
              const taskId = mensagemId.slice('registro-'.length);
              const det = (await lerTask(taskId)) as
                | { attachments?: Array<{ url?: string; extension?: string }> }
                | null;
              const anexo = det?.attachments?.[0];
              if (!anexo?.url) return c.json({ erro: 'Mídia indisponível' }, 404);
              const resArq = await fetch(anexo.url);
              if (!resArq.ok) return c.json({ erro: 'Mídia indisponível' }, 404);
              const buf = Buffer.from(await resArq.arrayBuffer());
              // o ClickUp rotula .webm como video/* — é áudio de voz: normaliza
              // pra audio/* (players de <audio> engasgam com data:video/...).
              const mimetype = (resArq.headers.get('content-type') || (anexo.extension === 'ogg' ? 'audio/ogg' : 'audio/webm')).replace(/^video\//, 'audio/');
              return c.json({ base64: buf.toString('base64'), mimetype });
            }
            const midia = await baixarAudioMensagem(mensagemId);
            if (!midia) return c.json({ erro: 'Mídia indisponível' }, 404);
            return c.json(midia);
          } catch (e) {
            console.error('[discador] erro ao baixar mídia da mensagem:', e instanceof Error ? e.message : String(e));
            return c.json({ erro: 'Erro ao baixar a mídia' }, 502);
          }
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
              console.log(`[wavoip] evento type=${evento} status=${payload.status || ''} dir=${payload.direction || ''} dur=${payload.duration ?? ''} reason=${payload.reason || ''} record_status=${payload.record_status || ''} keys=[${Object.keys(payload).join(',')}]`);
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

            // ---------------- DEVICE: alerta de queda do numero Wavoip de um ATENDENTE (Quick 260819-p1r) ----------------
            // Best-effort (T-p1r-02): todo o branch em try/catch — evento
            // DEVICE malformado NUNCA vira 500 nem derruba o recebimento de
            // CALL/RECORD (que ja retornaram acima). Nao muda durabilidade
            // nem o log geral de shape (ambos ja pulam DEVICE por design —
            // heartbeat frequente).
            if (evento === 'DEVICE') {
              try {
                // LOG DE SHAPE LGPD-SAFE (INCOGNITA #1): o shape real do
                // payload DEVICE em producao ainda nao esta confirmado —
                // loga SO as chaves presentes + o status, JAMAIS
                // telefone/token/phone em claro (T-p1r-01).
                console.log(`[wavoip] DEVICE shape keys=[${Object.keys(payload).join(',')}] status=${String(payload.status ?? '')}`);

                // Extracao defensiva: nomes de campo do payload real do
                // webhook DEVICE nao sao garantidos (ver nota no config no
                // topo do arquivo) — tenta id/device_id/token, nessa ordem.
                const deviceIdBruto = String(payload.id ?? payload.device_id ?? payload.token ?? '').trim();
                const status = String(payload.status ?? '');
                const conectado = status.toLowerCase() === 'open';

                // Mapeamento pra deviceId conhecido (INCOGNITA #2): (a) casa
                // com donosDevices()/snapshotDevicesWavoip(); (b) senao,
                // payload.phone -> deviceIdPorNumero (reverso numero->device).
                const donos = donosDevices();
                const idsConhecidos = new Set<string>([
                  ...Object.keys(donos),
                  ...snapshotDevicesWavoip().map((dv) => dv.id),
                ]);
                let chaveConhecida: string | null = idsConhecidos.has(deviceIdBruto) ? deviceIdBruto : null;
                if (!chaveConhecida && payload.phone) {
                  chaveConhecida = deviceIdPorNumero(String(payload.phone).replace(/[^\d]/g, ''));
                }

                // GATE: sem identificador estavel (nem deviceId conhecido nem
                // bruto), NAO processa — evita spam com evento nao-atribuivel
                // (T-p1r-03). Segue pro return comum.
                const chave = chaveConhecida || deviceIdBruto;
                if (chave) {
                  const prev = estadoAlertaDevice.get(chave);
                  const d = decidirAlertaQuedaDevice(prev, conectado, Date.now(), ALERTA_QUEDA_COOLDOWN_MS);
                  estadoAlertaDevice.set(chave, d.novoEstado);

                  if (d.disparar) {
                    const nome = chaveConhecida ? donos[chaveConhecida] : undefined;
                    const rotulo = nome ? `atendente ${nome}` : 'atendente';
                    // Numero SEMPRE mascarado (LGPD) — nunca em claro no log
                    // nem na mensagem do grupo (T-p1r-01).
                    const numeroBruto = snapshotDevicesWavoip().find((dv) => dv.id === chave)?.numero || String(payload.phone ?? '');
                    const numeroMascarado = mascararTelefone(numeroBruto);
                    if (d.tipo === 'queda') {
                      void enviarAlertaGrupo(`🔴 Número do ${rotulo} caiu do WhatsApp (final ${numeroMascarado}). Reconectar.`);
                    } else if (d.tipo === 'volta') {
                      void enviarAlertaGrupo(`🟢 Número do ${rotulo} reconectou (final ${numeroMascarado}).`);
                    }
                  }
                  return c.json({ status: 'device', alertado: d.disparar });
                }
              } catch (e) {
                console.error('[wavoip] falha ao processar evento DEVICE (best-effort, ignorado):', e instanceof Error ? e.message : String(e));
              }
              return c.json({ status: 'ignorado', evento });
            }

            // outros eventos: nao aplicaveis.
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

// A5 (Pacote A / incidente 2026-08-22): arma o refresh periódico de
// background do inventário Wavoip — desacopla o invCache de bater na API só
// quando uma requisição de discagem (/config, /dispositivo/lease) passa por
// ele. Self-guarded (no-op se a API Wavoip não está configurada) e `unref()`
// no timer (molde do top-level `iniciarChecagemAlertas()` de worker.ts) — o
// web não tem SIGTERM próprio, confia no exit do processo.
iniciarRefreshInventarioWavoip();
