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

// =================== SDR AUTON — pipeline/calendario GHL (COMERCIAL USI) ===================
// IDs descobertos via API oficial (ver .planning/notes/ghl-config-ids.md). Nao sao segredos.
// Endpoints de opportunities/calendars usam Version 2021-07-28 (conversations usa 2021-04-15).
export const GHL_API_VERSION_V2 = process.env.GHL_API_VERSION_V2 || '2021-07-28';
export const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'zEFpdSK1pMIC9d8aY4Lm';
export const GHL_PIPELINE_ID = process.env.GHL_PIPELINE_ID || 'uVLzqVXjBjI7sACn3vKL'; // COMERCIAL USI
export const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID || 'nZ8n9QSZttjChj1CLwjC'; // Call Comercial USI (45min, Sidney)

// Stages do pipeline COMERCIAL USI (chave logica -> id no GHL). O Qualificador e a
// Camila movem o card via a tool move_pipeline_stage usando estas chaves.
// Nota: no GHL o stage 'FORMULARIO_RESPONDIDO' esta grafado 'FOMULARIO' (typo da conta).
export const GHL_STAGES = {
  LEAD_NOVO: '6408b8ae-ed1a-4e8f-994a-7394d7d0cac7',
  CONTATO_REALIZADO: '89fcc487-6b0f-4ca8-860b-ebcefb2c4673',
  FORMULARIO_RESPONDIDO: 'ed7196f7-f8c8-4d08-8a84-f91586131392',
  QUALIFICADO: 'bc8127ed-0d30-479a-8f36-7377c614f4a9',
  CALL_AGENDADA: '998395cb-f190-4991-8892-e24b45cb26cb',
  RETORNAR_CONTATO: 'c251790d-ff29-47c2-994f-304bb52ddc67',
  NO_SHOW: '5b84348b-2e28-4b40-b11c-cc3bc10f08a4',
  NEGOCIACAO: 'ad667da8-0e38-47d3-a865-f5d5725b4776',
  GANHO: 'd883789c-3b0e-4638-821d-7524e1cb4ebb',
  PERDIDO: '86a27fe8-c759-4bda-a418-072a64275627',
} as const;
export type GhlStage = keyof typeof GHL_STAGES;

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

// Kiwify webhooks — 1 token por produto, vem como ?token=xxx na URL.
// Configurados em Kiwify -> produto -> Settings -> Webhooks. Cada produto
// tem o seu token pra deixar claro qual webhook bateu mesmo se a URL
// vazar. Token vazio = webhook do produto correspondente desabilitado.
export const KIWIFY_TOKEN_CAMINHO = process.env.KIWIFY_TOKEN_CAMINHO || '';
export const KIWIFY_TOKEN_BOLHA = process.env.KIWIFY_TOKEN_BOLHA || '';

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
