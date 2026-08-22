#!/usr/bin/env node
// scripts/gap-19-12.smoke.mjs
//
// Smoke determinístico (SEM rede) do guard WR-B (gap-closure 19-12): o sync espelho
// ClickUp→Supabase (Fase A) de `ligacoes` NÃO pode escrever/upsertar quando
// FONTE_LIGACOES=supabase — Supabase virou o writer autoritativo de `ligacoes`
// (iniciar_ligacao/consolidar_e_fechar escrevem direto), e re-espelhar do ClickUp
// clobraria operador/status/resultado nativos (o clobber que o teste ClickUp-morto
// do 19-10 exporia). As OUTRAS listas (leads/audios) seguem espelhando normalmente.
//
// Prova, com um ClickUp fake (listar injetado) e upserts que só CONTAM chamadas:
//   1. ligacoesEspelhoDesativado('supabase')===true, ('clickup')===false (predicado puro).
//   2. supabase: sincronizarEspelhoLigacoes → NÃO chama listar NEM upsert; devolve o
//      sentinel no-op {paginas:0, registros:0, ultimaPagina:0}.
//   3. clickup: sincronizarEspelhoLigacoes → escreve como hoje (upsert chamado ≥1).
//   4. leads/audios: NÃO afetados pelo flip (upsert chamado nos dois valores da flag).
//
// LGPD: nenhum telefone/cpf/transcrição — só contagem de chamadas.
//
// Uso: node --experimental-strip-types scripts/gap-19-12.smoke.mjs

import {
  ligacoesEspelhoDesativado,
  sincronizarEspelhoLigacoes,
  sincronizarEspelhoLeads,
  sincronizarEspelhoAudios,
} from '../src/mastra/espelho.ts';

const falhas = [];
function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ClickUp fake: uma página só (lastPage) com as tasks dadas. Conta as chamadas.
function listarFake(tasks) {
  const estado = { chamadas: 0 };
  const fn = async (_listId, _opts, _tentativas) => {
    estado.chamadas += 1;
    return { tasks, lastPage: true };
  };
  return { fn, estado };
}

// Upsert fake: conta chamadas e linhas, devolve o total (contrato: Promise<number>).
function upsertFake() {
  const estado = { chamadas: 0, linhas: 0 };
  const fn = async (rows) => {
    estado.chamadas += 1;
    estado.linhas += rows.length;
    return rows.length;
  };
  return { fn, estado };
}

const taskLigacao = { id: 'lig-1', name: 'Ligação — x', status: { status: 'aberto', type: 'open' }, assignees: [], custom_fields: [] };
const taskLead = { id: 'lead-1', name: 'X', description: '', tags: [], custom_fields: [] };
const taskAudio = { id: 'aud-1', name: 'Áudio enviado — x', description: '', custom_fields: [] };

// ===== 1. Predicado puro =====
function testarPredicado() {
  checar(ligacoesEspelhoDesativado('supabase') === true, "ligacoesEspelhoDesativado('supabase') deveria ser true");
  checar(ligacoesEspelhoDesativado('clickup') === false, "ligacoesEspelhoDesativado('clickup') deveria ser false");
  // qualquer valor != 'supabase' mantém o espelho ligado (default seguro)
  checar(ligacoesEspelhoDesativado('') === false, "ligacoesEspelhoDesativado('') deveria ser false");
}

// ===== 2. supabase: ligacoes é PULADO (não lê, não escreve) =====
async function testarLigacoesPuladoSupabase() {
  const listar = listarFake([taskLigacao]);
  const upsert = upsertFake();
  const r = await sincronizarEspelhoLigacoes({}, { fonte: 'supabase', listar: listar.fn, upsertLigacoes: upsert.fn });
  checar(upsert.estado.chamadas === 0, `supabase: upsert de ligacoes NÃO deveria ser chamado — chamadas=${upsert.estado.chamadas}`);
  checar(listar.estado.chamadas === 0, `supabase: listar NÃO deveria ser chamado (curto-circuito antes da paginação) — chamadas=${listar.estado.chamadas}`);
  checar(r.paginas === 0 && r.registros === 0 && r.ultimaPagina === 0, `supabase: deveria devolver o sentinel no-op — got ${JSON.stringify(r)}`);
}

// ===== 3. clickup: ligacoes ESCREVE como hoje =====
async function testarLigacoesEscreveClickup() {
  const listar = listarFake([taskLigacao]);
  const upsert = upsertFake();
  const r = await sincronizarEspelhoLigacoes({}, { fonte: 'clickup', listar: listar.fn, upsertLigacoes: upsert.fn });
  checar(listar.estado.chamadas === 1, `clickup: listar deveria ser chamado 1x — chamadas=${listar.estado.chamadas}`);
  checar(upsert.estado.chamadas === 1, `clickup: upsert de ligacoes deveria ser chamado — chamadas=${upsert.estado.chamadas}`);
  checar(upsert.estado.linhas === 1, `clickup: upsert deveria receber 1 linha — linhas=${upsert.estado.linhas}`);
  checar(r.registros === 1, `clickup: deveria contar 1 registro — got ${JSON.stringify(r)}`);
}

// ===== 4. leads/audios NÃO afetados pelo flip (escrevem sob supabase E clickup) =====
async function testarLeadsAudiosNaoAfetados() {
  for (const fonte of ['supabase', 'clickup']) {
    const listarL = listarFake([taskLead]);
    const upsertL = upsertFake();
    const rL = await sincronizarEspelhoLeads({}, { fonte, listar: listarL.fn, upsertLeads: upsertL.fn });
    checar(upsertL.estado.chamadas === 1, `leads (fonte=${fonte}): upsert deveria ser chamado — chamadas=${upsertL.estado.chamadas}`);
    checar(rL.registros === 1, `leads (fonte=${fonte}): deveria contar 1 registro — got ${JSON.stringify(rL)}`);

    const listarA = listarFake([taskAudio]);
    const upsertA = upsertFake();
    const rA = await sincronizarEspelhoAudios({}, { fonte, listar: listarA.fn, upsertAudios: upsertA.fn });
    checar(upsertA.estado.chamadas === 1, `audios (fonte=${fonte}): upsert deveria ser chamado — chamadas=${upsertA.estado.chamadas}`);
    checar(rA.registros === 1, `audios (fonte=${fonte}): deveria contar 1 registro — got ${JSON.stringify(rA)}`);
  }
}

async function main() {
  testarPredicado();
  await testarLigacoesPuladoSupabase();
  await testarLigacoesEscreveClickup();
  await testarLeadsAudiosNaoAfetados();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('SMOKE OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('=== SMOKE ERRO ===', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
