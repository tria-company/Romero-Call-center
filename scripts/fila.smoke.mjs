#!/usr/bin/env node
// scripts/fila.smoke.mjs
//
// Smoke determinístico (sem rede) do mapeamento da fila de Ligações — Lista 02
// (LOTE-04/05, Fase 02 Plano 03). Prova que `mapearFilaLigacao`
// (src/mastra/lote.ts) extrai nome/telefone/idLead de cada TaskClickUp da
// fila SEMPRE por field-id (D-07, nunca por nome) e descarta tasks sem
// telefone (não são ligáveis — não fazem sentido na fila do discador).
//
// Uso: node --experimental-strip-types scripts/fila.smoke.mjs

import { mapearFilaLigacao } from '../src/mastra/lote.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// Field-ids de exemplo (fixture) — injetados como argumento (D-07), não
// importados de clickup.ts, para provar que lote.ts continua puro/genérico.
const CAMPOS_LIGACOES_FIXTURE = {
  ID_LEAD: 'field-id-lead-ligacoes',
  TELEFONE: 'field-telefone-ligacoes',
};

const tasksFixture = [
  {
    id: 'task-ligacao-1',
    name: 'Ligar — Maria Souza',
    custom_fields: [
      { id: CAMPOS_LIGACOES_FIXTURE.TELEFONE, value: '11988887777' },
      { id: CAMPOS_LIGACOES_FIXTURE.ID_LEAD, value: 'ghl-lead-1' },
    ],
  },
  {
    id: 'task-ligacao-2',
    name: 'Ligar — João Pereira',
    custom_fields: [
      { id: CAMPOS_LIGACOES_FIXTURE.TELEFONE, value: '11977776666' },
      { id: CAMPOS_LIGACOES_FIXTURE.ID_LEAD, value: 'ghl-lead-2' },
    ],
  },
  {
    // sem custom field de TELEFONE (dado incompleto) — não ligável, deve ser descartada.
    id: 'task-ligacao-sem-telefone',
    name: 'Ligar — Sem Telefone',
    custom_fields: [
      { id: CAMPOS_LIGACOES_FIXTURE.ID_LEAD, value: 'ghl-lead-3' },
    ],
  },
];

function testarMapeamento() {
  const itens = mapearFilaLigacao(tasksFixture, CAMPOS_LIGACOES_FIXTURE);

  checar(Array.isArray(itens), 'mapearFilaLigacao: deveria retornar um array');
  checar(
    itens.length === 2,
    `mapearFilaLigacao: deveria descartar a task sem telefone e retornar 2 itens, recebido ${itens.length}`,
  );

  const item1 = itens.find((i) => i.taskId === 'task-ligacao-1');
  checar(Boolean(item1), 'mapearFilaLigacao: deveria conter a task-ligacao-1');
  checar(item1?.nome === 'Ligar — Maria Souza', `mapearFilaLigacao: nome incorreto, recebido "${item1?.nome}"`);
  checar(item1?.telefone === '11988887777', `mapearFilaLigacao: telefone incorreto, recebido "${item1?.telefone}"`);
  checar(item1?.idLead === 'ghl-lead-1', `mapearFilaLigacao: idLead incorreto, recebido "${item1?.idLead}"`);

  const item2 = itens.find((i) => i.taskId === 'task-ligacao-2');
  checar(Boolean(item2), 'mapearFilaLigacao: deveria conter a task-ligacao-2');
  checar(item2?.nome === 'Ligar — João Pereira', `mapearFilaLigacao: nome incorreto (item2), recebido "${item2?.nome}"`);
  checar(item2?.telefone === '11977776666', `mapearFilaLigacao: telefone incorreto (item2), recebido "${item2?.telefone}"`);
  checar(item2?.idLead === 'ghl-lead-2', `mapearFilaLigacao: idLead incorreto (item2), recebido "${item2?.idLead}"`);

  checar(
    itens.every((i) => i.taskId !== 'task-ligacao-sem-telefone'),
    'mapearFilaLigacao: task sem telefone não deveria aparecer na fila (não é ligável)',
  );
}

testarMapeamento();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
