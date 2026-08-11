#!/usr/bin/env node
// scripts/ingerir-supabase.mjs
//
// Runner de ingestão/dedupe Supabase -> Lista 01 LEADS (DOSS-02, Fase 04
// Plano 03): lê a base Supabase self-hosted (militantes/triagem) paginada,
// deduplica em cascata contra a Lista 01 (ID_SUPABASE -> CPF -> telefone,
// D-P4-08) e materializa o resultado no ClickUp -- cria lead novo pra quem
// não casa, só preenche campo vazio + ID_SUPABASE pra quem casa (D-P4-09).
// Primeiro passo da rotina diária (D-P4-07), rodado sob demanda (sem cron).
//
// Uso:
//   node --env-file=.env --experimental-strip-types scripts/ingerir-supabase.mjs [--dry-run]
//
// LGPD (T-04-03-I): logs imprimem só CONTAGENS e ids não-sensíveis; telefone
// SEMPRE mascarado (mascararTelefone); CPF NUNCA aparece em log, nem
// mascarado -- regra mais estrita que a de telefone (a fase introduz CPF
// ativo pela primeira vez via a cascata de dedupe).

import {
  listarTasks,
  criarTask,
  setCustomField,
  CLICKUP_LIST_LEADS,
  CAMPOS_LEADS,
} from '../src/mastra/clickup.ts';
import { listarTabela } from '../src/mastra/supabase.ts';
import { resolverDedupe, mesclarCamposVazios } from '../src/mastra/dossie.ts';
import {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUPABASE_TABLE_MILITANTES,
  SUPABASE_COL_ID,
  SUPABASE_COL_CPF,
  SUPABASE_COL_TELEFONE,
  SUPABASE_COL_NOME,
} from '../src/mastra/config.ts';

const DRY_RUN = process.argv.includes('--dry-run');

/** Pagina uma lista inteira do ClickUp (listarTasks LANÇA em falha -- WR-03, molde de gerar-lote.mjs). */
async function lerTodasAsTasks(listId, opts = {}) {
  const todas = [];
  let page = 0;
  let lastPage = false;
  while (!lastPage) {
    const resultado = await listarTasks(listId, { ...opts, page });
    todas.push(...resultado.tasks);
    lastPage = resultado.lastPage;
    page += 1;
  }
  return todas;
}

/** Pagina uma tabela inteira do Supabase (listarTabela LANÇA em falha -- WR-03). */
async function lerTabelaSupabasePaginada(tabela, limite = 100) {
  const todas = [];
  let offset = 0;
  for (;;) {
    const pagina = await listarTabela(tabela, { limit: limite, offset });
    todas.push(...pagina);
    if (pagina.length < limite) break;
    offset += limite;
  }
  return todas;
}

// Colunas de perfil/endereço AINDA NÃO têm env dedicada em config.ts
// (SUPABASE_COL_* só cobre identidade: ID/CPF/TELEFONE/NOME) -- os nomes
// abaixo são um palpite razoável (mesmo padrão dos defaults de
// SUPABASE_COL_*), a confirmar contra o esquema real no checkpoint 04-05
// (scripts/descobrir-supabase-ghl.mjs). Coluna ausente no registro é só
// ignorada -- não gera patch pra esse campo (nunca inventa dado).
const COLUNAS_PERFIL = {
  UF: 'uf',
  CIDADE: 'cidade',
  BAIRRO: 'bairro',
  LOGRADOURO: 'logradouro',
  NUMERO: 'numero',
  COMPLEMENTO: 'complemento',
  CEP: 'cep',
  ORIGEM: 'origem',
  MILITANTE: 'militante',
};

/** Mapa de field-ids da Lista 01 que a ingestão pode ler/preencher (campos "patcháveis" além de NOME/CPF/TELEFONE/ID_SUPABASE). */
const CAMPOS_PATCHAVEIS = [
  CAMPOS_LEADS.NOME,
  CAMPOS_LEADS.UF,
  CAMPOS_LEADS.CIDADE,
  CAMPOS_LEADS.BAIRRO,
  CAMPOS_LEADS.LOGRADOURO,
  CAMPOS_LEADS.NUMERO,
  CAMPOS_LEADS.COMPLEMENTO,
  CAMPOS_LEADS.CEP,
  CAMPOS_LEADS.ORIGEM,
  CAMPOS_LEADS.MILITANTE,
];

function valorCampo(task, fieldId) {
  const campo = task.custom_fields?.find((c) => c.id === fieldId);
  return campo?.value;
}

function paraString(valor) {
  return valor === null || valor === undefined ? '' : String(valor);
}

/** Extrai um `LeadExistente` (shape de dossie.ts) de uma TaskClickUp da Lista 01. */
function paraLeadExistente(task) {
  const campos = {};
  for (const fieldId of CAMPOS_PATCHAVEIS) {
    campos[fieldId] = paraString(valorCampo(task, fieldId));
  }
  return {
    taskId: task.id,
    idSupabase: paraString(valorCampo(task, CAMPOS_LEADS.ID_SUPABASE)),
    cpf: paraString(valorCampo(task, CAMPOS_LEADS.CPF)),
    telefone: paraString(valorCampo(task, CAMPOS_LEADS.TELEFONE)),
    campos,
  };
}

/**
 * Normaliza um registro bruto do Supabase em `{ idSupabase, cpf, telefone,
 * nome, patchCandidato }` -- chave de dedupe (D-P4-08) + patch candidato pra
 * `mesclarCamposVazios`/criação de lead novo, usando os nomes de coluna de
 * `SUPABASE_COL_*` (identidade) + `COLUNAS_PERFIL` (perfil/endereço).
 */
function normalizarRegistro(registro) {
  const idSupabase = paraString(registro[SUPABASE_COL_ID]).trim();
  const cpf = paraString(registro[SUPABASE_COL_CPF]).trim();
  const telefone = paraString(registro[SUPABASE_COL_TELEFONE]).trim();
  const nome = paraString(registro[SUPABASE_COL_NOME]).trim();

  const patchCandidato = {};
  if (nome) patchCandidato[CAMPOS_LEADS.NOME] = nome;
  if (cpf) patchCandidato[CAMPOS_LEADS.CPF] = cpf;
  if (telefone) patchCandidato[CAMPOS_LEADS.TELEFONE] = telefone;
  if (idSupabase) patchCandidato[CAMPOS_LEADS.ID_SUPABASE] = idSupabase;
  for (const [campoLogico, colunaRaw] of Object.entries(COLUNAS_PERFIL)) {
    const valor = registro[colunaRaw];
    if (valor !== undefined && valor !== null && String(valor).trim() !== '') {
      patchCandidato[CAMPOS_LEADS[campoLogico]] = String(valor).trim();
    }
  }
  return { idSupabase, cpf, telefone, nome, patchCandidato };
}

async function main() {
  console.log('=== Ingestão Supabase -> Lista 01 LEADS (RomeroCall, DOSS-02) ===');
  if (DRY_RUN) console.log('(modo --dry-run: nada será escrito no ClickUp -- só o preview do dedupe.)');

  // Config ausente LANÇA claro (WR-03) -- nunca um resumo vazio silencioso.
  // Checado ANTES de qualquer leitura (inclusive a Lista 01) pra ser
  // determinístico independente de outros tokens (ex.: ClickUp) estarem
  // configurados no ambiente.
  if (!SUPABASE_URL) {
    throw new Error(
      '[ingerir-supabase] SUPABASE_URL ausente -- configure no .env antes de rodar a ingestão (ver scripts/descobrir-supabase-ghl.mjs).',
    );
  }
  if (!SUPABASE_SERVICE_KEY) {
    throw new Error('[ingerir-supabase] SUPABASE_SERVICE_KEY ausente -- configure no .env antes de rodar a ingestão.');
  }
  if (!SUPABASE_TABLE_MILITANTES) {
    throw new Error(
      '[ingerir-supabase] SUPABASE_TABLE_MILITANTES ausente -- rode scripts/descobrir-supabase-ghl.mjs e configure no .env antes de ingerir.',
    );
  }

  console.log(`Lendo a base Supabase (tabela "${SUPABASE_TABLE_MILITANTES}")...`);
  const registros = await lerTabelaSupabasePaginada(SUPABASE_TABLE_MILITANTES);
  console.log(`  ${registros.length} registro(s) lido(s) da base Supabase (contagem apenas, sem PII).`);

  console.log(`Lendo Lista 01 LEADS (lista ${CLICKUP_LIST_LEADS})...`);
  const tasksLeads = await lerTodasAsTasks(CLICKUP_LIST_LEADS);
  const leadsExistentes = tasksLeads.map(paraLeadExistente);
  console.log(`  ${leadsExistentes.length} lead(s) lido(s) da Lista 01 (contagem apenas, sem PII).`);

  const classificados = registros.map((registro) => {
    const chave = normalizarRegistro(registro);
    const resultado = resolverDedupe(chave, leadsExistentes);
    return { chave, resultado };
  });

  const novos = classificados.filter((c) => c.resultado.match === null);
  const casadosPorNivel = {
    id_supabase: classificados.filter((c) => c.resultado.nivel === 'id_supabase').length,
    cpf: classificados.filter((c) => c.resultado.nivel === 'cpf').length,
    telefone: classificados.filter((c) => c.resultado.nivel === 'telefone').length,
  };
  const totalCasados = casadosPorNivel.id_supabase + casadosPorNivel.cpf + casadosPorNivel.telefone;

  console.log(
    `\n=== Preview do dedupe: ${novos.length} seria(m) criado(s) como lead novo, ` +
      `${totalCasados} casaria(m) com lead existente ` +
      `(id_supabase: ${casadosPorNivel.id_supabase}, cpf: ${casadosPorNivel.cpf}, telefone: ${casadosPorNivel.telefone}). ===`,
  );

  if (DRY_RUN) {
    console.log('\n(--dry-run: nada foi escrito no ClickUp.)');
    process.exit(0);
  }

  console.log('\n(escrita real ainda não implementada nesta fatia -- nada foi escrito.)');
  process.exit(0);
}

main().catch((e) => {
  const mensagem = e instanceof Error ? e.message : String(e);
  console.error(`\n=== FALHA ao ingerir a base Supabase -- ${mensagem} ===`);
  process.exit(1);
});
