// Cliente Azure OpenAI compartilhado.
// Uma unica instancia reutilizada por: agente vendedor (gpt-4.1), processors
// (gpt-4.1-mini), Memory (embedding). Whisper continua via fetch direto em
// evolution.ts porque o Mastra nao tem provider nativo de transcricao.

import { createAzure } from '@ai-sdk/azure';
import {
  AZURE_OPENAI_RESOURCE_NAME,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_API_VERSION,
  AZURE_OPENAI_HOST,
} from './config';

if (!AZURE_OPENAI_RESOURCE_NAME || !AZURE_OPENAI_API_KEY) {
  console.warn(
    '[azure-client] AZURE_OPENAI_RESOURCE_NAME ou AZURE_OPENAI_API_KEY nao configurados. ' +
    'O agente nao vai conseguir gerar respostas ate isso ser corrigido no .env.',
  );
}

// Host configuravel via AZURE_OPENAI_HOST (default openai.azure.com — o
// recurso auton-health NAO resolve em cognitiveservices.azure.com; ENOTFOUND
// verificado em 2026-07-14). Junto com useDeploymentBasedUrls=true, a URL
// final fica <baseURL>/deployments/<deployment>/chat/completions?api-version=...
// que e o formato que azure.chat() espera (compativel com 2024-12-01-preview
// e modelos gpt-5.x).
export const azure = createAzure({
  baseURL: `https://${AZURE_OPENAI_RESOURCE_NAME}.${AZURE_OPENAI_HOST}/openai`,
  apiKey: AZURE_OPENAI_API_KEY,
  apiVersion: AZURE_OPENAI_API_VERSION,
  useDeploymentBasedUrls: true,
});
