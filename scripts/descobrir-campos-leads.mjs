#!/usr/bin/env node
// scripts/descobrir-campos-leads.mjs
//
// Runner de descoberta: lê a DEFINIÇÃO dos custom fields da Lista 01 LEADS via
// API do ClickUp (GET /list/:id/field) e imprime tipo + opções dos campos de
// voto (CONFIRMOU_VOTO_ROMERO / CONFIRMOU_VOTO_ANDRESSA). Serve pra fixar o
// tipo correto na escrita (checkbox aceita boolean; drop_down exige o UUID da
// opção — mesmo racional de OPCOES_LIGACOES). NÃO escreve nada.
//
// Uso:
//   node --env-file=.env --experimental-strip-types scripts/descobrir-campos-leads.mjs
//
// LGPD: imprime só metadados de campo (id/nome/tipo/opções) — nenhum valor de
// task, nenhum telefone/CPF/nome de lead.

import { CLICKUP_API_TOKEN, CLICKUP_LIST_LEADS } from '../src/mastra/config.ts';
import { CAMPOS_LEADS } from '../src/mastra/clickup.ts';

const ALVO = {
  [CAMPOS_LEADS.CONFIRMOU_VOTO_ROMERO]: 'CONFIRMOU_VOTO_ROMERO',
  [CAMPOS_LEADS.CONFIRMOU_VOTO_ANDRESSA]: 'CONFIRMOU_VOTO_ANDRESSA',
};

async function main() {
  if (!CLICKUP_API_TOKEN) {
    console.error('CLICKUP_API_TOKEN ausente — rode com --env-file=.env');
    process.exit(1);
  }
  const url = `https://api.clickup.com/api/v2/list/${CLICKUP_LIST_LEADS}/field`;
  const res = await fetch(url, { headers: { Authorization: CLICKUP_API_TOKEN } });
  if (!res.ok) {
    console.error(`GET /list/${CLICKUP_LIST_LEADS}/field falhou (${res.status})`);
    process.exit(1);
  }
  const { fields = [] } = await res.json();
  console.log(`=== Campos de voto na Lista 01 LEADS (${CLICKUP_LIST_LEADS}) ===\n`);
  let achou = 0;
  for (const f of fields) {
    if (!ALVO[f.id]) continue;
    achou++;
    console.log(`• ${ALVO[f.id]}`);
    console.log(`  id:    ${f.id}`);
    console.log(`  name:  ${f.name}`);
    console.log(`  type:  ${f.type}`);
    const opts = f.type_config && f.type_config.options;
    if (Array.isArray(opts)) {
      console.log('  options:');
      for (const o of opts) {
        console.log(`    - "${o.name ?? o.label ?? ''}"  id=${o.id}  orderindex=${o.orderindex}`);
      }
    }
    console.log('');
  }
  if (achou === 0) {
    console.error('Nenhum dos 2 campos de voto encontrado na lista — confira os field-ids em CAMPOS_LEADS.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('erro:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
