#!/usr/bin/env node
// scripts/backfill-notas.smoke.mjs
//
// Smoke OFFLINE (sem rede, sem Supabase/ClickUp) do Plano 17-05:
//   (1) `mapaComentarioParaNota` (PURO): comentario normal -> linha; comentario
//       vazio/sem texto -> null (pulado, nunca lanca); idempotencia pela chave
//       `clickup_comment_id` (o mesmo comentario mapeia sempre pra mesma chave).
//   (2) o backfill reusa as guardas fail-closed do 17-04
//       (`executarBackfillFailClosed`): RECUSA fora da janela de manutencao e
//       RECUSA sem o lock de concorrencia — sem NUNCA chamar o `sync` (o I/O que,
//       no runner real, hit o ClickUp/Storage).
//
// Uso: node --experimental-strip-types scripts/backfill-notas.smoke.mjs

import { mapaComentarioParaNota } from '../src/mastra/notas.ts';
import { executarBackfillFailClosed } from '../src/mastra/backfill-guardas.ts';

const falhas = [];
function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

async function esperaLancar(promessa) {
  try {
    await promessa;
    return { lancou: false, erro: null };
  } catch (e) {
    return { lancou: true, erro: e instanceof Error ? e.message : String(e) };
  }
}

// ===== (1) mapaComentarioParaNota (puro) =====

function testarComentarioNormalViraLinha() {
  const comentario = {
    id: '90040012345',
    comment_text: 'Lead pediu retorno amanha de manha',
    user: { username: 'maria.closer', email: 'maria@ex.com' },
    date: '1755720000000', // epoch-ms como string (formato do ClickUp)
  };
  const nota = mapaComentarioParaNota(comentario, 'lead', 'abc123');
  checar(nota !== null, 'comentario normal deveria virar uma linha (nao null)');
  checar(nota?.aggregate === 'lead', `aggregate deveria ser 'lead': ${nota?.aggregate}`);
  checar(nota?.aggregate_id === 'abc123', `aggregate_id deveria ser 'abc123': ${nota?.aggregate_id}`);
  checar(nota?.clickup_comment_id === '90040012345', `clickup_comment_id deveria ser o id do comentario: ${nota?.clickup_comment_id}`);
  checar(nota?.autor === 'maria.closer', `autor deveria ser o username: ${nota?.autor}`);
  checar(nota?.corpo === 'Lead pediu retorno amanha de manha', `corpo deveria ser o texto do comentario: ${nota?.corpo}`);
  checar(typeof nota?.criado_em === 'string' && nota.criado_em.includes('T'), `criado_em deveria ser ISO: ${nota?.criado_em}`);
}

function testarComentarioRichTextConcatena() {
  const comentario = {
    id: 42,
    comment: [{ text: 'parte 1 ' }, { text: 'parte 2' }],
    user: { email: 'so-email@ex.com' }, // sem username -> cai no email
    date: 1755720000000, // epoch-ms como number
  };
  const nota = mapaComentarioParaNota(comentario, 'ligacao', 'lig999');
  checar(nota !== null, 'comentario rich-text deveria virar linha');
  checar(nota?.aggregate === 'ligacao', `aggregate deveria ser 'ligacao': ${nota?.aggregate}`);
  checar(nota?.corpo === 'parte 1 parte 2', `corpo deveria concatenar os blocos: '${nota?.corpo}'`);
  checar(nota?.autor === 'so-email@ex.com', `autor deveria cair no email quando sem username: ${nota?.autor}`);
  checar(nota?.clickup_comment_id === '42', `clickup_comment_id deveria virar string: ${nota?.clickup_comment_id}`);
}

function testarComentarioVazioViraNull() {
  checar(mapaComentarioParaNota({ id: '1', comment_text: '' }, 'lead', 'x') === null, 'comentario com texto vazio deveria virar null');
  checar(mapaComentarioParaNota({ id: '2', comment_text: '   ' }, 'lead', 'x') === null, 'comentario so com espacos deveria virar null');
  checar(mapaComentarioParaNota({ id: '3', comment: [] }, 'lead', 'x') === null, 'comentario sem blocos de texto deveria virar null');
  checar(mapaComentarioParaNota({ comment_text: 'sem id' }, 'lead', 'x') === null, 'comentario sem id (sem chave de idempotencia) deveria virar null');
  checar(mapaComentarioParaNota(null, 'lead', 'x') === null, 'comentario null deveria virar null');
  checar(mapaComentarioParaNota({ id: '1', comment_text: 'ok' }, 'lead', '') === null, 'aggregateId vazio deveria virar null');
}

function testarNuncaLanca() {
  let lancou = false;
  try {
    mapaComentarioParaNota(undefined, 'lead', 'x');
    mapaComentarioParaNota({}, 'lead', 'x');
    mapaComentarioParaNota({ id: 'x', comment_text: 'ok', date: 'nao-e-data' }, 'lead', 'y');
  } catch {
    lancou = true;
  }
  checar(lancou === false, 'mapaComentarioParaNota NUNCA deveria lancar (entradas malformadas)');
}

function testarIdempotenciaPorCommentId() {
  const comentario = { id: '777', comment_text: 'mesma nota', user: { username: 'a' }, date: '1755720000000' };
  const n1 = mapaComentarioParaNota(comentario, 'lead', 'L1');
  const n2 = mapaComentarioParaNota(comentario, 'lead', 'L1');
  checar(n1?.clickup_comment_id === n2?.clickup_comment_id, 'o mesmo comentario deveria mapear pra mesma chave de idempotencia');
  checar(n1?.clickup_comment_id === '777', `a chave de idempotencia deveria ser o clickup_comment_id: ${n1?.clickup_comment_id}`);
}

// ===== (2) fail-closed do runner (reuso das guardas do 17-04) =====

const JANELA_1A5 = { inicioHora: 1, fimHora: 5 };

async function testarRecusaForaDaJanela() {
  const chamadas = [];
  const { lancou, erro } = await esperaLancar(
    executarBackfillFailClosed({
      sync: async (n) => {
        chamadas.push(n); // no runner real, aqui hit o ClickUp/Storage
        return { registros: 1, ultimaPagina: true };
      },
      agora: new Date('2026-08-21T12:00:00'), // horario de operacao
      janela: JANELA_1A5,
      lockAdquirido: true,
    }),
  );
  checar(lancou === true, 'fora da janela: o backfill deveria RECUSAR (lancar)');
  checar(/janela de manutenção/.test(erro ?? ''), `mensagem deveria citar a janela: ${erro}`);
  checar(chamadas.length === 0, `fora da janela: o sync (ClickUp/Storage) NUNCA deveria ser chamado (foi ${chamadas.length}x)`);
}

async function testarRecusaSemLock() {
  const chamadas = [];
  const { lancou, erro } = await esperaLancar(
    executarBackfillFailClosed({
      sync: async (n) => {
        chamadas.push(n);
        return { registros: 1, ultimaPagina: true };
      },
      agora: new Date('2026-08-21T02:00:00'), // dentro da janela
      janela: JANELA_1A5,
      lockAdquirido: false, // sem lock
    }),
  );
  checar(lancou === true, 'sem lock: o backfill deveria RECUSAR (lancar)');
  checar(/lock/.test(erro ?? ''), `mensagem deveria citar o lock: ${erro}`);
  checar(chamadas.length === 0, `sem lock: o sync (ClickUp/Storage) NUNCA deveria ser chamado (foi ${chamadas.length}x)`);
}

async function main() {
  testarComentarioNormalViraLinha();
  testarComentarioRichTextConcatena();
  testarComentarioVazioViraNull();
  testarNuncaLanca();
  testarIdempotenciaPorCommentId();
  await testarRecusaForaDaJanela();
  await testarRecusaSemLock();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('SMOKE OK');
  process.exit(0);
}

main();
