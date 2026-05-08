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

export const azure = createAzure({
  resourceName: AZURE_OPENAI_RESOURCE_NAME,
  apiKey: AZURE_OPENAI_API_KEY,
  apiVersion: AZURE_OPENAI_API_VERSION,
});
