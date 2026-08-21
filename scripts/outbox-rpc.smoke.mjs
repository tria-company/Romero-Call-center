#!/usr/bin/env node
// scripts/outbox-rpc.smoke.mjs
//
// Smoke determinístico (OFFLINE — sem rede/Supabase real) do helper
// transacional do Caminho B (Fase 18, Portão 1 — src/mastra/outbox-rpc.ts).
// Molde de scripts/supabase.smoke.mjs (checar()/falhas[], exit 1 em falha).
//
// Como SUPABASE_URL/SUPABASE_SERVICE_KEY são lidas no IMPORT-TIME do módulo
// (config.ts, module-level `const`), este smoke roda em DOIS regimes:
//
//  (a) SEM env, NO PRÓPRIO PROCESSO deste smoke (invocação normal, `node
//      --experimental-strip-types scripts/outbox-rpc.smoke.mjs`) — prova que
//      `montarChamadaRpc`/`comOutboxRpc` LANÇAM citando 'SUPABASE_URL
//      ausente' ou 'SUPABASE_SERVICE_KEY ausente' (WR-03): nunca montam URL
//      nem fazem I/O sem config.
//
//  (b) COM env SINTÉTICA, num SUBPROCESSO dedicado (`node:child_process`) —
//      necessário porque uma vez que este processo já importou
//      `outbox-rpc.ts`/`config.ts` sem env (regime a), as constantes
//      module-level já ficaram fixadas nesse processo (semântica de cache
//      de módulos ESM); setar `process.env.*` depois não as re-lê. Um
//      subprocesso isolado, com `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`
//      sintéticas JÁ no ambiente ANTES do import, prova que
//      `montarChamadaRpc('registrar_desfecho', {...})` retorna UM
//      descritor único (`/rest/v1/rpc/registrar_desfecho`, POST, body
//      correto, apikey + Authorization Bearer) — a invariante estrutural
//      "uma chamada só" da RPC (design §3.0/§3.1; 18-CONTEXT.md decisão 2).
//
// Nunca chama `comOutboxRpc` de verdade (sem rede) — a prova da chamada
// única é ESTRUTURAL via `montarChamadaRpc` (um descritor = uma chamada).
// NUNCA loga a service key sintética nem o body cru fora do necessário para
// o diagnóstico do próprio smoke (a key é sempre 'k', valor de teste).
//
// Uso: node --experimental-strip-types scripts/outbox-rpc.smoke.mjs

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Raiz do repo (dirname deste arquivo / ..) — via fileURLToPath (NUNCA
// URL#pathname: em paths com espaço, como este projeto, .pathname devolve
// percent-encoded '%20' e quebra o cwd do subprocesso).
const RAIZ_REPO = fileURLToPath(new URL('..', import.meta.url));

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ===== Regime (a): SEM env, neste processo — config ausente deve LANÇAR (WR-03) =====

async function testeConfigAusente() {
  const { montarChamadaRpc, comOutboxRpc } = await import('../src/mastra/outbox-rpc.ts');

  try {
    montarChamadaRpc('registrar_desfecho', { p_ligacao_id: 42 });
    checar(false, 'montarChamadaRpc deveria LANÇAR sem SUPABASE_URL/SUPABASE_SERVICE_KEY configurados');
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    checar(
      mensagem.includes('SUPABASE_URL ausente') || mensagem.includes('SUPABASE_SERVICE_KEY ausente'),
      `montarChamadaRpc sem config deveria citar "SUPABASE_URL ausente" ou "SUPABASE_SERVICE_KEY ausente", recebido: "${mensagem}"`,
    );
  }

  try {
    await comOutboxRpc('registrar_desfecho', { p_ligacao_id: 42 });
    checar(false, 'comOutboxRpc deveria LANÇAR sem SUPABASE_URL/SUPABASE_SERVICE_KEY configurados (antes de qualquer I/O)');
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    checar(
      mensagem.includes('SUPABASE_URL ausente') || mensagem.includes('SUPABASE_SERVICE_KEY ausente'),
      `comOutboxRpc sem config deveria citar "SUPABASE_URL ausente" ou "SUPABASE_SERVICE_KEY ausente", recebido: "${mensagem}"`,
    );
  }
}

// ===== Regime (b): COM env sintética, em subprocesso — prova o POST único =====

/** Roda um trecho ESM inline num subprocesso com env sintética já setada
 *  ANTES do import (necessário p/ as constantes module-level de config.ts
 *  serem lidas com a env de teste). Nunca herda SUPABASE_SERVICE_KEY real do
 *  ambiente — sobrescreve explicitamente com o valor sintético 'k'. */
function rodarNoSubprocesso(codigoEsm) {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', codigoEsm],
    {
      cwd: RAIZ_REPO,
      env: { ...process.env, SUPABASE_URL: 'http://fake.local', SUPABASE_SERVICE_KEY: 'k' },
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  return r;
}

function testeConstrucaoDoPostUnico() {
  const r = rodarNoSubprocesso(`
    import { montarChamadaRpc } from './src/mastra/outbox-rpc.ts';
    const descritor = montarChamadaRpc('registrar_desfecho', { p_ligacao_id: 42 });
    console.log('DESCRITOR:' + JSON.stringify(descritor));
    try {
      montarChamadaRpc('', { p_ligacao_id: 42 });
      console.log('NOME_VAZIO:NAO_LANCOU');
    } catch (e) {
      console.log('NOME_VAZIO:LANCOU:' + (e instanceof Error ? e.message : String(e)));
    }
  `);

  checar(r.status === 0, `subprocesso do teste (b) deveria sair 0, saiu ${r.status}. stderr: ${(r.stderr || '').slice(0, 500)}`);

  const linhaDescritor = (r.stdout || '').split('\n').find((l) => l.startsWith('DESCRITOR:'));
  checar(!!linhaDescritor, `subprocesso não imprimiu DESCRITOR: — stdout: ${(r.stdout || '').slice(0, 500)}`);
  if (linhaDescritor) {
    const descritor = JSON.parse(linhaDescritor.slice('DESCRITOR:'.length));
    checar(
      typeof descritor.url === 'string' && descritor.url.endsWith('/rest/v1/rpc/registrar_desfecho'),
      `montarChamadaRpc deveria terminar em '/rest/v1/rpc/registrar_desfecho', recebido: "${descritor.url}"`,
    );
    checar(descritor.method === 'POST', `montarChamadaRpc deveria usar method 'POST', recebido: "${descritor.method}"`);
    checar(
      descritor.body === '{"p_ligacao_id":42}',
      `montarChamadaRpc deveria montar body '{"p_ligacao_id":42}', recebido: "${descritor.body}"`,
    );
    checar(
      descritor.headers?.apikey === 'k',
      'montarChamadaRpc deveria setar headers.apikey igual à service key sintética',
    );
    checar(
      typeof descritor.headers?.Authorization === 'string' && descritor.headers.Authorization.startsWith('Bearer '),
      `montarChamadaRpc deveria setar headers.Authorization começando com 'Bearer ', recebido: "${descritor.headers?.Authorization}"`,
    );
    // NUNCA logar a key/headers crus aqui — só o resultado booleano dos checks acima.
  }

  const linhaNomeVazio = (r.stdout || '').split('\n').find((l) => l.startsWith('NOME_VAZIO:'));
  checar(
    !!linhaNomeVazio && linhaNomeVazio.startsWith('NOME_VAZIO:LANCOU:'),
    `montarChamadaRpc com nomeRpc vazio deveria LANÇAR — recebido: "${linhaNomeVazio}"`,
  );
}

async function main() {
  await testeConfigAusente();
  testeConstrucaoDoPostUnico();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
