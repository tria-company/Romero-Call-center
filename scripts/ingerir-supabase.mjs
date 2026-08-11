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
import { planejarIngestao } from '../src/mastra/dossie.ts';
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

/** Mascara o telefone (LGPD, T-04-03-I) -- só os últimos 4 dígitos aparecem (mesmo padrão de gerar-lote.mjs). */
function mascararTelefone(telefone) {
  const digitos = String(telefone || '').replace(/\D/g, '');
  if (digitos.length === 0) return '(sem telefone)';
  if (digitos.length <= 4) return `****${digitos}`;
  return `${'*'.repeat(digitos.length - 4)}${digitos.slice(-4)}`;
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

/**
 * Monta o payload de `criarTask` (clickup.ts) pra um lead NOVO (sem match no
 * dedupe): `name`/custom_fields por field-id de `CAMPOS_LEADS`, com os
 * defaults que tornam o lead elegível ao lote do dia HOJE (Claude's
 * Discretion, coerente com `selecionarLoteElegivel`/`elegivel` em lote.ts):
 * PROXIMO_CONTATO = hoje (epoch ms, mesmo shape de `consolidarLead`) => o
 * lead entra no lote de hoje; SCORE = 0 (neutro, sem sinal ainda);
 * QTD_TENTATIVAS/QTD_ATENDIMENTOS/QTD_NAO_ATENDIMENTOS = 0 (nunca contatado).
 * ORIGEM usa a coluna do registro quando presente, senão "supabase"
 * (rastreabilidade — este lead nasceu desta ingestão).
 */
function montarPayloadNovoLead(chave, hojeEpoch) {
  const nome = chave.nome || '(sem nome)';
  const customFields = [
    { id: CAMPOS_LEADS.ID_SUPABASE, value: chave.idSupabase },
    { id: CAMPOS_LEADS.CPF, value: chave.cpf },
    { id: CAMPOS_LEADS.TELEFONE, value: chave.telefone },
    { id: CAMPOS_LEADS.NOME, value: nome },
    { id: CAMPOS_LEADS.PROXIMO_CONTATO, value: hojeEpoch },
    { id: CAMPOS_LEADS.SCORE, value: 0 },
    { id: CAMPOS_LEADS.QTD_TENTATIVAS, value: 0 },
    { id: CAMPOS_LEADS.QTD_ATENDIMENTOS, value: 0 },
    { id: CAMPOS_LEADS.QTD_NAO_ATENDIMENTOS, value: 0 },
  ];
  const jaTemOrigem = Object.prototype.hasOwnProperty.call(chave.patchCandidato, CAMPOS_LEADS.ORIGEM);
  for (const [fieldId, valor] of Object.entries(chave.patchCandidato)) {
    // ID_SUPABASE/CPF/TELEFONE/NOME já foram adicionados acima (com defaults
    // próprios) -- só os demais campos de perfil/endereço entram aqui.
    if ([CAMPOS_LEADS.ID_SUPABASE, CAMPOS_LEADS.CPF, CAMPOS_LEADS.TELEFONE, CAMPOS_LEADS.NOME].includes(fieldId)) continue;
    customFields.push({ id: fieldId, value: valor });
  }
  if (!jaTemOrigem) customFields.push({ id: CAMPOS_LEADS.ORIGEM, value: 'supabase' });

  return { name: nome, custom_fields: customFields };
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

  // Dedupe incremental (fecha CR-03, 04-VERIFICATION.md/04-REVIEW.md): resolve
  // o plano UMA vez, registro a registro, contra uma coleção viva que cresce
  // a cada 'criar'/atualiza a cada 'mesclar' -- dois registros da mesma
  // pessoa nesta leitura (mesmo CPF/telefone, ids diferentes) nunca viram 2
  // leads novos; o 2º sempre casa o lead recém-criado pelo 1º.
  const registrosNormalizados = registros.map(normalizarRegistro);
  const plano = planejarIngestao(registrosNormalizados, leadsExistentes, CAMPOS_LEADS.ID_SUPABASE);

  const acoesCriar = plano.filter((a) => a.acao === 'criar');
  const acoesMesclar = plano.filter((a) => a.acao === 'mesclar');
  const acoesSemAlteracao = plano.filter((a) => a.acao === 'sem-alteracao');
  const casadosPorNivel = { id_supabase: 0, cpf: 0, telefone: 0 };
  for (const acao of [...acoesMesclar, ...acoesSemAlteracao]) {
    if (acao.nivel) casadosPorNivel[acao.nivel] += 1;
  }

  console.log(
    `\n=== Preview do dedupe incremental: ${acoesCriar.length} seria(m) criado(s) como lead novo, ` +
      `${acoesMesclar.length} seria(m) atualizado(s), ${acoesSemAlteracao.length} sem alteração ` +
      `(casados por nível -- id_supabase: ${casadosPorNivel.id_supabase}, cpf: ${casadosPorNivel.cpf}, telefone: ${casadosPorNivel.telefone}). ===`,
  );

  if (DRY_RUN) {
    console.log('\n(--dry-run: nada foi escrito no ClickUp.)');
    process.exit(0);
  }

  // ===== Escrita real (fora de --dry-run): materializa o plano NA ORDEM =====
  const hojeEpoch = Date.now();
  const mapaRefNovo = new Map(); // refNovo ('novo#<indice>') -> taskId real, preenchido a cada 'criar'.
  let criados = 0;
  let atualizados = 0;
  let semAlteracao = 0;
  let falhas = 0;

  console.log(`\nMaterializando ${plano.length} registro(s) no ClickUp...`);
  for (const acao of plano) {
    const registro = registrosNormalizados[acao.indice];
    const identificador = `${registro.nome || '(sem nome)'} (${mascararTelefone(registro.telefone)})`;
    try {
      if (acao.acao === 'criar') {
        // Registro NOVO -- cria lead elegível ao lote de hoje (D-P4-07).
        const payload = montarPayloadNovoLead(registro, hojeEpoch);
        const novaTask = await criarTask(CLICKUP_LIST_LEADS, payload);
        if (!novaTask?.id) {
          throw new Error('criarTask retornou sem id');
        }
        mapaRefNovo.set(acao.refNovo, novaTask.id);
        console.log(`  [novo] ${identificador} -> lead ${novaTask.id}`);
        criados += 1;
        continue;
      }

      const alvoTaskId = acao.alvoTaskId ?? mapaRefNovo.get(acao.alvoRefNovo);
      if (!alvoTaskId) {
        throw new Error(`alvo do plano não resolvido (alvoRefNovo=${acao.alvoRefNovo} sem taskId real correspondente)`);
      }

      if (acao.acao === 'sem-alteracao') {
        console.log(`  [casado/${acao.nivel}, sem alteração] ${identificador} -> lead ${alvoTaskId}`);
        semAlteracao += 1;
        continue;
      }

      // acao.acao === 'mesclar' -- Registro CASADO (D-P4-08), só preenche campo vazio + ID_SUPABASE (D-P4-09).
      for (const [fieldId, valor] of Object.entries(acao.patch)) {
        await setCustomField(alvoTaskId, fieldId, valor);
      }
      console.log(
        `  [casado/${acao.nivel}, ${Object.keys(acao.patch).length} campo(s) preenchido(s)] ${identificador} -> lead ${alvoTaskId}`,
      );
      atualizados += 1;
    } catch (e) {
      // Falha num registro conta e segue -- nunca aborta a ingestão inteira
      // (mesmo padrão de gerar-lote.mjs, D-P4-06). Erro de infra/HTTP das
      // funções clickup/supabase LANÇA (WR-03) e é capturado aqui, por item.
      falhas += 1;
      console.error(`  [erro] falha ao ingerir ${identificador}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(
    `\n=== Resumo: ${criados} criado(s), ${atualizados} atualizado(s), ${semAlteracao} sem alteração, ${falhas} falha(s). ===`,
  );
  process.exit(falhas > 0 ? 1 : 0);
}

main().catch((e) => {
  const mensagem = e instanceof Error ? e.message : String(e);
  console.error(`\n=== FALHA ao ingerir a base Supabase -- ${mensagem} ===`);
  process.exit(1);
});
