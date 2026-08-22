#!/usr/bin/env node
// scripts/correlacao-telefone.gate.mjs
//
// Gate de CORRELAÇÃO ±9º dígito (R4, obrigatório — Fase B, Phase 19, LEITURA-05,
// design §4/§5.3). Prova, contra dados semeados em hml_ (DB-only, seguro a
// qualquer hora — nunca toca o ClickUp), que as formas de 12 e 13 dígitos do
// MESMO número casam a MESMA ligação aberta via
// `buscarLigacaoAbertaPorTelefoneSupabase` (src/mastra/supabase.ts).
//
// Como a prova funciona: `canonizarTelefone`/`variantesTelefone`
// (src/mastra/telefone-canonico.ts) são a fonte única de normalização — 12 e
// 13 dígitos do mesmo número produzem o MESMO `telefone_canonico` e o MESMO
// conjunto de variantes. O gate semeia UMA ligação 'aberta' em hml_ligacoes
// com esse canônico + variantes e então chama
// `buscarLigacaoAbertaPorTelefoneSupabase(num12)` e
// `buscarLigacaoAbertaPorTelefoneSupabase(num13)`: as duas TÊM que devolver o
// MESMO id da linha semeada. Se qualquer forma não casar (ou casarem ids
// diferentes), o gate falha (sai 1).
//
// SEGURANÇA (T-19-10-Th/I): a tabela de ligações vem do env e é validada
// contra /^hml_[a-z0-9_]+$/ ANTES de qualquer uso (nunca contra produção). O
// número é SINTÉTICO (DDD 99 + local derivado do runId, faixa implausível) —
// reduz a ~zero a chance de casar uma ligação real aberta. LGPD: o telefone
// completo NUNCA é impresso; o gate loga só ids/contagens.
//
// Uso: node --experimental-strip-types --env-file=deploy/homolog.env scripts/correlacao-telefone.gate.mjs

import { buscarLigacaoAbertaPorTelefoneSupabase } from '../src/mastra/supabase.ts';
import { canonizarTelefone, variantesTelefone } from '../src/mastra/telefone-canonico.ts';

// ===== Config env =====

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TABELA_LIGACOES = process.env.SUPABASE_TABLE_LIGACOES || '';

const RE_IDENTIFICADOR_HML = /^hml_[a-z0-9_]+$/;

if (!SUPABASE_URL) {
  console.error('[gate] ABORTANDO: SUPABASE_URL ausente.');
  process.exit(1);
}
if (!SUPABASE_SERVICE_KEY) {
  console.error('[gate] ABORTANDO: SUPABASE_SERVICE_KEY ausente.');
  process.exit(1);
}
if (!TABELA_LIGACOES || !RE_IDENTIFICADOR_HML.test(TABELA_LIGACOES)) {
  console.error(
    `[gate] ABORTANDO: SUPABASE_TABLE_LIGACOES="${TABELA_LIGACOES}" não é um identificador hml_ ` +
      `seguro (precisa casar ${RE_IDENTIFICADOR_HML}) — recusando rodar contra produção.`,
  );
  process.exit(1);
}

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const HEADERS_PG = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function pgQuery(sql) {
  const r = await fetch(`${SUPABASE_URL}/pg/query`, {
    method: 'POST',
    headers: HEADERS_PG,
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(30_000),
  });
  const texto = await r.text();
  if (!r.ok) {
    throw new Error(`[gate] pgQuery HTTP ${r.status} — ${texto.slice(0, 300)}`);
  }
  if (!texto) return [];
  return JSON.parse(texto);
}

// Número SINTÉTICO em par 12/13 dígitos do MESMO número (DDD 99 + local
// derivado do runId, faixa implausível). num13 = num12 com o 9º dígito
// inserido após o DDD.
function gerarParTelefoneSintetico() {
  // 8 dígitos de local a partir do runId (só dígitos, preenchido/truncado).
  const soDigitos = runId.replace(/\D/g, '');
  const local8 = (soDigitos + '00000000').slice(-8);
  const num12 = `55${'99'}${local8}`; // 55 + DDD 99 + 8 dígitos = 12
  const num13 = `55${'99'}9${local8}`; // insere o 9 após o DDD = 13
  return { num12, num13 };
}

async function main() {
  console.log(
    `[gate] correlacao-telefone — runId=${runId} — DB-only (nunca chama o ClickUp) — tabela=${TABELA_LIGACOES}`,
  );

  const { num12, num13 } = gerarParTelefoneSintetico();

  // Sanidade da normalização (pura, sem I/O) antes de tocar o banco: 12 e 13
  // dígitos DEVEM produzir o mesmo canônico. LGPD: não imprime o número.
  const canon12 = canonizarTelefone(num12);
  const canon13 = canonizarTelefone(num13);
  if (!canon12 || canon12 !== canon13) {
    console.error(
      `[gate] FALHA (pré-DB): canonizarTelefone diverge entre 12 e 13 dígitos (canon12 vazio=${!canon12}, ` +
        `iguais=${canon12 === canon13}) — a fonte única de normalização não unifica ±9º dígito.`,
    );
    process.exit(1);
  }

  const canon = canon12;
  const variantes = variantesTelefone(num13); // conjunto ±9º dígito (com '+')
  const variantesSql = `array[${variantes.map((v) => `'${v}'`).join(',')}]::text[]`;

  let ligId = null;
  try {
    // Semeia UMA ligação aberta com o canônico + variantes.
    const linhas = await pgQuery(`
      insert into ${TABELA_LIGACOES} (lead_id, telefone_canonico, telefone_variantes, status, origem)
      values (990000000, '${canon}', ${variantesSql}, 'aberta', 'avulsa')
      returning id;`);
    ligId = linhas[0]?.id;
    if (!ligId) throw new Error('[gate] falha ao semear a ligação aberta de teste');
    console.log(`[gate] ligação de teste semeada: id=${ligId} (canônico/variantes não logados — LGPD)`);

    // Prova: 12 e 13 dígitos casam a MESMA ligação (o id semeado).
    const achado12 = await buscarLigacaoAbertaPorTelefoneSupabase(num12);
    const achado13 = await buscarLigacaoAbertaPorTelefoneSupabase(num13);

    const idEsperado = String(ligId);
    const ok12 = achado12 === idEsperado;
    const ok13 = achado13 === idEsperado;
    const iguais = achado12 !== null && achado12 === achado13;

    console.log(
      `[gate] resultado: 12díg -> ${achado12}  13díg -> ${achado13}  ` +
        `(esperado ${idEsperado}; casam=${ok12 && ok13}; mesmo id=${iguais})`,
    );

    if (!ok12 || !ok13 || !iguais) {
      console.error('=== GATE FAIL ===');
      if (!ok12) console.error(`  - forma de 12 dígitos NÃO casou a ligação semeada (achou ${achado12}, esperava ${idEsperado})`);
      if (!ok13) console.error(`  - forma de 13 dígitos NÃO casou a ligação semeada (achou ${achado13}, esperava ${idEsperado})`);
      if (!iguais) console.error(`  - 12 e 13 dígitos casaram ligações DIFERENTES (${achado12} vs ${achado13})`);
      process.exit(1);
    }
  } finally {
    if (ligId !== null) {
      try {
        await pgQuery(`delete from ${TABELA_LIGACOES} where id = ${ligId};`);
      } catch (e) {
        console.error(`[gate] AVISO: falha ao limpar a ligação de teste id=${ligId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Sweep defensivo por canônico sintético.
    try {
      await pgQuery(`delete from ${TABELA_LIGACOES} where telefone_canonico = '${canon}';`);
    } catch {
      /* já limpo */
    }
  }

  console.log('GATE OK: correlação ±9º dígito PROVADA — 12 e 13 dígitos do mesmo número casam a MESMA ligação aberta');
  process.exit(0);
}

main().catch((e) => {
  console.error(`[gate] ERRO FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
