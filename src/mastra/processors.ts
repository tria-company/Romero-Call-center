import { PromptInjectionDetector, PIIDetector, SystemPromptScrubber } from '@mastra/core/processors';
import { azure } from './azure-client';
import { AZURE_OPENAI_DEPLOYMENT_GPT41_MINI } from './config';

// Modelo leve compartilhado pelos 3 processors (instancia unica via factory).
const modeloLeve = azure(AZURE_OPENAI_DEPLOYMENT_GPT41_MINI);

// --- Input Processors ---

/**
 * Detecta tentativas de prompt injection, jailbreak e manipulacao.
 * Strategy: rewrite — neutraliza o ataque mas preserva a intencao legitima.
 * Usa modelo leve para manter custo baixo.
 */
export const promptInjectionDetector = new PromptInjectionDetector({
  model: modeloLeve,
  threshold: 0.7,
  strategy: 'rewrite',
  detectionTypes: [
    'jailbreak',
    'instruction-override',
    'system-manipulation',
  ],
});

/**
 * Detecta dados pessoais sensiveis (CPF, cartao, email, telefone).
 * Strategy: warn — permite a mensagem mas loga warning para auditoria.
 * Importante: nao bloqueia porque o cliente pode precisar enviar CPF para identificacao.
 */
export const piiDetector = new PIIDetector({
  model: modeloLeve,
  threshold: 0.6,
  strategy: 'warn',
  detectionTypes: [
    'credit-card',
    'email',
    'phone',
    'api-key',
  ],
  includeDetections: true,
  preserveFormat: true,
});

// --- Output Processors ---

/**
 * Impede que o agente vaze o system prompt na resposta.
 * Strategy: rewrite — reescreve a mensagem suprimindo trechos internos.
 * Mais limpo visualmente que 'redact' (que deixava "[informacao interna]"
 * no meio da frase, parecendo bug pro lead).
 */
export const systemPromptScrubber = new SystemPromptScrubber({
  model: modeloLeve,
  strategy: 'rewrite',
});
