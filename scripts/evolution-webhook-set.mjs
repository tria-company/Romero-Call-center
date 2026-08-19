// Configura o WEBHOOK da instância Evolution → o receptor do backend (Fase 13):
// POST /webhook/set/<instância> com MESSAGES_UPSERT + base64 (o áudio do lead já
// chega no evento). Uso único por ambiente — a instância tem UM webhook: apontar
// pra produção desliga o recebimento no local (e vice-versa).
//
// Uso: node --env-file=.env scripts/evolution-webhook-set.mjs https://<host-do-backend>
//   ex. produção: node --env-file=.env scripts/evolution-webhook-set.mjs https://discador.<ip>.sslip.io
//   ex. local:    node --env-file=.env scripts/evolution-webhook-set.mjs https://<tunel>.trycloudflare.com
//
// Requer no env: EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE e
// EVOLUTION_WEBHOOK_TOKEN (o MESMO valor configurado no backend — o receptor
// compara). LGPD/segurança: nunca imprime a apikey nem o token.

const U = process.env.EVOLUTION_API_URL?.replace(/\/+$/, '');
const K = process.env.EVOLUTION_API_KEY;
const I = process.env.EVOLUTION_INSTANCE;
const TOKEN = process.env.EVOLUTION_WEBHOOK_TOKEN;
if (!U || !K || !I) throw new Error('EVOLUTION_API_URL/API_KEY/INSTANCE ausentes no env');
if (!TOKEN) throw new Error('EVOLUTION_WEBHOOK_TOKEN ausente no env — gere com `openssl rand -hex 24` (mesmo valor do backend)');
const BASE = process.argv[2]?.replace(/\/+$/, '');
if (!BASE) throw new Error('uso: evolution-webhook-set.mjs <url-base-do-backend>');

const H = { apikey: K, 'Content-Type': 'application/json' };
const urlWebhook = `${BASE}/api/evolution/webhook?token=${TOKEN}`;

// v2 usa o shape aninhado; algumas versões aceitam só o plano — tenta os dois.
const shapes = [
  { nome: 'aninhado', body: { webhook: { enabled: true, url: urlWebhook, byEvents: false, base64: true, events: ['MESSAGES_UPSERT'] } } },
  { nome: 'plano', body: { enabled: true, url: urlWebhook, webhook_by_events: false, webhook_base64: true, events: ['MESSAGES_UPSERT'] } },
];
let ok = false;
for (const s of shapes) {
  const r = await fetch(`${U}/webhook/set/${I}`, { method: 'POST', headers: H, body: JSON.stringify(s.body) });
  const txt = await r.text();
  console.log(`set (${s.nome}): HTTP ${r.status}${r.ok ? '' : ' — ' + txt.replace(TOKEN, '<token>').slice(0, 160)}`);
  if (r.ok) { ok = true; break; }
}
if (!ok) throw new Error('nenhum shape aceito — confira a versão da Evolution');

const rf = await fetch(`${U}/webhook/find/${I}`, { headers: H });
const df = await rf.text();
console.log('find:', rf.status, df.replace(TOKEN, '<token>').slice(0, 240));
process.exit(0);
