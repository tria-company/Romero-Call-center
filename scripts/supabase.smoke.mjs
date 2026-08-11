#!/usr/bin/env node
// scripts/supabase.smoke.mjs
//
// Smoke determinístico (sem rede) do client Supabase self-hosted (DOSS-01/02,
// Fase 04 Plano 01, D-P4-11; gap CR-02, 04-VERIFICATION.md). Roda SEM
// `--env-file` (env vazio) e prova que:
//  - `listarTabela`/`buscarMilitante`/`listarFollowUps`/`descobrirEsquema`
//    LANÇAM com mensagem clara de config ausente (SUPABASE_URL/
//    SUPABASE_SERVICE_KEY) — nunca resolvem vazio silenciosamente (WR-03);
//  - `montarFiltroFollowUps` (pura) filtra pela FK dedicada — NUNCA pelas
//    colunas de identidade de militantes — e LANÇA em env/referência ausente
//    (fecha CR-02, risco LGPD de contaminação cruzada de PII).
//
// Uso: node --experimental-strip-types scripts/supabase.smoke.mjs

import {
  listarTabela,
  buscarMilitante,
  listarFollowUps,
  descobrirEsquema,
  montarFiltroFollowUps,
} from '../src/mastra/supabase.ts';
import { SUPABASE_COL_ID } from '../src/mastra/config.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

async function rejeitaComConfigAusente(promessa, rotulo) {
  try {
    await promessa;
    checar(false, `${rotulo} deveria LANÇAR sem SUPABASE_URL/SUPABASE_SERVICE_KEY configurados`);
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    checar(
      mensagem.includes('SUPABASE_URL ausente') || mensagem.includes('SUPABASE_SERVICE_KEY ausente'),
      `${rotulo} deveria citar "SUPABASE_URL ausente" ou "SUPABASE_SERVICE_KEY ausente", recebido: "${mensagem}"`,
    );
  }
}

/** Test A (CR-02): filtro correto — chave é a FK passada, NUNCA a coluna de identidade de militante. */
function testeFiltroCorreto() {
  const filtro = montarFiltroFollowUps({ refMilitante: 'mil-42' }, 'militante_id');
  checar(
    filtro.militante_id === 'eq.mil-42',
    `montarFiltroFollowUps deveria retornar { militante_id: 'eq.mil-42' }, recebido: ${JSON.stringify(filtro)}`,
  );
  checar(
    !Object.prototype.hasOwnProperty.call(filtro, SUPABASE_COL_ID),
    `montarFiltroFollowUps NUNCA deveria filtrar pela coluna de identidade de militante (${SUPABASE_COL_ID}) — LGPD/CR-02`,
  );
}

/** Test B (CR-02): env ausente -> degradação explícita, nunca vazio silencioso nem dado de outra pessoa. */
function testeEnvAusente() {
  try {
    montarFiltroFollowUps({ refMilitante: 'x' }, '');
    checar(false, 'montarFiltroFollowUps deveria LANÇAR quando colFollowupRef está vazio (env ausente)');
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    checar(
      mensagem.includes('configuração de follow-ups ausente'),
      `montarFiltroFollowUps sem colFollowupRef deveria citar "configuração de follow-ups ausente", recebido: "${mensagem}"`,
    );
  }
}

/** Test C (CR-02): sem referência do militante -> LANÇA, nunca filtra sem chave. */
function testeSemReferencia() {
  try {
    montarFiltroFollowUps({ refMilitante: '' }, 'militante_id');
    checar(false, 'montarFiltroFollowUps deveria LANÇAR quando refMilitante está vazio');
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    checar(
      mensagem.includes('referência do militante ausente'),
      `montarFiltroFollowUps sem refMilitante deveria citar "referência do militante ausente", recebido: "${mensagem}"`,
    );
  }
}

async function main() {
  await rejeitaComConfigAusente(listarTabela('x'), 'listarTabela');
  await rejeitaComConfigAusente(buscarMilitante({ cpf: '123' }), 'buscarMilitante');
  // Test D: config-ausente ainda vale mesmo com a assinatura nova (checarConfig roda antes da FK).
  await rejeitaComConfigAusente(listarFollowUps({ refMilitante: 'x' }), 'listarFollowUps');
  await rejeitaComConfigAusente(descobrirEsquema(), 'descobrirEsquema');

  testeFiltroCorreto();
  testeEnvAusente();
  testeSemReferencia();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
