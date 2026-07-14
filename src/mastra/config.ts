// Configuracao central — SDR AUTON Health

// Evolution API — DEPRECATED. Substituido por GoHighLevel (ver GHL_*).
// Mantido apenas pra rollback rapido se precisar.
export const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
export const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
export const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE_NAME || 'sdr-auton';

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
// Closers do overflow de agendamento: Sidnei primeiro, Petriv quando Sidnei sem slot
// (ver .planning/notes/ghl-config-ids.md, secao Closers). IDs GHL, nao sao segredos.
export const GHL_CLOSER_SIDNEI = process.env.GHL_CLOSER_SIDNEI || 'IpN8uafQzHc3Rm6LVd3g';
export const GHL_CLOSER_PETRIV = process.env.GHL_CLOSER_PETRIV || 'rR3bhyhsMMzVssbhzxAR';

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
// Sufixo do host do recurso. Recursos "AI Services" unificados tambem resolvem
// em cognitiveservices.azure.com, mas recursos Azure OpenAI puros (ex.:
// auton-health) SO resolvem em openai.azure.com — ENOTFOUND no outro dominio.
export const AZURE_OPENAI_HOST = process.env.AZURE_OPENAI_HOST || 'openai.azure.com';
// Responses API (/openai/v1/responses) usada pelo @ai-sdk/azure v3 exige
// 2024-10-01-preview ou mais novo. Versoes mais antigas (ex: 2024-08-01-preview)
// retornam BadRequest "API version not supported".
export const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';
export const AZURE_OPENAI_DEPLOYMENT_GPT41 = process.env.AZURE_OPENAI_DEPLOYMENT_GPT41 || 'gpt-4.1';
export const AZURE_OPENAI_DEPLOYMENT_GPT41_MINI = process.env.AZURE_OPENAI_DEPLOYMENT_GPT41_MINI || 'gpt-4.1-mini';
// SDR AUTON — modelos dos agentes novos (Qualificador + Camila). Mesmo azure-client.ts
// (azure.chat(...)), sem provider novo. Se o Azure recusar por api-version, subir
// AZURE_OPENAI_API_VERSION no .env (o default atual e 2024-12-01-preview).
export const AZURE_OPENAI_DEPLOYMENT_GPT51 = process.env.AZURE_OPENAI_DEPLOYMENT_GPT51 || 'gpt-5.1'; // Camila
export const AZURE_OPENAI_DEPLOYMENT_GPT5_MINI = process.env.AZURE_OPENAI_DEPLOYMENT_GPT5_MINI || 'gpt-5-mini'; // Qualificador
// Embedding: o recurso atual tem 'text-embedding-3-large' (3072 dim).
// Atencao: se o pgvector ja foi populado com embeddings 1536d (small), trocar
// para 3-large quebra os indices vetoriais — limpe a tabela antes ou recrie.
export const AZURE_OPENAI_DEPLOYMENT_EMBEDDING = process.env.AZURE_OPENAI_DEPLOYMENT_EMBEDDING || 'text-embedding-3-large';
// Transcricao: 'gpt-4o-transcribe-diarize' substitui Whisper no Azure moderno.
// Mesmo endpoint /audio/transcriptions, deployment diferente.
// whisper (transcricao simples, 1 locutor) — ideal pra nota de voz de WhatsApp.
// O gpt-4o-transcribe-diarize alucinava "falantes" em audio de 1 pessoa so
// (verificado 2026-07-14). Diarize fica reservado pra gravacao de call
// (multi-locutor) se/quando for plugado via env separada.
export const AZURE_OPENAI_DEPLOYMENT_TRANSCRICAO = process.env.AZURE_OPENAI_DEPLOYMENT_TRANSCRICAO || 'whisper';

// Identificador da campanha do lancamento — vai como utm_campaign no link
export const CAMPANHA_NOME = process.env.CAMPANHA_NOME || 'lancamento';

// Webhook do formulario 14q (SDR AUTON, /api/webhook/formulario) — CR-01.
// A rota do Kiwify que validava ?token= foi removida do projeto (quick task
// 260713-t0f); este e o token novo, escrito do zero seguindo o MESMO padrao
// fail-closed acima: vem como ?token=xxx na URL (ou header x-webhook-token)
// e precisa ser colado na URL do GHL Workflow (Automation -> Workflow do
// formulario 14q -> acao de Webhook -> URL). Token vazio = endpoint
// DESABILITADO (nenhum POST e aceito) — sem isso, qualquer POST anonimo
// dispararia qualificacao + mutacao de CRM + mensagem proativa da Camila
// pra um telefone arbitrario (ver 01-REVIEW.md CR-01).
export const FORMULARIO_WEBHOOK_TOKEN = process.env.FORMULARIO_WEBHOOK_TOKEN || '';

if (!FORMULARIO_WEBHOOK_TOKEN) {
  console.warn(
    '[config] FORMULARIO_WEBHOOK_TOKEN vazio: o webhook /api/webhook/formulario esta DESABILITADO ' +
      '(fail-closed) — todo POST sera rejeitado com 401 ate o token ser configurado. Gere um segredo ' +
      "aleatorio (ex: 'openssl rand -hex 24'), coloque no .env do deploy como FORMULARIO_WEBHOOK_TOKEN " +
      "e cole '?token=<esse-segredo>' na URL do GHL Workflow do formulario (stage 'Formulario respondido').",
  );
}

// Webhook de gravacao de call/ligacao (Fase 3, GRAV-01/GRAV-04,
// /api/webhook/gravacao) — MESMO padrao fail-closed de
// FORMULARIO_WEBHOOK_TOKEN acima: segredo dedicado, vem como ?token=xxx na
// URL (ou header x-webhook-token) e precisa ser colado no Workflow GHL que
// dispara ao concluir a gravacao de uma call/ligacao (Automation -> Workflow
// -> acao Webhook). Token vazio = endpoint DESABILITADO (fail-closed) —
// qualquer POST e rejeitado com 401 ANTES de qualquer download/transcricao/
// persistencia (T-03-01).
export const GRAVACAO_WEBHOOK_TOKEN = process.env.GRAVACAO_WEBHOOK_TOKEN || '';

if (!GRAVACAO_WEBHOOK_TOKEN) {
  console.warn(
    '[config] GRAVACAO_WEBHOOK_TOKEN vazio: o webhook /api/webhook/gravacao esta DESABILITADO ' +
      '(fail-closed) — todo POST sera rejeitado com 401 ate o token ser configurado. Gere um segredo ' +
      "aleatorio (ex: 'openssl rand -hex 24'), coloque no .env do deploy como GRAVACAO_WEBHOOK_TOKEN " +
      "e cole '?token=<esse-segredo>' na URL do Workflow GHL que dispara ao concluir a gravacao " +
      'de uma call/ligacao (Automation -> Workflow -> acao Webhook).',
  );
}

// Allowlist de hosts pra baixar recordingUrl (anti-SSRF, T-03-02) — so URLs
// https com host presente nesta lista (ou na familia de dominios do proprio
// GHL, ver ehHostDominioGhl em ghl.ts) sao baixadas por baixarGravacaoBase64;
// qualquer outro host (inclusive IP direto, localhost, hosts internos) e
// recusado antes do fetch.
//
// CR-03: o default e RESTRITO a hosts especificos do GHL/LeadConnector. NAO
// ha mais wildcard *.amazonaws.com (cobria endpoints de computacao
// controlaveis por atacante — API Gateway/ELB — que, combinados com o retry
// Bearer PIT, permitiam exfiltrar o PIT token) nem storage.googleapis.com
// (host multi-tenant: qualquer bucket GCS de terceiro passava).
//
// GRAVACAO_HOSTS_PERMITIDOS (env, lista separada por virgula) e o OVERRIDE
// EXPLICITO do operador: se a URL real de gravacao vier de um bucket
// S3/GCS especifico, adicione o HOST EXATO (ex:
// 'meu-bucket.s3.sa-east-1.amazonaws.com' ou 'storage.googleapis.com') —
// ciente de que hosts de object storage sao multi-tenant (o allowlist
// restringe INFRAESTRUTURA, nao PROPRIEDADE do bucket) e de que o retry com
// Bearer PIT continua bloqueado pra hosts fora do dominio GHL de qualquer
// forma (ghl.ts, CR-03).
export const GRAVACAO_HOSTS_PERMITIDOS = (
  process.env.GRAVACAO_HOSTS_PERMITIDOS ||
  'services.leadconnectorhq.com,msg.leadconnectorhq.com'
)
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

// Webhook de MENSAGENS do WhatsApp (/api/webhook/evolution) — CR-02 (4a
// rodada, 04-REVIEW.md): MESMO padrao fail-closed dos tokens acima. Segredo
// dedicado, vem como ?token=xxx na URL (ou header x-webhook-token). Token
// vazio = endpoint DESABILITADO (fail-closed) — qualquer POST e rejeitado
// com 401 ANTES de qualquer parse/dedup/sessao/buffer.
//
// USER SETUP: a URL deste webhook e configurada na ORIGEM das mensagens de
// WhatsApp. Hoje a origem e o GHL Workflow de mensagens (a rota mantem o
// path legado /api/webhook/evolution pra nao reconfigurar o Workflow) —
// edite a acao de Webhook do Workflow e cole '?token=<segredo>' no fim da
// URL. Se a Evolution API voltar a ser usada como canal (rollback), o mesmo
// token vai na URL do webhook global configurado na instancia da Evolution.
export const EVOLUTION_WEBHOOK_TOKEN = process.env.EVOLUTION_WEBHOOK_TOKEN || '';

if (!EVOLUTION_WEBHOOK_TOKEN) {
  console.warn(
    '[config] EVOLUTION_WEBHOOK_TOKEN vazio: o webhook /api/webhook/evolution (mensagens WhatsApp) esta ' +
      'DESABILITADO (fail-closed) — todo POST sera rejeitado com 401 ate o token ser configurado. Gere um ' +
      "segredo aleatorio (ex: 'openssl rand -hex 24'), coloque no .env do deploy como EVOLUTION_WEBHOOK_TOKEN " +
      "e cole '?token=<esse-segredo>' na URL do webhook de mensagens configurada na origem (GHL Workflow de " +
      'mensagens; ou na instancia da Evolution API, se ela voltar a ser o canal).',
  );
}

// Token admin de /api/desbloquear — CR-03 (4a rodada, 04-REVIEW.md).
// /api/desbloquear desfaz a pausa DURAVEL de crise (limpa bloqueado_ate E
// volta a conversa aguardando_humano pra em_atendimento) — um endpoint que
// desmonta uma escalacao de seguranca (CVV-188) nao pode ser anonimo.
// MESMO padrao fail-closed: vem como ?token=xxx na URL (ou header
// x-admin-token). Token vazio = endpoint DESABILITADO (401 pra todo POST).
export const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';

// Tag no contato do GHL que PAUSA a IA: enquanto estiver presente no contato, a
// Camila nao responde mensagens nem abre proativamente (handoff humano por tag).
// Removida a tag, a IA volta a operar. Fonte da verdade = tags do contato no GHL.
export const TAG_PAUSAR_AGENTE = (process.env.TAG_PAUSAR_AGENTE || 'pausar-agente').trim().toLowerCase();

// Interruptor global da Camila (agente conversacional). CAMILA_ATIVA=false
// desativa a Camila TEMPORARIAMENTE: sem abertura proativa no lead QUALIFICADO
// e sem responder mensagens (leads em estado 'camila' ficam em silencio, humano
// atende). A QUALIFICACAO segue 100% funcional — o Qualificador continua
// pontuando BANT, gravando bant_*/ancora/spin_stage e movendo o card. Default: ativa.
export const CAMILA_ATIVA = (process.env.CAMILA_ATIVA || 'true').trim().toLowerCase() !== 'false';

if (!ADMIN_API_TOKEN) {
  console.warn(
    '[config] ADMIN_API_TOKEN vazio: o endpoint /api/desbloquear esta DESABILITADO (fail-closed) — ' +
      'todo POST sera rejeitado com 401 ate o token ser configurado. Gere um segredo aleatorio ' +
      "(ex: 'openssl rand -hex 24'), coloque no .env do deploy como ADMIN_API_TOKEN e use " +
      "'?token=<esse-segredo>' (ou header x-admin-token) ao chamar o endpoint.",
  );
}

// Allowlist do comando de reset de teste (#55555) — CR-02 (4a rodada).
// resetarConversaTeste DESTROI dados do lead (mensagens, conversas, memoria
// Mastra) e derruba o bloqueio de crise — nao pode ser acionavel por
// conteudo de mensagem de um numero arbitrario. Lista separada por virgula
// de telefones de TESTE (somente digitos, ex: '5511999999999'). Vazia =
// comando DESABILITADO pra todo mundo (fail-closed).
export const RESET_TELEFONES_PERMITIDOS = (process.env.RESET_TELEFONES_PERMITIDOS || '')
  .split(',')
  .map((t) => t.trim().replace(/[^\d]/g, ''))
  .filter(Boolean);

if (RESET_TELEFONES_PERMITIDOS.length === 0) {
  console.warn(
    '[config] RESET_TELEFONES_PERMITIDOS vazio: o comando de reset de teste (#55555) esta DESABILITADO ' +
      '(fail-closed) para todos os numeros. Configure uma lista separada por virgula com os telefones de ' +
      'teste autorizados (somente digitos) para reativa-lo.',
  );
}

// Telefone 1:1 (E.164, ex: '5511999999999') do responsavel de plantao que
// recebe o aviso quando a IA escala pra humano (inclusive sofrimento agudo
// / CVV 188). EXIGENCIA: precisa ser um telefone 1:1 valido — a API oficial
// do GHL NAO entrega mensagem pra grupo de WhatsApp (constraint documentada
// no CLAUDE.md do projeto). NAO usar JID de grupo (formato '<id>@g.us',
// herdado da Evolution) nem '@broadcast' aqui: o aviso seria apenas logado
// (ver notificacoes.ts, enviarAvisoAoSuporte), nunca entregue de fato.
// Vazio = notificacao 1:1 desabilitada; a escalacao ainda garante sinal
// humano-visivel via task URGENTE + move RETORNAR_CONTATO (ver Gap 7/CR-07
// em escalate-to-human.ts) — mas o aviso direto ao plantonista nao ocorre.
export const SUPORTE_GRUPO_JID = process.env.SUPORTE_GRUPO_JID || '';

if (!SUPORTE_GRUPO_JID) {
  console.warn(
    '[config] SUPORTE_GRUPO_JID vazio: a notificacao 1:1 do grupo de suporte esta DESABILITADA. ' +
      'Em escalacoes (inclusive sofrimento agudo/CVV 188), o unico sinal humano-visivel sera a ' +
      'task URGENTE + move de card pra RETORNAR_CONTATO (escalate-to-human.ts). Configure um ' +
      'telefone 1:1 (E.164) do responsavel de plantao pra tambem receber o aviso direto.',
  );
} else if (SUPORTE_GRUPO_JID.includes('@g.us') || SUPORTE_GRUPO_JID.includes('@broadcast')) {
  console.warn(
    `[config] SUPORTE_GRUPO_JID="${SUPORTE_GRUPO_JID}" parece ser um JID de GRUPO do WhatsApp. ` +
      'O GHL (API oficial) NAO entrega mensagens pra grupos WhatsApp — esse aviso sera apenas ' +
      'logado, nunca chega no plantonista. Troque SUPORTE_GRUPO_JID pra um telefone 1:1 (E.164), ' +
      'sem "@g.us"/"@broadcast".',
  );
}

// Tempos
export const JANELA_CONVERSA_FLUIDA = 2 * 60 * 60 * 1000; // 2h
export const DURACAO_BLOQUEIO = 1 * 24 * 60 * 60 * 1000;  // 1 dia

// Dashboard de metricas (Basic Auth em /api/dashboard).
// Se ambos vazios, dashboard responde 503 (nao habilitado) — seguro por default.
export const DASHBOARD_USER = process.env.DASHBOARD_USER || '';
export const DASHBOARD_PASS = process.env.DASHBOARD_PASS || '';
