import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

config({ path: join(projectRoot, '.env') });

const arg = process.argv[2] || 'docs/sql/01_init.sql';
const sqlPath = resolve(projectRoot, arg);
const connectionString = process.env.SUPABASE_DB_URL;

if (!connectionString) {
  console.error('SUPABASE_DB_URL nao encontrada no .env');
  process.exit(1);
}

const sql = await readFile(sqlPath, 'utf8');
console.log(`[migrate] Aplicando ${arg} (${sql.length} bytes)`);

const client = new pg.Client({ connectionString });
try {
  await client.connect();
  console.log('[migrate] Conectado.');
  await client.query(sql);
  console.log('[migrate] Migration aplicada com sucesso.');
} catch (e) {
  console.error('[migrate] Falha:', e.message);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
