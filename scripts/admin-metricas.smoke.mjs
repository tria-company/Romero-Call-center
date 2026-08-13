#!/usr/bin/env node
// scripts/admin-metricas.smoke.mjs
//
// Smoke determinístico (sem rede/servidor HTTP) da base de `GET
// /api/admin/metricas` (`src/mastra/index.ts`, Fase 10 Plano 05, OBS-01).
// Subir o servidor Mastra inteiro é pesado demais pra um smoke — este script
// foca nas duas garantias verificáveis unitariamente, direto dos módulos que
// a rota consome:
//   1. verificarToken(tokenDoHeader('Bearer <token-invalido>')) retorna null
//      — a base do 401 { status: 'unauthorized' } que a rota devolve.
//   2. lerMetricas() resolve com um snapshot contendo TODAS as chaves de
//      MetricasSnapshot e NENHUMA chave/valor com substring de PII
//      (telefone/cpf/voto) — o shape exato que a rota espelha em c.json(...).
//   3. (best-effort) Se DISCADOR_SESSION_SECRET estiver setado no ambiente,
//      gera um token válido com emitirToken() e confirma que verificarToken
//      o aceita — prova o caminho "feliz" simetricamente ao 401.
//
// Uso: node --experimental-strip-types scripts/admin-metricas.smoke.mjs

import { verificarToken, tokenDoHeader, emitirToken } from '../src/mastra/discador-auth.ts';
import { lerMetricas } from '../src/mastra/metricas.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function testeTokenInvalidoRejeitado() {
  const sess = verificarToken(tokenDoHeader('Bearer token-completamente-invalido'));
  checar(sess === null, `verificarToken de um token invalido deveria retornar null (base do 401), recebido: ${JSON.stringify(sess)}`);
}

function testeSemHeaderRejeitado() {
  const sess = verificarToken(tokenDoHeader(undefined));
  checar(sess === null, `verificarToken sem Authorization header deveria retornar null, recebido: ${JSON.stringify(sess)}`);
}

function testeTokenValidoAceito() {
  // DISCADOR_SESSION_SECRET pode nao estar setado neste ambiente — o modulo
  // ja usa um default (com warning) nesse caso, entao o teste roda de
  // qualquer forma; best-effort, nunca bloqueia o smoke por ausencia de env.
  const token = emitirToken('smoke-op');
  const sess = verificarToken(tokenDoHeader(`Bearer ${token}`));
  checar(!!sess && sess.usuario === 'smoke-op', `verificarToken de um token recem-emitido deveria aceitar e retornar o usuario, recebido: ${JSON.stringify(sess)}`);
}

const CHAVES_ESPERADAS = [
  'atendentesOnline',
  'chamadasAtivas',
  'profundidadeFila',
  'errosDia',
  'taxaErroPorEtapa',
  'contagem429',
];

const TERMOS_PII = ['telefone', 'cpf', 'voto', 'phone'];

function contemTermoPII(chave) {
  const k = chave.toLowerCase();
  return TERMOS_PII.some((termo) => k.includes(termo));
}

async function testeSnapshotShapeSemPII() {
  let lancou = false;
  let snapshot;
  try {
    snapshot = await lerMetricas();
  } catch {
    lancou = true;
  }
  checar(!lancou, 'lerMetricas() nao deveria rejeitar (base do 200 sempre-resolve da rota)');

  for (const chave of CHAVES_ESPERADAS) {
    checar(chave in (snapshot || {}), `MetricasSnapshot deveria conter a chave '${chave}'`);
  }

  // Nenhuma chave de topo nem das sub-chaves de taxaErroPorEtapa carrega
  // substring de PII (telefone/cpf/voto) — o payload que /api/admin/metricas
  // devolve e so agregados numericos (T-10-05-I1).
  for (const chave of Object.keys(snapshot || {})) {
    checar(!contemTermoPII(chave), `chave de topo '${chave}' do snapshot nao deveria conter termo de PII`);
  }
  const etapas = snapshot?.taxaErroPorEtapa || {};
  for (const etapa of Object.keys(etapas)) {
    checar(!contemTermoPII(etapa), `chave de etapa '${etapa}' nao deveria conter termo de PII`);
    for (const campo of Object.keys(etapas[etapa] || {})) {
      checar(!contemTermoPII(campo), `campo '${campo}' da etapa '${etapa}' nao deveria conter termo de PII`);
    }
  }
}

async function main() {
  testeTokenInvalidoRejeitado();
  testeSemHeaderRejeitado();
  testeTokenValidoAceito();
  await testeSnapshotShapeSemPII();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('PASS');
  process.exit(0);
}

main();
