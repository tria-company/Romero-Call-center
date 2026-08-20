#!/usr/bin/env node
// scripts/lead-detalhe-cache.smoke.mjs
//
// Smoke determinístico (sem rede) do cache resiliente do detalhe do lead
// (quick 260819-v2a — src/mastra/lead-detalhe-cache.ts): stale-while-
// revalidate + dedup em-voo, espelho do precedente sancionado da fila
// resiliente (index.ts:455-484). Reader e clock são injetados (D-3) —
// nenhuma chamada real ao ClickUp.
//
// Prova as 6 propriedades do <behavior> do plano:
//   1. fresco (idade < TTL) não rebusca;
//   2. vencido rebusca e re-aquece;
//   3. falha de INFRA com cópia existente serve stale (console.warn, sem PII);
//   4. falha de INFRA sem cópia (primeiro load) relança;
//   5. falha de VALIDAÇÃO relança SEMPRE (nunca stale-serve, nunca cacheia);
//   6. dedup em-voo: 2 chamadas concorrentes = 1 chamada só ao reader;
//   7. derrubarLeadDetalheMem força miss (próxima leitura vem fresca).
//
// Uso: node --experimental-strip-types scripts/lead-detalhe-cache.smoke.mjs

import { lerLeadDetalheResiliente, derrubarLeadDetalheMem } from '../src/mastra/lead-detalhe-cache.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function fichaFake(marcador) {
  return { lead: { leadTaskId: 'lead-1', nome: `Fulano-${marcador}` }, dossie: '', timeline: [] };
}

async function testeFrescoNaoRebusca() {
  let chamadas = 0;
  let t = 0;
  const agora = () => t;
  const ler = async () => {
    chamadas++;
    return fichaFake(chamadas);
  };

  const r1 = await lerLeadDetalheResiliente('lead-1', ler, agora);
  checar(chamadas === 1, `primeira leitura deveria chamar o reader 1x, chamou ${chamadas}x`);

  t = 10_000; // 10s depois, ainda dentro do TTL de 30s
  const r2 = await lerLeadDetalheResiliente('lead-1', ler, agora);
  checar(chamadas === 1, `leitura fresca (10s < TTL 30s) NÃO deveria rebuscar, chamou ${chamadas}x`);
  checar(r2 === r1, 'leitura fresca deveria devolver a MESMA cópia (objeto) do cache');
}

async function testeVencidoRebusca() {
  let chamadas = 0;
  let t = 0;
  const agora = () => t;
  const ler = async () => {
    chamadas++;
    return fichaFake(chamadas);
  };

  await lerLeadDetalheResiliente('lead-2', ler, agora);
  checar(chamadas === 1, `primeira leitura deveria chamar o reader 1x, chamou ${chamadas}x`);

  t = 31_000; // 31s depois, vencido (TTL 30s)
  const r2 = await lerLeadDetalheResiliente('lead-2', ler, agora);
  checar(chamadas === 2, `leitura vencida (31s > TTL 30s) deveria rebuscar, chamou ${chamadas}x`);
  checar(r2.lead.nome === 'Fulano-2', 're-aquecimento deveria devolver o valor NOVO do reader');
}

async function testeInfraComCopiaServeStale() {
  let t = 0;
  const agora = () => t;
  const lerOk = async () => fichaFake('ok');
  await lerLeadDetalheResiliente('lead-3', lerOk, agora);

  t = 31_000; // vencido, força rebusca
  const lerFalha = async () => {
    throw new Error('[clickup] ECONNRESET timeout de infra');
  };
  const avisoOriginal = console.warn;
  let avisou = false;
  let vazouPii = false;
  console.warn = (...args) => {
    avisou = true;
    const texto = args.join(' ');
    if (/\d{10,}|cpf/i.test(texto)) vazouPii = true;
  };
  let resultado;
  let lancou = false;
  try {
    resultado = await lerLeadDetalheResiliente('lead-3', lerFalha, agora);
  } catch {
    lancou = true;
  } finally {
    console.warn = avisoOriginal;
  }
  checar(!lancou, 'falha de infra COM cópia existente NÃO deveria relançar (deveria servir stale)');
  checar(resultado?.lead?.nome === 'Fulano-ok', 'falha de infra com cópia deveria servir a última cópia BOA');
  checar(avisou, 'falha de infra com cópia deveria emitir console.warn');
  checar(!vazouPii, 'console.warn de stale-serve NÃO deveria conter telefone/CPF (LGPD)');
}

async function testeInfraSemCopiaRelanca() {
  const lerFalha = async () => {
    throw new Error('[clickup] ECONNRESET timeout de infra');
  };
  let lancou = false;
  try {
    await lerLeadDetalheResiliente('lead-4-nunca-visto', lerFalha, () => 0);
  } catch {
    lancou = true;
  }
  checar(lancou, 'falha de infra SEM nenhuma cópia (primeiro load) deveria RELANÇAR (WR-03)');
}

async function testeValidacaoSempreRelanca() {
  let t = 0;
  const agora = () => t;
  const lerOk = async () => fichaFake('valido');
  await lerLeadDetalheResiliente('lead-5', lerOk, agora);

  t = 31_000; // vencido, força rebusca — agora com erro de validação
  const lerInvalido = async () => {
    throw new Error('[clickup] lead lead-5 nao encontrada');
  };
  let lancou = false;
  try {
    await lerLeadDetalheResiliente('lead-5', lerInvalido, agora);
  } catch {
    lancou = true;
  }
  checar(lancou, 'erro de VALIDAÇÃO (lead não encontrado) deveria relançar SEMPRE, mesmo com cópia existente');

  // Confirma que NÃO cacheou o erro nem a cópia velha ficou "revalidada":
  // uma leitura seguinte ainda vencida deveria tentar de novo (chamando o reader).
  let chamouDeNovo = false;
  const lerConta = async () => {
    chamouDeNovo = true;
    throw new Error('[clickup] task lead-5 nao e um Lead da Lista 01');
  };
  try {
    await lerLeadDetalheResiliente('lead-5', lerConta, agora);
  } catch {
    /* esperado */
  }
  checar(chamouDeNovo, 'erro de validação não deveria ter cacheado nada — próxima leitura vencida chama o reader de novo');
}

async function testeDedupEmVoo() {
  let chamadas = 0;
  let resolverPromise;
  const ler = () =>
    new Promise((resolve) => {
      chamadas++;
      resolverPromise = () => resolve(fichaFake('dedup'));
    });

  const p1 = lerLeadDetalheResiliente('lead-6', ler, () => 0);
  const p2 = lerLeadDetalheResiliente('lead-6', ler, () => 0);
  checar(chamadas === 1, `2 chamadas concorrentes deveriam disparar 1 chamada só ao reader, disparou ${chamadas}x`);
  resolverPromise();
  const [r1, r2] = await Promise.all([p1, p2]);
  checar(r1 === r2, 'as 2 chamadas concorrentes deveriam devolver o MESMO resultado (mesma promise)');
}

async function testeDerrubarInvalida() {
  let chamadas = 0;
  let t = 0;
  const agora = () => t;
  const ler = async () => {
    chamadas++;
    return fichaFake(chamadas);
  };

  await lerLeadDetalheResiliente('lead-7', ler, agora);
  checar(chamadas === 1, `primeira leitura deveria chamar o reader 1x, chamou ${chamadas}x`);

  // Ainda fresco (t=0), mas derrubarLeadDetalheMem força miss.
  derrubarLeadDetalheMem('lead-7');
  await lerLeadDetalheResiliente('lead-7', ler, agora);
  checar(chamadas === 2, `após derrubarLeadDetalheMem, leitura mesmo fresca deveria rebuscar (miss forçado), chamou ${chamadas}x`);
}

async function main() {
  await testeFrescoNaoRebusca();
  await testeVencidoRebusca();
  await testeInfraComCopiaServeStale();
  await testeInfraSemCopiaRelanca();
  await testeValidacaoSempreRelanca();
  await testeDedupEmVoo();
  await testeDerrubarInvalida();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
