#!/usr/bin/env node
// scripts/smoke-fundacao.mjs
//
// Smoke da fundação do RomeroCall (Fase 01, Plano 01-04): prova a vertical
// slice mais fina — ClickUp(read+write) + LLM(provider) — funcionando de
// ponta a ponta contra os serviços REAIS. Fecha FUND-04 (read do seed),
// FUND-03 (chamada real ao LLM) e FUND-02 (create+update+read-back de task).
//
// Por que este script REPLICA a lógica de src/mastra/clickup.ts e
// src/mastra/llm.ts em vez de importá-los: o Node (mesmo com strip nativo de
// tipos TS) não resolve os imports extensionless usados em src/mastra
// (ex: `from './config'`), e o projeto não tem `tsx` como devDependency.
// `.mastra/output` (gerado por `npm run build`) é um bundle de servidor opaco.
// Por isso este smoke reimplementa a MESMA semântica de listarTasks /
// criarTask / atualizarTask / lerTask (clickup.ts) e chamarLLM (llm.ts),
// usando os MESMOS nomes de env var.
//
// WRITE via DESCRIÇÃO (campo nativo), não custom field: o plano do workspace
// ClickUp bloqueia escrita de custom field (400 FIELD_033 "Custom field usages
// exceeded for your plan"). A descrição/comentários são nativos e não entram
// nessa cota — e casam com D-06 revisado (script/observações vão na descrição
// da task). A prova de FUND-02 aqui é create + update(descrição) + read-back.
//
// Uso: node --env-file=.env scripts/smoke-fundacao.mjs
// LGPD (D-10): nunca imprime nome/telefone/cpf de lead — só contagem/ids técnicos.
// Segurança: nenhum token é logado, só lido de process.env.

import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAzure } from '@ai-sdk/azure';

const CLICKUP_BASE_URL = 'https://api.clickup.com/api/v2';

const CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN || '';
const CLICKUP_LIST_LEADS = process.env.CLICKUP_LIST_LEADS || '1000320000002833';
const CLICKUP_LIST_LIGACOES = process.env.CLICKUP_LIST_LIGACOES || '1000320000002834';
// Provider ativo — espelha LLM_PROVIDER de src/mastra/llm.ts para provar o
// caminho que producao realmente usa (WR-02), nao um caminho fixo em OpenAI.
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'openai';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || '';
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || '';
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '';

// Sai com mensagem clara e exit 1 se faltar env (D-09) — sem fazer nenhuma
// request antes de validar as chaves.
function falharConfigAusente(faltando) {
  console.error(
    `[smoke-fundacao] ${faltando} vazio — preencha a(s) variavel(is) no .env ` +
      'antes de rodar o smoke (node --env-file=.env scripts/smoke-fundacao.mjs).',
  );
  process.exit(1);
}

if (!CLICKUP_API_TOKEN) falharConfigAusente('CLICKUP_API_TOKEN');
// Valida o provider ATIVO (WR-02) — espelha configAusente() de llm.ts: em
// Azure exige API_KEY + ENDPOINT + DEPLOYMENT; em OpenAI exige OPENAI_API_KEY.
if (LLM_PROVIDER === 'azure') {
  if (!AZURE_OPENAI_API_KEY) falharConfigAusente('AZURE_OPENAI_API_KEY (LLM_PROVIDER=azure)');
  if (!AZURE_OPENAI_ENDPOINT) falharConfigAusente('AZURE_OPENAI_ENDPOINT (LLM_PROVIDER=azure)');
  if (!AZURE_OPENAI_DEPLOYMENT) falharConfigAusente('AZURE_OPENAI_DEPLOYMENT (LLM_PROVIDER=azure)');
} else {
  if (!OPENAI_API_KEY) falharConfigAusente('OPENAI_API_KEY');
}

function headersClickUp() {
  return { Authorization: CLICKUP_API_TOKEN, 'Content-Type': 'application/json' };
}

/** Espelha listarTasks() de src/mastra/clickup.ts (D-01). */
async function listarTasks(listId) {
  const params = new URLSearchParams({ page: '0', include_closed: 'true' });
  const res = await fetch(`${CLICKUP_BASE_URL}/list/${listId}/task?${params.toString()}`, {
    headers: headersClickUp(),
  });
  if (!res.ok) throw new Error(`GET /list/${listId}/task falhou (${res.status})`);
  const data = await res.json();
  return data?.tasks || [];
}

/** Espelha criarTask() de src/mastra/clickup.ts. */
async function criarTask(listId, payload) {
  const res = await fetch(`${CLICKUP_BASE_URL}/list/${listId}/task`, {
    method: 'POST',
    headers: headersClickUp(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST /list/${listId}/task falhou (${res.status})`);
  return res.json();
}

/** Atualiza a DESCRIÇÃO da task (campo nativo — PUT /task/{id}). Não usa custom
 *  field por causa do limite de plano (FIELD_033). */
async function atualizarDescricao(taskId, descricao) {
  const res = await fetch(`${CLICKUP_BASE_URL}/task/${taskId}`, {
    method: 'PUT',
    headers: headersClickUp(),
    body: JSON.stringify({ description: descricao }),
  });
  if (!res.ok) throw new Error(`PUT /task/${taskId} (description) falhou (${res.status})`);
  return true;
}

/** Espelha lerTask() de src/mastra/clickup.ts. */
async function lerTask(taskId) {
  const res = await fetch(`${CLICKUP_BASE_URL}/task/${taskId}`, { headers: headersClickUp() });
  if (!res.ok) throw new Error(`GET /task/${taskId} falhou (${res.status})`);
  return res.json();
}

/** Deleta a task de teste ao final (T-04-03: não sujar a Lista 02). */
async function deletarTask(taskId) {
  const res = await fetch(`${CLICKUP_BASE_URL}/task/${taskId}`, {
    method: 'DELETE',
    headers: headersClickUp(),
  });
  if (!res.ok) throw new Error(`DELETE /task/${taskId} falhou (${res.status})`);
  return true;
}

/** Espelha chamarLLM()/modeloLLM() de src/mastra/llm.ts — exercita o provider
 *  ATIVO conforme LLM_PROVIDER (WR-02), nao um caminho fixo em OpenAI. */
function modeloLLM() {
  if (LLM_PROVIDER === 'azure') {
    const azure = createAzure({
      apiKey: AZURE_OPENAI_API_KEY,
      baseURL: AZURE_OPENAI_ENDPOINT || undefined,
      apiVersion: AZURE_OPENAI_API_VERSION || undefined,
      // Espelha llm.ts (WR-01): formato /deployments/{deploymentId}.
      useDeploymentBasedUrls: true,
    });
    return azure(AZURE_OPENAI_DEPLOYMENT);
  }
  const openai = createOpenAI({ apiKey: OPENAI_API_KEY });
  return openai(OPENAI_MODEL);
}

async function chamarLLM(prompt) {
  const { text } = await generateText({ model: modeloLLM(), prompt });
  return text;
}

async function checarRead() {
  console.log('\n[1/3] FUND-04 — leitura da Lista 01 LEADS...');
  const tasks = await listarTasks(CLICKUP_LIST_LEADS);
  if (!(tasks.length >= 1)) {
    throw new Error(`esperava >= 1 lead na Lista 01, encontrado ${tasks.length}`);
  }
  // LGPD (D-10/T-04-01): NUNCA imprimir nome/telefone/cpf — só a contagem.
  console.log(`  PASS — ${tasks.length} lead(s) lido(s) da Lista 01 (contagem apenas, sem PII).`);
}

async function checarLLM() {
  console.log(`\n[2/3] FUND-03 — chamada real ao LLM (provider=${LLM_PROVIDER})...`);
  const texto = await chamarLLM('Responda apenas OK.');
  if (!texto || typeof texto !== 'string' || texto.trim().length === 0) {
    throw new Error('LLM retornou string vazia');
  }
  console.log(`  PASS — LLM (${LLM_PROVIDER}) respondeu (${texto.trim().length} caractere(s)).`);
}

async function checarWrite() {
  console.log('\n[3/3] FUND-02 — create + update(descrição) + read-back na Lista 02 LIGACOES...');
  const valorEsperado = `smoke ${Date.now()}`;
  let taskId = null;
  try {
    const task = await criarTask(CLICKUP_LIST_LIGACOES, { name: 'SMOKE FUNDACAO — apagar' });
    taskId = task?.id;
    if (!taskId) throw new Error('criarTask não retornou id');

    // WRITE na descrição (nativo; custom field bloqueado pelo plano — FIELD_033).
    await atualizarDescricao(taskId, valorEsperado);

    const lida = await lerTask(taskId);
    // Read-back robusto (WR-04): o ClickUp normaliza/renderiza a descrição
    // (markdown, text_content vs description, espaçamento), então comparar por
    // igualdade estrita é flaky. Basta o marcador único aparecer em qualquer
    // dos dois campos nativos.
    const descricao = (lida?.description ?? '').trim();
    const textContent = (lida?.text_content ?? '').trim();
    if (!descricao.includes(valorEsperado) && !textContent.includes(valorEsperado)) {
      throw new Error(
        `read-back não bateu: marcador "${valorEsperado}" não encontrado em description/text_content`,
      );
    }
    console.log(`  PASS — write na descrição confirmado por read-back (task ${taskId}).`);
  } finally {
    // Cleanup protegido (WR-04): uma falha no DELETE não pode sobrescrever o
    // erro real do teste nem deixar a task órfã sem sinal claro.
    if (taskId) {
      try {
        await deletarTask(taskId);
        console.log(`  cleanup — task de teste ${taskId} deletada (T-04-03).`);
      } catch (e) {
        console.error(`  cleanup falhou — task ${taskId} pode ter ficado órfã: ${e?.message || e}`);
      }
    }
  }
}

async function main() {
  console.log('=== Smoke da Fundação (RomeroCall — Fase 01, Plano 01-04) ===');
  await checarRead();
  await checarLLM();
  await checarWrite();
  console.log('\n=== RESULTADO: PASS — as 3 checagens passaram ===');
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n=== RESULTADO: FAIL — ${e?.message || e} ===`);
  process.exit(1);
});
