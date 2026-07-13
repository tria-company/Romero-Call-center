// Modulo de DUPLA ACAO (QUAL-04) do SDR AUTON.
//
// Quando o Qualificador move o lead pra QUALIFICADO, index.ts (webhook do
// formulario, /api/webhook/formulario) chama dispararDuplaAcao(...) — as
// duas acoes disparam em SEQUENCIA, mas AMBAS acontecem (nao e "ou": uma
// falhar nao cancela a outra, o objetivo e nunca deixar o SDR humano sem
// sinal so porque a IA teve um erro de rede/LLM, nem deixar de abrir com o
// lead so porque a task falhou):
//   (A) troca o agente da sessao pra 'camila' e dispara a ABERTURA PROATIVA
//       (a Camila fala primeiro, sem esperar o lead escrever) usando a
//       ancora de abordagem que o Qualificador ja gravou no GHL
//       (ancora_abordagem, custom field lido por read-lead-ficha);
//   (B) cria uma task pro SDR humano, priorizada pelo score BANT (Filtro 3,
//       ja implementado em tools/create-task.ts via prioridadePorBant).
//
// A regra de COORDENACAO (FUN-05, "quem agenda primeiro move o stage; o
// outro para") entra neste mesmo arquivo na proxima task (podeAgendar).

import { trocarAgente } from './sessao';
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
import { despacharSaidaCamila } from './index';

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
 * (A depois B) mas cada uma tem seu proprio try/catch — uma falhar nao
 * impede a outra de rodar.
 */
export async function dispararDuplaAcao(args: DispararDuplaAcaoArgs): Promise<DispararDuplaAcaoResultado> {
  const { telefone, contactId, nome, bant, ancora } = args;

  let aberturaOk = false;
  try {
    aberturaOk = await dispararAberturaProativaCamila({ telefone, contactId, nome, ancora });
  } catch (e) {
    console.error(`[dupla-acao] falha na abertura proativa da Camila para ${telefone}:`, e);
  }

  let taskOk = false;
  try {
    taskOk = await dispararTaskPriorizada({ telefone, bant });
  } catch (e) {
    console.error(`[dupla-acao] falha ao criar task priorizada para ${telefone}:`, e);
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

  const resposta = await camilaAgent.generate(seedPrompt, {
    memory: { thread: telefone, resource: telefone },
    threadId: telefone,
    resourceId: telefone,
  } as any);

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
    'A Camila ja iniciou a abertura proativa no WhatsApp em paralelo — acompanhar o card caso ela precise escalar pra humano.',
  ].join('\n');

  const resultado = (await createTask.execute!({ telefone, titulo, corpo, bantTotal: bant.total } as any, {} as any)) as {
    sucesso: boolean;
  };
  return !!resultado?.sucesso;
}
