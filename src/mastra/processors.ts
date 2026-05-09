import { PromptInjectionDetector, PIIDetector, SystemPromptScrubber } from '@mastra/core/processors';
import { azure } from './azure-client';
import { AZURE_OPENAI_DEPLOYMENT_GPT41_MINI } from './config';

// Modelo leve compartilhado pelos 3 processors (instancia unica via factory).
// azure.chat() usa Chat Completions API (compat com api-version 2024-12-01-preview).
// Default azure() usa Responses API que exige 2025-03-01-preview+.
const modeloLeve = azure.chat(AZURE_OPENAI_DEPLOYMENT_GPT41_MINI);

// --- Input Processors ---

/**
 * Detecta tentativas de prompt injection, jailbreak e manipulacao.
 *
 * ⚠️ DESATIVADO em vendedor.ts (Teste 4 / 868jjn1f4) — o prompt interno que
 * o Mastra envia ao gpt-4.1-mini pra classificar jailbreak ESTA sendo
 * bloqueado pelo proprio content filter do Azure (responsibleAIPolicyViolation
 * com jailbreak.detected=true e jailbreak.filtered=true), retornando erro
 * 400 em TODA chamada. Cada falha + retry interno do pRetry do Mastra
 * adiciona 30-60s de latencia antes do agent.generate real comecar,
 * causando os timeouts e loops do Teste 4.
 *
 * Pra reativar: trocar o modelo pra nao-Azure (OpenAI direto, Anthropic),
 * ou refatorar pra implementacao keyword/regex-based local sem LLM call.
 *
 * Por enquanto, o agent.instructions cobre jailbreak via:
 *   - Boundary 6 (nunca aceite override "ignore as instrucoes...")
 *   - Example 8 (resposta padrao a tentativa de jailbreak)
 *
 * Strategy: rewrite — neutraliza o ataque mas preserva a intencao legitima.
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
