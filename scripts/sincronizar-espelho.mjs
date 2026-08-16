#!/usr/bin/env node
// scripts/sincronizar-espelho.mjs
//
// Backfill/refresh do ESPELHO (u10): copia os leads da Lista 01 do ClickUp pro
// read-model Postgres (discador_leads_espelho), pra a Base do painel ser rápida
// (busca/filtro/paginação em ms em vez de ~2,7s/página no ClickUp). O ClickUp
// segue a fonte da verdade; este é só um cache de leitura.
//
// PRÉ-REQUISITO: a tabela precisa existir — aplique sql/escala/02_leads_espelho.sql
// no SQL editor do Supabase antes do primeiro backfill.
//
// Uso:
//   node --env-file=.env --experimental-strip-types scripts/sincronizar-espelho.mjs [--dry-run] [--paginas N]
//     --dry-run     lê do ClickUp e conta, mas NÃO grava (validação sem tocar no banco)
//     --paginas N   sincroniza só N páginas (100 leads cada) — teste rápido; sem isso, tudo
//
// LGPD: imprime só contagem/página — nunca telefone/cpf/nome.

import { sincronizarEspelhoLeads } from '../src/mastra/espelho.ts';
import {
  CLICKUP_API_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUPABASE_TABLE_LEADS_ESPELHO,
} from '../src/mastra/config.ts';

function arg(nome) {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? (process.argv[i + 1] ?? '') : null;
}
const dryRun = process.argv.includes('--dry-run');
const paginas = Number(arg('--paginas')) || 0;

async function main() {
  if (!CLICKUP_API_TOKEN) {
    console.error('CLICKUP_API_TOKEN ausente — rode com --env-file=.env');
    process.exit(1);
  }
  if (!dryRun && (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)) {
    console.error('SUPABASE_URL/SUPABASE_SERVICE_KEY ausentes — sem isso não dá pra gravar o espelho');
    process.exit(1);
  }
  console.log(
    `[espelho] ${dryRun ? 'DRY-RUN (não grava)' : 'gravando em ' + SUPABASE_TABLE_LEADS_ESPELHO}` +
      `${paginas ? ' — ' + paginas + ' página(s)' : ' — base inteira'}`,
  );
  const t0 = Date.now();
  const r = await sincronizarEspelhoLeads({
    maxPaginas: paginas,
    dryRun,
    onProgress: (pag, leads) => {
      if (pag <= 3 || pag % 10 === 0) console.log(`[espelho] página ${pag} — ${leads} leads acumulados`);
    },
  });
  const seg = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[espelho] pronto: ${r.paginas} página(s), ${r.leads} leads em ${seg}s${dryRun ? ' (dry-run, nada gravado)' : ''}`,
  );
}

main().catch((e) => {
  console.error('[espelho] erro:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
