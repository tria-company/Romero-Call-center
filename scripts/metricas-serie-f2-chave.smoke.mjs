#!/usr/bin/env node
// scripts/metricas-serie-f2-chave.smoke.mjs
//
// Smoke determinístico (sem rede) dos dois "menores" da Fase 19.1 (plano 06):
//   F1 — série diária DURÁVEL de métricas (retenção METRICAS_SERIE_TTL_MS),
//        write-side, pra investigação pós-incidente (src/mastra/metricas.ts).
//   F2 — chave Redis de task-ativa deixa de carregar telefone em claro no NOME
//        (digest determinístico DENTRO de chaveTelefone, src/mastra/estado-webhook.ts).
//
// Roda SEM `--env-file` (REDIS_URL vazio) — modo memória, mesma casca dos
// outros smokes do repo (estado-webhook.smoke.mjs, metricas.smoke.mjs).
//
// Uso: node --experimental-strip-types scripts/metricas-serie-f2-chave.smoke.mjs

import { registrarErroEtapa, registrarSucessoEtapa, registrar429ClickUp, lerSerieDiaria } from '../src/mastra/metricas.ts';
import {
  digestTelefone,
  chaveTelefone,
  chaveTelefoneLegado,
  chaveTaskAtiva,
  guardarTaskAtiva,
  lerTaskAtiva,
  limparTaskAtiva,
} from '../src/mastra/estado-webhook.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ===== F1 — série diária durável =====

async function testeSerieDiariaErroSucesso() {
  const antes = await lerSerieDiaria('erro:webhook', 1);
  const contagemAntes = antes[0]?.contagem ?? 0;

  registrarErroEtapa('webhook');
  registrarErroEtapa('webhook');
  registrarSucessoEtapa('webhook');

  const depoisErro = await lerSerieDiaria('erro:webhook', 1);
  const depoisSucesso = await lerSerieDiaria('sucesso:webhook', 1);

  checar(
    depoisErro[0]?.contagem === contagemAntes + 2,
    `lerSerieDiaria('erro:webhook', 1) deveria acumular +2 hoje, esperado ${contagemAntes + 2}, recebido: ${depoisErro[0]?.contagem}`,
  );
  checar(
    (depoisSucesso[0]?.contagem ?? 0) >= 1,
    `lerSerieDiaria('sucesso:webhook', 1) deveria ter >=1 hoje, recebido: ${depoisSucesso[0]?.contagem}`,
  );
  checar(depoisErro[0]?.data === new Date().toISOString().slice(0, 10), 'a data do 1o item deveria ser hoje (UTC)');
}

async function testeSerieDiaria429() {
  const antes = await lerSerieDiaria('429', 1);
  const contagemAntes = antes[0]?.contagem ?? 0;

  registrar429ClickUp();
  registrar429ClickUp();
  registrar429ClickUp();

  const depois = await lerSerieDiaria('429', 1);
  checar(
    depois[0]?.contagem === contagemAntes + 3,
    `lerSerieDiaria('429', 1) deveria acumular +3, esperado ${contagemAntes + 3}, recebido: ${depois[0]?.contagem}`,
  );
}

async function testeSerieDiariaVariosDias() {
  const serie = await lerSerieDiaria('erro:webhook', 5);
  checar(serie.length === 5, `lerSerieDiaria(metrica, 5) deveria devolver 5 entradas, recebido: ${serie.length}`);
  for (const item of serie) {
    checar(typeof item.data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.data), `data mal formada: ${item.data}`);
    checar(typeof item.contagem === 'number', `contagem deveria ser number: ${item.contagem}`);
  }
}

async function testeSerieDiariaMetricaInexistenteZerada() {
  const serie = await lerSerieDiaria('metrica-que-nunca-existiu', 3);
  checar(serie.every((i) => i.contagem === 0), 'metrica nunca registrada deveria vir zerada em todos os dias, nunca lançar');
}

async function testeSerieDiariaNuncaLanca() {
  let lancou = false;
  try {
    await lerSerieDiaria('qualquer', 1);
  } catch {
    lancou = true;
  }
  checar(!lancou, 'lerSerieDiaria não deveria lançar mesmo sem Redis');
}

// ===== F2 — chave sem telefone em claro =====

const OITO_DIGITOS_CONSECUTIVOS = /\d{8,}/;

function testeDigestDeterministico() {
  const d1 = digestTelefone('5511999998888');
  const d2 = digestTelefone('5511999998888');
  checar(d1 === d2, 'digestTelefone deveria ser determinístico p/ o mesmo input');
  checar(typeof d1 === 'string' && d1.length === 16, `digestTelefone deveria devolver 16 hex chars, recebido: '${d1}' (len ${d1.length})`);
  checar(/^[0-9a-f]{16}$/.test(d1), `digestTelefone deveria ser hex lowercase, recebido: '${d1}'`);

  const outro = digestTelefone('5511988887777');
  checar(d1 !== outro, 'digestTelefone deveria variar p/ telefones diferentes (não é uma constante)');
}

function testeChaveTelefoneSemNonoDigitoMesmoDigest() {
  // 12 dígitos (sem o 9, formato Wavoip/webhook) e 13 dígitos (com o 9, formato
  // Ligação/operador) do MESMO número precisam colapsar no MESMO digest —
  // senão a correlação call->task quebra pra número móvel (mesmo bug que
  // semNonoDigito já resolvia antes do F2).
  const chave12 = chaveTelefone('551199998888'); // 12 dígitos, sem 9
  const chave13 = chaveTelefone('5511999998888'); // 13 dígitos, com 9
  checar(chave12 === chave13, `chaveTelefone(12 dígitos) e chaveTelefone(13 dígitos) do mesmo número deveriam ser o MESMO digest — '${chave12}' vs '${chave13}'`);
}

function testeChaveSemTelefoneEmClaro() {
  const telefone = '5511999998888';
  const chaveTel = chaveTelefone(telefone);
  const chaveComposta = chaveTaskAtiva(telefone, 'dev1');
  const chaveSemDevice = chaveTaskAtiva(telefone);

  checar(
    !OITO_DIGITOS_CONSECUTIVOS.test(chaveTel),
    `chaveTelefone(...) não deveria conter 8+ dígitos consecutivos (telefone cru vazando) — recebido: '${chaveTel}'`,
  );
  checar(
    !OITO_DIGITOS_CONSECUTIVOS.test(chaveComposta),
    `chaveTaskAtiva(tel, dev) não deveria conter 8+ dígitos consecutivos — recebido: '${chaveComposta}'`,
  );
  checar(
    !OITO_DIGITOS_CONSECUTIVOS.test(chaveSemDevice),
    `chaveTaskAtiva(tel) sem device não deveria conter 8+ dígitos consecutivos — recebido: '${chaveSemDevice}'`,
  );
  checar(chaveTel !== telefone.replace(/\D/g, ''), 'chaveTelefone não deveria mais devolver os dígitos crus do telefone');
}

function testeChaveLegadoAindaDevolveDigitos() {
  const telefone = '5511999998888';
  const legado = chaveTelefoneLegado(telefone);
  const digest = chaveTelefone(telefone);

  checar(legado === '551199998888', `chaveTelefoneLegado deveria devolver os dígitos sem o nono dígito (semNonoDigito) — recebido: '${legado}'`);
  checar(legado !== digest, 'chaveTelefoneLegado deveria ser DISTINTO do digest novo (formatos diferentes)');
  checar(
    OITO_DIGITOS_CONSECUTIVOS.test(legado),
    'pré-condição do teste: chaveTelefoneLegado tem que conter os dígitos crus (senão o teste de fallback não prova nada)',
  );
}

async function testeCorrelacaoPreservadaFimAFim() {
  const telefone = '5511977776666';
  await guardarTaskAtiva(telefone, 'task-f2', 'devF2');
  checar(
    (await lerTaskAtiva(telefone, 'devF2')) === 'task-f2',
    'lerTaskAtiva pós-guardarTaskAtiva deveria achar a task (correlação preservada com a chave nova/digest)',
  );
  checar(
    (await lerTaskAtiva(telefone)) === 'task-f2',
    'lerTaskAtiva sem deviceId (fallback telefone-só) também deveria achar a task',
  );
  await limparTaskAtiva(telefone, 'devF2');
  checar((await lerTaskAtiva(telefone, 'devF2')) === null, 'lerTaskAtiva pós-limparTaskAtiva deveria ser null');
}

async function main() {
  await testeSerieDiariaErroSucesso();
  await testeSerieDiaria429();
  await testeSerieDiariaVariosDias();
  await testeSerieDiariaMetricaInexistenteZerada();
  await testeSerieDiariaNuncaLanca();

  testeDigestDeterministico();
  testeChaveTelefoneSemNonoDigitoMesmoDigest();
  testeChaveSemTelefoneEmClaro();
  testeChaveLegadoAindaDevolveDigitos();
  await testeCorrelacaoPreservadaFimAFim();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
