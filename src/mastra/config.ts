// Configuracao central — projeto Roberth (agente de WhatsApp vendedor de curso)

// Evolution API (WhatsApp)
export const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
export const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
export const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE_NAME || 'roberth';

// OpenAI
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Checkout (Kiwify/Eduzz/Cakto/...) — definir no briefing qual plataforma e qual URL
export const CHECKOUT_URL_PRINCIPAL = process.env.CHECKOUT_URL_PRINCIPAL || '';
export const CHECKOUT_URL_ORDERBUMP = process.env.CHECKOUT_URL_ORDERBUMP || '';

// Identificador da campanha do lancamento — vai como utm_campaign no link
export const CAMPANHA_NOME = process.env.CAMPANHA_NOME || 'lancamento';

// JID do grupo de suporte que recebe notificacao quando a IA chama handoff humano.
// Formato: '<id>@g.us'. Vazio = sem notificacao (apenas pausa a IA).
export const SUPORTE_GRUPO_JID = process.env.SUPORTE_GRUPO_JID || '';

// Tempos
export const JANELA_CONVERSA_FLUIDA = 2 * 60 * 60 * 1000; // 2h
export const DURACAO_BLOQUEIO = 1 * 24 * 60 * 60 * 1000;  // 1 dia
