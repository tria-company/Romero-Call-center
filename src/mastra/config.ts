// Configuracao central — projeto Roberth (agente de WhatsApp vendedor de curso)

// Evolution API — DEPRECATED. Substituido por GoHighLevel (ver GHL_*).
// Mantido apenas pra rollback rapido se precisar.
export const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
export const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
export const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE_NAME || 'roberth';

// GoHighLevel (canal WhatsApp via API oficial Meta).
// PIT (Private Integration Token): Settings -> Integrations -> Private Integrations.
// Scopes minimos: conversations.write, conversations/message.write, contacts.readonly.
export const GHL_PIT_TOKEN = process.env.GHL_PIT_TOKEN || '';
// Versao da API GHL (LeadConnector). 2021-04-15 e a estavel default.
export const GHL_API_VERSION = process.env.GHL_API_VERSION || '2021-04-15';
// Tipo padrao de mensagem pra envio. Opcoes comuns: 'WhatsApp', 'SMS', 'Email', 'GMB', 'IG', 'FB'.
export const GHL_DEFAULT_TYPE = process.env.GHL_DEFAULT_TYPE || 'WhatsApp';

// OpenAI direto (deprecated — usar Azure abaixo). Mantido para rollback.
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Azure OpenAI — substitui OpenAI direto pra atender requisitos de compliance
// (residencia de dados na regiao Azure). Endpoint base e
// https://<AZURE_OPENAI_RESOURCE_NAME>.openai.azure.com.
export const AZURE_OPENAI_RESOURCE_NAME = process.env.AZURE_OPENAI_RESOURCE_NAME || '';
export const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || '';
// Responses API (/openai/v1/responses) usada pelo @ai-sdk/azure v3 exige
// 2024-10-01-preview ou mais novo. Versoes mais antigas (ex: 2024-08-01-preview)
// retornam BadRequest "API version not supported".
export const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';
export const AZURE_OPENAI_DEPLOYMENT_GPT41 = process.env.AZURE_OPENAI_DEPLOYMENT_GPT41 || 'gpt-4.1';
export const AZURE_OPENAI_DEPLOYMENT_GPT41_MINI = process.env.AZURE_OPENAI_DEPLOYMENT_GPT41_MINI || 'gpt-4.1-mini';
// Embedding: o recurso atual tem 'text-embedding-3-large' (3072 dim).
// Atencao: se o pgvector ja foi populado com embeddings 1536d (small), trocar
// para 3-large quebra os indices vetoriais — limpe a tabela antes ou recrie.
export const AZURE_OPENAI_DEPLOYMENT_EMBEDDING = process.env.AZURE_OPENAI_DEPLOYMENT_EMBEDDING || 'text-embedding-3-large';
// Transcricao: 'gpt-4o-transcribe-diarize' substitui Whisper no Azure moderno.
// Mesmo endpoint /audio/transcriptions, deployment diferente.
export const AZURE_OPENAI_DEPLOYMENT_TRANSCRICAO = process.env.AZURE_OPENAI_DEPLOYMENT_TRANSCRICAO || 'gpt-4o-transcribe-diarize';

// Checkout — 2 URLs Kiwify, uma por produto.
// Sofia recomenda UM produto via decision tree e a tool enviar-checkout
// escolhe a URL com base no parametro `produto`.
//   - CHECKOUT_URL_CAMINHO: Caminho da Rainha (R$ 1.997)
//   - CHECKOUT_URL_BOLHA:   Bolha RR (R$ 2.997)
// CHECKOUT_URL_PRINCIPAL e CHECKOUT_URL_ORDERBUMP ficam por compatibilidade
// como fallback (se as ENVs especificas estiverem vazias, cai pra essas).
export const CHECKOUT_URL_CAMINHO = process.env.CHECKOUT_URL_CAMINHO || '';
export const CHECKOUT_URL_BOLHA = process.env.CHECKOUT_URL_BOLHA || '';
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

// Dashboard de metricas (Basic Auth em /api/dashboard).
// Se ambos vazios, dashboard responde 503 (nao habilitado) — seguro por default.
export const DASHBOARD_USER = process.env.DASHBOARD_USER || '';
export const DASHBOARD_PASS = process.env.DASHBOARD_PASS || '';
