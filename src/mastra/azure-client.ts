// Cliente Azure OpenAI compartilhado.
// Uma unica instancia reutilizada por: agente vendedor (gpt-4.1), processors
// (gpt-4.1-mini), Memory (embedding). Whisper continua via fetch direto em
// evolution.ts porque o Mastra nao tem provider nativo de transcricao.

import { createAzure } from '@ai-sdk/azure';
import {
  AZURE_OPENAI_RESOURCE_NAME,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_API_VERSION,
} from './config';

if (!AZURE_OPENAI_RESOURCE_NAME || !AZURE_OPENAI_API_KEY) {
  console.warn(
    '[azure-client] AZURE_OPENAI_RESOURCE_NAME ou AZURE_OPENAI_API_KEY nao configurados. ' +
    'O agente nao vai conseguir gerar respostas ate isso ser corrigido no .env.',
  );
}

// O recurso atual (Cognitive Services unificado) usa o dominio
// 'cognitiveservices.azure.com' em vez de 'openai.azure.com' (legacy).
// Junto com useDeploymentBasedUrls=true, a URL final fica
// <baseURL>/deployments/<deployment>/chat/completions?api-version=...
// que e o formato que azure.chat() espera (compativel com api-version
// 2024-12-01-preview e modelo gpt-4.1).
export const azure = createAzure({
  baseURL: `https://${AZURE_OPENAI_RESOURCE_NAME}.cognitiveservices.azure.com/openai`,
  apiKey: AZURE_OPENAI_API_KEY,
  apiVersion: AZURE_OPENAI_API_VERSION,
  useDeploymentBasedUrls: true,
});
