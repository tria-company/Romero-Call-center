import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getSessao, trocarAgente } from '../sessao';
import {
  enviarAvisoAoSuporte,
  consultarNotificacao,
  registrarNotificacao,
} from '../notificacoes';
import { bloquearNumero } from '../bloqueio';
import { createTask } from './create-task';
import { movePipelineStage } from './move-pipeline-stage';
// HARD-05 (Fase 5, plano 05-03): INVARIANTE INVIOLAVEL — as chamadas GHL do
// protocolo de crise (task URGENTE, move RETORNAR_CONTATO, aviso ao grupo de
// suporte) NUNCA podem ser bloqueadas pelo circuit breaker('ghl'). O bypass
// {crise:true} garante que a escalacao de sofrimento agudo (CVV 188) e
// SEMPRE tentada, mesmo com o breaker('ghl') aberto por falhas recentes de
// chamadas GHL normais (nao-crise). So muda o comportamento do breaker — a
// mecanica de idempotencia honesta (consultarNotificacao/registrarNotificacao
// apos sucesso real, CR-02) continua identica, ver comentarios abaixo.
import { chamarComResiliencia } from '../resiliencia';

// Motivos AUTON (playbook §15 "Bandeiras vermelhas" + §4 protocolo de
// escalacao tripla). O LLM pode mandar texto livre, mas normalizamos pra
// um label legivel pro time. Clone de handoff-humano.ts (ex-bot Closer),
// trocando as categorias de vendas pelas categorias clinicas/juridicas do
// SDR AUTON.
const MOTIVO_LABEL: Record<string, string> = {
  sofrimento_agudo: 'sofrimento psicologico agudo (protocolo CVV 188)',
  lexico_incompativel: 'lexico incompativel com o perfil profissional de saude',
  processo_etico_judicial: 'mencao a processo etico/regulador/judicial',
  pedido_info_clinica: 'pedido de informacao clinica pessoal',
  lead_reclama_bot: 'lead reclama de estar falando com bot',
  menor_como_paciente: 'menor de idade mencionado como paciente',
  reembolso_cancelamento: 'pedido de reembolso/cancelamento',
  // CR-02 (review Fase 5): motivo emitido por montarHandoffPadrao
  // (fallback.ts, cascata HARD-07 esgotada SEM crise) — com label proprio,
  // o grupo de suporte distingue "IA caiu, atender o lead" de um hiccup
  // generico do Azure.
  falha_tecnica: 'falha tecnica persistente (LLM indisponivel — fallback esgotado, atender o lead manualmente)',
};

function rotularMotivo(motivo: string): string {
  const chave = motivo.trim().toLowerCase().replace(/\s+/g, '_');
  return MOTIVO_LABEL[chave] || motivo;
}

async function notificarGrupoSuporte(
  telefone: string,
  motivo: string,
  resumo: string | undefined,
): Promise<boolean> {
  // Idempotencia com consult/register SPLIT (CR-02, 3a rodada): a consulta
  // aqui e READ-ONLY — a janela so e registrada la embaixo, APOS
  // enviarAvisoAoSuporte confirmar entrega real (ok===true). Registrar
  // ANTES da tentativa fazia a segunda chamada devolver true FAKE ("grupo
  // notificado") quando a primeira falhou (SUPORTE_GRUPO_JID vazio, erro de
  // envio GHL) — nada foi entregue e o retry ficava travado por 1h.
  // Retornar true no cache hit e correto AQUI: a janela so existe se um
  // aviso ja foi ENTREGUE de verdade antes (nao repetir nao e falha).
  if (consultarNotificacao(telefone, `escalate:${motivo}`)) {
    console.log(`[escalate-to-human] ${telefone} (${motivo}): grupo ja notificado, ignorando`);
    return true;
  }

  const sessao = await getSessao(telefone);
  const nome = sessao?.nome && sessao.nome !== 'Não identificado' ? sessao.nome : '(sem nome)';
  const motivoLegivel = rotularMotivo(motivo);

  const linhas = [
    '🚨 *Escalacao IA → Humano (SDR AUTON)*',
    `Lead: ${nome}`,
    `Telefone: ${telefone}`,
    `Motivo: ${motivoLegivel}`,
  ];
  if (resumo) linhas.push(`Resumo: ${resumo}`);
  linhas.push('', 'A IA esta em silencio neste numero. Alguem do time precisa assumir.');

  // Bypass de crise (HARD-05): esta notificacao e parte do protocolo de
  // escalacao — nunca pode ser bloqueada pelo breaker('ghl'), mesmo se
  // chamadas GHL normais recentes tiverem aberto o circuito.
  const ok = await chamarComResiliencia(() => enviarAvisoAoSuporte(linhas), { recurso: 'ghl', crise: true });
  if (ok) {
    // Entrega REAL confirmada — so agora consome a janela de idempotencia.
    registrarNotificacao(telefone, `escalate:${motivo}`);
    console.log(`[escalate-to-human] Grupo de suporte notificado para ${telefone}`);
  }
  return ok;
}

// Retorno HONESTO do acionamento humano garantido: taskOk/moveOk refletem
// o `sucesso` REAL devolvido por createTask/movePipelineStage (que nunca
// lancam excecao — retornam {sucesso:false, motivo} em falha, ex: GHL fora
// do ar, PIT token ausente, contactId nao resolvido). O caller (execute)
// usa esse retorno pra nao afirmar falsamente que o acionamento funcionou.
interface AcionamentoResultado {
  taskOk: boolean;
  moveOk: boolean;
}

// Gap 7 (CR-07) + fechamento residual (CR-02/Gap 7): acionamento humano
// GARANTIDO, independente de SUPORTE_GRUPO_JID/notificarGrupoSuporte (que
// so entrega se for telefone 1:1 valido — GHL nao manda pra grupo
// WhatsApp). Toda escalacao (inclusive sofrimento agudo/CVV 188) precisa
// deixar um sinal humano-visivel no GHL: task URGENTE (Filtro 3,
// prioridadePorBant >= 10) + card movido pro stage RETORNAR_CONTATO.
//
// IMPORTANTE: createTask.execute/movePipelineStage.execute NUNCA lancam —
// retornam {sucesso:false} em falha. Os try/catch abaixo sao defesa extra
// (nao custam nada), mas quem determina sucesso real e a CAPTURA do
// retorno (`r?.sucesso`), nao a ausencia de excecao.
async function acionarHumanoGarantido(
  telefone: string,
  motivo: string,
  resumo: string | undefined,
): Promise<AcionamentoResultado> {
  const motivoLegivel = rotularMotivo(motivo);
  const chaveNormalizada = motivo.trim().toLowerCase().replace(/\s+/g, '_');
  // WR-02 (3a rodada): UMA chave de idempotencia POR CANAL (task e move sao
  // independentes). Com chave unica compartilhada, um sucesso parcial (task
  // ok, move falhou) consumia a janela dos DOIS canais: o move falhado nao
  // podia ser retentado por 1h e o cache hit devolvia {taskOk:true,
  // moveOk:true} hardcoded — mentindo "Card movido" pro LLM/time.
  const chaveTask = `escalate-task:${chaveNormalizada}`;
  const chaveMove = `escalate-move:${chaveNormalizada}`;
  const ehSofrimentoAgudo = chaveNormalizada === 'sofrimento_agudo';

  // Idempotencia (read-only, por canal): consulta aqui, registra la embaixo
  // APOS sucesso real de CADA canal. Cache hit por canal = aquele canal ja
  // teve sucesso real recentemente (verdade por-canal, nao hardcoded); o
  // canal que falhou continua elegivel pra retry nesta mesma chamada.
  const taskJaOk = consultarNotificacao(telefone, chaveTask);
  const moveJaOk = consultarNotificacao(telefone, chaveMove);
  if (taskJaOk && moveJaOk) {
    console.log(`[escalate-to-human] ${telefone} (${motivo}): acionamento garantido ja disparado com sucesso recentemente (task e move), ignorando`);
    return { taskOk: true, moveOk: true };
  }

  const titulo = `ESCALACAO URGENTE - ${motivoLegivel}`;
  const corpoPartes = [`Lead escalado da IA (Camila) para atendimento humano. Motivo: ${motivoLegivel}.`];
  if (resumo) corpoPartes.push(`Resumo: ${resumo}`);
  if (ehSofrimentoAgudo) {
    corpoPartes.push('ATENCAO: sofrimento psicologico agudo — protocolo CVV 188. Contato humano IMEDIATO necessario.');
  }
  corpoPartes.push('A IA ja pausou as respostas para este numero (trocarAgente humano).');
  const corpo = corpoPartes.join('\n');

  let taskOk = taskJaOk;
  if (!taskJaOk) {
    try {
      // bantTotal alto o suficiente pra forcar prioridade URGENTE
      // (prioridadePorBant >= 10) independente do score real do lead — toda
      // escalacao e, por definicao, prioridade maxima pro humano de plantao.
      // Bypass de crise (HARD-05): task URGENTE do protocolo de escalacao
      // nunca pode ser bloqueada pelo breaker('ghl').
      const r = await chamarComResiliencia(
        () => createTask.execute!({ telefone, titulo, corpo, bantTotal: 12 } as any, {} as any),
        { recurso: 'ghl', crise: true },
      );
      taskOk = !!r?.sucesso;
      if (taskOk) {
        // Sucesso REAL deste canal — so agora consome a janela DELE.
        registrarNotificacao(telefone, chaveTask);
      } else {
        console.error(`[escalate-to-human] createTask retornou sucesso:false para ${telefone} — motivo: ${r?.motivo ?? 'desconhecido'}`);
      }
    } catch (e) {
      console.error(`[escalate-to-human] falha ao criar task URGENTE para ${telefone}:`, e);
    }
  } else {
    console.log(`[escalate-to-human] ${telefone} (${motivo}): task URGENTE ja criada com sucesso recentemente, pulando so este canal`);
  }

  let moveOk = moveJaOk;
  if (!moveJaOk) {
    try {
      // Bypass de crise (HARD-05): move RETORNAR_CONTATO do protocolo de
      // escalacao nunca pode ser bloqueado pelo breaker('ghl').
      const r = await chamarComResiliencia(
        () => movePipelineStage.execute!({ telefone, stage: 'RETORNAR_CONTATO' } as any, {} as any),
        { recurso: 'ghl', crise: true },
      );
      moveOk = !!r?.sucesso;
      if (moveOk) {
        // Sucesso REAL deste canal — so agora consome a janela DELE.
        registrarNotificacao(telefone, chaveMove);
      } else {
        console.error(`[escalate-to-human] movePipelineStage retornou sucesso:false para ${telefone} — motivo: ${r?.motivo ?? 'desconhecido'}`);
      }
    } catch (e) {
      console.error(`[escalate-to-human] falha ao mover card para RETORNAR_CONTATO para ${telefone}:`, e);
    }
  } else {
    console.log(`[escalate-to-human] ${telefone} (${motivo}): card ja movido com sucesso recentemente, pulando so este canal`);
  }

  // Falha total (nenhum canal ok): NENHUMA janela foi registrada acima —
  // a proxima chamada de escalate re-tenta os dois canais de verdade
  // (retry honesto, sem cache de sucesso fake — CR-01/CR-02/WR-02).
  return { taskOk, moveOk };
}

export const escalateToHuman = createTool({
  id: 'escalate-to-human',
  description:
    'Transfere a conversa para um atendente humano e PAUSA a IA. Use nas bandeiras vermelhas do playbook: sofrimento psicologico agudo (protocolo CVV 188), mencao a processo etico/regulador/judicial, pedido de informacao clinica pessoal, lead reclama do bot, menor de idade como paciente, ou pedido de reembolso/cancelamento. APOS chamar esta tool, NAO escreva mais nenhuma mensagem ao lead — a IA fica em silencio absoluto e o time humano assume.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    motivo: z
      .string()
      .describe(
        'Motivo da escalacao. Categorias preferidas: sofrimento_agudo, lexico_incompativel, processo_etico_judicial, pedido_info_clinica, lead_reclama_bot, menor_como_paciente, reembolso_cancelamento.',
      ),
    resumo: z
      .string()
      .optional()
      .describe('Resumo curto (1 linha) do que o lead pediu/precisa, pra orientar o humano que assumir.'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
    mensagem: z.string(),
  }),
  execute: async ({ telefone, motivo, resumo }) => {
    console.log(`[escalate-to-human] ${telefone} → humano (${motivo})`);
    // A pausa da IA NUNCA depende do acionamento humano ter sucesso — roda
    // incondicionalmente antes de qualquer tentativa (a IA nunca volta a
    // responder um lead em crise por causa de uma falha de GHL/task/move).
    await trocarAgente(telefone, 'humano');
    // WR-01 (3a rodada): pausa DURAVEL alem da janela de 24h de
    // buscarConversaAtiva. trocarAgente persiste agente_atual +
    // status='aguardando_humano' na conversa, mas getSessao so recupera
    // conversas com data_ultima_mensagem < 24h — um lead em crise que fica
    // em silencio >24h "perderia" a pausa num cold cache. bloquearNumero
    // grava metadata.bloqueado_ate (recuperavel por estaBloqueado apos
    // restart) E o guard do webhook do formulario (index.ts, CR-03) tambem
    // consulta a conversa 'aguardando_humano' SEM janela de tempo
    // (buscarConversaAguardandoHumano). Best-effort: falha aqui nao desfaz
    // a pausa (trocarAgente ja rodou) nem impede o acionamento abaixo.
    try {
      await bloquearNumero(telefone);
    } catch (e) {
      console.error(`[escalate-to-human] falha ao persistir bloqueio duravel para ${telefone}:`, e);
    }
    // Acionamento garantido (Gap 7/CR-07): task URGENTE + move RETORNAR_CONTATO,
    // sempre — nao depende de SUPORTE_GRUPO_JID estar configurado. Retorno
    // real capturado (as tools reusadas nunca lancam, retornam sucesso:false).
    const { taskOk, moveOk } = await acionarHumanoGarantido(telefone, motivo, resumo);
    // Canal adicional best-effort (grupo de suporte via GHL, se configurado).
    // WR-07 (review Fase 5): notificarGrupoSuporte PODE rejeitar (o timeout
    // interno de chamarComResiliencia se aplica mesmo com crise:true) — um
    // throw aqui abortava execute() DEPOIS da pausa/task/move, perdendo o
    // retorno HONESTO {sucesso, mensagem} e impedindo o marcador
    // [SEM-SINAL-HUMANO] de ser emitido exatamente no caminho de GHL flaky
    // pra que ele existe. Falha do grupo vira grupoOk=false, nunca excecao.
    let grupoOk = false;
    try {
      grupoOk = await notificarGrupoSuporte(telefone, motivo, resumo);
    } catch (e) {
      console.error(`[escalate-to-human] notificacao ao grupo lancou para ${telefone} (best-effort, seguindo com retorno honesto):`, e);
    }

    const sucesso = taskOk || moveOk || grupoOk;

    if (!taskOk && !moveOk && !grupoOk) {
      // Nenhum canal humano-visivel foi acionado: task falhou, move falhou
      // E grupo falhou/nao configurado. A IA ja esta pausada, mas ninguem
      // foi avisado por nenhum canal automatico — marcador inconfundivel
      // pra investigacao/dashboard (fechamento CR-02/Gap 7 residual).
      console.error(
        `[escalate-to-human][SEM-SINAL-HUMANO] ${telefone} (${motivo}): nenhum canal de acionamento humano teve sucesso (task, move e grupo falharam) — IA pausada, mas escalacao SEM sinal humano-visivel. Investigar manualmente.`,
      );
    }

    const mensagem = sucesso
      ? `Lead encaminhado para atendente humano. A IA pausou as respostas para esse numero.${taskOk ? ' Task URGENTE criada.' : ''}${moveOk ? ' Card movido para RETORNAR_CONTATO.' : ''}${grupoOk ? ' Grupo de suporte notificado.' : ''}`
      : 'Lead encaminhado para humano e IA pausada, PORÉM o acionamento automatico (task/card/grupo) FALHOU — verificar manualmente com URGENCIA.';

    return { sucesso, mensagem };
  },
});
