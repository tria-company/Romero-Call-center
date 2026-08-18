#!/usr/bin/env node
// scripts/campos-audios.smoke.mjs
//
// Smoke determinístico (sem rede) de CAMPOS_AUDIOS + buscarLeadsNuncaLigados()
// + registrarEnvioAudio() (Fase 12 Plano 02, ENVIO-03/04/06). `globalThis.fetch`
// é mockado — nenhuma chamada real ao ClickUp. Prova:
//
//   1. NEVER-CALLED — Lista 01 tem 3 leads (A/B/C); a Lista 02 tem UMA
//      Ligação vinculada ao lead B (por ID_LEAD). buscarLeadsNuncaLigados()
//      devolve A e C, NUNCA B — e casa telefone em formato de 12 dígitos
//      (sem o nono dígito) contra o de 13 dígitos gravado no lead, via
//      telefonesIguais/semNonoDigito (mesma correlação usada no restante do
//      módulo, quick-260818-u25).
//   2. CHIPS — `origens` são os valores DISTINTOS de ORIGEM entre A e C
//      (B fica de fora por não estar no resultado).
//   3. WRITE — registrarEnvioAudio() monta `custom_fields` com os field-ids
//      de CAMPOS_AUDIOS (DATA_DO_ENVIO/ENVIADO_POR/TELEFONE/AUDIO) na
//      criação da task; uma falha simulada na escrita (fetch -> 500) NÃO
//      lança (WR-03 — o envio primário já aconteceu, best-effort).
//
// Telefones/nomes são FAKE — nunca dados reais (LGPD).
//
// Uso: node --experimental-strip-types scripts/campos-audios.smoke.mjs

process.env.CLICKUP_API_TOKEN ||= 'smoke-fake-token';
delete process.env.REDIS_URL;

const { CAMPOS_AUDIOS, CAMPOS_LEADS, CAMPOS_LIGACOES, CLICKUP_LIST_LEADS, CLICKUP_LIST_LIGACOES, CLICKUP_LIST_AUDIOS, buscarLeadsNuncaLigados, registrarEnvioAudio } =
  await import('../src/mastra/clickup.ts');

const falhas = [];
function checar(condicao, mensagem) {
  if (condicao) {
    console.log('  ✅', mensagem);
  } else {
    console.error('  ❌', mensagem);
    falhas.push(mensagem);
  }
}

// ===== Fixtures (fake, LGPD) =====
// Lead A: nunca ligado. Telefone de 13 dígitos (com nono dígito).
const leadA = {
  id: 'lead-a',
  name: 'lead-a-native-name',
  custom_fields: [
    { id: CAMPOS_LEADS.NOME, value: 'Fulano A' },
    { id: CAMPOS_LEADS.TELEFONE, value: '5581988887777' },
    { id: CAMPOS_LEADS.ID_LEAD_GHL, value: 'ghl-a' },
    { id: CAMPOS_LEADS.ORIGEM, value: 'Facebook' },
  ],
};
// Lead B: TEM Ligação (vinculada por ID_LEAD na Lista 02) — deve ser excluído.
const leadB = {
  id: 'lead-b',
  name: 'lead-b-native-name',
  custom_fields: [
    { id: CAMPOS_LEADS.NOME, value: 'Fulano B' },
    { id: CAMPOS_LEADS.TELEFONE, value: '5581977776666' },
    { id: CAMPOS_LEADS.ID_LEAD_GHL, value: 'ghl-b' },
    { id: CAMPOS_LEADS.ORIGEM, value: 'Instagram' },
  ],
};
// Lead C: nunca ligado. Telefone gravado com 13 dígitos (nono dígito) — a
// Ligação de B usa TELEFONE de 12 dígitos (sem o nono) só pra provar que o
// filtro de C não casa por engano (telefones distintos).
const leadC = {
  id: 'lead-c',
  name: 'lead-c-native-name',
  custom_fields: [
    { id: CAMPOS_LEADS.NOME, value: 'Fulano C' },
    { id: CAMPOS_LEADS.TELEFONE, value: '5581966665555' },
    { id: CAMPOS_LEADS.ID_LEAD_GHL, value: 'ghl-c' },
    { id: CAMPOS_LEADS.ORIGEM, value: 'Facebook' },
  ],
};

// Ligação vinculada a B — por ID_LEAD (ghl-b) E por telefone (formato de 12
// dígitos, sem o nono — prova que telefonesIguais/semNonoDigito casa mesmo
// assim, quick-260818-u25).
const ligacaoDeB = {
  id: 'ligacao-1',
  name: 'Ligação B',
  custom_fields: [
    { id: CAMPOS_LIGACOES.ID_LEAD, value: 'ghl-b' },
    { id: CAMPOS_LIGACOES.TELEFONE, value: '558177776666' }, // 12 dígitos (sem o 9)
  ],
};

let ultimoBodyCriarTask = null;
let falharProximaEscrita = false;

globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  const method = options.method || 'GET';

  if (method === 'GET' && u.includes(`/list/${CLICKUP_LIST_LEADS}/task`)) {
    return { ok: true, status: 200, json: async () => ({ tasks: [leadA, leadB, leadC], last_page: true }) };
  }
  if (method === 'GET' && u.includes(`/list/${CLICKUP_LIST_LIGACOES}/task`)) {
    return { ok: true, status: 200, json: async () => ({ tasks: [ligacaoDeB], last_page: true }) };
  }
  if (method === 'POST' && u.includes(`/list/${CLICKUP_LIST_AUDIOS}/task`)) {
    ultimoBodyCriarTask = JSON.parse(options.body);
    if (falharProximaEscrita) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'audios-task-1' }) };
  }

  throw new Error(`fetch mock: rota não coberta neste smoke: ${method} ${u}`);
};

async function testeNeverCalledEChips() {
  console.log('\n=== (1)/(2) NEVER-CALLED + CHIPS ===');
  const { leads, origens } = await buscarLeadsNuncaLigados();

  const ids = leads.map((l) => l.leadTaskId).sort();
  checar(
    ids.length === 2 && ids.includes('lead-a') && ids.includes('lead-c') && !ids.includes('lead-b'),
    `buscarLeadsNuncaLigados() devolve A e C, exclui B (recebido: ${JSON.stringify(ids)})`,
  );

  const origensOrdenadas = [...origens].sort();
  checar(
    origensOrdenadas.length === 1 && origensOrdenadas[0] === 'Facebook',
    `origens são os valores distintos de A/C ('Facebook'), B (Instagram) fica de fora (recebido: ${JSON.stringify(origensOrdenadas)})`,
  );
}

async function testeWriteFieldIdOnly() {
  console.log('\n=== (3) WRITE field-id-only ===');
  falharProximaEscrita = false;
  const resultado = await registrarEnvioAudio({
    telefone: '5581988887777',
    enviadoPor: 'romero',
    audioRef: 'audio-ref-fake.ogg',
  });
  checar(resultado?.id === 'audios-task-1', `registrarEnvioAudio() retorna a task criada (recebido: ${JSON.stringify(resultado)})`);

  const idsEsperados = [CAMPOS_AUDIOS.DATA_DO_ENVIO, CAMPOS_AUDIOS.ENVIADO_POR, CAMPOS_AUDIOS.TELEFONE, CAMPOS_AUDIOS.AUDIO];
  const idsEnviados = (ultimoBodyCriarTask?.custom_fields || []).map((cf) => cf.id);
  checar(
    idsEsperados.every((id) => idsEnviados.includes(id)),
    `custom_fields do POST usa os field-ids de CAMPOS_AUDIOS (DATA_DO_ENVIO/ENVIADO_POR/TELEFONE/AUDIO) (recebido: ${JSON.stringify(idsEnviados)})`,
  );
}

async function testeWriteFalhaNaoLanca() {
  console.log('\n=== (3b) WRITE best-effort (WR-03) — falha não lança ===');
  falharProximaEscrita = true;
  let lancou = false;
  let resultado = null;
  try {
    resultado = await registrarEnvioAudio({
      telefone: '5581988887777',
      enviadoPor: 'romero',
      audioRef: 'audio-ref-fake.ogg',
    });
  } catch {
    lancou = true;
  }
  falharProximaEscrita = false;
  checar(!lancou, 'registrarEnvioAudio() NÃO lança quando a escrita falha (WR-03, best-effort)');
  checar(resultado === null, `registrarEnvioAudio() retorna null em falha da escrita (recebido: ${JSON.stringify(resultado)})`);
}

async function main() {
  console.log('=== Smoke CAMPOS_AUDIOS + buscarLeadsNuncaLigados + registrarEnvioAudio (Fase 12 Plano 02) ===');
  await testeNeverCalledEChips();
  await testeWriteFieldIdOnly();
  await testeWriteFalhaNaoLanca();

  if (falhas.length > 0) {
    console.error('\n=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('\nSMOKE OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('erro inesperado:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
