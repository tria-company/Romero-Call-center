#!/usr/bin/env node
// scripts/outbox-orphan.mjs
//
// CLI OPERACIONAL — a AÇÃO DE OPERADOR do escape head-of-line (Fase B, Phase
// 19 Plano 06, ESCRITA-03/design §3.2/Riscos R6). Invoca
// `outbox-repo.ts::marcarOrphan(aggregate, aggregateId)`: descarta as ops
// PRESAS (`pendente`/`erro`) de UM aggregate no `clickup_outbox` — elas viram
// `status='orphan'` e nunca mais são retentadas. O Supabase segue como SoT;
// o espelho ClickUp fica reconhecidamente incompleto para aquele item. É
// isso ou o aggregate travado para sempre bloqueando `set_campo`/`fechar`
// posteriores (head-of-line blocking).
//
// O sinal para rodar isto é o alarme de idade da cabeça (`alertas.ts`,
// `outbox:head:{aggregate}:{id}`, DRENO_HEAD_AGE_ALERTA_MS) — um aggregate
// com a cabeça `pendente`/`erro` há mais tempo que o limite. Ação EXPLÍCITA
// do operador, NUNCA automática (mesmo racional de T-19-06-Th: rodar contra
// o ambiente errado é o risco).
//
// Molde de `aplicar-sql.mjs` (CLI Node que lê SUPABASE_URL/SUPABASE_SERVICE_KEY
// do env passado via `--env-file`) — nunca hardcoda instância.
//
// LGPD: loga SÓ aggregate + id + contagem de linhas descartadas — NUNCA
// payload/telefone/URL.
//
// Uso: node --experimental-strip-types --env-file=deploy/homolog.env \
//        scripts/outbox-orphan.mjs --aggregate=ligacao --id=<aggregateId>

import { marcarOrphan } from '../src/mastra/outbox-repo.ts';

const AGGREGATES_VALIDOS = new Set(['ligacao', 'lead', 'audio', 'nota']);

function uso() {
  console.error(
    'uso: node --experimental-strip-types --env-file=deploy/homolog.env scripts/outbox-orphan.mjs --aggregate=<ligacao|lead|audio|nota> --id=<aggregateId numerico>',
  );
}

function parseArgs(argv) {
  const opts = { aggregate: undefined, id: undefined };
  for (const arg of argv) {
    if (arg.startsWith('--aggregate=')) {
      opts.aggregate = arg.slice('--aggregate='.length);
    } else if (arg.startsWith('--id=')) {
      opts.id = arg.slice('--id='.length);
    }
  }
  return opts;
}

async function main() {
  const { aggregate, id } = parseArgs(process.argv.slice(2));

  if (!aggregate || !AGGREGATES_VALIDOS.has(aggregate)) {
    console.error(`--aggregate invalido/ausente: '${aggregate ?? ''}' — esperado um de: ${[...AGGREGATES_VALIDOS].join(', ')}`);
    uso();
    process.exit(1);
  }

  const aggregateId = Number(id);
  if (!id || !Number.isFinite(aggregateId) || !Number.isInteger(aggregateId) || aggregateId <= 0) {
    console.error(`--id invalido/ausente: '${id ?? ''}' — esperado um inteiro positivo`);
    uso();
    process.exit(1);
  }

  let descartadas;
  try {
    descartadas = await marcarOrphan(aggregate, aggregateId);
  } catch (e) {
    console.error(
      `[outbox-orphan] falha ao marcar orphan (aggregate=${aggregate}, id=${aggregateId}): ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }

  console.log(`[outbox-orphan] aggregate=${aggregate} id=${aggregateId} — ${descartadas} linha(s) descartada(s) (status=orphan)`);
  process.exit(0);
}

main();
