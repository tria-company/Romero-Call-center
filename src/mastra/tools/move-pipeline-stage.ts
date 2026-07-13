import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GHL_PIT_TOKEN, GHL_API_VERSION_V2, GHL_PIPELINE_ID, GHL_STAGES, GhlStage } from '../config';
import { fetchTimeout } from '../http';
import { buscarContactIdPorTelefone } from '../ghl';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';

const STAGE_KEYS = Object.keys(GHL_STAGES) as [GhlStage, ...GhlStage[]];

// Resolve a opportunity ativa do contato no pipeline COMERCIAL USI.
// GET /opportunities/search aceita contact_id (V2). Pode retornar mais de
// uma opportunity (ex: historico); pegamos a mais recente/aberta.
async function buscarOpportunity(contactId: string): Promise<{ id: string; pipelineStageId: string } | null> {
  const url = `${GHL_BASE_URL}/opportunities/search?contact_id=${encodeURIComponent(contactId)}&pipeline_id=${encodeURIComponent(GHL_PIPELINE_ID)}`;
  const res = await fetchTimeout(url, {
    headers: {
      'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
      'Version': GHL_API_VERSION_V2,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    console.error(`[move-pipeline-stage] GET /opportunities/search falhou (${res.status}):`, await res.text());
    return null;
  }
  const data = await res.json();
  const opp = data?.opportunities?.[0];
  if (!opp?.id) return null;
  return { id: opp.id, pipelineStageId: opp.pipelineStageId };
}

export const movePipelineStage = createTool({
  id: 'move-pipeline-stage',
  description:
    'Move o card do lead no pipeline COMERCIAL USI para o stage informado. Use as chaves logicas de GHL_STAGES (ex: QUALIFICADO, CALL_AGENDADA). Idempotente: se o card ja estiver no stage alvo, nao faz nada e retorna sucesso.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    stage: z.enum(STAGE_KEYS).describe('Chave logica do stage alvo (chave de GHL_STAGES)'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
    motivo: z.string().optional(),
  }),
  execute: async ({ telefone, stage }) => {
    if (!GHL_PIT_TOKEN) {
      console.error('[move-pipeline-stage] GHL_PIT_TOKEN nao configurado');
      return { sucesso: false, motivo: 'GHL_PIT_TOKEN nao configurado' };
    }

    const contactId = await buscarContactIdPorTelefone(telefone);
    if (!contactId) {
      console.error(`[move-pipeline-stage] nao foi possivel resolver contactId para ${telefone}`);
      return { sucesso: false, motivo: 'contactId nao resolvido' };
    }

    const stageIdAlvo = GHL_STAGES[stage];

    try {
      const opportunity = await buscarOpportunity(contactId);
      if (!opportunity) {
        console.error(`[move-pipeline-stage] nenhuma opportunity encontrada para contato ${contactId} no pipeline ${GHL_PIPELINE_ID}`);
        return { sucesso: false, motivo: 'opportunity nao encontrada' };
      }

      // Idempotencia: ja esta no stage alvo, nao falha nem duplica chamada.
      if (opportunity.pipelineStageId === stageIdAlvo) {
        console.log(`[move-pipeline-stage] ${telefone} ja esta em ${stage}, ignorando`);
        return { sucesso: true };
      }

      const res = await fetchTimeout(`${GHL_BASE_URL}/opportunities/${opportunity.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
          'Version': GHL_API_VERSION_V2,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ pipelineId: GHL_PIPELINE_ID, pipelineStageId: stageIdAlvo }),
      });
      if (!res.ok) {
        const erroBody = await res.text();
        console.error(`[move-pipeline-stage] PUT /opportunities/${opportunity.id} falhou (${res.status}):`, erroBody);
        return { sucesso: false, motivo: `GHL respondeu ${res.status}` };
      }
      console.log(`[move-pipeline-stage] ${telefone} (${contactId}) -> ${stage}`);
      return { sucesso: true };
    } catch (e) {
      console.error('[move-pipeline-stage] erro:', e);
      return { sucesso: false, motivo: 'erro de rede' };
    }
  },
});
