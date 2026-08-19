// Aplica uma migração de sql/ na instância Supabase self-hosted via pg-meta
// (rota /pg/query do Kong, autenticada com a SUPABASE_SERVICE_KEY) — alternativa
// ao SQL editor/psql quando só há acesso REST. Depois de DDL, avisa o PostgREST
// pra recarregar o schema (NOTIFY pgrst). Nunca imprime a key (LGPD/segurança).
//
// Uso: node --env-file=.env scripts/aplicar-sql.mjs sql/escala/03_mensagens_whatsapp.sql
import fs from 'node:fs';

const U = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const K = process.env.SUPABASE_SERVICE_KEY;
if (!U || !K) throw new Error('SUPABASE_URL/SUPABASE_SERVICE_KEY ausentes no .env');
const arquivo = process.argv[2];
if (!arquivo) throw new Error('uso: aplicar-sql.mjs <caminho do .sql>');
const sql = fs.readFileSync(arquivo, 'utf8');

const H = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' };
async function query(q) {
  const r = await fetch(`${U}/pg/query`, {
    method: 'POST', headers: H, body: JSON.stringify({ query: q }),
    signal: AbortSignal.timeout(30_000),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${txt.slice(0, 300)}`);
  return txt;
}

await query(sql);
console.log(`aplicado: ${arquivo}`);
await query(`NOTIFY pgrst, 'reload schema'`);
// Neste deploy self-hosted o canal de NOTIFY do PostgREST está desabilitado —
// o cache de schema NÃO recarrega sozinho (constatado 2026-08-19: POST 404 {}
// em tabela nova com GET funcionando). Derrubar as conexões do `authenticator`
// força o PostgREST a reconectar e reconstruir o cache na hora.
await query(
  `select count(pg_terminate_backend(pid)) from pg_stat_activity where usename='authenticator' and pid <> pg_backend_pid()`,
);
console.log('PostgREST recarregado (reconexão forçada do authenticator)');
