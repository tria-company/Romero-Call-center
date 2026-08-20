// Backfill da atribuição histórica de voto (tabela `votos_ligacao`, migração 05).
//
// POR QUE EXISTE: a gravação da atribuição passou a acontecer no momento da marcação
// (/api/discador/voto → sync-clickup.ts), mas isso só vale do deploy em diante. As
// declarações já colhidas ficaram no ClickUp sem operador e sem data. Este script
// reconstrói o crédito delas cruzando dado que já existe — nada é criado no ClickUp.
//
// COMO ATRIBUI: para cada lead com voto marcado na Lista 01, procura as Ligações da Lista
// 02 que apontam para ele (LEAD_REL, com fallback em ID_LEAD) e credita o operador da
// ligação ATENDIDA mais recente; sem atendida, o de INICIO mais recente.
//
// QUÃO CONFIÁVEL É: o voto só pode ter nascido numa chamada ATENDIDA — tentativa que
// ninguém atendeu não gera declaração. Medido em 20/08 sobre os 44 leads votados:
//
//   38 (86%)  uma única ligação atendida no lead   -> atribuição é FATO
//    1 ( 2%)  várias atendidas, do MESMO operador  -> FATO
//    0 ( 0%)  dois operadores atenderam o mesmo lead -> não existe disputa
//    5 (11%)  NENHUMA atendida                     -> palpite (última discagem)
//
// Os 5 últimos são lead com voto marcado e desfecho esquecido. Eles entram com
// `origem='backfill-incerto'`; os confiáveis com `origem='backfill'`; e o que for medido
// na hora pelo closer, com `origem='ligacao'`. Sem essa separação os três viram um número
// só e ninguém mais distingue o medido do deduzido do chutado.
//
// SEGURO POR PADRÃO: sem `--aplicar` só relata, não grava nada. O upsert é idempotente
// (chave ligacao_task_id+candidato) e NUNCA sobrescreve linha de origem 'ligacao' — o que
// foi medido na hora tem precedência sobre o que foi inferido depois.
//
// Uso:
//   node --env-file=.env scripts/backfill-votos-ligacao.mjs             # relatório
//   node --env-file=.env scripts/backfill-votos-ligacao.mjs --aplicar   # grava
//
// LGPD: só login de operador e ids de task. Nenhum telefone, CPF ou nome é lido ou impresso.

const APLICAR = process.argv.includes('--aplicar');

const TOKEN = process.env.CLICKUP_API_TOKEN;
const L1 = process.env.CLICKUP_LIST_LEADS;
const L2 = process.env.CLICKUP_LIST_LIGACOES;
const SUPA = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY;
const TABELA = process.env.SUPABASE_TABLE_VOTOS_LIGACAO || 'votos_ligacao';
if (!TOKEN || !L1 || !L2) throw new Error('CLICKUP_API_TOKEN/CLICKUP_LIST_LEADS/CLICKUP_LIST_LIGACOES ausentes');
if (APLICAR && (!SUPA || !KEY)) throw new Error('SUPABASE_URL/SUPABASE_SERVICE_KEY ausentes — nao da para gravar');

const BASE = 'https://api.clickup.com/api/v2';
const MAX_PAGINAS = Number(process.env.PAINEL_MAX_PAGINAS) || 30;

// Field ids espelhados de src/mastra/clickup.ts (D-07: nunca resolver por nome em runtime).
const LEAD_REL = '381d4565-aeae-4abb-a4f7-38322a1c71f8';
const ID_LEAD = 'f9efe4d9-bfbd-452d-85c1-d88462b28462';
const OPERADOR = '7fe613d6-8170-43e9-a422-7b5f9dd45a99';
const INICIO = 'c5eadc11-bd39-4b5c-b46c-3b3fddf49e89';
const ATENDEU = '68daf21b-6420-4ceb-9c8c-bc67d6f7a2ef';
const ATENDEU_SIM = '84ee8d4b-a924-4ed2-bcf5-fb4dc7f82ce5';
const VOTO = {
  romero: {
    campo: 'e2b6558f-7d6e-4af6-93b7-d0adde65b79b',
    opcoes: { sim: 'af4e0629-1abf-4dbc-b362-acca1fb7e879', nao: '7ced7b75-743f-4047-bb6b-5c4e575bca3b', naoDeclarou: 'ca798bf8-03dc-4cf6-981b-8fc90df80904' },
  },
  andressa: {
    campo: '0e6bf825-be20-4bf4-a967-986c2e46ea26',
    opcoes: { sim: '6a96d622-13ec-4afb-a98e-f9331ae43397', nao: '74fdf62a-4393-4ab9-828d-926625063c53', naoDeclarou: '229a7f1f-42a7-4b7d-8622-89e105cc3ff7' },
  },
};

// A varredura da Lista 02 leva minutos e o gateway do ClickUp devolve 500 (timeout interno
// dele) quando está frio — medido em 19/08, 3 páginas seguidas em ~55s cada, todas OK na
// segunda tentativa. Sem retry aqui o backfill morre no meio e grava atribuição parcial.
async function pegar(url) {
  let ultimoErro;
  for (let t = 1; t <= 4; t += 1) {
    try {
      const r = await fetch(url, { headers: { Authorization: TOKEN }, signal: AbortSignal.timeout(90_000) });
      if (r.ok) return await r.json();
      ultimoErro = `HTTP ${r.status}`;
    } catch (e) {
      ultimoErro = e instanceof Error ? e.message : String(e);
    }
    if (t < 4) await new Promise((s) => setTimeout(s, 2500 * t));
  }
  throw new Error(`ClickUp falhou apos 4 tentativas (${ultimoErro})`);
}

const campo = (t, id) => t.custom_fields?.find((c) => c.id === id)?.value;
const temCampo = (t, id) => { const v = campo(t, id); return v !== undefined && v !== null && String(v).trim() !== ''; };

async function paginar(lista, extra = '') {
  const out = [];
  let p = 0;
  let ultima = false;
  while (!ultima && p < MAX_PAGINAS) {
    const j = await pegar(`${BASE}/list/${lista}/task?page=${p}&include_closed=true${extra}`);
    out.push(...(j.tasks || []));
    ultima = Boolean(j.last_page);
    p += 1;
  }
  if (!ultima) console.warn(`  ! teto de ${MAX_PAGINAS} paginas atingido na lista ${lista} — resultado PARCIAL`);
  return out;
}

console.log(`modo: ${APLICAR ? 'APLICAR (grava)' : 'relatorio (nao grava nada)'}\n`);

console.log('lendo Lista 02 (ligacoes)...');
const ligacoes = await paginar(L2);
console.log(`  ${ligacoes.length} tasks`);

// Índice lead -> ligações. LEAD_REL é a relação nativa; ID_LEAD é o fallback (id do GHL ou
// task-id cru), o mesmo par que `resolverLeadPelaTask` usa no backend.
const porLead = new Map();
for (const t of ligacoes) {
  const ids = new Set();
  const rel = campo(t, LEAD_REL);
  if (Array.isArray(rel)) for (const x of rel) if (x?.id) ids.add(String(x.id));
  const alt = String(campo(t, ID_LEAD) ?? '').trim();
  if (alt) ids.add(alt);
  for (const id of ids) {
    const arr = porLead.get(id) ?? [];
    arr.push(t);
    porLead.set(id, arr);
  }
}

console.log('lendo votos ja marcados na Lista 01...');
const votados = new Map(); // leadTaskId -> { romero?, andressa? }
for (const [quem, cfg] of Object.entries(VOTO)) {
  for (const escolha of ['sim', 'nao', 'naoDeclarou']) {
    const filtro = encodeURIComponent(JSON.stringify([{ field_id: cfg.campo, operator: '=', value: cfg.opcoes[escolha] }]));
    for (const t of await paginar(L1, `&custom_fields=${filtro}`)) {
      const e = votados.get(String(t.id)) ?? {};
      e[quem] = escolha;
      votados.set(String(t.id), e);
    }
  }
}
console.log(`  ${votados.size} leads com voto marcado\n`);

const linhas = [];
let semLigacao = 0;
let semOperador = 0;
let confiavel = 0;
let palpite = 0;

for (const [leadId, escolhas] of votados) {
  const ls = porLead.get(leadId) ?? [];
  if (ls.length === 0) { semLigacao += 1; continue; }
  const operadores = new Set(ls.map((t) => String(campo(t, OPERADOR) ?? '').trim().toLowerCase()).filter(Boolean));
  if (operadores.size === 0) { semOperador += 1; continue; }

  // Desempate: atendida vence não-atendida; entre iguais, a discagem mais recente.
  const ehAtendida = (t) => temCampo(t, ATENDEU) && String(campo(t, ATENDEU)) === '0';
  const escolhida = [...ls].sort((a, b) => {
    if (ehAtendida(a) !== ehAtendida(b)) return ehAtendida(b) ? 1 : -1;
    return Number(campo(b, INICIO) ?? 0) - Number(campo(a, INICIO) ?? 0);
  })[0];

  // O voto só pode ter nascido numa chamada ATENDIDA. Quando o lead tem uma (e uma só,
  // ou várias do mesmo operador), a atribuição é FATO. Quando não tem nenhuma atendida,
  // o crédito vai para a última discagem — palpite razoável, mas palpite: provavelmente
  // o closer marcou o voto e esqueceu o desfecho. Medido em 20/08: 39 de 44 são fato,
  // 5 são palpite, e ZERO têm dois operadores disputando.
  //
  // A diferença fica GRAVADA em `origem`. Sem isso, daqui a um mês ninguém mais separa o
  // que foi medido do que foi deduzido — e um ranking construído sobre palpite indistinto
  // é pior do que um ranking vazio.
  const atendidas = ls.filter(ehAtendida);
  const origem = atendidas.length > 0 ? 'backfill' : 'backfill-incerto';
  if (atendidas.length > 0) confiavel += 1; else palpite += 1;

  const operador = String(campo(escolhida, OPERADOR) ?? '').trim();
  // `registrado_em` sai da DISCAGEM, não de agora: é o instante mais próximo da verdade
  // que existe. Carimbar `now()` jogaria a campanha inteira para hoje e estragaria
  // qualquer leitura por data.
  const quando = Number(campo(escolhida, INICIO) ?? escolhida.date_created);
  for (const [quem, escolha] of Object.entries(escolhas)) {
    linhas.push({
      ligacao_task_id: String(escolhida.id),
      lead_task_id: leadId,
      operador,
      candidato: quem,
      escolha,
      origem,
      registrado_em: new Date(quando || Date.now()).toISOString(),
    });
  }
}

console.log('===== ATRIBUICAO =====');
console.log(`  leads sem ligacao vinculada (voto veio da Base): ${semLigacao}`);
console.log(`  leads com ligacao mas sem operador            : ${semOperador}`);
console.log(`  --`);
console.log(`  FATO    (tem chamada atendida) -> origem='backfill'         : ${confiavel}`);
console.log(`  PALPITE (nenhuma atendida)     -> origem='backfill-incerto' : ${palpite}`);
console.log(`  linhas a gravar                               : ${linhas.length}`);

const credito = new Map();
for (const l of linhas) if (l.escolha === 'sim') credito.set(l.operador, (credito.get(l.operador) ?? 0) + 1);
console.log('\n===== "SIM" POR OPERADOR (declaracoes, nao pessoas distintas) =====');
for (const [op, n] of [...credito.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${op.padEnd(36)} ${n}`);

if (!APLICAR) {
  console.log('\nnada foi gravado. rode de novo com --aplicar para persistir.');
  process.exit(0);
}

// `merge-duplicates` faz upsert na PK (ligacao_task_id, candidato). O filtro abaixo protege
// o que foi medido na hora: linha com origem='ligacao' nao e sobrescrita por backfill.
console.log(`\ngravando ${linhas.length} linha(s) em ${TABELA}...`);
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const jaMedidas = new Set();
{
  const r = await fetch(`${SUPA}/rest/v1/${TABELA}?origem=eq.ligacao&select=ligacao_task_id,candidato`, { headers: H });
  if (r.ok) for (const l of await r.json()) jaMedidas.add(`${l.ligacao_task_id}|${l.candidato}`);
}
const gravar = linhas.filter((l) => !jaMedidas.has(`${l.ligacao_task_id}|${l.candidato}`));
console.log(`  ${linhas.length - gravar.length} ja medida(s) na hora — preservada(s)`);

let ok = 0;
for (let i = 0; i < gravar.length; i += 100) {
  const lote = gravar.slice(i, i + 100);
  const r = await fetch(`${SUPA}/rest/v1/${TABELA}`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(lote),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ao gravar lote: ${(await r.text()).slice(0, 200)}`);
  ok += lote.length;
  console.log(`  ${ok}/${gravar.length}`);
}
console.log('pronto.');
