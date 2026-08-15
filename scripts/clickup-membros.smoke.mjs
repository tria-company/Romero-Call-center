#!/usr/bin/env node
// scripts/clickup-membros.smoke.mjs
//
// Smoke determinístico (sem rede) de `mapearMembrosTeam` (src/mastra/clickup.ts,
// Fase 11 Plano 04, D-03): achata `GET /team` (`{ teams: [{ members: [{ user }] }] }`)
// numa lista de membros deduplicada por `id`, e nunca lança em entrada
// ausente/malformada (retorna `[]`).
//
// `listarMembrosWorkspace()` (a função com I/O) não é testada aqui — faz uma
// chamada de rede real ao ClickUp, fora do escopo de um smoke sem rede (mesmo
// racional dos outros smokes de módulo deste projeto).
//
// Uso: node --experimental-strip-types scripts/clickup-membros.smoke.mjs

import { mapearMembrosTeam } from '../src/mastra/clickup.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// Caso 1: fixture com 2 teams, membros repetidos entre eles -> achata + dedupa por id.
const fixtureComRepeticao = {
  teams: [
    {
      members: [
        { user: { id: 1, username: 'joao', email: 'joao@example.com' } },
        { user: { id: 2, username: 'maria', email: 'maria@example.com' } },
      ],
    },
    {
      members: [
        // mesmo id 1 (numero, não string) repetido no segundo team -> dedupa.
        { user: { id: 1, username: 'joao', email: 'joao@example.com' } },
        { user: { id: 3, username: 'pedro', email: 'pedro@example.com' } },
      ],
    },
  ],
};

const resultado1 = mapearMembrosTeam(fixtureComRepeticao);
checar(
  resultado1.length === 3,
  `mapearMembrosTeam deveria achatar+dedupar para 3 membros, recebido ${resultado1.length}: ${JSON.stringify(resultado1)}`,
);
checar(
  resultado1.every((m) => typeof m.id === 'string'),
  `mapearMembrosTeam deveria devolver id sempre como String, recebido: ${JSON.stringify(resultado1)}`,
);
const idsResultado1 = resultado1.map((m) => m.id).sort();
checar(
  JSON.stringify(idsResultado1) === JSON.stringify(['1', '2', '3']),
  `mapearMembrosTeam deveria devolver ids ['1','2','3'], recebido: ${JSON.stringify(idsResultado1)}`,
);
const joao = resultado1.find((m) => m.id === '1');
checar(
  joao && joao.nome === 'joao' && joao.email === 'joao@example.com',
  `mapearMembrosTeam deveria mapear username->nome e email->email, recebido: ${JSON.stringify(joao)}`,
);

// Caso 2: fixture vazio -> [].
checar(
  Array.isArray(mapearMembrosTeam({})) && mapearMembrosTeam({}).length === 0,
  `mapearMembrosTeam({}) deveria ser [], recebido: ${JSON.stringify(mapearMembrosTeam({}))}`,
);

// Caso 3: null -> [] (nunca lança).
checar(
  Array.isArray(mapearMembrosTeam(null)) && mapearMembrosTeam(null).length === 0,
  `mapearMembrosTeam(null) deveria ser [], recebido: ${JSON.stringify(mapearMembrosTeam(null))}`,
);

// Caso 4: sem `teams` -> [].
checar(
  Array.isArray(mapearMembrosTeam({ foo: 'bar' })) && mapearMembrosTeam({ foo: 'bar' }).length === 0,
  `mapearMembrosTeam({foo:'bar'}) deveria ser [], recebido: ${JSON.stringify(mapearMembrosTeam({ foo: 'bar' }))}`,
);

// Caso 5: teams com members malformado (não-array) -> pula sem lançar.
checar(
  Array.isArray(mapearMembrosTeam({ teams: [{ members: 'nao-e-array' }] })) &&
    mapearMembrosTeam({ teams: [{ members: 'nao-e-array' }] }).length === 0,
  `mapearMembrosTeam com members malformado deveria ser [], recebido: ${JSON.stringify(mapearMembrosTeam({ teams: [{ members: 'nao-e-array' }] }))}`,
);

// Caso 6: membro sem user.id -> pulado (não quebra os demais).
const fixtureSemId = {
  teams: [
    {
      members: [
        { user: { username: 'sem-id', email: 'sem-id@example.com' } },
        { user: { id: 9, username: 'com-id', email: 'com-id@example.com' } },
      ],
    },
  ],
};
const resultado6 = mapearMembrosTeam(fixtureSemId);
checar(
  resultado6.length === 1 && resultado6[0].id === '9',
  `mapearMembrosTeam deveria pular membro sem user.id e manter o com id, recebido: ${JSON.stringify(resultado6)}`,
);

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
