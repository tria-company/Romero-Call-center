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
// Vira o FALLBACK GLOBAL do multi-device (Fase 07, DD-07-02 item 3) quando o
// usuario nao tem device dedicado nem ha device de pool disponivel.
export const WAVOIP_DEVICE_TOKEN = process.env.WAVOIP_DEVICE_TOKEN || '';

if (!WAVOIP_DEVICE_TOKEN) {
  console.warn(
    '[config] WAVOIP_DEVICE_TOKEN vazio: o discador nao consegue abrir ligacoes ' +
      '(o SDK do navegador precisa do token do device). Pegue o "Token" do device no ' +
      'painel Wavoip e coloque no .env como WAVOIP_DEVICE_TOKEN.',
  );
}

// ===== Multi-device Wavoip (DEVICE-01, Fase 07 Plano 01) =====
//
// Inventario + mapa dedicado por usuario, lidos por src/mastra/dispositivos.ts
// (resolverConfigDoUsuario). Defaults vazios DE PROPOSITO (degradacao
// graciosa — DD-07-02 item 3: sem nenhuma das duas, o discador volta ao
// comportamento atual de 1 device via WAVOIP_DEVICE_TOKEN acima). NAO emitir
// console.warn com o CONTEUDO destas envs (contem token) — o warn de boot
// (sem valores) fica em dispositivos.ts.

// Inventario de devices: "deviceId:token:numero,...". deviceId e rotulo
// curto e estavel; token e o device token Wavoip; numero e o WhatsApp do
// device (so-digitos, usado no plano 07-03 pro mapeamento reverso).
export const WAVOIP_DEVICES = process.env.WAVOIP_DEVICES || '';

// Device DEDICADO por usuario (DEVICE-01): "usuario:deviceId,...". Parsing
// identico a DISCADOR_ASSIGNEES (operadores.ts).
export const WAVOIP_USER_DEVICES = process.env.WAVOIP_USER_DEVICES || '';

// TTL (ms) da lease de um device do pool (DEVICE-02, Fase 07 Plano 02) — o
// release explicito no fim da chamada e o caminho normal; o TTL e so o
// backstop de crash (atendente caiu/travou com a call ativa). Default 2h
// cobre com folga chamadas de 30-90min. Default sensato -> sem console.warn
// (mesmo espirito de FILA_*).
export const DEVICE_LEASE_TTL_MS = Number(process.env.DEVICE_LEASE_TTL_MS) || 7200000;

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

// ===== API de GERENCIA da Wavoip (auto-descoberta de dispositivos + auto-webhook) =====
//
// Diferente do WAVOIP_DEVICE_TOKEN (por-device, client-side): aqui e o login da
// CONTA (email+senha) que autentica na API REST `api.wavoip.com/v2` e devolve um
// JWT. Com ele o painel de admin LISTA todos os aparelhos (nome/numero/status) e
// GRAVA o webhook automaticamente nos conectados. Server-side only; NUNCA logar.
export const WAVOIP_API_EMAIL = process.env.WAVOIP_API_EMAIL || '';
export const WAVOIP_API_PASSWORD = process.env.WAVOIP_API_PASSWORD || '';
export const WAVOIP_API_BASE = (process.env.WAVOIP_API_BASE || 'https://api.wavoip.com/v2').replace(/\/+$/, '');

// URL PUBLICA do webhook de producao (pra onde a Wavoip manda os eventos). O
// backend anexa `?token=WAVOIP_WEBHOOK_TOKEN` sozinho. Ex.:
// "https://SEU-BACKEND/api/webhook/wavoip". Vazio = auto-webhook desabilitado
// (o painel ainda LISTA os aparelhos, so nao grava webhook).
export const WAVOIP_WEBHOOK_URL = (process.env.WAVOIP_WEBHOOK_URL || '').replace(/\/+$/, '');

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
// LLM_PROVIDER escolhe entre OpenAI direto (D-08a) e Azure OpenAI
// (D-08b, quando houver chaves). Ver src/mastra/llm.ts para a selecao do
// modelo. Um provider unico para os 3 agentes (Contexto/Script/Analise).

// Default AZURE (2026-08-20, ordem do gestor "sempre use Azure" — e a
// constraint do projeto já dizia: os 3 agentes usam Azure OpenAI). OpenAI
// direto continua selecionável com LLM_PROVIDER=openai explícito.
export const LLM_PROVIDER = process.env.LLM_PROVIDER || 'azure';

// OpenAI direto (D-08a) — usado enquanto LLM_PROVIDER=openai (default).
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

if (LLM_PROVIDER !== 'azure' && !OPENAI_API_KEY) {
  console.warn(
    '[config] OPENAI_API_KEY vazio: chamarLLM() nao consegue chamar a IA ' +
      '(nenhuma request e feita sem a chave — D-09). Coloque sua key no .env ' +
      'como OPENAI_API_KEY.',
  );
}

// Azure OpenAI (D-08b) — caminho atual selecionavel via LLM_PROVIDER=azure.
// Suporta os DOIS esquemas de endpoint Azure (ver src/mastra/llm.ts,
// normalizarEndpointAzure/modeloLLM — WR-01): classico (*.openai.azure.com,
// com api-version) e Azure AI Foundry (endpoint com /api/projects/, esquema
// /openai/v1/..., sem api-version).
export const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || '';
export const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || '';
export const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.1';
export const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '';

if (LLM_PROVIDER === 'azure' && (!AZURE_OPENAI_API_KEY || !AZURE_OPENAI_ENDPOINT)) {
  console.warn(
    '[config] AZURE_OPENAI_API_KEY / AZURE_OPENAI_ENDPOINT vazio: chamarLLM() nao ' +
      'consegue chamar a IA no Azure (nenhuma request e feita sem as duas — D-09). ' +
      'Coloque as keys no .env como AZURE_OPENAI_API_KEY / AZURE_OPENAI_ENDPOINT.',
  );
}

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
// Lista 03 AUDIOS (Fase 12, ENVIO-06) — ja existe com os 19 campos certos
// (investigacao previa, PROJECT.md); este modulo so MAPEIA (CAMPOS_AUDIOS em
// clickup.ts), nunca cria lista/campo (D-07).
export const CLICKUP_LIST_AUDIOS = process.env.CLICKUP_LIST_AUDIOS || '1000320000003180';

// Timeout das chamadas de SAÍDA ao ClickUp (fetchClickUp em clickup.ts).
// Separado do default global de 15s do fetchTimeout (http.ts) porque as
// consultas de tasks do workspace chegam a ~45s quando o índice do ClickUp
// degrada (incidente 2026-08-20) — com 15s, 100% abortam e o painel/fila
// ficam presos no cache. 60s cobre a degradação observada; Azure/GHL/Supabase
// continuam nos 15s globais.
export const CLICKUP_TIMEOUT_MS = Number(process.env.CLICKUP_TIMEOUT_MS) || 60000;

// Trava de ESCRITA no ClickUp. Default `true` = comportamento de produção
// (escreve normalmente). O ambiente de HOMOLOG aponta para o ClickUp de
// produção só-leitura: setar CLICKUP_ESCRITA_HABILITADA=false faz o choke
// point fetchClickUp (clickup.ts) BLOQUEAR todo verbo mutante (POST/PUT/DELETE)
// antes de sair — nenhum voto/desfecho/task de homolog toca uma task real.
// Prod-safe por design: só desativa quando explicitamente setado como 'false'.
export const CLICKUP_ESCRITA_HABILITADA = process.env.CLICKUP_ESCRITA_HABILITADA !== 'false';

// Flag por-agregado da inversão Supabase-fonte-da-verdade (Fase B,
// .planning/phases/19-fase-b-inverter-ligacoes-escrita-leitura-juntas/
// 19-CONTEXT.md decisão 13, design §6). Default 'clickup' = comportamento
// ATUAL (escrita/leitura de `ligacoes` via ClickUp; fallback 404→ClickUp
// intacto). 'supabase' ativa a leitura+escrita LOCAL de `ligacoes` JUNTAS
// (R10 — nunca uma sem a outra, pra não deixar o espelho atrasado servir
// fila vazia). O flip só acontece no homolog na verificação final (19-10).
// Não é boolean de propósito: deixa espaço a outros modos (ex.: 'shadow')
// sem quebrar o contrato do caller.
export const FONTE_LIGACOES = process.env.FONTE_LIGACOES || 'clickup';

// ===== Fase 20 (Fase C) — flags por-agregado dos demais espelhos =====
//
// Mesmo racional/molde de FONTE_LIGACOES acima (string, não boolean — deixa
// espaço a modos futuros). Cada `FONTE_*` gateia a escrita+leitura JUNTAS
// daquele agregado (R10 — nunca uma sem a outra). NUNCA reusar
// FONTE_LIGACOES: o roadmap exige que áudios/leads/notas invertam e rolem de
// volta INDEPENDENTES um do outro — um flip/rollback de um agregado não pode
// arrastar os outros. Default 'clickup' = comportamento ATUAL em todos os
// três. O flip acontece só no homolog na verificação final (20-08).
export const FONTE_AUDIOS = process.env.FONTE_AUDIOS || 'clickup';
export const FONTE_LEADS = process.env.FONTE_LEADS || 'clickup';
export const FONTE_NOTAS = process.env.FONTE_NOTAS || 'clickup';

// Workspace (team) cujos MEMBROS aparecem no painel de admin (dropdown do
// vínculo clickup_member_id). Default = Gabinete 509 (9014971829, a mesma das
// listas). O token enxerga várias workspaces; sem esse filtro o painel mistura
// membros de todas elas. Vazio ('') = todas (comportamento antigo).
export const CLICKUP_TEAM_ID = process.env.CLICKUP_TEAM_ID ?? '9014971829';

// [SEM EFEITO desde quick 260815-r12] Antiga trava de env (kill-switch) da
// Lista 01 LEADS (quick 260815-b1). A trava do backend agora é o gate de PAPEL
// gestor (papelDoOperador em operadores.ts): as rotas de leads (GET/POST
// /api/discador/leads*, /lead/:id*) exigem papel 'gestor' — a conta de serviço
// do mobile (admin) é gestor no seed (D-06), então não há mais env a configurar.
// Mantido só como export documentado (nenhum caller lê) para não quebrar
// deploys que ainda tenham a variável setada; pode ser removido no futuro.
export const DISCADOR_LEAD_BROWSE = process.env.DISCADOR_LEAD_BROWSE || '';

// ===== Porta única — redirect do gestor pro painel (quick 260816-u5) =====
//
// URL do painel do gestor (romero-mobile). O discador é a PORTA de todos: o
// login devolve `panelUrl` e a rota /api/discador/me também — o front redireciona
// o GESTOR pra cá (já logado, token no fragmento) e mantém o ATENDENTE na fila.
// Default = o painel em produção (Vercel, u10). O env sobrescreve (ex.: domínio
// próprio ou local http://localhost:3011). Se ficar vazio, degrada gracioso: ninguém
// é redirecionado — todos caem na fila (não quebra). Nunca logar o token no redirect.
export const DISCADOR_PANEL_URL =
  process.env.DISCADOR_PANEL_URL ?? 'https://romero-call-center.vercel.app';

// ===== Lote diario priorizado (LOTE-01, Fase 02 Plano 01) =====
//
// Parametros da selecao/priorizacao do lote do dia (src/mastra/lote.ts).
// Claude's Discretion (D-P2-03): parametrizaveis via env, sem cron nesta fase.

// Numero maximo de tentativas antes do lead sair da elegibilidade do lote.
export const LOTE_LIMITE_TENTATIVAS = Number(process.env.LOTE_LIMITE_TENTATIVAS) || 5;

// Tamanho padrao do lote diario (quantos leads entram na fila de hoje).
export const LOTE_TAMANHO_DEFAULT = Number(process.env.LOTE_TAMANHO_DEFAULT) || 30;

// ===== Operação — status intermediário da Ligação (OPER-02, Fase 03 Plano 01) =====
//
// Nome EXATO (status nativo da Lista 02 LIGACOES) usado por `iniciarLigacao`
// (clickup.ts) para mover a task pra "em processamento" ao tocar Ligar
// (D-P3-07), e por `buscarFilaLigacoes` para excluir essa task da fila
// enquanto ela está sendo processada. Default vazio de proposito — o valor
// real so pode vir do output de `scripts/descobrir-status-ligacoes.mjs`
// (os statuses da Lista 02 sao descobertos, nunca adivinhados no codigo).
export const OPER_STATUS_EM_PROCESSAMENTO = process.env.OPER_STATUS_EM_PROCESSAMENTO || '';

if (!OPER_STATUS_EM_PROCESSAMENTO) {
  console.warn(
    '[config] OPER_STATUS_EM_PROCESSAMENTO vazio: tocar Ligar nao vai mover a task pra ' +
      '"em processamento" nem tira-la da fila (D-P3-07). Rode ' +
      'scripts/descobrir-status-ligacoes.mjs pra descobrir o nome exato do status na Lista 02 ' +
      'e configure no .env.',
  );
}

// ===== Agente Análise — limiar de aderência (OPER-03, Fase 03 Plano 03) =====
//
// Limiar parametrizável (D-P3-10) usado por `necessitaRevisao` (analise.ts):
// aderencia < ANALISE_ADERENCIA_MINIMA marca NECESSITA_REVISAO=true na
// Ligação. O módulo puro não importa esta env — o limiar é injetado como
// argumento pelo webhook (index.ts) e pelos smokes.
export const ANALISE_ADERENCIA_MINIMA = Number(process.env.ANALISE_ADERENCIA_MINIMA) || 6;

// ===== Agente Contexto — regra fixa de PROXIMO_CONTATO (OPER-05, Fase 03 Plano 04) =====
//
// Usados por `proximoContato` (contexto.ts) quando a ligação NÃO trouxe um
// compromisso de retorno explícito (DATA_RETORNO da análise sempre vence
// quando presente — D-P3-14): não atendeu -> hoje + OPER_RETORNO_NAO_ATENDEU_DIAS;
// atendeu sem retorno combinado -> hoje + OPER_RETORNO_DEFAULT_DIAS. O
// módulo puro não importa esta env — os dias são injetados como argumento
// pelo webhook (index.ts) e pelo smoke.
export const OPER_RETORNO_NAO_ATENDEU_DIAS = Number(process.env.OPER_RETORNO_NAO_ATENDEU_DIAS) || 1;
export const OPER_RETORNO_DEFAULT_DIAS = Number(process.env.OPER_RETORNO_DEFAULT_DIAS) || 2;

// ===== Operação — status de fechamento da Ligação (OPER-05, D-P3-06, Fase 03 Plano 04) =====
//
// Nome EXATO do status de conclusão nativo da Lista 02 LIGACOES, descoberto
// via scripts/descobrir-status-ligacoes.mjs (03-01-SUMMARY.md): "complete".
// Usado por `fecharLigacao` (clickup.ts) para fechar a task sozinha no
// pós-processamento (D-P3-06) — sem passo manual do operador ("Próxima" no
// discador só avança a UI). Sobrescrevível via env caso o nome real mude.
export const OPER_STATUS_FECHADO = process.env.OPER_STATUS_FECHADO || 'complete';

// ===== Supabase self-hosted — base de militantes/triagem/follow-ups (DOSS-01/02, Fase 04 Plano 01) =====
//
// Instância self-hosted própria (D-P4-10/11) — NUNCA a instância gerenciada
// pelo MCP desta sessão. `src/mastra/supabase.ts` monta o REST endpoint a
// partir de SUPABASE_URL (nunca hardcoded). SUPABASE_SERVICE_KEY autentica
// server-side only (bypassa RLS) — o valor NUNCA é logado/commitado, só vai
// no .env do usuário (D-P4-11); se vazio, a leitura/descoberta LANÇA erro
// claro em vez de devolver um resultado vazio silencioso (WR-03).
export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

if (!SUPABASE_URL) {
  console.warn(
    '[config] SUPABASE_URL vazio: a ingestão (DOSS-02) e as seções 1/5 do dossiê (DOSS-01) ' +
      'não conseguem ler a base self-hosted de militantes/triagem/follow-ups. Coloque a URL da ' +
      'instância no .env como SUPABASE_URL.',
  );
}
if (!SUPABASE_SERVICE_KEY) {
  console.warn(
    '[config] SUPABASE_SERVICE_KEY vazio: a ingestão (DOSS-02) e as seções 1/5 do dossiê ' +
      '(DOSS-01) não conseguem autenticar na base self-hosted. Coloque a service key (server-side ' +
      'only) no .env como SUPABASE_SERVICE_KEY — NUNCA em log/comentário/docs.',
  );
}

// Mapa de esquema PARAMETRIZÁVEL (descoberto via scripts/descobrir-supabase-ghl.mjs, nunca
// hardcoded — mesmo padrão de OPER_STATUS_EM_PROCESSAMENTO): nomes de tabela default vazio
// (preenchidos pelo humano após rodar a descoberta); colunas de identidade com defaults
// razoáveis a confirmar na descoberta.
export const SUPABASE_TABLE_MILITANTES = process.env.SUPABASE_TABLE_MILITANTES || '';
export const SUPABASE_TABLE_FOLLOWUPS = process.env.SUPABASE_TABLE_FOLLOWUPS || '';

if (!SUPABASE_TABLE_MILITANTES) {
  console.warn(
    '[config] SUPABASE_TABLE_MILITANTES vazio: buscarMilitante não sabe em qual tabela ler. ' +
      'Rode scripts/descobrir-supabase-ghl.mjs para descobrir o nome real da tabela e configure ' +
      'no .env.',
  );
}
if (!SUPABASE_TABLE_FOLLOWUPS) {
  console.warn(
    '[config] SUPABASE_TABLE_FOLLOWUPS vazio: listarFollowUps não sabe em qual tabela ler. ' +
      'Rode scripts/descobrir-supabase-ghl.mjs para descobrir o nome real da tabela e configure ' +
      'no .env.',
  );
}

export const SUPABASE_COL_ID = process.env.SUPABASE_COL_ID || 'id';
export const SUPABASE_COL_CPF = process.env.SUPABASE_COL_CPF || 'cpf';
export const SUPABASE_COL_TELEFONE = process.env.SUPABASE_COL_TELEFONE || 'telefone';
export const SUPABASE_COL_NOME = process.env.SUPABASE_COL_NOME || 'nome';

// Coluna FK da tabela de follow-ups (SUPABASE_TABLE_FOLLOWUPS) que referencia o
// militante dono do follow-up — DISTINTA das colunas de identidade da tabela de
// MILITANTES (SUPABASE_COL_ID/CPF/TELEFONE acima). Default vazio de propósito
// (gap CR-02, 04-VERIFICATION.md): sem esta env, `listarFollowUps` NÃO tenta
// filtrar pelas colunas de militante (isso já causou contaminação cruzada de
// PII — LGPD) — em vez disso lança degradação explícita. Rode
// scripts/descobrir-supabase-ghl.mjs para descobrir as colunas candidatas.
export const SUPABASE_COL_FOLLOWUP_REF = process.env.SUPABASE_COL_FOLLOWUP_REF || '';

if (!SUPABASE_COL_FOLLOWUP_REF) {
  console.warn(
    '[config] SUPABASE_COL_FOLLOWUP_REF vazio: a seção 5 do dossiê (follow-ups) não consegue ' +
      'filtrar pela FK do militante e fica DEGRADADA de propósito — nunca traz follow-up de ' +
      'outra pessoa (LGPD). Rode scripts/descobrir-supabase-ghl.mjs para descobrir a coluna FK ' +
      'real da tabela de follow-ups e configure no .env.',
  );
}

// ===== Supabase self-hosted — tabelas de serviço romero_db_* (seção 5 do dossiê, DOSS-01) =====
//
// Lista CSV das tabelas de serviço prestado que `listarServicosPrestados`
// (supabase.ts) lê para montar a seção 5 do dossiê (histórico real de
// serviços prestados — castração, cirurgias, consultas, cesta básica,
// resgate etc.), além da triagem/follow-ups já lida por SUPABASE_TABLE_FOLLOWUPS.
// SUPABASE_TABLES_SERVICOS no .env sobrescreve; quando vazio, aplica o
// default abaixo com as 17 tabelas reais passadas pelo usuário no processo
// de ingestão. Todas compartilham o mesmo shape por-pessoa (id_contato,
// telefone, servico, status, fase, criado_em, atualizado_em, observacao,
// feedback) — colunas extras de cada tabela NUNCA são selecionadas. Como há
// default sensato, sem console.warn (mesmo espírito de GHL_API_VERSION/
// LOTE_TAMANHO_DEFAULT, que não avisam).
const SUPABASE_TABLES_SERVICOS_DEFAULT = [
  'romero_db_ajuda_diversas',
  'romero_db_carona',
  'romero_db_castracao',
  'romero_db_cesta_basica',
  'romero_db_cirurgias',
  'romero_db_consultas',
  'romero_db_demandas_veterinarias_municipios_parceiros',
  'romero_db_denuncias',
  'romero_db_emergencia',
  'romero_db_emprego_recomendacao',
  'romero_db_exames',
  'romero_db_ghl_adocao',
  'romero_db_medicacao',
  'romero_db_municipios_com_atuacao',
  'romero_db_outros_municipios',
  'romero_db_racao',
  'romero_db_resgate',
];

export const SUPABASE_TABLES_SERVICOS: string[] = process.env.SUPABASE_TABLES_SERVICOS
  ? process.env.SUPABASE_TABLES_SERVICOS.split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  : SUPABASE_TABLES_SERVICOS_DEFAULT;

// ===== Escala — durabilidade do webhook Wavoip (Fase 2, escala-150-atendentes) =====
//
// Tabela no Supabase onde CADA evento do webhook Wavoip é persistido CRU e ANTES
// de processar — a rede de segurança do "não perder nenhuma ligação": se a
// transcrição/LLM/escrita falhar ou o processo cair no meio, o evento fica
// gravado aqui e é reprocessável. Default sensato ('webhook_eventos'), então sem
// console.warn (mesmo espírito de OPER_STATUS_FECHADO). Se o Supabase não estiver
// configurado, a durabilidade degrada para o comportamento atual (processamento
// inline, sem rede de segurança) — NUNCA quebra o webhook.
export const SUPABASE_TABLE_WEBHOOK_EVENTOS = process.env.SUPABASE_TABLE_WEBHOOK_EVENTOS || 'webhook_eventos';

// ===== Gestão de usuários — store de operadores (Fase 11, gestao-de-usuarios) =====
//
// Tabela no Supabase que guarda os operadores do discador (login, hash de senha, papel,
// vínculo opcional com ClickUp/Wavoip) — substitui os mapas env (DISCADOR_USERS/
// DISCADOR_ASSIGNEES/WAVOIP_USER_DEVICES) como fonte viva, lida no login e na tela de
// gestão de usuários do painel admin. Default sensato ('discador_usuarios'), sem
// console.warn (mesmo espírito de SUPABASE_TABLE_WEBHOOK_EVENTOS).
export const SUPABASE_TABLE_USUARIOS = process.env.SUPABASE_TABLE_USUARIOS || 'discador_usuarios';

// ===== Escala — ESPELHO rápido dos leads da Lista 01 (u10, sql/escala/02) =====
//
// Read-model no Postgres pra Base do painel: busca/filtro/paginação em ms em vez de
// ~2,7s/página no ClickUp (inviável p/ 100 mil). ClickUp segue a fonte da verdade;
// o espelho é sincronizado em 2º plano + write-through no voto. Default sensato.
export const SUPABASE_TABLE_LEADS_ESPELHO =
  process.env.SUPABASE_TABLE_LEADS_ESPELHO || 'discador_leads_espelho';

// ===== Fase 13 — conversa WhatsApp por lead (campanha de áudios, sql/escala/03) =====
//
// Read-model da conversa (mensagens dos DOIS lados) + durabilidade do que chega
// pelo webhook da Evolution: a UI lê daqui (ms) e nada se perde em restart do
// processo. ClickUp Lista 03 segue o registro operacional. Default sensato, sem
// console.warn (mesmo espírito de SUPABASE_TABLE_WEBHOOK_EVENTOS).
export const SUPABASE_TABLE_MENSAGENS_WHATSAPP =
  process.env.SUPABASE_TABLE_MENSAGENS_WHATSAPP || 'mensagens_whatsapp';

// Atribuição da declaração de voto ao operador que a colheu (sql/escala/05_votos_ligacao.sql).
// O ClickUp guarda o voto no LEAD, sem operador e sem data; esta tabela guarda o EVENTO.
export const SUPABASE_TABLE_VOTOS_LIGACAO =
  process.env.SUPABASE_TABLE_VOTOS_LIGACAO || 'votos_ligacao';

// ===== Fase 17-A — inversão Supabase-fonte-da-verdade: espelho p/ LEITURA futura =====
//
// Tabelas novas de sql/escala/06..11 (.planning/arquitetura/
// inversao-supabase-fonte-da-verdade.md §2). Mesmo padrão de
// SUPABASE_TABLE_LEADS_ESPELHO: default SEM prefixo (produção); homolog
// sobrescreve com o prefixo hml_ via deploy/homolog.env. NADA lê estas
// tabelas ainda nesta fase — defaults sensatos, sem console.warn.
export const SUPABASE_TABLE_LIGACOES = process.env.SUPABASE_TABLE_LIGACOES || 'ligacoes';
export const SUPABASE_TABLE_AUDIOS_ENVIOS = process.env.SUPABASE_TABLE_AUDIOS_ENVIOS || 'audios_envios';
export const SUPABASE_TABLE_CLICKUP_OUTBOX = process.env.SUPABASE_TABLE_CLICKUP_OUTBOX || 'clickup_outbox';
export const SUPABASE_TABLE_CLICKUP_CAMPO_MAPA =
  process.env.SUPABASE_TABLE_CLICKUP_CAMPO_MAPA || 'clickup_campo_mapa';
export const SUPABASE_TABLE_NOTAS = process.env.SUPABASE_TABLE_NOTAS || 'notas';

// ===== Quick 260822-tdj — persistência de classificação/demanda/super-fã =====
//
// Tabela nova (sql/escala/20_anotacoes_ligacao.sql) para a escrita dupla
// best-effort dos campos estruturados do retorno de ligação. Mesmo padrão de
// isolamento das SUPABASE_TABLE_* acima: default SEM prefixo (produção);
// homolog sobrescreve para 'hml_anotacoes_ligacao' via deploy/homolog.env.
// Default sensato -> sem console.warn.
export const SUPABASE_TABLE_ANOTACOES_LIGACAO =
  process.env.SUPABASE_TABLE_ANOTACOES_LIGACAO || 'anotacoes_ligacao';

// ===== Quick 260822-ubk — linha estruturada de transcrição/análise-IA =====
//
// Tabela nova (sql/escala/21_transcricoes_ligacao.sql) para a linha
// estruturada/queryável de cada ligação transcrita (transcrição, análise-IA,
// metadados). Mesmo padrão de isolamento das SUPABASE_TABLE_* acima: default
// SEM prefixo (produção); homolog sobrescreve para
// 'hml_transcricoes_ligacao' via deploy/homolog.env. Default sensato -> sem
// console.warn.
export const SUPABASE_TABLE_TRANSCRICOES_LIGACAO =
  process.env.SUPABASE_TABLE_TRANSCRICOES_LIGACAO || 'transcricoes_ligacao';

// ===== Fase 18 — Portão 1 (substrato transacional, Caminho B) — nome da RPC =====
//
// Nome da RPC plpgsql que src/mastra/outbox-rpc.ts::comOutboxRpc chama
// (sql/escala/12_rpc_registrar_desfecho.sql). Default SEM prefixo (produção,
// mesmo padrão de isolamento só-env das SUPABASE_TABLE_* acima); homolog
// sobrescreve para 'hml_registrar_desfecho' via deploy/homolog.env — sem
// isso, chamar do homolog escreveria em tabelas de PRODUÇÃO (lição do
// 17-02). Default sensato -> sem console.warn.
export const SUPABASE_RPC_REGISTRAR_DESFECHO =
  process.env.SUPABASE_RPC_REGISTRAR_DESFECHO || 'registrar_desfecho';

// ===== Fase 19 (Fase B) — nomes das demais RPCs do Caminho B =====
//
// Mesmo padrão de isolamento de SUPABASE_RPC_REGISTRAR_DESFECHO acima: default
// SEM prefixo (produção); homolog sobrescreve pra 'hml_<nome>' via
// deploy/homolog.env — sem isso, chamar do homolog escreveria nas RPCs (logo,
// nas tabelas) de PRODUÇÃO (lição do 17-02). Uma RPC plpgsql por mutação de
// `ligacoes`/voto (19-02..19-09) — cada corpo é criado/aplicado nos planos que
// invertem a rota correspondente; aqui só se declara o NOME que
// src/mastra/outbox-rpc.ts::comOutboxRpc vai chamar. Defaults sensatos -> sem
// console.warn.
export const SUPABASE_RPC_INICIAR_LIGACAO = process.env.SUPABASE_RPC_INICIAR_LIGACAO || 'iniciar_ligacao';
export const SUPABASE_RPC_PULAR_LIGACAO = process.env.SUPABASE_RPC_PULAR_LIGACAO || 'pular_ligacao';
export const SUPABASE_RPC_CRIAR_LIGACAO_AVULSA =
  process.env.SUPABASE_RPC_CRIAR_LIGACAO_AVULSA || 'criar_ligacao_avulsa';
export const SUPABASE_RPC_REGISTRAR_VOTO = process.env.SUPABASE_RPC_REGISTRAR_VOTO || 'registrar_voto';
export const SUPABASE_RPC_CONSOLIDAR_E_FECHAR =
  process.env.SUPABASE_RPC_CONSOLIDAR_E_FECHAR || 'consolidar_e_fechar_ligacao';

// ===== Fase 20 (Fase C) — nomes das RPCs novas do Caminho B =====
//
// Mesmo padrão de isolamento das SUPABASE_RPC_* acima: default SEM prefixo
// (produção); homolog sobrescreve pra 'hml_<nome>' via deploy/homolog.env —
// sem isso, chamar do homolog escreveria nas RPCs (logo, nas tabelas) de
// PRODUÇÃO (lição do 17-02). Corpo de cada RPC criado/aplicado nos planos que
// estendem os agregados audios/leads/notas (20-02+); aqui só se declara o
// NOME. Defaults sensatos -> sem console.warn.
export const SUPABASE_RPC_REGISTRAR_ENVIO_AUDIO =
  process.env.SUPABASE_RPC_REGISTRAR_ENVIO_AUDIO || 'registrar_envio_audio';
export const SUPABASE_RPC_REGISTRAR_MENSAGEM_TEXTO =
  process.env.SUPABASE_RPC_REGISTRAR_MENSAGEM_TEXTO || 'registrar_mensagem_texto';
export const SUPABASE_RPC_REGISTRAR_ANOTACAO =
  process.env.SUPABASE_RPC_REGISTRAR_ANOTACAO || 'registrar_anotacao';
export const SUPABASE_RPC_GERAR_LOTE = process.env.SUPABASE_RPC_GERAR_LOTE || 'gerar_lote';

// ===== Fase 19 (Fase B) — teto/threshold do worker de dreno do outbox =====
//
// Consumidos por src/mastra/drenar-outbox.ts (19-03) — o dreno generaliza
// sync-clickup.ts pra empurrar TODO o clickup_outbox (não só votos),
// idempotente, ordenado por `seq` por aggregate. Riscos R6 (head-of-line) e
// R9 (rate cap global fail-closed), 19-CONTEXT.md decisões 3-5. Numéricos
// parseados com `Number(process.env.X) || DEFAULT` — mesmo molde de
// RL_CLICKUP_MAX/RL_CLICKUP_WINDOW_MS (rate-limiter-clickup.ts). Defaults
// sensatos -> sem console.warn.

// Teto GLOBAL de pushes ao ClickUp pelo dreno, somando TODAS as réplicas
// (R9 — fail-CLOSED, não é `concurrency` por-processo). Mesmo teto de
// RL_CLICKUP_MAX (90/min): o dreno de fundo disputa o MESMO balde do ClickUp
// que a fila síncrona dos closers, então o cap vira throughput de sync de
// fundo, nunca latência do usuário.
export const DRENO_RATE_MAX = Number(process.env.DRENO_RATE_MAX) || 90;

// Janela do teto acima (ms) — mesmo molde de RL_CLICKUP_WINDOW_MS.
export const DRENO_RATE_WINDOW_MS = Number(process.env.DRENO_RATE_WINDOW_MS) || 60000;

// Idade (ms) da cabeça de um aggregate no outbox que dispara o alarme de
// head-of-line (R6, ix_outbox_head_age) — reusa alertas.ts::avaliarThresholds.
// Default 2h: uma linha travada bloqueando o push de um aggregate por mais
// que isso é sintoma de algo preso (ClickUp fora, payload inválido, etc.),
// não backlog normal de tráfego.
export const DRENO_HEAD_AGE_ALERTA_MS = Number(process.env.DRENO_HEAD_AGE_ALERTA_MS) || 7200000;

// Habilita o dreno INLINE (síncrono, sem BullMQ) quando não há REDIS_URL —
// mesmo espírito do fallback inline de fila.ts (degradação graciosa "roda
// sem infra opcional"). Boolean-por-env: qualquer valor exceto 'false'
// habilita quando não há Redis (default sensato: sem Redis, o dreno TEM que
// rodar de algum jeito pro outbox não empilhar pra sempre).
export const DRENO_INLINE = process.env.DRENO_INLINE !== 'false';

// Bucket do Supabase Storage p/ o store canônico de gravações (§2.6) —
// consumido a partir do plano 17-05. Default sensato ('gravacoes').
export const SUPABASE_STORAGE_BUCKET_GRAVACOES =
  process.env.SUPABASE_STORAGE_BUCKET_GRAVACOES || 'gravacoes';

// ===== Escala — estado compartilhado do webhook (Fase 5, escala-150-atendentes) =====
//
// URL do Redis usado para compartilhar entre processos/réplicas o estado do webhook
// Wavoip (correlação call→telefone, task ativa por telefone, dedup de RECORD/falha
// terminal) — server-side/rede interna, NUNCA client-side. Default vazio: sem
// REDIS_URL, o estado roda em MEMÓRIA (comportamento atual de 1 instância) — não
// sobrevive a restart nem é compartilhado entre réplicas, mas o loop diário continua
// fechando (degradação graciosa, decisão "construir código primeiro").
export const REDIS_URL = process.env.REDIS_URL || '';

if (!REDIS_URL) {
  console.warn(
    '[config] REDIS_URL vazio: o estado do webhook (correlação call→telefone, task ativa ' +
      'por telefone, dedup de RECORD/falha) roda em MEMÓRIA — não sobrevive a restart nem é ' +
      'compartilhado entre réplicas. Configure REDIS_URL no .env para habilitar o estado ' +
      'compartilhado (necessário para múltiplas réplicas/worker).',
  );
}

// ===== Escala — fila assíncrona de processamento (Fase 6, escala-150-atendentes) =====
//
// Parâmetros da fila BullMQ (src/mastra/fila.ts), que tira o processamento pesado
// (transcrição/análise/consolidação) do caminho síncrono do webhook Wavoip. Todas
// têm default sensato — mesmo espírito de LOTE_TAMANHO_DEFAULT/OPER_STATUS_FECHADO,
// sem console.warn quando há default. Sem REDIS_URL, fila.ts degrada para modo
// inline (comportamento atual de 1 instância) — estas envs só têm efeito em modo bullmq.

// Teto de 3 tentativas por job antes de cair na DLQ (set `failed` do BullMQ) — FILA-03.
// 3 (não 5) alivia a pressão de 429 no storage do Wavoip (cada retry de RECORD re-baixa
// a gravação) e limita quanto tempo uma Ligação fica "em processamento" antes da
// finalização graciosa (finalizarRecordSemTranscricao) fechá-la. Override por env intacto.
export const FILA_ATTEMPTS = Number(process.env.FILA_ATTEMPTS) || 3;

// Delay base (ms) do backoff exponencial entre tentativas — FILA-03.
export const FILA_BACKOFF_MS = Number(process.env.FILA_BACKOFF_MS) || 5000;

// Jobs simultâneos por worker. Teto modesto de propósito: cada job de RECORD pode
// segurar o Deepgram por até 600s (áudio longo) — concorrência alta demais esgota
// o worker sob rajada (defesa T-06-01-DOS).
export const FILA_CONCURRENCY = Number(process.env.FILA_CONCURRENCY) || 4;

// Nome da fila BullMQ (Redis key namespace).
export const FILA_NOME = process.env.FILA_NOME || 'processamento-ligacao';

// URL de webhook para alerta de DLQ (POST best-effort quando um job esgota as
// tentativas — FILA-04). Vazio é modo válido: o alerta fica só no log
// (`[ALERTA][DLQ]`), sem console.warn (mesmo espírito de ALERT_WEBHOOK_URL vazio
// não ser um erro de configuração, e sim um degrau de observabilidade opcional).
export const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';

// ===== Escala — rate limiter global do ClickUp (Fase 8, escala-150-atendentes) =====
//
// Parâmetros do token bucket (src/mastra/rate-limiter-clickup.ts) na frente de TODAS
// as chamadas de saída ao ClickUp (CACHE-02). Todas têm default sensato — mesmo
// espírito de FILA_*, sem console.warn quando há default. Sem REDIS_URL, o bucket
// degrada para modo local por processo (best-effort, ~mesmo teto — D-02).

// Capacidade do balde (tokens/janela) — folga deliberada abaixo dos ~100 req/min
// do ClickUp (D-05).
export const RL_CLICKUP_MAX = Number(process.env.RL_CLICKUP_MAX) || 90;

// Janela de recarga do balde, em ms.
export const RL_CLICKUP_WINDOW_MS = Number(process.env.RL_CLICKUP_WINDOW_MS) || 60000;

// Teto da espera limitada (bounded-wait) ao esvaziar o balde, em ms — nunca espera
// além disso; ao esgotar, deixa passar (fail-open, D-06, nunca gera 429 pro chamador).
export const RL_CLICKUP_WAIT_MAX_MS = Number(process.env.RL_CLICKUP_WAIT_MAX_MS) || 3000;

// ===== Escala — cache-aside de leitura da fila/script (Fase 8, escala-150-atendentes) =====
//
// TTL (ms) do cache-aside Redis (src/mastra/cache-fila.ts) SOBRE o ClickUp para a fila
// do dia + o script/detalhe da Ligação (CACHE-01). O ClickUp permanece a fonte da
// verdade (D-01) — o Redis é só uma rede de segurança de leitura. 45s fica dentro da
// janela 30-60s de D-03 (belt-and-suspenders com invalidação explícita na escrita).
// Default sensato -> sem console.warn (mesmo espírito de RL_CLICKUP_*). Sem REDIS_URL,
// cache-fila.ts degrada para leitura DIRETO ao ClickUp (não para um cache in-process —
// D-02).
export const CACHE_FILA_TTL_MS = Number(process.env.CACHE_FILA_TTL_MS) || 45000;

// ===== Escala — observabilidade/alertas (Fase 10, escala-150-atendentes, OBS-02) =====
//
// Thresholds da checagem periódica de métricas (src/mastra/metricas.ts) — profundidade
// de fila, taxa de erro por etapa e 429s do ClickUp (D-06/D-07). Todas têm default
// sensato — mesmo espírito de FILA_*/RL_CLICKUP_*, sem console.warn quando há default.
// Destino do alerta continua sendo ALERT_WEBHOOK_URL (já definido acima, linha ~388).

// Profundidade de fila (jobs pendentes no BullMQ) que dispara alerta (D-07).
export const METRICAS_FILA_ALERTA = Number(process.env.METRICAS_FILA_ALERTA) || 50;

// Taxa de erro por etapa (0-1) que dispara alerta — ponto de partida sugerido em UI-SPEC.md.
export const METRICAS_ERRO_TAXA_ALERTA = Number(process.env.METRICAS_ERRO_TAXA_ALERTA) || 0.1;

// Janela (ms) sobre a qual a taxa de erro por etapa é calculada — 15 min.
export const METRICAS_ERRO_JANELA_MS = Number(process.env.METRICAS_ERRO_JANELA_MS) || 900000;

// Contagem de 429s reais do ClickUp que dispara alerta na janela abaixo.
export const METRICAS_429_ALERTA = Number(process.env.METRICAS_429_ALERTA) || 5;

// Janela (ms) sobre a qual a contagem de 429s é calculada — 5 min.
export const METRICAS_429_JANELA_MS = Number(process.env.METRICAS_429_JANELA_MS) || 300000;

// Período (ms) da checagem periódica de threshold (D-07) — 1 min.
export const METRICAS_ALERTA_INTERVALO_MS = Number(process.env.METRICAS_ALERTA_INTERVALO_MS) || 60000;

// Janela (ms) em que um operador (presença registrada) ainda conta como "online" — 2 min.
export const METRICAS_PRESENCA_TTL_MS = Number(process.env.METRICAS_PRESENCA_TTL_MS) || 120000;

// ===== Evolution API — canal de envio dedicado de WhatsApp (Fase 12, v3.0 Fluxo A) =====
//
// Client REST (src/mastra/evolution.ts) para a instância dedicada
// (EVOLUTION_INSTANCE, ex. romero-call-center) usada pra ENVIAR o áudio de
// alcance — NUNCA o WhatsApp pessoal do Romero nem o device Wavoip 8761159
// (que é só voz, D-09). Autenticação por header `apikey` (minúsculo, NÃO
// `Authorization: Bearer` — diferente da Wavoip). Segredos SÓ no .env,
// NUNCA logados/commitados (D-09/LGPD) — os console.warn abaixo avisam só a
// AUSÊNCIA, nunca o valor.

export const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
export const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
export const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || '';

// ===== Reservas de envio — FAILOVER de instância (2026-08-20) =====
// Ordem do gestor: "se o número cair, outro que não está conectado com
// ninguém vai pro lugar; se não tiver nenhum, aí manda mensagem no WhatsApp".
// Lista em ORDEM DE PRIORIDADE, ex.: "reserva-1,reserva-2" (mesma apikey
// global da Evolution). Vazio = sem reserva → comportamento atual (queda da
// principal alerta o grupo direto). As instâncias reserva precisam estar
// CRIADAS na Evolution e com o chip conectado (QR) pra assumirem.
export const EVOLUTION_INSTANCES_RESERVA = (process.env.EVOLUTION_INSTANCES_RESERVA || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Fail-closed (mesmo espírito de WAVOIP_WEBHOOK_TOKEN): D-08 exige que o envio
// falhe alto quando mal-configurado, nunca desabilite silencioso.
export const EVOLUTION_WEBHOOK_TOKEN = process.env.EVOLUTION_WEBHOOK_TOKEN || '';

if (!EVOLUTION_WEBHOOK_TOKEN) {
  console.warn(
    '[config] EVOLUTION_WEBHOOK_TOKEN vazio: o webhook de recebimento da Evolution ' +
      '(Fase 13) vai ficar DESABILITADO quando existir. Gere um segredo ' +
      "(ex: 'openssl rand -hex 24') e coloque no .env como EVOLUTION_WEBHOOK_TOKEN.",
  );
}

// ===== Alerta de queda do chip (2026-08-19) =====
//
// Quando a instância PRINCIPAL (EVOLUTION_INSTANCE) cai (connection.update →
// state 'close' no webhook), o backend avisa o time num GRUPO de WhatsApp —
// enviado por uma SEGUNDA instância (EVOLUTION_INSTANCE_ALERTA), porque o
// chip caído não consegue anunciar a própria queda. Default 'avisos-romero'
// (instância criada 2026-08-19 pra isso): o alerta já nasce ARMADO — basta a
// instância existir/conectar na Evolution. `EVOLUTION_INSTANCE_ALERTA=` vazia
// no .env desliga explicitamente.
export const EVOLUTION_INSTANCE_ALERTA =
  process.env.EVOLUTION_INSTANCE_ALERTA !== undefined ? process.env.EVOLUTION_INSTANCE_ALERTA : 'avisos-romero';

// Apikey da instância de ALERTA — só quando a apikey GLOBAL (EVOLUTION_API_KEY)
// não autenticar a instância nova; vazio = usa a global. Segredo SÓ no .env.
export const EVOLUTION_API_KEY_ALERTA = process.env.EVOLUTION_API_KEY_ALERTA || '';

// Nome EXATO (subject) do grupo que recebe o alerta — a instância de ALERTA
// precisa ser MEMBRO do grupo. O JID é resolvido por nome na primeira
// necessidade e fica em cache (evolution.ts).
export const EVOLUTION_GRUPO_ALERTA = process.env.EVOLUTION_GRUPO_ALERTA || 'WHATSAPP TELEMARKETING - CALL CENTER';

// Cooldown do alerta de queda — a Evolution emite vários connection.update
// em sequência num flap de reconexão; no máximo 1 alerta de queda por janela.
export const ALERTA_QUEDA_COOLDOWN_MS = Number(process.env.ALERTA_QUEDA_COOLDOWN_MS) || 15 * 60_000;

// Teto de envios/minuto — alvo ~10-20/min por pesquisa (Pitfall 1, risco de
// banimento do número). Default conservador dentro dessa faixa.
export const EVOLUTION_MAX_POR_MINUTO = Number(process.env.EVOLUTION_MAX_POR_MINUTO) || 15;

// Teto da espera limitada (bounded-wait) do rate limiter de envio — DIFERENTE
// de RL_CLICKUP_WAIT_MAX_MS: ao esgotar, o cap da Evolution SEGURA (não faz
// fail-open, D-06) porque exceder throughput = risco de ban, não atraso
// inócuo. Ver src/mastra/evolution.ts (adquirirTokenEvolution).
export const RL_EVOLUTION_WAIT_MAX_MS = Number(process.env.RL_EVOLUTION_WAIT_MAX_MS) || 5000;

// ===== Painel — números lidos ao vivo (painel-dados.ts) =====
//
// O dashboard passou a ler cada número da fonte CORRETA: cadastros do Postgres
// (users_romero), votos e ligações do ClickUp ao vivo — em vez do task_count da Lista 01
// e do espelho congelado. Como as leituras do ClickUp custam segundos, o módulo serve o
// valor em cache na hora e revalida em segundo plano (stale-while-revalidate). Os TTLs
// abaixo controlam quão atrás da realidade um número pode ficar.

// Cadastros vêm de um count no Postgres (~150ms) — pode ser bem fresco.
export const PAINEL_TTL_BANCO_MS = Number(process.env.PAINEL_TTL_BANCO_MS) || 15000;

// Votos e ligações varrem o ClickUp (2-4s por leitura). 30s mantém o painel vivo sem
// queimar o balde de 90 req/min que a fila dos closers também disputa.
export const PAINEL_TTL_CLICKUP_MS = Number(process.env.PAINEL_TTL_CLICKUP_MS) || 30000;

// Teto de páginas por varredura do ClickUp (100 tasks/página). Protege o dia em que a
// Lista 02 crescer: acima do teto o número vem marcado `parcial` e a UI rotula "N+"
// em vez de mentir um total exato. 30 páginas = 3.000 ligações.
export const PAINEL_MAX_PAGINAS = Number(process.env.PAINEL_MAX_PAGINAS) || 30;
