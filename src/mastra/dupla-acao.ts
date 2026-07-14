// Modulo de DUPLA ACAO (QUAL-04) do SDR AUTON.
//
// Quando o Qualificador move o lead pra QUALIFICADO, index.ts (webhook do
// formulario, /api/webhook/formulario) chama dispararDuplaAcao(...) — as
// duas acoes disparam em SEQUENCIA (B primeiro, depois A — WR-03), mas
// AMBAS acontecem (nao e "ou": uma falhar nao cancela a outra, o objetivo e
// nunca deixar o SDR humano sem sinal so porque a IA teve um erro de
// rede/LLM, nem deixar de abrir com o lead so porque a task falhou):
//   (A) troca o agente da sessao pra 'camila' e dispara a ABERTURA PROATIVA
//       (a Camila fala primeiro, sem esperar o lead escrever) usando a
//       ancora de abordagem que o Qualificador ja gravou no GHL
//       (ancora_abordagem, custom field lido por read-lead-ficha);
//   (B) cria uma task pro SDR humano, priorizada pelo score BANT (Filtro 3,
//       ja implementado em tools/create-task.ts via prioridadePorBant).
//
// FUN-05 (coordenacao): quem agendar a call primeiro — a IA (Camila, via
// create_calendar_event, tool que entra na 01-07) ou o SDR humano
// diretamente no GHL — move o stage pra CALL_AGENDADA; o outro PARA.
// `podeAgendar`, no fim deste arquivo, e a funcao PURA que resolve esse
// "quem chega primeiro" e sera consultada pela 01-07 antes de qualquer
// tentativa real de agendamento pela IA. O owner (quem ganhou a corrida)
// fica gravado na sessao via `marcarAgendamentoOwner` (sessao.ts).

import { trocarAgente, getSessao } from './sessao';
import { camilaAgent } from './agents/camila';
import { createTask, prioridadePorBant } from './tools/create-task';
import { readLeadFicha } from './tools/read-lead-ficha';
import type { ScoreBant } from './bant';

// Import circular DELIBERADO: despacharSaidaCamila e a mesma funcao
// exportada de index.ts que despacha a saida JSON estrita da Camila em
// resposta as mensagens normais do lead (01-05 Task 3). Reusar essa funcao
// pra abertura proativa evita duplicar a logica de parse + execucao de
// tools_a_executar + envio de mensagens[] (decisao travada em
// 01-CONTEXT.md: "Dispatcher reutilizavel — a abertura proativa da Camila
// (01-06) reusa a mesma funcao"). A referencia circular e segura aqui
// porque despacharSaidaCamila e uma FUNCTION DECLARATION (hoisted) em
// index.ts, e dispararDuplaAcao so a invoca dentro do corpo de uma funcao
// async — nunca no top-level do modulo — entao o binding ja esta populado
// quando a chamada de fato acontece em runtime (o bundler da mastra/esbuild
// resolve o ciclo normalmente, mesmo padrao ja usado por outros modulos
// deste projeto que se importam de volta de index.ts indiretamente).
// WR-03 (3a rodada): comTimeout/comRetry/TIMEOUT_AGENTE/MAX_TENTATIVAS sao
// os MESMOS helpers usados pelos demais agent.generate do projeto — a
// abertura proativa da Camila era o unico generate sem timeout/retry, e um
// hang no Azure travava a acao (A) indefinidamente. Import circular seguro
// pelo mesmo motivo acima (function declarations/consts acessados so em
// call-time, nunca no top-level deste modulo).
import { despacharSaidaCamila, comTimeout, comRetry, TIMEOUT_AGENTE, MAX_TENTATIVAS } from './index';

export interface DispararDuplaAcaoArgs {
  telefone: string;
  contactId?: string;
  nome?: string;
  bant: ScoreBant;
  /** Ancora de abordagem gerada pelo Qualificador (fallback se a releitura da ficha falhar). */
  ancora: string;
}

export interface DispararDuplaAcaoResultado {
  aberturaOk: boolean;
  taskOk: boolean;
}

/**
 * QUAL-04. Dispara as 2 acoes do lead recem-QUALIFICADO: abertura proativa
 * da Camila (A) + task priorizada pro SDR humano (B). Executa em sequencia
 * (B depois A — WR-03: a task nunca espera o LLM) e cada uma tem seu
 * proprio try/catch — uma falhar nao impede a outra de rodar.
 */
export async function dispararDuplaAcao(args: DispararDuplaAcaoArgs): Promise<DispararDuplaAcaoResultado> {
  const { telefone, contactId, nome, bant, ancora } = args;

  // WR-03 (3a rodada): a task pro SDR humano (B) roda PRIMEIRO — ela nao
  // depende da abertura da Camila e e a perna que o cabecalho deste modulo
  // promete nunca perder. Antes, (A) rodava primeiro e uma chamada de LLM
  // pendurada (hang nao e throw — o try/catch nao pega) deixava (B) sem
  // rodar indefinidamente. Alem da reordenacao, o generate de (A) agora tem
  // comTimeout/comRetry (defesa dupla).
  let taskOk = false;
  try {
    taskOk = await dispararTaskPriorizada({ telefone, bant });
  } catch (e) {
    console.error(`[dupla-acao] falha ao criar task priorizada para ${telefone}:`, e);
  }

  let aberturaOk = false;
  try {
    aberturaOk = await dispararAberturaProativaCamila({ telefone, contactId, nome, ancora });
  } catch (e) {
    console.error(`[dupla-acao] falha na abertura proativa da Camila para ${telefone}:`, e);
  }

  console.log(`[dupla-acao] ${telefone} -> abertura=${aberturaOk ? 'ok' : 'falhou'} task=${taskOk ? 'ok' : 'falhou'}`);
  return { aberturaOk, taskOk };
}

// ==================== (A) Abertura proativa da Camila ====================

async function dispararAberturaProativaCamila(args: {
  telefone: string;
  contactId?: string;
  nome?: string;
  ancora: string;
}): Promise<boolean> {
  const { telefone, contactId, nome, ancora } = args;

  // CR-03 (defesa em profundidade): rele a sessao antes de trocar o agente.
  // Se entre o momento em que o Qualificador marcou QUALIFICADO e este ponto
  // o lead foi escalado pra 'humano' (sofrimento agudo/CVV 188, handoff
  // manual), a abertura proativa da Camila e RECUSADA — nao desfaz a pausa
  // de crise por cima. O handler do webhook (index.ts, CR-03) ja suprime o
  // pipeline nesse caso antes de chegar aqui; esta checagem cobre a janela
  // de corrida entre a leitura de la e a execucao deste modulo.
  const sessaoAtual = await getSessao(telefone);
  if (sessaoAtual?.agenteAtual === 'humano') {
    console.log(`[dupla-acao] ${telefone} em atendimento humano — abertura proativa da Camila RECUSADA`);
    return false;
  }

  // Troca o agente da sessao ANTES de gerar a abertura — se a Camila
  // eventualmente for interrompida (erro de rede no meio do generate), o
  // lead ja esta roteado pra ela no proximo turno normal (nao volta pro
  // Qualificador).
  await trocarAgente(telefone, 'camila');

  // Rele a ficha antes de montar a semente do prompt — mesma leitura que a
  // Camila faria no inicio normal de uma conversa (read_lead_ficha, ver
  // agents/camila.ts). A abertura proativa nao passa pelo ciclo normal
  // turno-a-turno de processarMensagem (index.ts) — ninguem mais faria essa
  // leitura por ela, entao o proprio modulo chama a tool direto.
  let nomeFicha = nome;
  let ancoraFicha = '';
  let ancoraQ08 = '';
  try {
    const leitura = (await readLeadFicha.execute!({ telefone, contactId } as any, {} as any)) as {
      sucesso: boolean;
      nome?: string;
      ficha?: Record<string, string>;
    };
    if (leitura?.sucesso) {
      nomeFicha = leitura.nome || nomeFicha;
      ancoraFicha = leitura.ficha?.ancora_abordagem || '';
      ancoraQ08 = leitura.ficha?.aplicou_ads || '';
    }
  } catch (e) {
    console.error(`[dupla-acao] falha ao reler ficha antes da abertura proativa de ${telefone}:`, e);
  }

  // Preferencia: ancora recem-lida do GHL (mais fresca) > ancora recebida
  // como argumento (calculada no momento do webhook, pode ter ficado
  // desatualizada se o Qualificador demorou a gravar).
  const ancoraFinal = ancoraFicha || ancora;

  const seedPromptPartes = [
    `[telefone: ${telefone}] ATENCAO: este e o seu 1o turno de abertura (CAM-01) — o lead AINDA NAO escreveu nada, voce fala primeiro (mensagem proativa).`,
    `Nome do lead: ${nomeFicha || '(nao identificado)'}`,
    `Ancora de abordagem (gerada pelo Qualificador a partir do formulario — use como base da sua abertura personalizada): ${ancoraFinal || '(sem ancora registrada — personalize com o que houver na ficha)'}`,
  ];
  if (ancoraQ08) {
    seedPromptPartes.push(`Dado adicional do form (Q08 — ja aplicou o Metodo ADS?): ${ancoraQ08}`);
  }
  seedPromptPartes.push(
    'Gere sua PRIMEIRA mensagem pra este lead: unica, personalizada, sem template (Safety Envelope item 10). Responda no formato JSON estrito do Output Schema, com acao="responder".',
  );
  const seedPrompt = seedPromptPartes.join('\n');

  // WR-03: mesmo envelope de resiliencia dos demais generates do projeto
  // (index.ts processarMensagem/pipeline do Qualificador) — sem isso, um
  // hang no Azure segurava a abertura (e, antes da reordenacao acima, a
  // task do SDR humano) indefinidamente.
  const resposta = await comRetry(
    () => comTimeout(
      camilaAgent.generate(seedPrompt, {
        memory: { thread: telefone, resource: telefone },
        threadId: telefone,
        resourceId: telefone,
      } as any),
      TIMEOUT_AGENTE,
      'camila-abertura',
    ),
    MAX_TENTATIVAS,
    'camila-abertura',
  );

  // Reusa o dispatcher da 01-05: parseia o JSON, executa tools_a_executar[]
  // e envia mensagens[] respeitando delay_ms[]. JSON invalido -> silencio
  // seguro (T-05-JSON), ja tratado dentro de despacharSaidaCamila.
  return despacharSaidaCamila(telefone, resposta.text || '');
}

// ==================== (B) Task priorizada pro SDR humano ====================

async function dispararTaskPriorizada(args: { telefone: string; bant: ScoreBant }): Promise<boolean> {
  const { telefone, bant } = args;
  const { prioridade } = prioridadePorBant(bant.total);

  const titulo = `Ligar - lead qualificado (${prioridade})`;
  const corpo = [
    'Lead qualificado pelo Qualificador (Filtro 2, BANT >= 5).',
    `BANT: budget=${bant.budget} authority=${bant.authority} need=${bant.need} timing=${bant.timing} total=${bant.total}`,
    `Prioridade: ${prioridade}.`,
    'A Camila vai disparar a abertura proativa no WhatsApp na sequencia — acompanhar o card caso ela precise escalar pra humano.',
  ].join('\n');

  const resultado = (await createTask.execute!({ telefone, titulo, corpo, bantTotal: bant.total } as any, {} as any)) as {
    sucesso: boolean;
  };
  return !!resultado?.sucesso;
}

// ==================== FUN-05 — Coordenacao de agendamento ====================

export type AgendamentoOwner = 'ia' | 'humano';

/**
 * Funcao PURA (sem I/O) — consultada pela 01-07 (agendamento) antes de
 * qualquer tentativa real de criar a call/mover o card pra CALL_AGENDADA.
 * Regra (playbook Sec.7 "Coordenacao: quem agendar primeiro (IA ou SDR
 * humano) move o stage; o outro para"):
 *   - card ja esta em CALL_AGENDADA -> ninguem mais agenda (false pra
 *     qualquer `quem`, mesmo se for o mesmo lado que ja agendou —
 *     idempotencia: mover pra CALL_AGENDADA 2x nao pode gerar efeito
 *     duplicado, ex: 2 eventos de calendario ou 2 notificacoes).
 *   - `ownerAtual` ja setado por OUTRO lado (diferente de `quem`) -> false
 *     pro lado que chegou depois (ele PARA, mesmo que o stage ainda nao
 *     tenha refletido CALL_AGENDADA por um instante de race).
 *   - `ownerAtual` vazio/undefined OU igual a `quem` -> true (pode tentar
 *     agendar; se for igual a `quem`, e o mesmo lado retentando, seguro).
 */
export function podeAgendar(
  stageAtual: string,
  ownerAtual: AgendamentoOwner | undefined,
  quem: AgendamentoOwner,
): boolean {
  if (stageAtual === 'CALL_AGENDADA') return false;
  if (ownerAtual && ownerAtual !== quem) return false;
  return true;
}
