// Smoke de HARD-03: prova o rate limit + fila com prioridade in-memory de
// fila.ts — crise inviolavel (nunca rate-limited/shedada), shed explicito de
// NORMAL sob overload (nunca perda silenciosa), e drenagem crise-antes-de-
// normal.
//
// fila.ts le capacidade/janela/tamanho-max via process.env em MODULE LOAD
// TIME (top-level const) — por isso configuramos os envs ANTES do import e
// usamos `await import(...)` dinamico (import estatico e hoisted e rodaria
// antes de qualquer linha deste arquivo, inclusive antes de setar os envs).

process.env.SDR_RATE_LIMIT_CAPACIDADE = '2';
process.env.SDR_RATE_LIMIT_JANELA_MS = '3600000'; // 1h -- nao queremos refill durante o smoke
process.env.SDR_FILA_NORMAL_CAPACIDADE_MAX = '1';
process.env.SDR_FILA_DRENAGEM_MS = '3600000'; // 1h -- nao queremos a entrada "drenar" durante o smoke

const { classificarPrioridade, admitir, FilaPrioridade, PRIORIDADE_CRISE, PRIORIDADE_NORMAL } =
  await import('../src/mastra/fila.ts');

const falhas = [];

function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// ---- classificarPrioridade: lexico de sofrimento agudo ----
{
  const frasesCrise = [
    'nao aguento mais',
    'quero morrer',
    'vou me matar',
    'sumir de vez',
  ];
  for (const frase of frasesCrise) {
    const p = classificarPrioridade('5511999999999', frase);
    checar(`classificarPrioridade("${frase}") = CRISE`, p === PRIORIDADE_CRISE);
  }

  const pNormal = classificarPrioridade('5511999999999', 'oi, tudo bem? queria saber mais sobre a call');
  checar('classificarPrioridade(texto neutro) = NORMAL', pNormal === PRIORIDADE_NORMAL);

  // Predicado leadEmCrise injetado tambem forca CRISE, mesmo com texto neutro.
  const pViaPredicado = classificarPrioridade('5511999999999', 'oi tudo bem', () => true);
  checar('classificarPrioridade com leadEmCrise=true = CRISE', pViaPredicado === PRIORIDADE_CRISE);

  // Predicado que lanca nao derruba a classificacao (fail-safe -> NORMAL,
  // mas nunca lanca pro caller).
  let lancouPredicado = false;
  let pComPredicadoQuebrado;
  try {
    pComPredicadoQuebrado = classificarPrioridade('5511999999999', 'oi tudo bem', () => {
      throw new Error('boom');
    });
  } catch {
    lancouPredicado = true;
  }
  checar('classificarPrioridade nao lanca quando o predicado lanca', lancouPredicado === false);
  checar('classificarPrioridade degrada pra NORMAL quando o predicado lanca', pComPredicadoQuebrado === PRIORIDADE_NORMAL);
}

// ---- (a) crise admitida mesmo com bucket zerado ----
{
  // Esgota o bucket (capacidade=2 via env acima).
  admitir(PRIORIDADE_NORMAL);
  admitir(PRIORIDADE_NORMAL);
  // A esta altura tokensDisponiveis=0 (2 consumidos, sem refill nesta janela).

  const resultadoCrise = admitir(PRIORIDADE_CRISE);
  checar('(a) crise admitida com bucket zerado: admitido=true', resultadoCrise.admitido === true);
}

// ---- (b) normal enfileirado sob limite (nao perdido) ----
// Bucket ja esgotado pelo bloco (a) acima. FILA_NORMAL_CAPACIDADE_MAX=1 (env).
{
  const resultadoEnfileirado = admitir(PRIORIDADE_NORMAL);
  checar(
    '(b) normal sob limite: admitido=true (enfileirado, nao perdido)',
    resultadoEnfileirado.admitido === true,
  );
  checar(
    '(b) normal sob limite: motivo=rate_limited_enfileirado',
    resultadoEnfileirado.motivo === 'rate_limited_enfileirado',
  );
}

// ---- (c) fila cheia -> normal recebe overload, crise ainda admitida ----
// A fila (capacidade=1) ja esta ocupada pela entrada do bloco (b) acima.
{
  const resultadoOverload = admitir(PRIORIDADE_NORMAL);
  checar('(c) fila cheia: admitido=false', resultadoOverload.admitido === false);
  checar('(c) fila cheia: motivo=overload', resultadoOverload.motivo === 'overload');

  const resultadoCriseAindaOk = admitir(PRIORIDADE_CRISE);
  checar('(c) crise ainda admitida com fila cheia: admitido=true', resultadoCriseAindaOk.admitido === true);
}

// ---- (d) drenagem: CRISE antes de NORMAL, independente da ordem de chegada ----
{
  const fila = new FilaPrioridade();
  fila.enfileirar('normal-1', PRIORIDADE_NORMAL);
  fila.enfileirar('normal-2', PRIORIDADE_NORMAL);
  fila.enfileirar('crise-1', PRIORIDADE_CRISE);
  fila.enfileirar('normal-3', PRIORIDADE_NORMAL);
  fila.enfileirar('crise-2', PRIORIDADE_CRISE);

  const ordem = [fila.proximo(), fila.proximo(), fila.proximo(), fila.proximo(), fila.proximo()];
  checar(
    '(d) drenagem: crise-1 e crise-2 vem antes de qualquer normal',
    ordem[0] === 'crise-1' && ordem[1] === 'crise-2',
  );
  checar(
    '(d) drenagem: normais mantem ordem FIFO entre si (normal-1, normal-2, normal-3)',
    ordem[2] === 'normal-1' && ordem[3] === 'normal-2' && ordem[4] === 'normal-3',
  );
  checar('(d) drenagem: fila vazia apos drenar tudo', fila.proximo() === undefined);
}

if (falhas.length > 0) {
  console.error('[smoke-fila-prioridade] HARD-03 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-fila-prioridade] HARD-03 OK');
// fila.ts registra um setInterval de refill do token bucket (mesmo padrao de
// notificacoes.ts) — sem exit explicito o processo ficaria vivo esperando o
// timer.
process.exit(0);
