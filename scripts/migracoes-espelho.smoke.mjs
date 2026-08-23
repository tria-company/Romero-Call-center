#!/usr/bin/env node
// scripts/migracoes-espelho.smoke.mjs
//
// Smoke determinístico (offline, SEM rede) das 6 migrações da Fase A do
// espelho (17-01, .planning/arquitetura/inversao-supabase-fonte-da-verdade.md
// §2.1–§2.6): lê os arquivos SQL em sql/escala/06..11 e confere
// estruturalmente — grants só-service_role + reload de cache em todas, os
// índices exigidos por design, e a AUSÊNCIA deliberada do UNIQUE de dedup
// (débito MODELO-02/Phase 19) em `06_ligacoes.sql`.
//
// Uso: node scripts/migracoes-espelho.smoke.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR_SQL = path.join(__dirname, '..', 'sql', 'escala');

const ARQUIVOS = [
  '06_ligacoes.sql',
  '07_audios_envios.sql',
  '08_leads_full.sql',
  '09_clickup_outbox.sql',
  '10_clickup_campos.sql',
  '11_notas.sql',
];

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function lerSemComentarios(conteudo) {
  return conteudo
    .split('\n')
    .filter((linha) => !linha.trim().startsWith('--'))
    .join('\n');
}

function main() {
  const conteudos = {};
  for (const arquivo of ARQUIVOS) {
    const caminho = path.join(DIR_SQL, arquivo);
    checar(fs.existsSync(caminho), `arquivo ausente: sql/escala/${arquivo}`);
    if (!fs.existsSync(caminho)) continue;
    conteudos[arquivo] = fs.readFileSync(caminho, 'utf8');
  }

  // Toda migração termina com grant service_role + reload de cache (LGPD-01/R13, PORTAO-03/R11).
  for (const arquivo of ARQUIVOS) {
    const conteudo = conteudos[arquivo];
    if (!conteudo) continue;
    checar(
      /to service_role/.test(conteudo),
      `sql/escala/${arquivo}: falta 'to service_role' (grant LGPD-01)`,
    );
    checar(
      /reload schema/.test(conteudo),
      `sql/escala/${arquivo}: falta \"notify pgrst, 'reload schema'\" (PORTAO-03)`,
    );
  }

  // 06_ligacoes.sql: índices de fila/lead/lote presentes; UNIQUE de dedup AUSENTE
  // fora de comentários (débito explícito MODELO-02/Phase 19 — 17-CONTEXT.md decisão 5).
  const ligacoes = conteudos['06_ligacoes.sql'] || '';
  checar(ligacoes.includes('ix_ligacoes_fila'), '06_ligacoes.sql: falta índice ix_ligacoes_fila');
  checar(ligacoes.includes('ix_ligacoes_lead'), '06_ligacoes.sql: falta índice ix_ligacoes_lead');
  checar(ligacoes.includes('ix_ligacoes_lote'), '06_ligacoes.sql: falta índice ix_ligacoes_lote');
  const ligacoesSemComentario = lerSemComentarios(ligacoes);
  checar(
    !/create\s+(unique\s+)?index[^;]*ux_ligacoes_aberta_por_tel/i.test(ligacoesSemComentario),
    '06_ligacoes.sql: NÃO deveria criar ux_ligacoes_aberta_por_tel fora de comentário (débito MODELO-02/Phase 19)',
  );

  // 07_audios_envios.sql: índice de lead presente.
  const audios = conteudos['07_audios_envios.sql'] || '';
  checar(audios.includes('ix_audios_lead'), '07_audios_envios.sql: falta índice ix_audios_lead');

  // 08_leads_full.sql: só ADD COLUMN IF NOT EXISTS (aditivo) + ix_leads_lote; nunca DROP/RENAME.
  const leadsFull = conteudos['08_leads_full.sql'] || '';
  checar(
    /add column if not exists/i.test(leadsFull),
    '08_leads_full.sql: falta ADD COLUMN IF NOT EXISTS (deve ser aditivo)',
  );
  checar(leadsFull.includes('ix_leads_lote'), '08_leads_full.sql: falta índice ix_leads_lote');
  checar(
    !/drop\s+(table|column)/i.test(lerSemComentarios(leadsFull)),
    '08_leads_full.sql: NÃO deveria conter DROP TABLE/COLUMN (deve ser só-aditivo)',
  );
  checar(
    !/rename\s+(table|to)/i.test(lerSemComentarios(leadsFull)),
    '08_leads_full.sql: NÃO deveria renomear a tabela (renomeação p/ `leads` deferida — Phase 19/20)',
  );

  // 09_clickup_outbox.sql: os 3 índices do outbox + dedup_key UNIQUE.
  const outbox = conteudos['09_clickup_outbox.sql'] || '';
  checar(outbox.includes('ix_outbox_drain'), '09_clickup_outbox.sql: falta índice ix_outbox_drain');
  checar(outbox.includes('ix_outbox_ordem'), '09_clickup_outbox.sql: falta índice ix_outbox_ordem');
  checar(outbox.includes('ix_outbox_head_age'), '09_clickup_outbox.sql: falta índice ix_outbox_head_age');
  checar(/dedup_key\s+text\s+unique/i.test(outbox), '09_clickup_outbox.sql: falta dedup_key text UNIQUE');

  // 10_clickup_campos.sql: PK composta (lista, campo_logico).
  const campos = conteudos['10_clickup_campos.sql'] || '';
  checar(
    /primary key \(lista, campo_logico\)/i.test(campos),
    '10_clickup_campos.sql: falta PRIMARY KEY (lista, campo_logico)',
  );

  // 11_notas.sql: clickup_comment_id presente (backfill/idempotência do plano 17-05).
  const notas = conteudos['11_notas.sql'] || '';
  checar(notas.includes('clickup_comment_id'), '11_notas.sql: falta coluna clickup_comment_id');

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('OK — SMOKE PASS (6 migrações do espelho Fase A estruturalmente corretas)');
  process.exit(0);
}

main();
