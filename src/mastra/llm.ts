// Provider de IA plugavel — ponto unico dos 3 futuros agentes (Contexto/Script/
// Analise) para obter o modelo de LLM (D-08). Troca de provider e so env
// (LLM_PROVIDER=openai|azure) sem tocar em nenhum agente. OpenAI e o default
// agora (D-08a); Azure fica alcancavel por env quando houver chaves (D-08b).
// NAO cria nenhum agente Mastra aqui — so a abstracao de modelo.

import { createOpenAI } from '@ai-sdk/openai';
import { createAzure } from '@ai-sdk/azure';
import { generateText, type LanguageModel } from 'ai';
import {
  LLM_PROVIDER,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_DEPLOYMENT,
  AZURE_OPENAI_API_VERSION,
} from './config.ts';

/**
 * Normaliza o endpoint Azure informado no .env para o formato que
 * @ai-sdk/azure espera como baseURL, cobrindo os DOIS esquemas suportados
 * (WR-01):
 * - Classico (recurso `*.openai.azure.com`): so remove barra(s) final(is) —
 *   NAO forca `/v1` (esse esquema usa /deployments/{id}?api-version=...).
 * - Azure AI Foundry (projeto, endpoint contem `/api/projects/`) ou outro:
 *   remove barra(s) final(is), remove sufixos acidentais que o usuario pode
 *   colar do painel (`/responses`, `/chat/completions`) e garante o sufixo
 *   `/v1` — esse esquema so aceita `/openai/v1/chat/completions`, sem
 *   api-version (comprovado por curl real: `/deployments/...?api-version=...`
 *   responde "API version not supported" no Foundry).
 * Funcao pura: sem I/O, sem logs.
 */
export function normalizarEndpointAzure(endpoint: string): string {
  const semBarraFinal = endpoint.replace(/\/+$/, '');

  if (semBarraFinal.includes('.openai.azure.com')) {
    return semBarraFinal;
  }

  const semSufixoAcidental = semBarraFinal.replace(/\/(responses|chat\/completions)$/, '');
  return semSufixoAcidental.endsWith('/v1') ? semSufixoAcidental : `${semSufixoAcidental}/v1`;
}

/**
 * Retorna o LanguageModel a usar pelos agentes, selecionado por LLM_PROVIDER.
 * Um modelo unico para os 3 agentes (D-08) — nao diferenciar por agente aqui.
 */
export function modeloLLM(): LanguageModel {
  if (LLM_PROVIDER === 'azure') {
    // Dois esquemas Azure suportados (WR-01), distinguidos pelo endpoint:
    // - Foundry (endpoint contem '/api/projects/'): baseURL termina em
    //   /openai/v1, useDeploymentBasedUrls=false -> URL final e
    //   ${baseURL}${path} SEM api-version (@ai-sdk/azure@4.0.37, index.js
    //   linhas 96-105: !useAzureOpenAIEndpoint -> sem api-version).
    // - Classico (recurso *.openai.azure.com): useDeploymentBasedUrls=true ->
    //   /deployments/{deploymentId}?api-version=... (comportamento original,
    //   preservado EXATAMENTE).
    const ehFoundry = AZURE_OPENAI_ENDPOINT.includes('/api/projects/');

    if (ehFoundry) {
      const azure = createAzure({
        apiKey: AZURE_OPENAI_API_KEY,
        baseURL: normalizarEndpointAzure(AZURE_OPENAI_ENDPOINT),
        useDeploymentBasedUrls: false,
      });
      return azure(AZURE_OPENAI_DEPLOYMENT);
    }

    const azure = createAzure({
      apiKey: AZURE_OPENAI_API_KEY,
      baseURL: AZURE_OPENAI_ENDPOINT || undefined,
      apiVersion: AZURE_OPENAI_API_VERSION || undefined,
      // Usa o formato classico /deployments/{deploymentId}?api-version=... —
      // casa com AZURE_OPENAI_DEPLOYMENT (nome do deployment). Sem esta flag,
      // @ai-sdk/azure@4 monta URLs no esquema novo /v1{path} tratando o
      // argumento como model id, o que quebra o caminho Azure (WR-01).
      useDeploymentBasedUrls: true,
    });
    return azure(AZURE_OPENAI_DEPLOYMENT);
  }

  const openai = createOpenAI({ apiKey: OPENAI_API_KEY });
  return openai(OPENAI_MODEL);
}

/** Config ausente para o provider ativo — sem isso chamarLLM nao faz request (D-09). */
function configAusente(): string | null {
  if (LLM_PROVIDER === 'azure') {
    if (!AZURE_OPENAI_API_KEY || !AZURE_OPENAI_ENDPOINT) {
      return (
        'AZURE_OPENAI_API_KEY / AZURE_OPENAI_ENDPOINT vazio — preencha no .env ' +
        '(LLM_PROVIDER=azure exige as duas)'
      );
    }
    return null;
  }
  if (!OPENAI_API_KEY) {
    return 'OPENAI_API_KEY vazio — preencha no .env';
  }
  return null;
}

/**
 * Chama o LLM ativo (openai|azure conforme LLM_PROVIDER) e retorna o texto
 * gerado. Lanca erro claro de config ausente em vez de fazer a chamada
 * quando a chave do provider ativo nao esta setada (D-09) — nunca vaza o
 * valor da chave, so o nome da variavel faltando.
 */
export async function chamarLLM(prompt: string, system?: string): Promise<string> {
  const erro = configAusente();
  if (erro) {
    throw new Error(`[llm] ${erro}`);
  }

  const { text } = await generateText({
    model: modeloLLM(),
    system,
    prompt,
  });
  return text;
}
