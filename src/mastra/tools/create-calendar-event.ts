import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  GHL_PIT_TOKEN,
  GHL_API_VERSION_V2,
  GHL_PIPELINE_ID,
  GHL_CALENDAR_ID,
  GHL_CLOSER_SIDNEI,
  GHL_CLOSER_PETRIV,
  GHL_STAGES,
  GhlStage,
} from '../config';
import { fetchTimeout } from '../http';
import { buscarContactIdPorTelefone } from '../ghl';
import { movePipelineStage } from './move-pipeline-stage';
import { getSessao, marcarAgendamentoOwner } from '../sessao';
import { podeAgendar } from '../dupla-acao';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';

// Tipo de retorno em interface separada (nao inline) pra o smoke script
// conseguir extrair o CORPO REAL de `escolherCloser` via regex sem colidir
// com chaves da anotacao de tipo (mesmo padrao de PrioridadeResultado em
// tools/create-task.ts, ver scripts/smoke-overflow.mjs).
export interface EscolhaCloser {
  closerId: string;
  closer: 'sidnei' | 'petriv';
}

/**
 * FUN-06 — algoritmo DETERMINISTICO de overflow de closer (ver
 * .planning/notes/ghl-config-ids.md, secao Closers): Sidnei tem prioridade
 * absoluta — se ele tiver QUALQUER slot livre no periodo pedido, e sempre
 * ele (mesmo que o Petriv tambem esteja livre). Petriv so entra quando o
 * Sidnei nao tem nenhum slot livre no periodo. Se nenhum dos dois tem slot,
 * retorna null (a Camila ofertar outros horarios / escalar).
 *
 * Funcao PURA — sem I/O, sem dependencia de modulo (recebe os arrays de
 * slots ja buscados). Prova por scripts/smoke-overflow.mjs (3 casos).
 */
export function escolherCloser(
  slotsSidnei: string[],
  slotsPetriv: string[],
): EscolhaCloser | null {
  if (slotsSidnei.length > 0) return { closerId: GHL_CLOSER_SIDNEI, closer: 'sidnei' };
  if (slotsPetriv.length > 0) return { closerId: GHL_CLOSER_PETRIV, closer: 'petriv' };
  return null;
}

/**
 * Gap 4/CR-05 — valida se `startTime` (horario ISO 8601 proposto pelo LLM,
 * NAO confiavel) esta de fato entre os slots livres reais retornados por
 * GET /calendars/{id}/free-slots. Sem essa checagem a tool escolhia o closer
 * so pela DISPONIBILIDADE DE PERIODO (`escolherCloser` checa `length > 0`) e
 * criava o appointment no `startTime` do LLM sem garantir que aquele horario
 * especifico estivesse livre — double-booking em cima de compromisso
 * existente do closer, ou horario alucinado fora do periodo.
 *
 * Normaliza por INSTANTE (epoch via `new Date(x).getTime()`), nao por string
 * — slots e startTime podem vir com timezone/offset diferentes representando
 * o MESMO instante (ex: '...17:00:00Z' === '...14:00:00-03:00'). `NaN`
 * (data invalida em qualquer lado) nunca conta como match.
 *
 * Funcao PURA — sem I/O, sem dependencia de modulo — pro smoke script
 * (scripts/smoke-starttime-validacao.mjs) extrair o corpo real via regex,
 * mesmo padrao de `escolherCloser`/scripts/smoke-overflow.mjs.
 */
export function slotContemHorario(slots: string[], startTime: string): boolean {
  const alvo = new Date(startTime).getTime();
  if (Number.isNaN(alvo)) return false;
  return slots.some((slot) => {
    const instante = new Date(slot).getTime();
    return !Number.isNaN(instante) && instante === alvo;
  });
}

// Mapa reverso stageId -> chave logica, pra resolver o stage ATUAL do card
// antes de consultar podeAgendar (FUN-05) — precisamos saber se o card ja
// esta em CALL_AGENDADA antes de tentar agendar de novo.
const STAGE_ID_TO_KEY = new Map<string, GhlStage>(
  (Object.entries(GHL_STAGES) as Array<[GhlStage, string]>).map(([chave, id]) => [id, chave]),
);

// GET /opportunities/search (V2) — mesma consulta usada por
// tools/move-pipeline-stage.ts (nao exportada de la, entao repetimos aqui
// minimamente so pra ler o pipelineStageId atual, sem duplicar a logica de
// mover o card).
async function buscarStageAtual(contactId: string): Promise<GhlStage | null> {
  const url = `${GHL_BASE_URL}/opportunities/search?contact_id=${encodeURIComponent(contactId)}&pipeline_id=${encodeURIComponent(GHL_PIPELINE_ID)}`;
  const res = await fetchTimeout(url, {
    headers: {
      'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
      'Version': GHL_API_VERSION_V2,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    console.error(`[create-calendar-event] GET /opportunities/search falhou (${res.status}):`, await res.text());
    return null;
  }
  const data = await res.json();
  const stageId = data?.opportunities?.[0]?.pipelineStageId;
  if (!stageId) return null;
  return STAGE_ID_TO_KEY.get(stageId) || null;
}

// Extrai os horarios livres da resposta de GET /calendars/{id}/free-slots.
// A API GHL devolve os slots aninhados por data (formato pode variar entre
// { "<data>": { slots: [...] } } direto na raiz ou embrulhado em outra
// chave, ex: "_dates_") — sem credenciais reais pra validar o shape exato
// neste ambiente (ver checkpoint humano da Task 3), fazemos uma varredura
// tolerante: qualquer objeto aninhado ate 3 niveis com uma chave `slots`
// (array de strings) entra no resultado. Documentado como suposicao no
// SUMMARY da 01-07.
function extrairSlots(data: unknown, profundidade = 0): string[] {
  const slots: string[] = [];
  if (!data || typeof data !== 'object' || profundidade > 3) return slots;
  const node = data as Record<string, unknown>;
  if (Array.isArray(node.slots)) {
    for (const s of node.slots) {
      if (typeof s === 'string') slots.push(s);
    }
  }
  for (const valor of Object.values(node)) {
    if (valor && typeof valor === 'object') {
      slots.push(...extrairSlots(valor, profundidade + 1));
    }
  }
  return slots;
}

async function buscarFreeSlots(userId: string, startDate: string, endDate: string): Promise<string[]> {
  const url = `${GHL_BASE_URL}/calendars/${GHL_CALENDAR_ID}/free-slots?userId=${encodeURIComponent(userId)}&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
  const res = await fetchTimeout(url, {
    headers: {
      'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
      'Version': GHL_API_VERSION_V2,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    console.error(`[create-calendar-event] GET free-slots (userId=${userId}) falhou (${res.status}):`, await res.text());
    return [];
  }
  const data = await res.json();
  return extrairSlots(data);
}

export const createCalendarEvent = createTool({
  id: 'create-calendar-event',
  description:
    'Cria a call comercial no calendario Call Comercial USI com overflow deterministico de closer: tenta o Sidnei primeiro, so usa o Petriv se o Sidnei nao tiver slot livre no periodo pedido (startDate/endDate). Consulta a coordenacao FUN-05 (podeAgendar) antes de qualquer tentativa real — se o SDR humano ja agendou direto no GHL, nao faz nada. Apos criar a call com sucesso, move o card pra CALL_AGENDADA. NUNCA usa PUT no calendario (PUT /calendars/{id} e REPLACE e reseta config omitida).',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    startDate: z.string().describe('Inicio do periodo pra buscar slots livres (formato aceito pela API GHL free-slots, ex: epoch ms)'),
    endDate: z.string().describe('Fim do periodo pra buscar slots livres (formato aceito pela API GHL free-slots, ex: epoch ms)'),
    startTime: z.string().describe('Horario ISO 8601 escolhido pelo lead pra call (ex: 2026-07-20T14:00:00-03:00) — vira o startTime do appointment'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
    motivo: z.string().optional(),
    closer: z.enum(['sidnei', 'petriv']).optional(),
    startTime: z.string().optional(),
    // Gap 4/CR-05: quando nenhum closer tem o startTime pedido, devolve os
    // slots livres (Sidnei+Petriv) pra Camila ofertar alternativas ao lead.
    slotsDisponiveis: z.array(z.string()).optional(),
  }),
  execute: async ({ telefone, startDate, endDate, startTime }) => {
    if (!GHL_PIT_TOKEN) {
      console.error('[create-calendar-event] GHL_PIT_TOKEN nao configurado');
      return { sucesso: false, motivo: 'GHL_PIT_TOKEN nao configurado' };
    }

    const contactId = await buscarContactIdPorTelefone(telefone);
    if (!contactId) {
      console.error(`[create-calendar-event] nao foi possivel resolver contactId para ${telefone}`);
      return { sucesso: false, motivo: 'contactId nao resolvido' };
    }

    // FUN-05: consulta a coordenacao ANTES de qualquer tentativa real de
    // agendar (free-slots/POST) — evita double-booking se o SDR humano ja
    // ganhou a corrida (agendou direto no GHL).
    try {
      const sessao = await getSessao(telefone);
      const stageAtual = (await buscarStageAtual(contactId)) || '';
      if (!podeAgendar(stageAtual, sessao?.agendamentoOwner, 'ia')) {
        console.log(`[create-calendar-event] ${telefone}: agendamento ja resolvido por outro lado (owner=${sessao?.agendamentoOwner || '-'}, stage=${stageAtual || '-'}) — ignorando`);
        return { sucesso: false, motivo: 'agendamento ja resolvido por outro lado' };
      }
    } catch (e) {
      // Falha ao consultar coordenacao nao pode travar o "caminho feliz"
      // (PROJECT.md: "se tudo mais falhar, o agendamento da call qualificada
      // tem que funcionar") — loga e segue, o POST de appointment ainda e
      // seguro (GHL nao duplica evento no mesmo horario/contato).
      console.error(`[create-calendar-event] erro ao consultar coordenacao (FUN-05) para ${telefone}, seguindo mesmo assim:`, e);
    }

    try {
      // Gap 4/CR-05: decisao do closer por HORARIO (nao so por disponibilidade
      // de periodo). Sidnei tem prioridade absoluta — so buscamos os slots do
      // Petriv quando o startTime pedido NAO estiver entre os slots do Sidnei
      // (mesmo que o Sidnei tenha OUTROS slots livres no periodo). Isso fecha
      // o buraco onde `escolherCloser` escolhia o Sidnei so por `length > 0` e
      // o POST usava o startTime do LLM sem checar se aquele horario especifico
      // estava livre pra ele (double-booking em cima de compromisso existente,
      // ou horario alucinado). `escolherCloser` (FUN-06, decisao por PERIODO)
      // continua exportada e testada por scripts/smoke-overflow.mjs — nao
      // regride, so deixa de ser a fonte da decisao final de closer aqui.
      const slotsSidnei = await buscarFreeSlots(GHL_CLOSER_SIDNEI, startDate, endDate);
      let escolha: EscolhaCloser | null = null;
      let slotsPetriv: string[] = [];
      if (slotContemHorario(slotsSidnei, startTime)) {
        escolha = { closerId: GHL_CLOSER_SIDNEI, closer: 'sidnei' };
      } else {
        slotsPetriv = await buscarFreeSlots(GHL_CLOSER_PETRIV, startDate, endDate);
        if (slotContemHorario(slotsPetriv, startTime)) {
          escolha = { closerId: GHL_CLOSER_PETRIV, closer: 'petriv' };
        }
      }
      if (!escolha) {
        console.log(`[create-calendar-event] ${telefone}: startTime ${startTime} nao esta livre pra Sidnei nem Petriv (periodo ${startDate}~${endDate})`);
        return {
          sucesso: false,
          motivo: 'horario indisponivel',
          slotsDisponiveis: [...slotsSidnei, ...slotsPetriv],
        };
      }

      const res = await fetchTimeout(`${GHL_BASE_URL}/calendars/events/appointments`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
          'Version': GHL_API_VERSION_V2,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          calendarId: GHL_CALENDAR_ID,
          contactId,
          startTime,
          assignedUserId: escolha.closerId,
        }),
      });
      if (!res.ok) {
        const erroBody = await res.text();
        console.error(`[create-calendar-event] POST /calendars/events/appointments falhou (${res.status}):`, erroBody);
        return { sucesso: false, motivo: `GHL respondeu ${res.status}` };
      }

      // FUN-01/FUN-05: marca o owner da corrida ANTES de mover o stage (se o
      // move falhar por qualquer motivo, o owner ja fica registrado, evitando
      // que o SDR humano tente agendar de novo em cima da mesma call).
      await marcarAgendamentoOwner(telefone, 'ia');

      const moveResultado = (await movePipelineStage.execute!(
        { telefone, stage: 'CALL_AGENDADA' } as any,
        {} as any,
      )) as { sucesso: boolean; motivo?: string };
      if (!moveResultado?.sucesso) {
        console.error(`[create-calendar-event] call criada mas move-pipeline-stage falhou para ${telefone}: ${moveResultado?.motivo}`);
      }

      console.log(`[create-calendar-event] ${telefone} (${contactId}) -> call criada com ${escolha.closer} (${escolha.closerId}) em ${startTime}`);
      return { sucesso: true, closer: escolha.closer, startTime };
    } catch (e) {
      console.error('[create-calendar-event] erro:', e);
      return { sucesso: false, motivo: 'erro de rede' };
    }
  },
});
