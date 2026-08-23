#!/usr/bin/env node
// scripts/gerar-lote-supabase.smoke.mjs
//
// Smoke determinístico (OFFLINE — sem rede real, `global.fetch` mockado por
// característica de URL, molde `scripts/gap-19-11.smoke.mjs`) do caminho
// `FONTE_LEADS=supabase` de `scripts/gerar-lote.mjs` (20-06, LEITURA-06).
// Prova, sem tocar rede:
//
//   (a) PARIDADE DE ORDEM — um comparador escrito à mão reproduzindo
//       LITERALMENTE a cláusula SQL `order by retorno_necessario desc,
//       score desc, tentativas asc` de `gerar_lote`
//       (sql/escala/26_rpc_gerar_lote.sql, ix_leads_lote) produz a MESMA
//       ordem que `lote.ts::selecionarLoteElegivel` sobre um conjunto
//       sintético de leads — e `selecionarLoteElegiveisSupabase`
//       (src/mastra/supabase.ts, 20-04) de fato pede essa MESMA string de
//       `order` ao PostgREST.
//   (b) o caminho supabase do runner (`gerarLoteSupabase`) NUNCA chama a
//       listagem da Lista 01 (nenhum fetch bate em `api.clickup.com` com a
//       lista `CLICKUP_LIST_LEADS`).
//   (c) a chamada à RPC `gerar_lote` passa operador/assignee/tamanho/
//       lote_data corretos — uma chamada POR OPERADOR da rodada, fatiando
//       `--tamanho` (`distribuirTamanhoPorOperador`, D6).
//   (d) PARIDADE DO GOLDEN DE TELEFONE (MEDIUM-1) — o MESMO golden fixo
//       embutido no self-check `DO $$ ASSERT $$` de `canonizar_telefone()`
//       (sql/escala/22_fundacao_fase_c.sql) passado por `canonizarTelefone`
//       (src/mastra/telefone-canonico.ts, TS) bate com o canônico-alvo do
//       golden. O lado SQL da paridade é forçado pela APLICAÇÃO da migração
//       22 (self-check `DO $$ ASSERT $$`, ver 20-08); se um dos dois lados
//       divergir do golden, o smoke (TS) OU a aplicação da migração (SQL)
//       falha — nunca os dois silenciosamente.
//
// Só valores SINTÉTICOS (LGPD/T-20-01-I) — nenhum RAISE/checar cita telefone
// real. `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`/`CLICKUP_API_TOKEN` sintéticos,
// setados ANTES de qualquer import de src/ (config.ts lê no import-time).
//
// Uso: node --experimental-strip-types scripts/gerar-lote-supabase.smoke.mjs

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://fake.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'k';
process.env.CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN || 'tkn';

const falhas = [];
function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ===== (a) Paridade de ordem — comparador SQL-literal vs. lote.ts =====

async function testeParidadeOrdem() {
  const { selecionarLoteElegivel, derivarRetornoNecessario } = await import('../src/mastra/lote.ts');
  const { selecionarLoteElegiveisSupabase } = await import('../src/mastra/supabase.ts');

  const hoje = new Date('2026-08-23T12:00:00Z');
  const ontem = new Date(hoje.getTime() - 86400000);

  // Conjunto sintético: variação deliberada de retornoNecessario (via
  // tentativas>0 + proximoContato<=hoje)/score/tentativas — força colisões e
  // desempates nos 3 níveis da cláusula.
  function lead(taskId, { tentativas, score, comRetorno }) {
    return {
      taskId,
      idLead: '',
      nome: `lead-${taskId}`,
      telefone: '11988887777',
      score,
      tentativas,
      proximoContato: comRetorno ? ontem : hoje,
      retornoNecessario: false, // recalculado por derivarRetornoNecessario dentro de selecionarLoteElegivel
    };
  }

  const leads = [
    lead('L1', { tentativas: 2, score: 50, comRetorno: true }),
    lead('L2', { tentativas: 1, score: 80, comRetorno: true }),
    lead('L3', { tentativas: 0, score: 90, comRetorno: false }),
    lead('L4', { tentativas: 0, score: 80, comRetorno: true }),
    lead('L5', { tentativas: 3, score: 40, comRetorno: false }),
    lead('L6', { tentativas: 1, score: 80, comRetorno: true }), // mesmo score/retorno de L4 -> desempata por tentativas
  ];

  const opts = { hoje, limiteTentativas: 5, tamanho: leads.length };
  const ordemLoteTs = selecionarLoteElegivel(leads, opts).map((l) => l.taskId);

  // Comparador escrito à mão reproduzindo LITERALMENTE
  // `order by retorno_necessario desc, score desc, tentativas asc`
  // (sql/escala/26_rpc_gerar_lote.sql) — reusa SÓ a derivação canônica de
  // retornoNecessario (derivarRetornoNecessario, a MESMA usada pelo espelho
  // pra materializar a coluna `retorno_necessario`), nunca o `.sort()` de
  // selecionarLoteElegivel (senão o teste seria tautológico).
  const ordemSqlLiteral = [...leads]
    .map((l) => ({ ...l, retornoNecessario: derivarRetornoNecessario(l, hoje) }))
    .sort((a, b) => {
      if (a.retornoNecessario !== b.retornoNecessario) return a.retornoNecessario ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      return a.tentativas - b.tentativas;
    })
    .map((l) => l.taskId);

  checar(
    JSON.stringify(ordemLoteTs) === JSON.stringify(ordemSqlLiteral),
    `paridade de ordem: selecionarLoteElegivel (lote.ts) = ${JSON.stringify(ordemLoteTs)}, comparador SQL-literal = ${JSON.stringify(ordemSqlLiteral)} — deveriam ser IGUAIS`,
  );

  // selecionarLoteElegiveisSupabase (supabase.ts, 20-04) precisa pedir a MESMA
  // string de order ao PostgREST — fetch mockado só pra capturar a URL.
  const fetchReal = global.fetch;
  let urlCapturada = null;
  global.fetch = async (url) => {
    urlCapturada = String(url);
    if (urlCapturada.includes('/rest/v1/ligacoes')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await selecionarLoteElegiveisSupabase(10);
  } finally {
    global.fetch = fetchReal;
  }
  checar(
    urlCapturada !== null && urlCapturada.includes('order=retorno_necessario.desc%2Cscore.desc%2Ctentativas.asc'),
    `selecionarLoteElegiveisSupabase deveria pedir order=retorno_necessario.desc,score.desc,tentativas.asc (a mesma regra do comparador SQL-literal acima), recebido: ${urlCapturada}`,
  );
}

// ===== (b)/(c) gerarLoteSupabase — sem Lista 01, RPC com args corretos =====

async function testeGerarLoteSupabaseSemLista01EArgsCorretos() {
  const { gerarLoteSupabase, distribuirTamanhoPorOperador } = await import('./gerar-lote.mjs');
  const { CLICKUP_LIST_LEADS } = await import('../src/mastra/clickup.ts');
  const { SUPABASE_TABLE_LIGACOES } = await import('../src/mastra/config.ts');

  const chamadasRpc = [];
  const todasAsUrls = [];
  const fetchReal = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    todasAsUrls.push({ url: u, method: (opts.method || 'GET').toUpperCase() });

    if (u.includes('/rest/v1/rpc/gerar_lote')) {
      chamadasRpc.push(JSON.parse(String(opts.body || '{}')));
      return new Response(JSON.stringify({ criadas: 2, outbox_inseridos: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes(`/rest/v1/${SUPABASE_TABLE_LIGACOES}`) && u.includes('script=is.null')) {
      // Nenhuma ligação pendente de roteiro nesta rodada — o smoke foca em
      // provar (b)/(c), a materialização de roteiro fica coberta pelo seam
      // de deps (chamarLLM/etc nunca são exercitados aqui, por design).
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    throw new Error(`[smoke] fetch inesperado (nao deveria acontecer neste teste): ${(opts.method || 'GET')} ${u}`);
  };

  let resultado;
  try {
    resultado = await gerarLoteSupabase({
      operadores: [
        { nome: 'closer1', assigneeId: '111' },
        { nome: 'closer2', assigneeId: '222' },
      ],
      tamanho: 5,
      loteData: '2026-08-23',
      dryRun: false,
    });
  } finally {
    global.fetch = fetchReal;
  }

  // (b) NUNCA chama a listagem da Lista 01 — nenhuma URL bate em api.clickup.com
  // nem referencia CLICKUP_LIST_LEADS.
  const chamouListaClickup = todasAsUrls.some(
    (c) => c.url.includes('api.clickup.com') || c.url.includes(CLICKUP_LIST_LEADS),
  );
  checar(!chamouListaClickup, `gerarLoteSupabase NÃO deveria chamar a Lista 01 do ClickUp; URLs chamadas: ${JSON.stringify(todasAsUrls)}`);

  // (c) UMA chamada de RPC por operador, fatiando `tamanho` (D6) — 5 leads / 2
  // operadores = distribuirTamanhoPorOperador(5,2) = [3,2].
  const fatiasEsperadas = distribuirTamanhoPorOperador(5, 2);
  checar(JSON.stringify(fatiasEsperadas) === JSON.stringify([3, 2]), `distribuirTamanhoPorOperador(5,2) deveria ser [3,2], recebido ${JSON.stringify(fatiasEsperadas)}`);
  checar(chamadasRpc.length === 2, `gerar_lote deveria ser chamado 1x por operador (2 operadores), recebido ${chamadasRpc.length} chamada(s)`);
  checar(
    chamadasRpc[0]?.p_operador === 'closer1' && chamadasRpc[0]?.p_assignee_clickup_id === 111 && chamadasRpc[0]?.p_tamanho === 3 && chamadasRpc[0]?.p_lote_data === '2026-08-23',
    `1a chamada de gerar_lote incorreta: ${JSON.stringify(chamadasRpc[0])}`,
  );
  checar(
    chamadasRpc[1]?.p_operador === 'closer2' && chamadasRpc[1]?.p_assignee_clickup_id === 222 && chamadasRpc[1]?.p_tamanho === 2 && chamadasRpc[1]?.p_lote_data === '2026-08-23',
    `2a chamada de gerar_lote incorreta: ${JSON.stringify(chamadasRpc[1])}`,
  );

  // Resultado agregado (soma das 2 chamadas mockadas: 2+2=4 criadas, 2+2=4 outbox).
  checar(resultado.criadas === 4, `criadas deveria somar as 2 chamadas (4), recebido ${resultado.criadas}`);
  checar(resultado.outboxInseridos === 4, `outboxInseridos deveria somar as 2 chamadas (4), recebido ${resultado.outboxInseridos}`);
  checar(resultado.falhasRpc === 0, `falhasRpc deveria ser 0 (as 2 chamadas mockadas tiveram sucesso), recebido ${resultado.falhasRpc}`);
}

/** distribuirTamanhoPorOperador é pura — testa a distribuição isolada (sem fetch). */
async function testeDistribuirTamanhoPorOperador() {
  const { distribuirTamanhoPorOperador } = await import('./gerar-lote.mjs');
  checar(JSON.stringify(distribuirTamanhoPorOperador(10, 1)) === JSON.stringify([10]), 'distribuirTamanhoPorOperador(10,1) deveria ser [10]');
  checar(JSON.stringify(distribuirTamanhoPorOperador(9, 3)) === JSON.stringify([3, 3, 3]), 'distribuirTamanhoPorOperador(9,3) deveria ser [3,3,3]');
  checar(JSON.stringify(distribuirTamanhoPorOperador(7, 3)) === JSON.stringify([3, 2, 2]), 'distribuirTamanhoPorOperador(7,3) deveria ser [3,2,2]');
  let lancou = false;
  try {
    distribuirTamanhoPorOperador(5, 0);
  } catch {
    lancou = true;
  }
  checar(lancou, 'distribuirTamanhoPorOperador(5,0) deveria lançar (nenhum operador para distribuir)');
}

// ===== (d) Paridade do golden de telefone (MEDIUM-1) =====
//
// MESMO golden do self-check `DO $$ ASSERT $$` de canonizar_telefone()
// (sql/escala/22_fundacao_fase_c.sql, linhas do bloco "Self-check golden") —
// se um lado divergir, este smoke (TS) OU a aplicação da migração 22 (SQL)
// falha; nunca os dois silenciosamente. Só números SINTÉTICOS.
async function testeParidadeGoldenTelefone() {
  const { canonizarTelefone, variantesTelefone } = await import('../src/mastra/telefone-canonico.ts');

  const golden = [
    { raw: '5581987654321', esperado: '+558187654321', desc: '13-dig/com-9/com-55' },
    { raw: '558187654321', esperado: '+558187654321', desc: '12-dig/sem-9/com-55' },
    { raw: '81987654321', esperado: '+558187654321', desc: '11-dig-local/com-9/sem-55' },
    { raw: '+55 (81) 98765-4321', esperado: '+558187654321', desc: 'com-formatacao' },
    { raw: '11912345678', esperado: '+551112345678', desc: 'segundo-numero (DDD 11)' },
  ];
  for (const g of golden) {
    checar(
      canonizarTelefone(g.raw) === g.esperado,
      `canonizarTelefone golden "${g.desc}" divergiu do self-check SQL (22_fundacao_fase_c.sql): esperado ${g.esperado}, recebido ${canonizarTelefone(g.raw)}`,
    );
  }
  checar(canonizarTelefone(null) === null, 'canonizarTelefone(null) deveria ser null (mesmo golden SQL)');
  checar(canonizarTelefone('') === null, 'canonizarTelefone("") deveria ser null (mesmo golden SQL)');

  const variantes12 = [...variantesTelefone('558187654321')].sort();
  const esperadas = ['+558187654321', '+5581987654321'].sort();
  checar(
    JSON.stringify(variantes12) === JSON.stringify(esperadas),
    `variantesTelefone golden 12-dig divergiu do self-check SQL: esperado ${JSON.stringify(esperadas)}, recebido ${JSON.stringify(variantes12)}`,
  );
  checar(JSON.stringify(variantesTelefone(null)) === JSON.stringify([]), 'variantesTelefone(null) deveria ser [] (mesmo golden SQL)');
}

await testeParidadeOrdem();
await testeGerarLoteSupabaseSemLista01EArgsCorretos();
await testeDistribuirTamanhoPorOperador();
await testeParidadeGoldenTelefone();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
