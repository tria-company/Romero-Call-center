// Sobe arquivos de MÍDIA para o bucket de conteúdos do Supabase self-hosted
// (Fase 5 — biblioteca de conteúdos). Cria o bucket PÚBLICO se não existir e faz
// upsert de cada arquivo, imprimindo a URL pública — é essa URL que vai em
// conteudos.url e que o WhatsApp/Evolution busca na hora de enviar a mídia.
//
// SEGURO: as credenciais vêm do --env-file (o Node carrega no processo). O script
// NUNCA imprime a service key. LGPD: só nomes de arquivo e URLs (públicas por design).
//
// Uso (rode da RAIZ do worktree, apontando pro .env que tem as chaves do Supabase):
//   node --env-file="/caminho/para/.env" scripts/upload-conteudo-midia.mjs [--prefixo=pasta] arq1.png arq2.jpg ...
//
// Bucket: SUPABASE_STORAGE_BUCKET_CONTEUDOS (default 'conteudos'). Prefixo (pasta
// dentro do bucket): --prefixo= (default 'biblioteca').

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

const SUPA = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET_CONTEUDOS || 'conteudos';

if (!SUPA || !KEY) {
  console.error('[upload] SUPABASE_URL/SUPABASE_SERVICE_KEY ausentes — rode com --env-file=<seu .env>');
  process.exit(1);
}

let prefixo = 'biblioteca';
const arquivos = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--prefixo=')) prefixo = a.slice('--prefixo='.length).replace(/^\/+|\/+$/g, '');
  else arquivos.push(a);
}
if (arquivos.length === 0) {
  console.error('[upload] passe ao menos um arquivo. Ex.: node --env-file=.env scripts/upload-conteudo-midia.mjs foto.png');
  process.exit(1);
}

const CT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.pdf': 'application/pdf',
};

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function garantirBucket() {
  const r = await fetch(`${SUPA}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 52428800 }),
  });
  if (r.ok) return console.log(`[upload] bucket '${BUCKET}' criado (público).`);
  const txt = await r.text().catch(() => '');
  if (r.status === 400 || r.status === 409 || /exist/i.test(txt)) {
    return console.log(`[upload] bucket '${BUCKET}' já existe — ok.`);
  }
  throw new Error(`falha ao criar bucket (${r.status}): ${txt}`);
}

function chaveObjeto(arquivo) {
  const nome = basename(arquivo).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-');
  return `${prefixo}/${nome}`;
}

async function subir(arquivo) {
  const bytes = readFileSync(arquivo);
  const ct = CT[extname(arquivo).toLowerCase()] || 'application/octet-stream';
  const chave = chaveObjeto(arquivo);
  const r = await fetch(`${SUPA}/storage/v1/object/${BUCKET}/${chave}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': ct, 'x-upsert': 'true' },
    body: bytes,
  });
  if (!r.ok) throw new Error(`falha ao subir (${r.status}): ${await r.text().catch(() => '')}`);
  return `${SUPA}/storage/v1/object/public/${BUCKET}/${chave}`;
}

(async () => {
  await garantirBucket();
  console.log('');
  for (const arq of arquivos) {
    try {
      const url = await subir(arq);
      console.log(`OK  ${basename(arq)}\n    -> ${url}\n`);
    } catch (e) {
      console.error(`ERRO ${basename(arq)}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  console.log('[upload] pronto. Copie as URLs acima e me mande — eu cadastro os panfletos na biblioteca.');
})().catch((e) => {
  console.error('[upload] erro:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
