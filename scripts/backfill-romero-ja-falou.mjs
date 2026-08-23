// Backfill da flag "Romero já falou" no espelho (coluna romero_ja_falou,
// migração escala/29).
//
// POR QUE EXISTE: a marca passou a ser gravada write-through no envio (áudio/
// texto) a partir do deploy da Fase 3. Este script reconstrói o histórico JÁ
// existente cruzando `mensagens_whatsapp`: todo lead_task_id que aparece lá com
// de_nos=true (mensagem NOSSA) já teve conversa iniciada pelo Romero — então
// entra no recorte "Romero já falou".
//
// SEGURO POR PADRÃO: sem `--aplicar` só relata (quantos leads seriam marcados).
// Idempotente (PATCH romero_ja_falou=true; reaplicar não muda nada).
//
// Uso:
//   node --env-file=.env scripts/backfill-romero-ja-falou.mjs            # relatório
//   node --env-file=.env scripts/backfill-romero-ja-falou.mjs --aplicar  # grava
//
// Homolog: respeita SUPABASE_TABLE_* (hml_) do env — rode com o env do homolog.
// LGPD: só ids de task. Nenhum telefone/CPF/nome é lido ou impresso.

const APLICAR = process.argv.includes('--aplicar');
const SUPA = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY;
const T_MSG = process.env.SUPABASE_TABLE_MENSAGENS_WHATSAPP || 'mensagens_whatsapp';
const T_ESP = process.env.SUPABASE_TABLE_LEADS_ESPELHO || 'discador_leads_espelho';

if (!SUPA || !KEY) {
  console.error('[backfill] SUPABASE_URL/SUPABASE_SERVICE_KEY ausentes — rode com --env-file=.env');
  process.exit(1);
}

const REST = `${SUPA}/rest/v1`;
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

/** Coleta os lead_task_id distintos que têm mensagem NOSSA persistida. */
async function coletarLeadsComConversa() {
  const ids = new Set();
  const passo = 1000;
  let offset = 0;
  for (;;) {
    const url =
      `${REST}/${T_MSG}?select=lead_task_id&de_nos=is.true&lead_task_id=not.is.null` +
      `&order=lead_task_id.asc&limit=${passo}&offset=${offset}`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`GET ${T_MSG} falhou (${r.status})`);
    const linhas = await r.json();
    for (const l of linhas) if (l.lead_task_id) ids.add(String(l.lead_task_id));
    if (linhas.length < passo) break;
    offset += passo;
  }
  return [...ids];
}

/** PATCH em lotes (clickup_task_id=in.(...)) — 1 chamada por chunk. */
async function marcarLote(ids) {
  const chunk = 150;
  let marcados = 0;
  for (let i = 0; i < ids.length; i += chunk) {
    const lote = ids.slice(i, i + chunk);
    const inList = lote.map((x) => encodeURIComponent(x)).join(',');
    const url = `${REST}/${T_ESP}?clickup_task_id=in.(${inList})`;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ romero_ja_falou: true }),
    });
    if (!r.ok) throw new Error(`PATCH ${T_ESP} falhou (${r.status})`);
    marcados += lote.length;
  }
  return marcados;
}

(async () => {
  const ids = await coletarLeadsComConversa();
  console.log(`[backfill] leads com conversa nossa (de_nos=true) em ${T_MSG}: ${ids.length}`);
  if (!APLICAR) {
    console.log('[backfill] DRY-RUN — nada gravado. Rode com --aplicar para marcar romero_ja_falou=true.');
    return;
  }
  const n = await marcarLote(ids);
  console.log(`[backfill] PATCH enviado para ${n} ids em ${T_ESP} (romero_ja_falou=true).`);
})().catch((e) => {
  console.error('[backfill] erro:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
