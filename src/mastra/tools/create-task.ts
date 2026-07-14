import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GHL_PIT_TOKEN, GHL_API_VERSION_V2 } from '../config';
import { fetchTimeout } from '../http';
import { buscarContactIdPorTelefone } from '../ghl';
import { consultarNotificacao, registrarNotificacao } from '../notificacoes';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';

export type PrioridadeTask = 'URGENTE' | 'ALTA' | 'MEDIA' | 'BAIXA';

// Tipo de retorno em interface separada (nao inline) pra o smoke script
// conseguir extrair o CORPO da funcao via regex sem colidir com chaves da
// anotacao de tipo (ver scripts/smoke-prioridade-task.mjs).
export interface PrioridadeResultado {
  prioridade: PrioridadeTask;
  horas: number;
}

// Filtro 3 do playbook (BANT total -> prioridade da task pro SDR humano):
// 10-12 URGENTE (<=2h uteis) / 7-9 ALTA (<=24h) / 5-6 MEDIA (<=48h).
// <5 nao deveria virar task (lead e "Perdido" no Filtro 2), mas a funcao
// nao pode quebrar se for chamada mesmo assim — cai em BAIXA/72h.
export function prioridadePorBant(total: number): PrioridadeResultado {
  if (total >= 10) return { prioridade: 'URGENTE', horas: 2 };
  if (total >= 7) return { prioridade: 'ALTA', horas: 24 };
  if (total >= 5) return { prioridade: 'MEDIA', horas: 48 };
  return { prioridade: 'BAIXA', horas: 72 };
}

export const createTask = createTool({
  id: 'create-task',
  description:
    'Cria uma task pro SDR humano no GHL, com prioridade (e prazo) derivados do score BANT do lead. Use apos qualificar o lead (Filtro 2 >=5) pra garantir que o time humano seja acionado dentro do prazo certo.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    titulo: z.string().describe('Titulo curto da task (ex: "Ligar - lead qualificado")'),
    corpo: z.string().describe('Descricao/contexto da task pro SDR humano'),
    bantTotal: z.number().describe('Score BANT total do lead (0-12) — define prioridade e dueDate'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
    motivo: z.string().optional(),
  }),
  execute: async ({ telefone, titulo, corpo, bantTotal }) => {
    // Idempotencia com consult/register SPLIT (CR-01, 3a rodada): a consulta
    // aqui e READ-ONLY — a janela so e registrada la embaixo, APOS o POST na
    // GHL confirmar sucesso real (res.ok). Registrar ANTES da tentativa
    // (padrao antigo, jaNotificouRecentemente) fazia o retry pos-falha
    // devolver {sucesso:true} FAKE sem criar task nenhuma — exatamente o que
    // quebrava o retry honesto de acionarHumanoGarantido (escalate-to-human).
    // Efeito colateral desejado nos demais callers (dispatcher, dupla-acao):
    // uma criacao que FALHOU nao consome a janela e pode ser retentada.
    if (consultarNotificacao(telefone, `create-task:${titulo}`)) {
      console.log(`[create-task] ${telefone} (${titulo}): task ja criada recentemente, ignorando`);
      return { sucesso: true };
    }

    if (!GHL_PIT_TOKEN) {
      console.error('[create-task] GHL_PIT_TOKEN nao configurado');
      return { sucesso: false, motivo: 'GHL_PIT_TOKEN nao configurado' };
    }

    const contactId = await buscarContactIdPorTelefone(telefone);
    if (!contactId) {
      console.error(`[create-task] nao foi possivel resolver contactId para ${telefone}`);
      return { sucesso: false, motivo: 'contactId nao resolvido' };
    }

    const { prioridade, horas } = prioridadePorBant(bantTotal);
    const dueDate = new Date(Date.now() + horas * 60 * 60 * 1000).toISOString();

    try {
      const res = await fetchTimeout(`${GHL_BASE_URL}/contacts/${contactId}/tasks`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
          'Version': GHL_API_VERSION_V2,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ title: titulo, body: corpo, dueDate }),
      });
      if (!res.ok) {
        const erroBody = await res.text();
        console.error(`[create-task] POST /contacts/${contactId}/tasks falhou (${res.status}):`, erroBody);
        return { sucesso: false, motivo: `GHL respondeu ${res.status}` };
      }
      // Sucesso REAL confirmado — so agora a janela de idempotencia e
      // registrada (retries futuros da mesma chamada viram no-op honesto).
      registrarNotificacao(telefone, `create-task:${titulo}`);
      console.log(`[create-task] ${telefone} (${contactId}) <- "${titulo}" prioridade=${prioridade} dueDate=${dueDate}`);
      return { sucesso: true };
    } catch (e) {
      console.error('[create-task] erro:', e);
      return { sucesso: false, motivo: 'erro de rede' };
    }
  },
});
