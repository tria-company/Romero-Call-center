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
