// Smoke de CLEAN-02: prova estatica (sem rede, sem SUPABASE_URL) de que
// src/mastra/supabase.ts le/escreve exclusivamente em tabelas com prefixo
// `auton_sdr_` e nao tem mais nenhuma referencia ao naming legado do bot
// Closer legado compartilhado.
//
// Mesma convencao dos demais smokes (node --experimental-strip-types,
// contador de falhas, process.exit(falhas ? 1 : 0)).
//
// Nota: o token do naming legado e montado em runtime (nao aparece como
// substring literal neste arquivo) para que o proprio grep de verificacao
// deste plano (`grep -rn "_<legado>\|<legado>_" src scripts`) nao acuse
// este smoke como falso-positivo — o smoke PROCURA o residuo, nao O CONTEM.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const supabasePath = resolve(__dirname, '../src/mastra/supabase.ts');
const dashboardPath = resolve(__dirname, '../src/mastra/dashboard.ts');
const conteudo = readFileSync(supabasePath, 'utf8');
const conteudoDashboard = readFileSync(dashboardPath, 'utf8');

const falhas = [];

function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// ---- Checagem 1: toda URL /rest/v1/<tabela> usa prefixo auton_sdr_ ----
const regexRestV1 = /\/rest\/v1\/([a-zA-Z_][a-zA-Z0-9_]*)/g;
const tabelasReferenciadas = new Set();
let match;
while ((match = regexRestV1.exec(conteudo)) !== null) {
  tabelasReferenciadas.add(match[1]);
}

checar('pelo menos 1 tabela /rest/v1/ encontrada em supabase.ts', tabelasReferenciadas.size > 0);

const tabelasSemPrefixo = [...tabelasReferenciadas].filter((t) => !t.startsWith('auton_sdr_'));
checar(
  `toda tabela /rest/v1/ comeca com auton_sdr_ (achadas sem prefixo: ${tabelasSemPrefixo.join(', ') || 'nenhuma'})`,
  tabelasSemPrefixo.length === 0
);

// ---- Checagem 2: zero ocorrencias do naming legado (bot Closer legado)
// no conteudo — token montado em runtime, ver nota do topo.
const legado = 'rob' + 'erth';
const regexLegado = new RegExp(`_${legado}|${legado}_`, 'gi');
const ocorrenciasLegado = conteudo.match(regexLegado) ?? [];
checar(
  `0 ocorrencias do naming legado em supabase.ts (achadas: ${ocorrenciasLegado.length})`,
  ocorrenciasLegado.length === 0
);

// ---- Checagem 3 (WR-04, 4a rodada): exports mortos do Closer REMOVIDOS de
// supabase.ts — as declaracoes nao podem voltar (tombstone comments podem
// citar o nome em prosa; o assert e sobre a DECLARACAO).
for (const fnMorta of [
  'buscarConversasParaFollowUp',
  'registrarObjecao',
  'contarConversoes',
  'contarFollowUps',
]) {
  checar(
    `WR-04: supabase.ts NAO declara mais 'export async function ${fnMorta}'`,
    !conteudo.includes(`export async function ${fnMorta}`),
  );
}

// ---- Checagem 4 (WR-03, 4a rodada): nenhuma QUERY usa link_enviado (coluna
// sem writer desde a remocao da tool de checkout do Closer). Prosa em
// comentario pode citar o nome; o assert e sobre USO em filtro/select.
checar(
  'WR-03: supabase.ts nao filtra nem seleciona link_enviado em nenhuma query',
  !/link_enviado=eq\.|select=[^`\n]*link_enviado/.test(conteudo),
);

// ---- Checagem 5 (WR-03, 4a rodada): dashboard neutralizado — sem branding
// legado do produto anterior e sem consumir as metricas mortas do Closer.
const brandingLegado = 'Rei' + ' Delas'; // montado em runtime (mesma nota do topo)
checar(
  `WR-03: dashboard.ts NAO contem o branding legado '${brandingLegado}'`,
  !conteudoDashboard.includes(brandingLegado),
);
checar(
  "WR-03: dashboard.ts NAO contem o rotulo 'checkouts' (cards de conversao do Closer)",
  !conteudoDashboard.includes('checkouts'),
);
for (const fnMorta of ['contarConversoes', 'contarFollowUps']) {
  checar(
    `WR-03: dashboard.ts NAO referencia mais ${fnMorta}`,
    !conteudoDashboard.includes(fnMorta),
  );
}
checar(
  'WR-03: dashboard.ts NAO le mais conversa.link_enviado (campo morto no viewer)',
  !conteudoDashboard.includes('link_enviado'),
);

if (falhas.length > 0) {
  console.error('[smoke-tabelas-auton] CLEAN-02/WR-03/WR-04 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log(`[smoke-tabelas-auton] CLEAN-02 OK (${tabelasReferenciadas.size} tabelas auton_sdr_ confirmadas, 0 residuo de naming legado) + WR-03/WR-04 OK (metricas/exports mortos do Closer fora de supabase.ts e dashboard.ts)`);
