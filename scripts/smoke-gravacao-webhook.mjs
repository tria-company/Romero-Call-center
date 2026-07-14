// Smoke de T-03-01/T-03-02/GRAV-04 (Fase 3, 03-01): prova por LEITURA DE
// FONTE (source-read, mesmo molde de scripts/smoke-webhook-formulario-auth.mjs
// / scripts/smoke-no-show.mjs) que o webhook /api/webhook/gravacao
// (src/mastra/index.ts) e o download em src/mastra/ghl.ts seguem a ORDEM
// correta:
//
//   (a) autenticacao (GRAVACAO_WEBHOOK_TOKEN, fail-closed) roda ANTES de
//       qualquer download/transcricao/persistencia — um POST sem token
//       valido nunca chega perto de baixar a gravacao ou mutar o CRM.
//   (b) persistirTranscricaoContato so e chamado DEPOIS do gate `.ok` da
//       anonimizacao — a transcricao bruta nunca persiste (GRAV-04).
//   (c) baixarGravacaoBase64 valida host allowlist + https ANTES do fetch
//       (anti-SSRF, T-03-02) — nao baixa URL arbitraria do payload.
//
// Por que source-read (nao unit-test comportamental completo do handler):
// index.ts/ghl.ts importam dezenas de modulos com imports relativos sem
// extensao que o loader nativo de TS do Node (--experimental-strip-types)
// nao resolve fora do bundler do Mastra — mesma limitacao documentada em
// smoke-webhook-formulario-dedup.mjs / smoke-escalacao.mjs. As asserções por
// regex comparam INDICES de string (`.indexOf`) pra provar ORDEM de codigo,
// nao so presenca — um trecho presente mas fora de ordem tambem falha o
// smoke.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const indexPath = resolve(projectRoot, 'src/mastra/index.ts');
const ghlPath = resolve(projectRoot, 'src/mastra/ghl.ts');
const configPath = resolve(projectRoot, 'src/mastra/config.ts');
const extracaoPath = resolve(projectRoot, 'src/mastra/extracao-sinais.ts');
const ucfPath = resolve(projectRoot, 'src/mastra/tools/update-contact-field.ts');

const indexSrc = await readFile(indexPath, 'utf8').catch(() => null);
const ghlSrc = await readFile(ghlPath, 'utf8').catch(() => null);
const configSrc = await readFile(configPath, 'utf8').catch(() => null);
const extracaoSrc = await readFile(extracaoPath, 'utf8').catch(() => null);
const ucfSrc = await readFile(ucfPath, 'utf8').catch(() => null);

const falhas = [];
function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

if (indexSrc === null) {
  console.error(`[smoke-gravacao-webhook] FALHOU: arquivo nao encontrado (${indexPath})`);
  process.exit(1);
}
if (ghlSrc === null) {
  console.error(`[smoke-gravacao-webhook] FALHOU: arquivo nao encontrado (${ghlPath})`);
  process.exit(1);
}
if (configSrc === null) {
  console.error(`[smoke-gravacao-webhook] FALHOU: arquivo nao encontrado (${configPath})`);
  process.exit(1);
}
if (extracaoSrc === null) {
  console.error(`[smoke-gravacao-webhook] FALHOU: arquivo nao encontrado (${extracaoPath})`);
  process.exit(1);
}
if (ucfSrc === null) {
  console.error(`[smoke-gravacao-webhook] FALHOU: arquivo nao encontrado (${ucfPath})`);
  process.exit(1);
}

// ---------------------------------------------------------------------
// 0. Config: GRAVACAO_WEBHOOK_TOKEN fail-closed (mesmo padrao de
// FORMULARIO_WEBHOOK_TOKEN) + GRAVACAO_HOSTS_PERMITIDOS (allowlist).
// ---------------------------------------------------------------------
checar(
  "config.ts exporta GRAVACAO_WEBHOOK_TOKEN (process.env.GRAVACAO_WEBHOOK_TOKEN || '')",
  /export const GRAVACAO_WEBHOOK_TOKEN\s*=\s*process\.env\.GRAVACAO_WEBHOOK_TOKEN\s*\|\|\s*''/.test(configSrc),
);
checar(
  'config.ts avisa (console.warn) quando GRAVACAO_WEBHOOK_TOKEN esta vazio (fail-closed, endpoint desabilitado)',
  /if\s*\(!GRAVACAO_WEBHOOK_TOKEN\)\s*\{[\s\S]{0,400}?console\.warn/.test(configSrc),
);
checar(
  'config.ts exporta GRAVACAO_HOSTS_PERMITIDOS (allowlist anti-SSRF)',
  /export const GRAVACAO_HOSTS_PERMITIDOS\s*=/.test(configSrc),
);

// ---------------------------------------------------------------------
// 1. Isola o CORPO do handler '/api/webhook/gravacao' em index.ts.
// ---------------------------------------------------------------------
const inicioHandler = indexSrc.indexOf("path: '/api/webhook/gravacao'");
checar("rota '/api/webhook/gravacao' encontrada em index.ts", inicioHandler !== -1);

let handlerBody = '';
if (inicioHandler !== -1) {
  const restoAposInicio = indexSrc.slice(inicioHandler + "path: '/api/webhook/gravacao'".length);
  const proximoPathRelativo = restoAposInicio.indexOf("path: '");
  checar('proxima rota (path:) encontrada apos o handler de gravacao (para isolar o corpo)', proximoPathRelativo !== -1);
  handlerBody = proximoPathRelativo !== -1 ? restoAposInicio.slice(0, proximoPathRelativo) : restoAposInicio;
}

checar(
  "index.ts importa GRAVACAO_WEBHOOK_TOKEN de './config'",
  /import\s*\{[^}]*GRAVACAO_WEBHOOK_TOKEN[^}]*\}\s*from\s*['"]\.\/config['"]/.test(indexSrc),
);
checar(
  "index.ts importa baixarGravacaoBase64 e persistirTranscricaoContato de './ghl'",
  /import\s*\{[^}]*baixarGravacaoBase64[^}]*\}\s*from\s*['"]\.\/ghl['"]/.test(indexSrc) &&
    /import\s*\{[^}]*persistirTranscricaoContato[^}]*\}\s*from\s*['"]\.\/ghl['"]/.test(indexSrc),
);
checar(
  "index.ts importa anonimizarTranscricao de './anonimizacao'",
  /import\s*\{[^}]*anonimizarTranscricao[^}]*\}\s*from\s*['"]\.\/anonimizacao['"]/.test(indexSrc),
);

if (handlerBody) {
  // -----------------------------------------------------------------
  // (a) T-03-01: auth fail-closed ANTES de qualquer download/transcricao/
  // persistencia/dedup.
  // -----------------------------------------------------------------
  const idxTokenRef = handlerBody.indexOf('GRAVACAO_WEBHOOK_TOKEN');
  checar('corpo do handler referencia GRAVACAO_WEBHOOK_TOKEN', idxTokenRef !== -1);

  const idxUnauthorized = handlerBody.indexOf("status: 'unauthorized' }, 401");
  checar("corpo do handler retorna c.json({ status: 'unauthorized' }, 401)", idxUnauthorized !== -1);

  const idxTentarRegistrarWebhook = handlerBody.indexOf('tentarRegistrarWebhook(');
  const idxBaixarGravacao = handlerBody.indexOf('baixarGravacaoBase64(');
  const idxTranscreverAudio = handlerBody.indexOf('transcreverAudio(');
  const idxAnonimizar = handlerBody.indexOf('anonimizarTranscricao(');
  const idxPersistir = handlerBody.indexOf('persistirTranscricaoContato(');

  checar('tentarRegistrarWebhook e chamado dentro do corpo do handler (dedup)', idxTentarRegistrarWebhook !== -1);
  checar('baixarGravacaoBase64 e chamado dentro do corpo do handler', idxBaixarGravacao !== -1);
  checar('transcreverAudio e chamado dentro do corpo do handler', idxTranscreverAudio !== -1);
  checar('anonimizarTranscricao e chamado dentro do corpo do handler', idxAnonimizar !== -1);
  checar('persistirTranscricaoContato e chamado dentro do corpo do handler', idxPersistir !== -1);

  if (idxTokenRef !== -1 && idxUnauthorized !== -1) {
    checar(
      'T-03-01: validacao de token (referencia a GRAVACAO_WEBHOOK_TOKEN) aparece ANTES do retorno 401 unauthorized',
      idxTokenRef < idxUnauthorized,
    );
  }
  if (idxUnauthorized !== -1 && idxTentarRegistrarWebhook !== -1) {
    checar('T-03-01: 401 unauthorized aparece ANTES de tentarRegistrarWebhook (fail-closed antes do dedup)', idxUnauthorized < idxTentarRegistrarWebhook);
  }
  if (idxUnauthorized !== -1 && idxBaixarGravacao !== -1) {
    checar('T-03-01: 401 unauthorized aparece ANTES de baixarGravacaoBase64 (fail-closed antes do download)', idxUnauthorized < idxBaixarGravacao);
  }
  if (idxUnauthorized !== -1 && idxTranscreverAudio !== -1) {
    checar('T-03-01: 401 unauthorized aparece ANTES de transcreverAudio (fail-closed antes da transcricao)', idxUnauthorized < idxTranscreverAudio);
  }
  if (idxUnauthorized !== -1 && idxPersistir !== -1) {
    checar('T-03-01: 401 unauthorized aparece ANTES de persistirTranscricaoContato (fail-closed antes da persistencia)', idxUnauthorized < idxPersistir);
  }

  // -----------------------------------------------------------------
  // (b) GRAV-04: persistirTranscricaoContato so DEPOIS do gate `.ok` da
  // anonimizacao (raw nunca persiste).
  // -----------------------------------------------------------------
  const idxAnonimizacaoOk = handlerBody.search(/if\s*\(!anonimizacao\.ok\)/);
  checar('corpo do handler checa !anonimizacao.ok (gate LGPD)', idxAnonimizacaoOk !== -1);

  const idxAnonimizacaoFalhouLog = handlerBody.indexOf('anonimizacao falhou');
  checar(
    "corpo do handler loga 'anonimizacao falhou' sem incluir o texto bruto (so o marcador)",
    idxAnonimizacaoFalhouLog !== -1,
  );

  if (idxAnonimizar !== -1 && idxAnonimizacaoOk !== -1) {
    checar('GRAV-04: chamada a anonimizarTranscricao(...) aparece ANTES da checagem do gate .ok', idxAnonimizar < idxAnonimizacaoOk);
  }
  if (idxAnonimizacaoOk !== -1 && idxPersistir !== -1) {
    checar('GRAV-04: persistirTranscricaoContato(...) so aparece DEPOIS do gate !anonimizacao.ok (raw nunca persiste)', idxAnonimizacaoOk < idxPersistir);
  }

  // Handler NAO pode logar a transcricao bruta nem o texto anonimizado —
  // so contadores/tamanhos. Nenhuma linha de console.* deve referenciar
  // transcricaoBruta ou anonimizacao.textoAnon diretamente.
  checar(
    'corpo do handler NUNCA loga transcricaoBruta (LGPD — dado bruto nao vai pra log)',
    !/console\.(log|error|warn)\([^)]*transcricaoBruta/.test(handlerBody),
  );
  checar(
    'corpo do handler NUNCA loga anonimizacao.textoAnon (LGPD — mesmo anonimizado, nao vai pro log do handler)',
    !/console\.(log|error|warn)\([^)]*anonimizacao\.textoAnon/.test(handlerBody),
  );

  // Handler nao deve chamar enviarMensagem/enviarMensagemUnica — persistencia
  // de dado, nao acao proativa ao lead.
  checar(
    'corpo do handler NAO envia mensagem ao lead (sem enviarMensagem(...))',
    !/enviarMensagem\(/.test(handlerBody),
  );

  // -----------------------------------------------------------------
  // Validacao do payload: tipo restrito a sdr_ligacao/closer_call e telefone
  // obrigatorio, com 400 em payload invalido.
  // -----------------------------------------------------------------
  checar(
    "corpo do handler valida tipo em {'sdr_ligacao','closer_call'}",
    /tipoRaw\s*===\s*['"]sdr_ligacao['"]/.test(handlerBody) && /tipoRaw\s*===\s*['"]closer_call['"]/.test(handlerBody),
  );
  checar(
    "corpo do handler retorna 400 em payload invalido (status: 'payload invalido')",
    /status:\s*['"]payload invalido['"]\s*\},\s*400/.test(handlerBody),
  );

  // -----------------------------------------------------------------
  // CR-05: dedup com bucket de MINUTO (retry pos-falha >1min ganha hash
  // novo) + 502 HONESTO em falha transitoria de download/transcricao (o GHL
  // Workflow precisa re-tentar; nada de fake 200 que perde a transcricao).
  // -----------------------------------------------------------------
  checar(
    'CR-05: hash de dedup da gravacao inclui bucket de minuto (minBucket, padrao formulario/evolution)',
    /minBucket\s*=\s*Math\.floor\(Date\.now\(\)\s*\/\s*60_000\)/.test(handlerBody) &&
      /\$\{tipo\}\|\$\{minBucket\}/.test(handlerBody),
  );
  checar(
    "CR-05: falha de download retorna 502 (status: 'download falhou', 502) pra provocar retry do GHL",
    /status:\s*['"]download falhou['"]\s*\},\s*502/.test(handlerBody),
  );
  checar(
    "CR-05: falha de transcricao retorna 502 (status: 'transcricao falhou', 502) pra provocar retry do GHL",
    /status:\s*['"]transcricao falhou['"]\s*\},\s*502/.test(handlerBody),
  );
  checar(
    "CR-05: falha de persistencia continua retornando 502 (status: 'persistencia falhou', 502)",
    /status:\s*['"]persistencia falhou['"]\s*\},\s*502/.test(handlerBody),
  );
}

// ---------------------------------------------------------------------
// (c) T-03-02 (anti-SSRF): baixarGravacaoBase64 valida host allowlist +
// https ANTES do fetch, em ghl.ts.
// ---------------------------------------------------------------------
checar(
  "ghl.ts importa GRAVACAO_HOSTS_PERMITIDOS de './config'",
  /import\s*\{[^}]*GRAVACAO_HOSTS_PERMITIDOS[^}]*\}\s*from\s*['"]\.\/config['"]/.test(ghlSrc),
);

const fnHostMatch = ghlSrc.match(/function hostGravacaoPermitido\([\s\S]*?\n\}/);
checar('funcao hostGravacaoPermitido encontrada em ghl.ts (validador de allowlist)', !!fnHostMatch);
if (fnHostMatch) {
  const corpoHost = fnHostMatch[0];
  checar("hostGravacaoPermitido checa protocol !== 'https:' (so https)", /protocol\s*!==\s*['"]https:['"]/.test(corpoHost));
  checar('hostGravacaoPermitido consulta GRAVACAO_HOSTS_PERMITIDOS', corpoHost.indexOf('GRAVACAO_HOSTS_PERMITIDOS') !== -1);
}

const fnBaixarMatch = ghlSrc.match(/export async function baixarGravacaoBase64\([\s\S]*?\n\}/);
checar('funcao baixarGravacaoBase64 encontrada em ghl.ts', !!fnBaixarMatch);
if (fnBaixarMatch) {
  const corpo = fnBaixarMatch[0];
  const idxValidacaoHost = corpo.indexOf('hostGravacaoPermitido(');
  const idxFetch = corpo.indexOf('fetchTimeout(recordingUrl');
  checar('baixarGravacaoBase64 chama hostGravacaoPermitido(...) (validacao anti-SSRF)', idxValidacaoHost !== -1);
  checar('baixarGravacaoBase64 chama fetchTimeout(recordingUrl...) (download real)', idxFetch !== -1);
  if (idxValidacaoHost !== -1 && idxFetch !== -1) {
    checar(
      'T-03-02: hostGravacaoPermitido(...) e checado ANTES do fetchTimeout(recordingUrl) (nao baixa URL fora do allowlist)',
      idxValidacaoHost < idxFetch,
    );
  }
  checar(
    'baixarGravacaoBase64 retorna null quando host fora do allowlist (fail-closed, nao lanca excecao)',
    /return null/.test(corpo),
  );
  checar(
    'T-03-05: baixarGravacaoBase64 tem guarda de tamanho (LIMITE_GRAVACAO_BYTES / content-length)',
    /LIMITE_GRAVACAO_BYTES/.test(corpo) && /content-length/i.test(corpo),
  );
}

// ---------------------------------------------------------------------
// persistirTranscricaoContato: nunca loga o texto, mapeia tipo -> custom
// field correto (transcricao_ligacao_sdr / transcricao_call_closer).
// ---------------------------------------------------------------------
const fnPersistirMatch = ghlSrc.match(/export async function persistirTranscricaoContato\([\s\S]*?\n\}/);
checar('funcao persistirTranscricaoContato encontrada em ghl.ts', !!fnPersistirMatch);
if (fnPersistirMatch) {
  const corpo = fnPersistirMatch[0];
  checar('persistirTranscricaoContato referencia transcricao_ligacao_sdr', ghlSrc.indexOf('transcricao_ligacao_sdr') !== -1);
  checar('persistirTranscricaoContato referencia transcricao_call_closer', ghlSrc.indexOf('transcricao_call_closer') !== -1);
  checar('persistirTranscricaoContato resolve contactId via buscarContactIdPorTelefone(...)', corpo.indexOf('buscarContactIdPorTelefone(') !== -1);
  checar('persistirTranscricaoContato retorna boolean honesto (res.ok)', /res\.ok/.test(corpo));
  checar(
    'persistirTranscricaoContato NUNCA loga textoAnon bruto (so tamanho/contagem)',
    !/console\.(log|error|warn)\([^)]*\btextoAnon\b(?!\.length)/.test(corpo.replace(/textoAnon\.length/g, '')),
  );
}

// ---------------------------------------------------------------------
// CR-01 (GRAV-04): transcreverAudio NUNCA loga o CONTEUDO da transcricao —
// so metadado (tamanho). O leak original era um preview de 80 chars do texto
// BRUTO (pre-anonimizacao), um nivel abaixo do handler (que o bloco (b)
// acima ja cobre).
// ---------------------------------------------------------------------
const fnTranscreverMatch = ghlSrc.match(/export async function transcreverAudio\([\s\S]*?\n\}/);
checar('funcao transcreverAudio encontrada em ghl.ts', !!fnTranscreverMatch);
if (fnTranscreverMatch) {
  const corpo = fnTranscreverMatch[0];
  // Nenhum console.* pode referenciar `texto` a nao ser via texto.length —
  // remove as ocorrencias legitimas de texto.length e checa o resto.
  const corpoSemLength = corpo.replace(/texto\.length/g, '');
  checar(
    'CR-01: transcreverAudio NAO loga o conteudo de `texto` (nenhum console.* referencia texto, exceto texto.length)',
    !/console\.(log|error|warn)\([^)]*\btexto\b/.test(corpoSemLength),
  );
  checar(
    'CR-01: transcreverAudio NAO usa substring/slice de texto em log (preview de conteudo)',
    !/texto\.(substring|slice)\(/.test(corpo),
  );
}

// ---------------------------------------------------------------------
// CR-03: allowlist SEM wildcard *.amazonaws.com (multi-tenant/atacante) e
// retry Bearer PIT GATEADO ao dominio GHL (leadconnectorhq.com/msgsndr.com)
// — o PIT token nunca e enviado pra host de terceiro.
// ---------------------------------------------------------------------
checar(
  "CR-03: ghl.ts NAO tem mais o wildcard endsWith('.amazonaws.com') (familia multi-tenant removida do allowlist)",
  !/endsWith\(\s*['"]\.amazonaws\.com['"]\s*\)/.test(ghlSrc),
);
checar(
  'CR-03: ghl.ts define ehHostDominioGhl restrito a .leadconnectorhq.com/.msgsndr.com',
  /function ehHostDominioGhl\(/.test(ghlSrc) &&
    /['"]\.leadconnectorhq\.com['"]/.test(ghlSrc) &&
    /['"]\.msgsndr\.com['"]/.test(ghlSrc),
);
checar(
  'CR-03: default de GRAVACAO_HOSTS_PERMITIDOS (config.ts) NAO inclui storage.googleapis.com (host multi-tenant)',
  !/GRAVACAO_HOSTS_PERMITIDOS\s*=\s*\(\s*process\.env\.GRAVACAO_HOSTS_PERMITIDOS\s*\|\|\s*'[^']*storage\.googleapis\.com/.test(configSrc),
);
checar(
  'CR-03: default de GRAVACAO_HOSTS_PERMITIDOS (config.ts) NAO inclui amazonaws.com',
  !/GRAVACAO_HOSTS_PERMITIDOS\s*=\s*\(\s*process\.env\.GRAVACAO_HOSTS_PERMITIDOS\s*\|\|\s*'[^']*amazonaws\.com/.test(configSrc),
);

if (fnBaixarMatch) {
  // Rematch pos-edicoes: o corpo usado nas asserts abaixo precisa ser o ATUAL.
  const corpoBaixar = ghlSrc.match(/export async function baixarGravacaoBase64\([\s\S]*?\n\}/)[0];

  const idxRetryPit = corpoBaixar.indexOf('Bearer ${GHL_PIT_TOKEN}');
  const idxGateGhl = corpoBaixar.indexOf('ehHostDominioGhl(host)');
  checar('CR-03: retry com Bearer PIT existe em baixarGravacaoBase64 (fallback 401/403)', idxRetryPit !== -1);
  checar('CR-03: retry com Bearer PIT e GATEADO por ehHostDominioGhl(host)', idxGateGhl !== -1);
  if (idxRetryPit !== -1 && idxGateGhl !== -1) {
    checar(
      'CR-03: o gate ehHostDominioGhl(host) aparece ANTES do header Bearer PIT (condicao do retry, nao depois)',
      idxGateGhl < idxRetryPit,
    );
  }

  // -----------------------------------------------------------------
  // CR-04: redirects desabilitados no download — allowlist valida so a URL
  // inicial; um 302 de origem permitida furaria o anti-SSRF.
  // -----------------------------------------------------------------
  const totalRedirectError = (corpoBaixar.match(/redirect:\s*'error'/g) || []).length;
  checar(
    "CR-04: baixarGravacaoBase64 usa redirect: 'error' em TODOS os fetches (primeiro + retry PIT)",
    totalRedirectError >= 2,
  );

  // -----------------------------------------------------------------
  // WR-05: guarda de tamanho aplicada DURANTE o streaming do corpo (nao so
  // no Content-Length, ausente/falsificavel) — aborta e cancela o reader
  // assim que o total passa do limite.
  // -----------------------------------------------------------------
  checar(
    'WR-05: baixarGravacaoBase64 le o corpo em streaming (res.body.getReader())',
    /res\.body\.getReader\(\)/.test(corpoBaixar),
  );
  checar(
    'WR-05: baixarGravacaoBase64 checa o total acumulado contra LIMITE_GRAVACAO_BYTES durante o download',
    /total\s*>\s*LIMITE_GRAVACAO_BYTES/.test(corpoBaixar),
  );
  checar(
    'WR-05: baixarGravacaoBase64 cancela o reader ao exceder o limite (reader.cancel())',
    /reader\.cancel\(\)/.test(corpoBaixar),
  );
  checar(
    'WR-05: baixarGravacaoBase64 NAO usa mais res.arrayBuffer() (bufferizacao integral antes da checagem)',
    !/res\.arrayBuffer\(\)/.test(corpoBaixar),
  );
}

// ---------------------------------------------------------------------
// WR-02/WR-03 (T-03-06): excertos de transcricao sao sanitizados antes de
// persistir (voltam pro prompt da Camila via read_lead_ficha) e o
// delimitador </transcricao> e neutralizado antes da interpolacao no prompt
// do extrator.
// ---------------------------------------------------------------------
checar(
  'WR-03: extracao-sinais.ts neutraliza <\\/?transcricao> antes da interpolacao (neutralizarDelimitadorTranscricao)',
  /replace\(\/<\\\/\?transcricao>\/gi,\s*''\)/.test(extracaoSrc) &&
    /function neutralizarDelimitadorTranscricao\(/.test(extracaoSrc),
);
checar(
  'WR-03: montarPrompt interpola a versao SEGURA da transcricao (transcricaoSegura), nao a crua',
  /const transcricaoSegura = neutralizarDelimitadorTranscricao\(transcricaoAnon\)/.test(extracaoSrc) &&
    /'<transcricao>',\s*\n\s*transcricaoSegura,/.test(extracaoSrc),
);
checar(
  'WR-02: extracao-sinais.ts define sanitizarExcerto (strip de delimitadores/colchetes + teto de tamanho)',
  /function sanitizarExcerto\(/.test(extracaoSrc) && /\.slice\(0,\s*maxChars\)/.test(extracaoSrc),
);
{
  const idxSanitiza = extracaoSrc.indexOf('sanitizarExcerto(objecoes');
  const idxPersisteObjecao = extracaoSrc.indexOf("chave: 'objecao_ativa'");
  checar('WR-02: objecaoResumo passa por sanitizarExcerto ANTES de persistir em objecao_ativa', idxSanitiza !== -1 && idxPersisteObjecao !== -1 && idxSanitiza < idxPersisteObjecao);
  checar('WR-02: evidencia do sinal de compra passa por sanitizarExcerto', /sanitizarExcerto\(sinais_compra\.evidencia/.test(extracaoSrc));
  checar('WR-02: dor_real/lexico/ajuste_bant passam por sanitizarExcerto no resumo consolidado', /sanitizarExcerto\(dor_real/.test(extracaoSrc) && /sanitizarExcerto\(l,/.test(extracaoSrc) && /sanitizarExcerto\(ajuste_bant/.test(extracaoSrc));
}

// ---------------------------------------------------------------------
// WR-01 (LGPD): update-contact-field NUNCA loga o valor completo do custom
// field (excertos quase-literais de transcricao) — so chave + tamanho.
// ---------------------------------------------------------------------
{
  const ucfSemLength = ucfSrc.replace(/valor\.length/g, '');
  checar(
    'WR-01: update-contact-field.ts nao loga o valor completo em console.log (so valor.length)',
    !/console\.log\([^)]*\$\{valor\}/.test(ucfSemLength) && !/console\.log\([^)]*\bvalor\b/.test(ucfSemLength),
  );
  checar(
    'WR-01: log de sucesso usa chave + tamanho (valor.length)',
    /console\.log\(`\[update-contact-field\][^`]*\$\{valor\.length\}/.test(ucfSrc),
  );
}

if (falhas.length > 0) {
  console.error('[smoke-gravacao-webhook] T-03-01/T-03-02/GRAV-04 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-gravacao-webhook] T-03-01/T-03-02/GRAV-04 (+CR-01/CR-03/CR-04/CR-05/WR-01/WR-02/WR-03/WR-05) OK');
