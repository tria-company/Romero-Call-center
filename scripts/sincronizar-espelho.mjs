#!/usr/bin/env node
// scripts/sincronizar-espelho.mjs
//
// Backfill/refresh do ESPELHO (u10, generalizado 17-02): copia da Lista 01
// LEADS (registro completo), Lista 02 LIGACOES ou Lista 03 AUDIOS do ClickUp
// pro read-model Postgres, escolhido por `--alvo`. O ClickUp segue a fonte da
// verdade; este é só um cache de leitura (Fase A — nada lê estas tabelas
// ainda, exceto discador_leads_espelho no caminho da Base).
//
// PRÉ-REQUISITO: as tabelas precisam existir — aplique sql/escala/06..08.sql
// (via scripts/aplicar-sql.mjs) antes do primeiro backfill de cada alvo.
//
// Uso:
//   node --env-file=.env --experimental-strip-types scripts/sincronizar-espelho.mjs [--alvo ligacoes|audios|leads] [--dry-run] [--paginas N]
//     --alvo N      qual tabela sincronizar (default: leads, retrocompatível)
//     --dry-run     lê do ClickUp e conta, mas NÃO grava (validação sem tocar no banco)
//     --paginas N   sincroniza só N páginas (100 registros cada) — teste rápido; sem isso, tudo
//
// LGPD: imprime só contagem/página — nunca telefone/cpf/nome/transcrição.

import { sincronizarEspelhoLeads, sincronizarEspelhoLigacoes, sincronizarEspelhoAudios } from '../src/mastra/espelho.ts';
import {
  CLICKUP_API_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUPABASE_TABLE_LEADS_ESPELHO,
  SUPABASE_TABLE_LIGACOES,
  SUPABASE_TABLE_AUDIOS_ENVIOS,
} from '../src/mastra/config.ts';

function arg(nome) {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? (process.argv[i + 1] ?? '') : null;
}
const dryRun = process.argv.includes('--dry-run');
const paginas = Number(arg('--paginas')) || 0;
const alvo = arg('--alvo') || 'leads';

const ALVOS = {
  leads: { sync: sincronizarEspelhoLeads, tabela: SUPABASE_TABLE_LEADS_ESPELHO },
  ligacoes: { sync: sincronizarEspelhoLigacoes, tabela: SUPABASE_TABLE_LIGACOES },
  audios: { sync: sincronizarEspelhoAudios, tabela: SUPABASE_TABLE_AUDIOS_ENVIOS },
};

async function main() {
  const escolhido = ALVOS[alvo];
  if (!escolhido) {
    console.error(`--alvo inválido: '${alvo}' — use um de: ${Object.keys(ALVOS).join(', ')}`);
    process.exit(1);
  }
  if (!CLICKUP_API_TOKEN) {
    console.error('CLICKUP_API_TOKEN ausente — rode com --env-file=.env');
    process.exit(1);
  }
  if (!dryRun && (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)) {
    console.error('SUPABASE_URL/SUPABASE_SERVICE_KEY ausentes — sem isso não dá pra gravar o espelho');
    process.exit(1);
  }
  console.log(
    `[espelho:${alvo}] ${dryRun ? 'DRY-RUN (não grava)' : 'gravando em ' + escolhido.tabela}` +
      `${paginas ? ' — ' + paginas + ' página(s)' : ' — base inteira'}`,
  );
  const t0 = Date.now();
  const r = await escolhido.sync({
    maxPaginas: paginas,
    dryRun,
    onProgress: (pag, registros) => {
      if (pag <= 3 || pag % 10 === 0) console.log(`[espelho:${alvo}] página ${pag} — ${registros} registro(s) acumulado(s)`);
    },
  });
  const seg = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[espelho:${alvo}] pronto: ${r.paginas} página(s), ${r.registros} registro(s) em ${seg}s${dryRun ? ' (dry-run, nada gravado)' : ''}`,
  );
}

main().catch((e) => {
  console.error(`[espelho:${alvo}] erro:`, e instanceof Error ? e.message : String(e));
  process.exit(1);
});
