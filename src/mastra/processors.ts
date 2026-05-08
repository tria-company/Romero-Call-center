import { PromptInjectionDetector, PIIDetector, SystemPromptScrubber } from '@mastra/core/processors';

// --- Input Processors ---

/**
 * Detecta tentativas de prompt injection, jailbreak e manipulacao.
 * Strategy: rewrite — neutraliza o ataque mas preserva a intencao legitima.
 * Usa modelo leve para manter custo baixo.
 */
export const promptInjectionDetector = new PromptInjectionDetector({
  model: 'openai/gpt-4.1-mini',
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
  model: 'openai/gpt-4.1-mini',
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
 * Strategy: redact — substitui por placeholder.
 */
export const systemPromptScrubber = new SystemPromptScrubber({
  model: 'openai/gpt-4.1-mini',
  strategy: 'redact',
  redactionMethod: 'placeholder',
  placeholderText: '[informacao interna]',
});
