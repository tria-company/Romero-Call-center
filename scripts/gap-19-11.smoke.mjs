#!/usr/bin/env node
// scripts/gap-19-11.smoke.mjs
//
// Smoke determinístico (OFFLINE — sem rede/Supabase/ClickUp/Redis real) do
// gap-closure 19-11: fecha os achados de código bloqueantes-pro-flip da
// revisão da Fase B (19-REVIEW.md). Molde de scripts/drenar-outbox.smoke.mjs
// (checar()/falhas[], exit 1) + scripts/sincronizar-espelho.smoke.mjs (fake
// TaskClickUp pros mappers puros) — env sintética ANTES do import (as
// constantes de config.ts são lidas no IMPORT-TIME).
//
// Cobre (cada um contra o defeito confirmado na revisão):
//   CR-01 — dreno `criar_task` idempotente a crash: com o clickup_task_id JÁ
//     resolvido (passada anterior que morreu entre criarTask e marcarEnviado),
//     a re-execução NÃO chama o POST /task do ClickUp (0 task duplicada) —
//     contraste com o caminho "ainda não criada", que chama.
//   WR-01 — fila diária não-vazia sob supabase: paraLinhaLigacao pré-preenche
//     `operador` a partir do assignee do lote quando o custom field OPERADOR
//     está null (adicionado no Task 3).
//   WR-03 — DRENO_INLINE sem Redis DRENA (não bloqueia) (adicionado no Task 5).
//
// NUNCA loga service key sintética nem payload — só booleans/ids de teste.
//
// Uso: node --experimental-strip-types scripts/gap-19-11.smoke.mjs

// Env sintética ANTES de qualquer import de src/ (config.ts lê no import-time).
// Nunca aponta para infra real; sem REDIS_URL (prova o caminho inline do WR-03).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://fake.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'k';
process.env.CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN || 'tkn';
// Mapa login->memberId do ClickUp (fallback de degradação de operadores.ts,
// usado pelo reverse-map do espelho quando o snapshot do store está vazio).
process.env.DISCADOR_ASSIGNEES = process.env.DISCADOR_ASSIGNEES || 'romero:88,andressa:99';
delete process.env.REDIS_URL;

const falhas = [];
function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ===== CR-01 — criar_task idempotente a crash (fetch mock offline) =====
//
// Intercepta global.fetch e roteia por CARACTERÍSTICA da URL/método (não por
// nome de tabela): Supabase REST (`/rest/v1/`) vs. ClickUp (`api.clickup.com`).
// A prova: com clickup_task_id JÁ resolvido, o POST /task do ClickUp tem que
// ficar em ZERO na re-execução.
async function testeCr01Idempotencia() {
  const { processarDrenoOutboxJob } = await import('../src/mastra/drenar-outbox.ts');
  const fetchReal = global.fetch;

  function instalarMock({ clickupTaskId }) {
    const chamadas = { criarTaskPost: 0, marcarEnviadoPatch: 0, backfillPatch: 0 };
    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      const metodo = (opts.method || 'GET').toUpperCase();
      const ok = (data) =>
        new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
      const okVazio = () => new Response(null, { status: 200 }); // PATCH return=minimal

      // ClickUp POST /list/{id}/task — criarTask (NÃO pode ser chamado no reuse).
      if (u.includes('api.clickup.com') && u.includes('/task') && metodo === 'POST') {
        chamadas.criarTaskPost += 1;
        return ok({ id: 'TASK_NOVA' });
      }
      // Supabase REST
      if (u.includes('/rest/v1/')) {
        // resolverClickupTaskId — GET ...?id=eq.42&select=clickup_task_id
        if (metodo === 'GET' && u.includes('select=clickup_task_id')) {
          return ok(clickupTaskId ? [{ clickup_task_id: clickupTaskId }] : [{ clickup_task_id: null }]);
        }
        // proximasPendentes — GET ...?aggregate_id=eq.42&status=in.(pendente,erro)...
        if (metodo === 'GET' && u.includes('aggregate_id=eq.') && u.includes('status=in')) {
          return ok([
            {
              id: 1,
              aggregate: 'ligacao',
              aggregate_id: 42,
              op: 'criar_task',
              bloqueante: true,
              payload: { origem: 'avulsa', telefone_canonico: '+5511999999999' },
              dedup_key: 'ligacao:42:criar',
              seq: 1,
              status: 'pendente',
              tentativas: 0,
            },
          ]);
        }
        // backfillClickupTaskId — PATCH ...?id=eq.42&clickup_task_id=is.null
        if (metodo === 'PATCH' && u.includes('clickup_task_id=is.null')) {
          chamadas.backfillPatch += 1;
          return okVazio();
        }
        // marcarEnviado — PATCH ...clickup_outbox?id=eq.1
        if (metodo === 'PATCH') {
          chamadas.marcarEnviadoPatch += 1;
          return okVazio();
        }
      }
      throw new Error(`fetch inesperado no smoke: ${metodo} ${u}`);
    };
    return chamadas;
  }

  try {
    // (a) MORTE na janela: clickup_task_id JÁ resolvido -> re-execução NÃO recria.
    const reuse = instalarMock({ clickupTaskId: 'TASK_EXISTENTE' });
    const rReuse = await processarDrenoOutboxJob(42);
    checar(
      reuse.criarTaskPost === 0,
      `CR-01: com clickup_task_id já resolvido, o POST /task do ClickUp NÃO deve ser chamado (recebido ${reuse.criarTaskPost})`,
    );
    checar(
      reuse.marcarEnviadoPatch === 1,
      `CR-01: a linha criar_task reusada deve ser marcada enviada 1x (recebido ${reuse.marcarEnviadoPatch})`,
    );
    checar(
      rReuse.enviadas === 1,
      `CR-01: a passada de reuse deve reportar 1 enviada (recebido ${JSON.stringify(rReuse)})`,
    );

    // O CONTRASTE ("sem id resolvido -> criarTask É chamado 1x") é exercido no
    // teste do WR-03 (Task 5), pois o caminho de criação exige que a guarda do
    // dreno LIBERE a saída inline sem Redis — o que é exatamente o fix do WR-03.
  } finally {
    global.fetch = fetchReal;
  }
}

async function main() {
  await testeCr01Idempotencia();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('SMOKE OK');
  process.exit(0);
}

main();
