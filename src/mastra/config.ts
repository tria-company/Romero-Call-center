// Configuracao central — Discador Wavoip (AUTON Health)
//
// Enxuto: apenas o que o discador precisa — credenciais GHL (para listar os
// leads qualificados do pipeline COMERCIAL USI) e o token do device Wavoip
// (para o SDK do navegador abrir a ligacao via WebRTC).

// GoHighLevel (GHL) — PIT (Private Integration Token). Scopes:
// opportunities.readonly (lista de qualificados) + contacts.readonly e
// contacts.write (nota de transcricao no contato). Usado por ghl.ts.
export const GHL_PIT_TOKEN = process.env.GHL_PIT_TOKEN || '';

// Version 2021-04-15 (contacts/notes) e 2021-07-28 (opportunities/contacts-search).
export const GHL_API_VERSION = process.env.GHL_API_VERSION || '2021-04-15';
export const GHL_API_VERSION_V2 = process.env.GHL_API_VERSION_V2 || '2021-07-28';

// Location + pipeline COMERCIAL USI e o stage QUALIFICADO (fonte da lista do discador).
export const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'zEFpdSK1pMIC9d8aY4Lm';
export const GHL_PIPELINE_ID = process.env.GHL_PIPELINE_ID || 'uVLzqVXjBjI7sACn3vKL'; // COMERCIAL USI

// Stages do pipeline COMERCIAL USI (chave logica -> id no GHL). O discador so
// usa QUALIFICADO, mas mantemos o mapa completo por clareza. IDs nao sao segredos.
export const GHL_STAGES = {
  LEAD_NOVO: '6408b8ae-ed1a-4e8f-994a-7394d7d0cac7',
  CONTATO_REALIZADO: '89fcc487-6b0f-4ca8-860b-ebcefb2c4673',
  FORMULARIO_RESPONDIDO: 'ed7196f7-f8c8-4d08-8a84-f91586131392',
  QUALIFICADO: 'bc8127ed-0d30-479a-8f36-7377c614f4a9',
  CALL_AGENDADA: '998395cb-f190-4991-8892-e24b45cb26cb',
  CALL_REALIZADA: '39afb559-afb7-421f-b716-da5c940e6714',
  RETORNAR_CONTATO: 'c251790d-ff29-47c2-994f-304bb52ddc67',
  NO_SHOW: '5b84348b-2e28-4b40-b11c-cc3bc10f08a4',
  NEGOCIACAO: 'ad667da8-0e38-47d3-a865-f5d5725b4776',
  GANHO: 'd883789c-3b0e-4638-821d-7524e1cb4ebb',
  PERDIDO: '86a27fe8-c759-4bda-a418-072a64275627',
} as const;
export type GhlStage = keyof typeof GHL_STAGES;

// Device token da Wavoip pro SDK do NAVEGADOR (PWA discador). E exposto
// client-side por design (o SDK `new Wavoip({tokens:[...]})` precisa dele pra
// abrir a call via WebRTC). Configure WAVOIP_DEVICE_TOKEN no .env.
export const WAVOIP_DEVICE_TOKEN = process.env.WAVOIP_DEVICE_TOKEN || '';

if (!WAVOIP_DEVICE_TOKEN) {
  console.warn(
    '[config] WAVOIP_DEVICE_TOKEN vazio: o discador nao consegue abrir ligacoes ' +
      '(o SDK do navegador precisa do token do device). Pegue o "Token" do device no ' +
      'painel Wavoip e coloque no .env como WAVOIP_DEVICE_TOKEN.',
  );
}

// ===== Transcricao da call (webhook Wavoip -> Deepgram -> nota no GHL) =====

// Token fail-closed do webhook Wavoip (/api/webhook/wavoip). Vem como ?token=xxx
// na URL (ou header x-webhook-token) e e colado no app Wavoip em
// Integrations > Webhook. Token vazio = webhook DESABILITADO (401 em todo POST).
export const WAVOIP_WEBHOOK_TOKEN = process.env.WAVOIP_WEBHOOK_TOKEN || '';

if (!WAVOIP_WEBHOOK_TOKEN) {
  console.warn(
    '[config] WAVOIP_WEBHOOK_TOKEN vazio: o webhook /api/webhook/wavoip (transcricao das calls) ' +
      "esta DESABILITADO. Gere um segredo (ex: 'openssl rand -hex 24'), coloque no .env como " +
      "WAVOIP_WEBHOOK_TOKEN e cole '?token=<segredo>' na URL do webhook no app Wavoip.",
  );
}

// Deepgram — transcricao da gravacao da call (a partir da record_url do evento
// RECORD). A API pre-recorded aceita a URL direto (nao baixamos o audio).
export const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
export const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || 'nova-2';
export const DEEPGRAM_LANGUAGE = process.env.DEEPGRAM_LANGUAGE || 'pt';

if (!DEEPGRAM_API_KEY) {
  console.warn(
    '[config] DEEPGRAM_API_KEY vazio: a transcricao das calls esta DESABILITADA ' +
      '(o webhook Wavoip ainda registra a correlacao, mas nao transcreve). ' +
      'Coloque sua key da Deepgram no .env como DEEPGRAM_API_KEY.',
  );
}

// ===== Provider de IA (LLM) — abstracao plugavel para os 3 agentes =====
//
// LLM_PROVIDER escolhe entre OpenAI direto (default, D-08a) e Azure OpenAI
// (D-08b, quando houver chaves). Ver src/mastra/llm.ts para a selecao do
// modelo. Um provider unico para os 3 agentes (Contexto/Script/Analise).

export const LLM_PROVIDER = process.env.LLM_PROVIDER || 'openai';

// OpenAI direto (D-08a) — usado enquanto LLM_PROVIDER=openai (default).
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

if (!OPENAI_API_KEY) {
  console.warn(
    '[config] OPENAI_API_KEY vazio: chamarLLM() nao consegue chamar a IA ' +
      '(nenhuma request e feita sem a chave — D-09). Coloque sua key no .env ' +
      'como OPENAI_API_KEY.',
  );
}

// Azure OpenAI (D-08b) — caminho futuro, so usado quando LLM_PROVIDER=azure.
// Sem warn-if-empty: Azure nao e o caminho atual, so falha quando selecionado.
export const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || '';
export const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || '';
export const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.1';
export const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '';

// ===== ClickUp — store operacional (Listas 01 LEADS / 02 LIGACOES) =====
//
// O runtime autentica via Personal API Token (REST v2, D-01/D-02) — o token
// tem acesso a workspace 9014971829, onde vivem as listas. NAO usar o MCP do
// ClickUp em runtime (o MCP desta sessao nao enxerga essa workspace).

export const CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN || '';

if (!CLICKUP_API_TOKEN) {
  console.warn(
    '[config] CLICKUP_API_TOKEN vazio: o client ClickUp nao consegue ler/escrever ' +
      'leads/ligacoes (D-01). Pegue o Personal API Token em ClickUp -> Settings -> Apps ' +
      'e coloque no .env como CLICKUP_API_TOKEN.',
  );
}

// IDs das listas ja existentes na workspace 9014971829 (D-04). Nao sao segredos.
export const CLICKUP_LIST_LEADS = process.env.CLICKUP_LIST_LEADS || '1000320000002833';
export const CLICKUP_LIST_LIGACOES = process.env.CLICKUP_LIST_LIGACOES || '1000320000002834';
