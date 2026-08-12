#!/usr/bin/env node
// scripts/voto-leads.smoke.mjs
//
// Smoke determinístico (sem rede) do mapa OPCOES_LEADS: garante que os 2 campos
// drop_down de voto da Lista 01 LEADS têm exatamente as 3 opções esperadas
// (sim/nao/naoDeclarou), cada uma com UUID válido e distinto — pega typo nos
// UUIDs copiados à mão de scripts/descobrir-campos-leads.mjs (drop_down exige o
// UUID exato; um errado é rejeitado pela API do ClickUp em runtime).
//
// Uso: node --experimental-strip-types scripts/voto-leads.smoke.mjs

import { OPCOES_LEADS, CAMPOS_LEADS } from '../src/mastra/clickup.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let falhas = 0;
const ok = (cond, msg) => { if (cond) { console.log('  ✅', msg); } else { console.error('  ❌', msg); falhas++; } };

console.log('=== smoke OPCOES_LEADS (voto) ===');

const campos = [
  ['CONFIRMOU_VOTO_ROMERO', CAMPOS_LEADS.CONFIRMOU_VOTO_ROMERO],
  ['CONFIRMOU_VOTO_ANDRESSA', CAMPOS_LEADS.CONFIRMOU_VOTO_ANDRESSA],
];

const todosUuids = [];
for (const [nome, fid] of campos) {
  console.log(`\n• ${nome}`);
  const opts = OPCOES_LEADS[fid];
  ok(!!opts, 'tem entrada em OPCOES_LEADS');
  if (!opts) continue;
  for (const chave of ['sim', 'nao', 'naoDeclarou']) {
    const v = opts[chave];
    ok(typeof v === 'string' && UUID.test(v), `opção "${chave}" é UUID válido (${v})`);
    if (v) todosUuids.push(v);
  }
}

// Nenhum UUID pode se repetir (entre opções e entre campos) — copy-paste errado
// costuma repetir um UUID em duas opções.
const distintos = new Set(todosUuids);
ok(distintos.size === todosUuids.length, `todos os ${todosUuids.length} UUIDs são distintos`);

console.log(falhas === 0 ? '\n✅ smoke OPCOES_LEADS OK' : `\n❌ ${falhas} falha(s)`);
process.exit(falhas === 0 ? 0 : 1);
