// Smoke do ALERTA DE GRUPO (2026-08-19): valida, de longe, que a instância de
// alerta ('avisos-romero') está no ar, enxerga o grupo de operação e consegue
// postar nele — o mesmo caminho que o backend usa quando o chip principal cai.
//
// Uso: node --env-file=.env scripts/alerta-grupo-teste.mjs ["mensagem opcional"]
//
// Requer no env: EVOLUTION_API_URL, EVOLUTION_API_KEY (global) e opcionalmente
//   EVOLUTION_INSTANCE_ALERTA (default: avisos-romero)
//   EVOLUTION_API_KEY_ALERTA  (só se a apikey global não autenticar a instância)
//   EVOLUTION_GRUPO_ALERTA    (default: WHATSAPP TELEMARKETING - CALL CENTER)
//
// Passos: connectionState da instância → fetchAllGroups (acha o grupo pelo
// nome) → sendText no grupo. Em cada falha imprime o diagnóstico e PARA.
// LGPD/segurança: nunca imprime apikey; JID do grupo sai mascarado.

const U = process.env.EVOLUTION_API_URL?.replace(/\/+$/, '');
const K = process.env.EVOLUTION_API_KEY_ALERTA || process.env.EVOLUTION_API_KEY;
const I = process.env.EVOLUTION_INSTANCE_ALERTA ?? 'avisos-romero';
const GRUPO = process.env.EVOLUTION_GRUPO_ALERTA || 'WHATSAPP TELEMARKETING - CALL CENTER';
if (!U || !K) throw new Error('EVOLUTION_API_URL/EVOLUTION_API_KEY ausentes no env');
if (!I) throw new Error('EVOLUTION_INSTANCE_ALERTA vazio no env — o alerta está explicitamente desligado');

const H = { apikey: K, 'Content-Type': 'application/json' };
const mascarar = (jid) => String(jid).replace(/\d(?=\d{4})/g, '*');

// 1) a instância existe e está conectada?
const rs = await fetch(`${U}/instance/connectionState/${I}`, { headers: H });
const js = await rs.json().catch(() => ({}));
const state = js?.instance?.state ?? '(sem state)';
console.log(`1. connectionState de "${I}": HTTP ${rs.status} — state=${state}`);
if (!rs.ok) {
  console.log('   → a instância não respondeu. Ela existe na Evolution com esse nome exato?');
  process.exit(1);
}
if (state !== 'open') {
  console.log('   → instância AINDA NÃO CONECTADA (leia o QR code dela na Evolution) — sem conexão o envio abaixo vai falhar.');
}

// 2) a instância enxerga o grupo?
const rg = await fetch(`${U}/group/fetchAllGroups/${I}?getParticipants=false`, { headers: H });
const jg = await rg.json().catch(() => null);
if (!rg.ok || !Array.isArray(jg)) {
  console.log(`2. fetchAllGroups: HTTP ${rg.status} — não deu pra listar os grupos (instância conectada?)`);
  process.exit(1);
}
const alvo = GRUPO.trim().toLowerCase();
const grupo = jg.find((g) => String(g?.subject ?? '').trim().toLowerCase() === alvo);
console.log(`2. fetchAllGroups: ${jg.length} grupo(s) visível(is) pela instância`);
if (!grupo?.id) {
  console.log(`   → grupo "${GRUPO}" NÃO encontrado. O número da instância é membro dele?`);
  console.log('   → grupos visíveis (subjects):');
  for (const g of jg.slice(0, 20)) console.log(`      - ${String(g?.subject ?? '(sem nome)').slice(0, 60)}`);
  process.exit(1);
}
console.log(`   → grupo encontrado: "${grupo.subject}" (jid ${mascarar(grupo.id)})`);

// 3) posta a mensagem de teste
const texto =
  process.argv[2] ||
  `✅ Teste do alerta do call center — instância "${I}" operante. Pode ignorar esta mensagem.`;
const re = await fetch(`${U}/message/sendText/${I}`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ number: grupo.id, text: texto }),
});
console.log(`3. sendText no grupo: HTTP ${re.status}${re.ok ? ' — mensagem postada ✔' : ''}`);
if (!re.ok) {
  const t = await re.text().catch(() => '');
  console.log('   → falhou: ' + t.slice(0, 200));
  process.exit(1);
}
console.log('\nTudo certo: o backend vai conseguir avisar a queda do chip neste grupo.');
