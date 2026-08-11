#!/usr/bin/env node
// scripts/descobrir-supabase-ghl.mjs
//
// Runner de descoberta read-only (DOSS-01/02, Fase 04 Plano 01, D-P4-11/12):
// lista o esquema REAL da base Supabase self-hosted (tabelas/colunas) e prova
// quais leituras GHL estendidas do dossie (conversas WhatsApp/oportunidades)
// respondem — ANTES de qualquer mapeamento de ingestao/dossie ser fixado no
// .env. NAO escreve nada — so le e imprime.
//
// Uso:
//   node --env-file=.env --experimental-strip-types scripts/descobrir-supabase-ghl.mjs [--contact <contactId>]
//
// LGPD: imprime so NOMES de tabela/coluna e contagens/status — NUNCA
// conteudo de linha/registro (a base tem CPF).

import { descobrirEsquema } from '../src/mastra/supabase.ts';
import { buscarConversasWhatsApp, buscarOportunidades, buscarQualificados } from '../src/mastra/ghl.ts';

// Palavras que costumam indicar as tabelas de interesse do dossie (militantes/
// triagem/follow-ups). So uma SUGESTAO — a decisao final e humana (checkpoint
// 04-05), porque o esquema real e desconhecido ate esta descoberta rodar.
const PISTAS_MILITANTES = ['militante', 'lead', 'contato', 'pessoa', 'cliente'];
const PISTAS_FOLLOWUPS = ['follow', 'triagem', 'acompanhamento', 'retorno'];

// Pistas pra SUPABASE_COL_FOLLOWUP_REF (gap CR-02, 04-VERIFICATION.md) — a FK
// da tabela de follow-ups que aponta pro militante dono do follow-up. So uma
// SUGESTAO (a decisao final e humana); NUNCA e a coluna `id` isolada (essa e a
// PK do proprio follow-up, e o filtro errado que causou a contaminacao cruzada
// de PII original).
const PISTAS_FOLLOWUP_REF = ['militante', 'lead', 'pessoa', 'contato', 'ref', 'fk'];

function sugerirTabela(tabelas, pistas) {
  const lower = tabelas.map((t) => t.tabela.toLowerCase());
  for (const pista of pistas) {
    const idx = lower.findIndex((t) => t.includes(pista));
    if (idx !== -1) return tabelas[idx];
  }
  return null;
}

/**
 * Sugere colunas candidatas a FK do militante na tabela de follow-ups (CR-02):
 * bate com pistas de nome (militante/lead/pessoa/contato/ref/fk), termina em
 * `_id` sem ser exatamente `id`, ou bate com o nome da tabela de militantes
 * sugerida (ex: "militante" -> "militante_id"). NUNCA sugere `id` sozinho —
 * essa e a PK do proprio follow-up, nao a FK do militante. So imprime NOMES de
 * coluna (LGPD — a base tem CPF), nunca conteudo de linha.
 */
function sugerirColunasFollowupRef(colunasFollowups, nomeTabelaMilitantes) {
  const candidatas = new Set();
  for (const col of colunasFollowups) {
    const lower = col.toLowerCase();
    if (lower === 'id') continue; // PK do proprio follow-up — nunca a FK do militante.
    if (PISTAS_FOLLOWUP_REF.some((pista) => lower.includes(pista))) candidatas.add(col);
    else if (/_id$/.test(lower)) candidatas.add(col);
    else if (nomeTabelaMilitantes && lower.includes(nomeTabelaMilitantes.toLowerCase())) candidatas.add(col);
  }
  return [...candidatas];
}

function lerArgv(nome) {
  const idx = process.argv.indexOf(nome);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

async function descobrirSupabase() {
  console.log('\n=== Parte 1/2: Esquema Supabase (self-hosted) ===');
  const tabelas = await descobrirEsquema();

  if (!tabelas.length) {
    console.log('  Nenhuma tabela encontrada no spec OpenAPI do PostgREST.');
    return;
  }

  console.log(`\nTabelas encontradas (${tabelas.length}):`);
  for (const t of tabelas) {
    console.log(`  - "${t.tabela}" (${t.colunas.length} coluna(s)): ${t.colunas.join(', ')}`);
  }

  const sugestaoMilitantes = sugerirTabela(tabelas, PISTAS_MILITANTES);
  const sugestaoFollowUps = sugerirTabela(tabelas, PISTAS_FOLLOWUPS);

  console.log('\n=== Sugestão de mapeamento (colar no .env) ===');
  if (sugestaoMilitantes) {
    console.log(`  SUPABASE_TABLE_MILITANTES=${sugestaoMilitantes.tabela}`);
    console.log(`    colunas candidatas: ${sugestaoMilitantes.colunas.join(', ')}`);
    console.log('    confirme SUPABASE_COL_ID/SUPABASE_COL_CPF/SUPABASE_COL_TELEFONE/SUPABASE_COL_NOME contra a lista acima.');
  } else {
    console.log(
      '  SUPABASE_TABLE_MILITANTES: nenhuma tabela óbvia encontrada por heurística.\n' +
        `  Tabelas disponíveis: ${tabelas.map((t) => `"${t.tabela}"`).join(', ')}. Confirme manualmente no checkpoint 04-05.`,
    );
  }
  if (sugestaoFollowUps) {
    console.log(`  SUPABASE_TABLE_FOLLOWUPS=${sugestaoFollowUps.tabela}`);
    console.log(`    colunas candidatas: ${sugestaoFollowUps.colunas.join(', ')}`);

    // CR-02 (04-VERIFICATION.md): sugere a FK do militante nessa tabela — NUNCA
    // `id` sozinho (PK do proprio follow-up). So nomes de coluna (LGPD).
    const nomeTabelaMilitantes = sugestaoMilitantes?.tabela;
    const candidatasFollowupRef = sugerirColunasFollowupRef(sugestaoFollowUps.colunas, nomeTabelaMilitantes);
    if (candidatasFollowupRef.length > 0) {
      console.log(`  SUPABASE_COL_FOLLOWUP_REF candidatas: ${candidatasFollowupRef.join(', ')}`);
      console.log(
        '    confirme no checkpoint qual delas e a FK real do militante (NUNCA "id" — essa e a PK do ' +
          'proprio follow-up, o filtro errado que causava contaminacao cruzada de PII).',
      );
    } else {
      console.log(
        `  SUPABASE_COL_FOLLOWUP_REF: nenhuma candidata obvia por heuristica. Colunas da tabela pra ` +
          `inspecao manual: ${sugestaoFollowUps.colunas.join(', ')} (confirmar no checkpoint).`,
      );
    }
  } else {
    console.log('  SUPABASE_TABLE_FOLLOWUPS: nenhuma tabela óbvia encontrada por heurística — confirmar manualmente.');
  }
}

async function descobrirEscoposGhl() {
  console.log('\n=== Parte 2/2: Escopos GHL (conversas WhatsApp + oportunidades, D-P4-12) ===');

  let contactId = lerArgv('--contact');
  if (!contactId) {
    console.log('  Nenhum --contact informado — usando o primeiro lead QUALIFICADO como contato de teste...');
    const { leads } = await buscarQualificados({ limit: 1 });
    if (!leads.length) {
      console.log('  Nenhum lead QUALIFICADO encontrado (ou GHL_PIT_TOKEN ausente) — pulando o probe de escopo.');
      console.log('  Rode novamente com --contact <contactId> para forçar o probe.');
      return;
    }
    // buscarQualificados não retorna contactId diretamente (só nome/telefone) —
    // sem um id explícito, o probe de escopo fica marcado como não executado.
    console.log('  Lead QUALIFICADO encontrado, mas buscarQualificados não expõe contactId.');
    console.log('  Rode novamente com --contact <contactId> (ex: resolvido via buscarContactIdPorTelefone) para o probe real.');
    return;
  }

  console.log(`  Usando contactId de teste: ${contactId}`);

  const conversas = await buscarConversasWhatsApp(contactId);
  if (conversas.length > 0) {
    console.log(`  [conversas WhatsApp] ACESSÍVEL — ${conversas.length} mensagem(ns) encontrada(s).`);
  } else {
    console.log(
      '  [conversas WhatsApp] VAZIO — sem dados OU sem escopo (ghl.ts degrada e loga o motivo acima, se houver).',
    );
    console.log('    Se o log acima mostrar status 401/403, o token PIT não tem o escopo de conversas.');
  }

  const oportunidades = await buscarOportunidades(contactId);
  if (oportunidades.length > 0) {
    console.log(`  [oportunidades] ACESSÍVEL — ${oportunidades.length} oportunidade(s) encontrada(s).`);
  } else {
    console.log(
      '  [oportunidades] VAZIO — sem dados OU sem escopo (ghl.ts degrada e loga o motivo acima, se houver).',
    );
    console.log('    Se o log acima mostrar status 401/403, o token PIT não tem o escopo de oportunidades.');
  }

  console.log(
    '\n  Uma capacidade sem acesso entra na degradação parcial do dossiê (D-P4-06) — não bloqueia a fase, ' +
      'mas deve ser reportada ao humano no checkpoint 04-05.',
  );
}

async function main() {
  console.log('=== Descobrir Supabase (esquema) + GHL (escopos) para o Dossiê 360 (DOSS-01/02, Fase 04 Plano 01) ===');

  await descobrirSupabase();
  await descobrirEscoposGhl();

  console.log('\n(Nada foi escrito — este runner só lê.)');
  process.exit(0);
}

main().catch((e) => {
  const mensagem = e instanceof Error ? e.message : String(e);
  console.error(`\n=== FALHA ao descobrir Supabase/GHL — ${mensagem} ===`);
  process.exit(1);
});
