import { PIIDetector } from '@mastra/core/processors';
import { azure } from './azure-client';
import { AZURE_OPENAI_DEPLOYMENT_GPT41_MINI } from './config';

// Modelo leve compartilhado pelos processors restantes (instancia unica via
// factory). azure.chat() usa Chat Completions API (compat com api-version
// 2024-12-01-preview). Default azure() usa Responses API que exige
// 2025-03-01-preview+.
const modeloLeve = azure.chat(AZURE_OPENAI_DEPLOYMENT_GPT41_MINI);

// --- Input Processors ---

/**
 * ⚰️ APOSENTADO (Fase 5, plano 05-01, HARD-01): o detector de prompt
 * injection LLM-based do Mastra (`@mastra/core/processors`, classe
 * "Prompt" + "InjectionDetector" — grafado assim de proposito neste
 * comentario pra nao deixar o simbolo antigo "vivo" em busca textual) que
 * vivia aqui foi DESATIVADO desde o vendedor.ts (Teste 4 / 868jjn1f4) — o
 * prompt interno que o Mastra manda ao gpt-4.1-mini pra classificar
 * jailbreak ERA bloqueado pelo proprio content filter do Azure
 * (responsibleAIPolicyViolation, jailbreak.detected=true), gerando 400 em
 * TODA chamada + 30-60s de latencia de retry antes do agent.generate real
 * comecar. Nunca esteve ligado em nenhum inputProcessors de agent (so
 * exportado, sem uso downstream) — aposenta-lo aqui NAO muda runtime dos
 * agents (camila.ts:inputProcessors=[piiDetector],
 * qualificador.ts:inputProcessors=[piiDetector]).
 *
 * O proprio comentario original recomendava: "refatorar pra
 * implementacao keyword/regex-based local sem LLM call" — e exatamente
 * isso que guardrails/injecao.ts (`detectarInjecao`/`normalizarEntrada`)
 * entrega: deteccao 100% DETERMINISTICA local (regex/keyword multilingue
 * PT+EN, normalizacao anti-bypass de zero-width/unicode), SEM chamar
 * LLM/Azure — elimina o 400/latencia na raiz. Ligado no caminho da Camila
 * em index.ts (processarMensagem, ANTES do agent.generate).
 *
 * Re-export fino abaixo pra quem procurar o simbolo antigo aqui.
 */
export { detectarInjecao } from './guardrails/injecao';

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
 * ⚰️ APOSENTADO (Fase 5, plano 05-05, HARD-02): o scrubber de saida
 * LLM-based do Mastra (`@mastra/core/processors`, classe "System" + "Prompt"
 * + "Scrubber" — grafado assim de proposito neste comentario pra nao deixar
 * o simbolo antigo "vivo" em busca textual) que vivia aqui foi DESATIVADO.
 * Nunca esteve ligado em nenhum outputProcessors de agent (camila.ts:478
 * ja era outputProcessors:[] desde antes deste plano) — aposenta-lo aqui NAO
 * muda runtime. Mesma familia de problema do promptInjectionDetector
 * aposentado no 05-01 (ver acima): o modelo leve usado por este processor
 * (modeloLeve, gpt-4.1-mini) tambem esta sujeito ao content filter do Azure
 * bloquear o proprio prompt interno de rewrite, gerando 400 +
 * latencia de retry.
 *
 * O scrub de PII/anti-vazamento na saida agora e 100% DETERMINISTICO e
 * LOCAL: guardrails/saida.ts (`scrubPII` + `checarFatosAutorizados`),
 * ligado no dispatcher (index.ts:despacharSaidaCamila) ANTES de cada
 * enviarMensagem — sem chamar LLM/Azure. Re-export fino abaixo pra quem
 * procurar um scrub de saida aqui.
 */
export { scrubPII } from './guardrails/saida';
