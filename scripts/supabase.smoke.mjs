#!/usr/bin/env node
// scripts/supabase.smoke.mjs
//
// Smoke determinístico (sem rede) do client Supabase self-hosted (DOSS-01/02,
// Fase 04 Plano 01, D-P4-11). Roda SEM `--env-file` (env vazio) e prova que
// `listarTabela`/`buscarMilitante`/`listarFollowUps`/`descobrirEsquema`
// LANÇAM com mensagem clara de config ausente (SUPABASE_URL/
// SUPABASE_SERVICE_KEY) — nunca resolvem vazio silenciosamente (WR-03).
//
// Uso: node --experimental-strip-types scripts/supabase.smoke.mjs

import { listarTabela, buscarMilitante, listarFollowUps, descobrirEsquema } from '../src/mastra/supabase.ts';

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

async function main() {
  await rejeitaComConfigAusente(listarTabela('x'), 'listarTabela');
  await rejeitaComConfigAusente(buscarMilitante({ cpf: '123' }), 'buscarMilitante');
  await rejeitaComConfigAusente(listarFollowUps({ cpf: '123' }), 'listarFollowUps');
  await rejeitaComConfigAusente(descobrirEsquema(), 'descobrirEsquema');

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
