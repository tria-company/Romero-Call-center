#!/usr/bin/env node
// scripts/gerar-lote.mjs
//
// Runner impuro da skill "gerar-lote-diario". Ramifica por `FONTE_LEADS`
// (Fase C, Phase 20 Plano 06, LEITURA-06):
//
// - FONTE_LEADS='clickup' (default): ClickUp-only (Quick 260815-hea, decisões
//   travadas D1-D6) — a Lista 01 (LEADS) já vem preenchida à mão pelo gestor;
//   este runner faz SELEÇÃO EXPLÍCITA (um dos 3 modos abaixo) -> DISTRIBUI em
//   round-robin entre os operadores da rodada (D6) -> cria uma Ligação por
//   lead na Lista 02 (LIGACOES) com o roteiro que o gestor escreveu num
//   arquivo .md (D3). Byte-a-byte o comportamento de hoje.
//
// - FONTE_LEADS='supabase': NÃO pagina a Lista 01 — a seleção dos leads
//   elegíveis + o INSERT de `ligacoes` + a linha de outbox `criar_task`
//   acontecem ATOMICAMENTE dentro da RPC `gerar_lote` (SQL, sql/escala/26,
//   20-03), reproduzindo a MESMA ordem de prioridade que `selecionarLoteElegivel`
//   (lote.ts) calcularia (`retorno_necessario DESC, score DESC, tentativas
//   ASC`). Este runner chama a RPC UMA VEZ POR OPERADOR da rodada (D6),
//   dividindo `--tamanho` em fatias quase-iguais (`distribuirTamanhoPorOperador`)
//   — a RPC não aceita uma lista explícita de leads para alternar por-lead,
//   então a fatia por-operador é o equivalente possível do round-robin
//   original preservando "todo operador recebe uma parte do lote". Só o modo
//   `--tamanho` é suportado sob `supabase` (`--telefones`/`--tag` dependem de
//   dado só disponível no ClickUp — tag nativa da task / telefone colado
//   contra a Lista 01 inteira; rode com `FONTE_LEADS=clickup` para usá-los).
//   `gerar_lote` grava `ligacoes.script=null` (débito assumido no 20-03: a
//   seleção só é conhecida DEPOIS que a RPC roda) — este runner materializa o
//   roteiro por-lead via Agente Script (`montarPromptScript`+`chamarLLM`,
//   mesmo agente do caminho ClickUp) e grava direto em `ligacoes.script`
//   (PATCH PostgREST, best-effort, molde `marcarSuperFaEspelho`); dispara o
//   dreno (kick checado, mesmo padrão de `index.ts`/`processador.ts`) para
//   materializar a task no ClickUp e, quando o `clickup_task_id` já resolveu
//   NESTA MESMA passada (caminho inline sem Redis), reflete o roteiro na
//   description da task via `atualizarTask` (best-effort). Falha ao
//   gerar/gravar o roteiro de UM lead NUNCA aborta o lote inteiro — a Ligação
//   já foi criada (o core value); o roteiro fica `null` e pode ser
//   regenerado depois (débito documentado).
//
// Uso:
//   node --env-file=.env --experimental-strip-types scripts/gerar-lote.mjs \
//     (--telefones "<lista>" | --tag [nome] | --tamanho N) \
//     [--script <caminho.md>] [--operadores nome1,nome2,...] [--dry-run]
//
// Modos de seleção (D4, exatamente UM é obrigatório):
//   --telefones "<lista>"  casa cada telefone colado (vírgula/espaço/quebra
//                          de linha) contra a Lista 01, via filtrarLeadsPorTelefones.
//                          Só FONTE_LEADS=clickup.
//   --tag [nome]           puxa só os leads marcados com a tag do ClickUp
//                          (default "lote-hoje" ou LOTE_TAG_DEFAULT). Só
//                          FONTE_LEADS=clickup.
//   --tamanho N            pega os primeiros N leads em ordem de prioridade
//                          (sem N usa LOTE_TAMANHO_DEFAULT). Único modo
//                          suportado sob FONTE_LEADS=supabase.
//
// --script <caminho.md> é OBRIGATÓRIA sob FONTE_LEADS=clickup: o texto do
// arquivo vira a description de TODAS as Ligações criadas nesta execução
// (D3, script único do dia). Sob FONTE_LEADS=supabase a flag é ignorada — o
// roteiro nasce por-lead do Agente Script (ver acima).
//
// --operadores nome1,nome2,... distribui as Ligações em round-robin (ClickUp)
// ou em fatias (Supabase) entre os operadores da rodada (D6); sem a flag,
// cai no fallback single-operator LOTE_OPERADOR_DEFAULT. Se QUALQUER operador
// não resolver o memberId (via DISCADOR_ASSIGNEES), a execução real PARA
// ANTES DE ESCREVER; em --dry-run segue com um assignee de exemplo '0' só
// para o preview.
//
// Backend REST direto (via clickup.ts, token .env) — mesmo choke point de
// escrita usado pelo resto do projeto (D-07: custom fields sempre por field-id).
//
// LGPD: logs só imprimem contagens/nome/nome-do-operador — telefone SEMPRE
// mascarado (mascararTelefone), nunca CPF (a skill não lê/escreve o CPF do
// lead — dossiê é read-only), token do ClickUp nunca aparece em log/erro.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  listarTasks,
  criarTask,
  atualizarTask,
  setCustomField,
  CLICKUP_LIST_LEADS,
  CLICKUP_LIST_LIGACOES,
  CAMPOS_LEADS,
  CAMPOS_LIGACOES,
} from '../src/mastra/clickup.ts';
import {
  parseLeadDaTask,
  montarTaskLigacao,
  montarPromptScript,
  deveCriar,
  filtrarLeadsPorTelefones,
  filtrarTasksPorTag,
  selecionarPorQuantidade,
  distribuirRoundRobin,
} from '../src/mastra/lote.ts';
import { assigneeDoOperador } from '../src/mastra/operadores.ts';
import {
  LOTE_TAMANHO_DEFAULT,
  FONTE_LEADS,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUPABASE_TABLE_LIGACOES,
  SUPABASE_TABLE_LEADS_ESPELHO,
  SUPABASE_RPC_GERAR_LOTE,
} from '../src/mastra/config.ts';
import { mascararTelefone } from '../src/mastra/mascarar.ts';
import { fetchTimeout } from '../src/mastra/http.ts';
import { comOutboxRpc } from '../src/mastra/outbox-rpc.ts';
import { selecionarLoteElegiveisSupabase } from '../src/mastra/supabase.ts';
import { chamarLLM } from '../src/mastra/llm.ts';
import { enfileirarDrenoOutbox } from '../src/mastra/fila.ts';
import { processarDrenoOutboxJob } from '../src/mastra/drenar-outbox.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const LOTE_TAG_DEFAULT = process.env.LOTE_TAG_DEFAULT || 'lote-hoje';

/** Presença de uma flag booleana/com-valor-opcional em process.argv. */
function flagPresente(nome) {
  return process.argv.includes(nome);
}

/** Valor explícito de uma flag (undefined se a flag não veio, ou veio "bare" seguida de outra flag/fim). */
function lerFlagValor(nome) {
  const idx = process.argv.indexOf(nome);
  if (idx === -1) return undefined;
  const valor = process.argv[idx + 1];
  if (valor === undefined || valor.startsWith('--')) return undefined;
  return valor;
}

function numeroPositivoOuNulo(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Quebra a lista de telefones colados por vírgula, espaço ou quebra de linha. */
function parseTelefonesColados(raw) {
  return raw
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Resolve o modo de seleção (D4, exatamente UM obrigatório) e os parâmetros
 * necessários. LANÇA (falha-claro, antes de tocar o ClickUp) se nenhum modo
 * ou mais de um modo foi passado, ou se --telefones veio sem nenhum telefone.
 */
function resolverModoSelecao() {
  const temTelefones = flagPresente('--telefones');
  const temTag = flagPresente('--tag');
  const temTamanho = flagPresente('--tamanho');
  const ativos = [temTelefones, temTag, temTamanho].filter(Boolean).length;

  if (ativos !== 1) {
    throw new Error(
      '[gerar-lote] escolha EXATAMENTE um modo de seleção: --telefones "<lista>", --tag [nome] ou --tamanho N ' +
        `(recebido: ${ativos} modo(s)).`,
    );
  }

  if (temTelefones) {
    const raw = lerFlagValor('--telefones');
    const telefonesColados = raw ? parseTelefonesColados(raw) : [];
    if (telefonesColados.length === 0) {
      throw new Error('[gerar-lote] --telefones veio sem nenhum telefone — passe uma lista separada por vírgula/espaço.');
    }
    return { modo: 'telefones', telefonesColados };
  }

  if (temTag) {
    const tagNome = lerFlagValor('--tag') || LOTE_TAG_DEFAULT;
    return { modo: 'tag', tagNome };
  }

  const tamanho = numeroPositivoOuNulo(lerFlagValor('--tamanho')) ?? LOTE_TAMANHO_DEFAULT;
  return { modo: 'tamanho', tamanho };
}

/** Lê o arquivo .md do roteiro (D3) — LANÇA claro se ausente/vazio, antes de tocar o ClickUp. */
function lerScriptDoArquivo() {
  const caminho = lerFlagValor('--script');
  if (!caminho) {
    throw new Error('[gerar-lote] --script <caminho.md> é obrigatório — o roteiro que o gestor escreveu para esta rodada.');
  }
  let conteudo;
  try {
    conteudo = readFileSync(caminho, 'utf8');
  } catch (e) {
    throw new Error(`[gerar-lote] não foi possível ler o arquivo de script "${caminho}": ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!conteudo.trim()) {
    throw new Error(`[gerar-lote] o arquivo de script "${caminho}" está vazio — escreva o roteiro antes de rodar o lote.`);
  }
  return conteudo;
}

/**
 * Resolve a lista de operadores da rodada (D6): `--operadores nome1,nome2,...`
 * ou o fallback single-operator `LOTE_OPERADOR_DEFAULT` sem a flag. Cada nome
 * resolve para memberId via `assigneeDoOperador`. GUARD: se QUALQUER nome não
 * resolver, em execução real LANÇA (para antes de escrever); em --dry-run
 * segue com assignee de exemplo '0' só para os não resolvidos (preview).
 */
function resolverOperadores() {
  const raw = lerFlagValor('--operadores');
  let nomes = raw
    ? raw.split(',').map((v) => v.trim()).filter(Boolean)
    : [];
  if (nomes.length === 0) nomes = [process.env.LOTE_OPERADOR_DEFAULT || ''];

  const resolvidos = nomes.map((nome) => ({ nome, assigneeId: assigneeDoOperador(nome) }));
  const naoResolvidos = resolvidos.filter((op) => !op.assigneeId).map((op) => op.nome || '(vazio)');

  if (naoResolvidos.length > 0) {
    const mensagem =
      `[gerar-lote] não foi possível resolver o memberId do(s) operador(es): ${naoResolvidos.join(', ')} — ` +
      'configure DISCADOR_ASSIGNEES ("usuario:memberId,...") no .env.';
    if (DRY_RUN) {
      console.warn(`${mensagem}\n(preview segue com assignee de exemplo '0' para os não resolvidos — nada será escrito.)`);
      return resolvidos.map((op) => ({ nome: op.nome, assigneeId: op.assigneeId ?? '0' }));
    }
    throw new Error(mensagem);
  }

  return resolvidos;
}

/** Pagina uma lista inteira do ClickUp (listarTasks LANÇA em falha — WR-03, nunca fila vazia silenciosa). */
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

// ===== Caminho FONTE_LEADS=supabase (LEITURA-06) — sem paginar a Lista 01 =====

/**
 * Divide `tamanho` em fatias quase-iguais entre `numOperadores` (D6): a RPC
 * `gerar_lote` faz a SELEÇÃO server-side (não aceita uma lista explícita de
 * leads para alternar por-lead como `distribuirRoundRobin` faz no caminho
 * ClickUp) — a fatia por-operador é o equivalente possível preservando "todo
 * operador da rodada recebe uma parte do lote". Pura e determinística —
 * primeiros `tamanho % numOperadores` operadores recebem +1. Exportada só
 * para o smoke provar a distribuição sem tocar rede.
 */
export function distribuirTamanhoPorOperador(tamanho, numOperadores) {
  if (!numOperadores || numOperadores <= 0) {
    throw new Error('distribuirTamanhoPorOperador: nenhum operador para distribuir o lote');
  }
  const base = Math.floor(tamanho / numOperadores);
  const resto = tamanho % numOperadores;
  return Array.from({ length: numOperadores }, (_, i) => base + (i < resto ? 1 : 0));
}

/** URL REST do Supabase para uma tabela — mesmo molde de `SUPABASE_REST_URL` (supabase.ts). */
function supabaseRestUrl(tabela) {
  if (!SUPABASE_URL) {
    throw new Error('[gerar-lote] SUPABASE_URL ausente — não dá para ler/escrever no Supabase (FONTE_LEADS=supabase)');
  }
  return `${SUPABASE_URL}/rest/v1/${tabela}`;
}

/** Headers PostgREST — mesmo molde de `headers()` (supabase.ts), duplicado de propósito
 *  (par pequeno demais pra justificar importar o módulo maior neste runner). */
function supabaseHeaders(extra = {}) {
  if (!SUPABASE_SERVICE_KEY) {
    throw new Error('[gerar-lote] SUPABASE_SERVICE_KEY ausente — não dá para autenticar no Supabase (FONTE_LEADS=supabase)');
  }
  return { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', ...extra };
}

/**
 * Lê as `ligacoes` que ESTE lote acabou de criar e ainda não têm roteiro
 * (`gerar_lote` sempre grava `script=null`, 20-03) — filtra por
 * `origem='lote'` + `lote_data` (hoje) + `operador IN (...)` + `script IS
 * NULL`. Preview/paridade de teste não se aplica aqui (diferente de
 * `selecionarLoteElegiveisSupabase`): esta leitura serve o PÓS-INSERT real.
 * LANÇA em config ausente/erro de rede/HTTP (WR-03).
 */
async function buscarLigacoesLoteSemScript({ operadores, loteData }) {
  const params = new URLSearchParams({
    select: 'id,lead_id,clickup_task_id',
    origem: 'eq.lote',
    lote_data: `eq.${loteData}`,
    script: 'is.null',
  });
  if (operadores.length > 0) {
    params.set('operador', `in.(${operadores.map((nome) => `"${nome}"`).join(',')})`);
  }
  let res;
  try {
    res = await fetchTimeout(`${supabaseRestUrl(SUPABASE_TABLE_LIGACOES)}?${params.toString()}`, { headers: supabaseHeaders() });
  } catch (e) {
    throw new Error(`[gerar-lote] falha de rede ao ler ligações recém-criadas do lote: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[gerar-lote] HTTP ${res.status} ao ler ligações recém-criadas do lote`);
  }
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map((r) => ({
    id: Number(r.id),
    leadId: r.lead_id !== null && r.lead_id !== undefined ? Number(r.lead_id) : null,
    clickupTaskId: r.clickup_task_id ?? null,
  }));
}

/** Resolve os leads (por `id`, chave numérica do 20-01) das ligações recém-criadas — em lote (1 GET, `in.(...)`). */
async function buscarLeadsPorId(ids) {
  if (ids.length === 0) return [];
  const params = new URLSearchParams({
    select: 'id,clickup_task_id,nome,telefone,score,tentativas,retorno_necessario',
    id: `in.(${ids.join(',')})`,
  });
  let res;
  try {
    res = await fetchTimeout(`${supabaseRestUrl(SUPABASE_TABLE_LEADS_ESPELHO)}?${params.toString()}`, { headers: supabaseHeaders() });
  } catch (e) {
    throw new Error(`[gerar-lote] falha de rede ao ler os leads do lote: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[gerar-lote] HTTP ${res.status} ao ler os leads do lote`);
  }
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map((r) => ({
    id: Number(r.id),
    clickupTaskId: String(r.clickup_task_id ?? ''),
    nome: String(r.nome ?? ''),
    telefone: String(r.telefone ?? ''),
    score: Number(r.score ?? 0),
    tentativas: Number(r.tentativas ?? 0),
    retornoNecessario: Boolean(r.retorno_necessario),
  }));
}

/** Grava o roteiro materializado direto em `ligacoes.script` — PATCH PostgREST best-effort
 *  (molde `marcarSuperFaEspelho`, supabase.ts): mutação secundária, fora do both-or-neither
 *  transacional do INSERT original (débito assumido no 20-03/20-06 — ver header do arquivo). */
async function patchScriptLigacao(id, script) {
  let res;
  try {
    res = await fetchTimeout(`${supabaseRestUrl(SUPABASE_TABLE_LIGACOES)}?id=eq.${id}`, {
      method: 'PATCH',
      headers: supabaseHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ script }),
    });
  } catch (e) {
    throw new Error(`[gerar-lote] falha de rede ao gravar o roteiro da ligação ${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[gerar-lote] HTTP ${res.status} ao gravar o roteiro da ligação ${id}`);
  }
}

/** Kick do dreno CHECADO (nunca fire-and-forget) — mesmo padrão de `posCommitLigacao`
 *  (index.ts, processador.ts, 19-07/08/19-13): sem Redis, drena inline aqui mesmo. */
async function kickDrenoLigacao(ligacaoId) {
  const { enfileirado } = await enfileirarDrenoOutbox({ aggregateId: ligacaoId });
  if (!enfileirado) {
    await processarDrenoOutboxJob(ligacaoId).catch((e) => {
      console.warn(
        '  [aviso] dreno inline pós-lote falhou (best-effort — a linha do outbox já foi persistida, drena depois):',
        e instanceof Error ? e.message : String(e),
      );
    });
  }
  return { enfileirado };
}

/**
 * Best-effort: só reflete o roteiro na `description` da task ClickUp quando o
 * dreno JÁ resolveu `clickup_task_id` NESTA MESMA passada (caminho inline,
 * sem Redis — `kickDrenoLigacao` acima roda `criar_task` sincronamente). Com
 * Redis (worker assíncrono) o back-fill acontece depois, fora desta janela —
 * a task nasce sem description e o roteiro fica disponível em
 * `ligacoes.script` (a fonte de leitura sob `FONTE_LIGACOES=supabase`, 19-09)
 * até uma sincronização futura ecoar de volta (débito documentado, nunca
 * bloqueia o lote). NUNCA lança — puramente best-effort.
 */
async function atualizarDescricaoTaskSeResolvida(ligacaoId, script) {
  try {
    const res = await fetchTimeout(
      `${supabaseRestUrl(SUPABASE_TABLE_LIGACOES)}?id=eq.${ligacaoId}&select=clickup_task_id`,
      { headers: supabaseHeaders() },
    );
    if (!res.ok) return;
    const data = await res.json();
    const clickupTaskId = Array.isArray(data) ? data[0]?.clickup_task_id : undefined;
    if (!clickupTaskId) return;
    await atualizarTask(clickupTaskId, { description: script });
  } catch (e) {
    console.warn(
      '  [aviso] não foi possível refletir o roteiro na description da task ClickUp (best-effort):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Materializa o roteiro (Agente Script, `montarPromptScript`+`chamarLLM`) de
 * cada ligação recém-criada sem `script` — PostgREST direto (débito herdado
 * do 20-03: `gerar_lote` grava `script=null`). Falha em UM lead NUNCA aborta
 * os demais nem o lote em si (a Ligação já foi criada — core value); conta
 * `scriptsFalhos` e segue. Deps injetáveis (seam de teste offline).
 */
async function materializarScriptsDoLote({ operadores, loteData, deps = {} }) {
  const buscarLigacoes = deps.buscarLigacoesLoteSemScript ?? buscarLigacoesLoteSemScript;
  const buscarLeads = deps.buscarLeadsPorId ?? buscarLeadsPorId;
  const gerarScript = deps.chamarLLM ?? chamarLLM;
  const patch = deps.patchScriptLigacao ?? patchScriptLigacao;
  const kick = deps.kickDrenoLigacao ?? kickDrenoLigacao;
  const atualizar = deps.atualizarDescricaoTaskSeResolvida ?? atualizarDescricaoTaskSeResolvida;

  if (operadores.length === 0) return { scriptsGerados: 0, scriptsFalhos: 0 };

  const ligacoes = await buscarLigacoes({ operadores, loteData });
  if (ligacoes.length === 0) return { scriptsGerados: 0, scriptsFalhos: 0 };

  const leadIds = [...new Set(ligacoes.map((l) => l.leadId).filter((id) => id !== null))];
  const leads = await buscarLeads(leadIds);
  const leadPorId = new Map(leads.map((l) => [l.id, l]));

  let scriptsGerados = 0;
  let scriptsFalhos = 0;
  for (const ligacao of ligacoes) {
    const lead = leadPorId.get(ligacao.leadId);
    if (!lead) {
      scriptsFalhos += 1;
      console.warn(`  [aviso] ligação ${ligacao.id}: lead_id ${ligacao.leadId} não resolvido no espelho — roteiro não gerado.`);
      continue;
    }
    const leadLote = {
      taskId: lead.clickupTaskId,
      idLead: '',
      nome: lead.nome,
      telefone: lead.telefone,
      score: lead.score,
      tentativas: lead.tentativas,
      proximoContato: null,
      retornoNecessario: lead.retornoNecessario,
    };
    try {
      const { system, prompt } = montarPromptScript(leadLote);
      const script = await gerarScript(prompt, system);
      await patch(ligacao.id, script);
      scriptsGerados += 1;
      await kick(ligacao.id);
      await atualizar(ligacao.id, script);
    } catch (e) {
      scriptsFalhos += 1;
      console.warn(
        `  [aviso] ligação ${ligacao.id}: falha ao gerar/materializar o roteiro (script fica null, pode ser regenerado depois): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { scriptsGerados, scriptsFalhos };
}

/**
 * Caminho `FONTE_LEADS=supabase` (LEITURA-06): NÃO pagina a Lista 01 — chama
 * a RPC `gerar_lote` (SQL faz a seleção+INSERT+outbox atomicamente, 20-03)
 * uma vez por operador da rodada (fatia de `tamanho`, D6,
 * `distribuirTamanhoPorOperador`), depois materializa os roteiros
 * (`materializarScriptsDoLote`). `--dry-run` só faz o PREVIEW via
 * `selecionarLoteElegiveisSupabase` (20-04) — nada é escrito. Deps injetáveis
 * (seam de teste offline — `scripts/gerar-lote-supabase.smoke.mjs`).
 */
export async function gerarLoteSupabase({ operadores, tamanho, loteData, dryRun = false, deps = {} }) {
  const rpc = deps.comOutboxRpc ?? comOutboxRpc;
  const preview = deps.selecionarLoteElegiveisSupabase ?? selecionarLoteElegiveisSupabase;

  if (dryRun) {
    const elegiveis = await preview(tamanho);
    console.log(`  [dry-run][supabase] ${elegiveis.length} lead(s) elegível(is) no preview (nada será escrito).`);
    return { criadas: 0, outboxInseridos: 0, scriptsGerados: 0, scriptsFalhos: 0, falhasRpc: 0 };
  }

  const fatias = distribuirTamanhoPorOperador(tamanho, operadores.length);
  let criadas = 0;
  let outboxInseridos = 0;
  let falhasRpc = 0;

  for (let i = 0; i < operadores.length; i++) {
    const fatia = fatias[i];
    if (fatia <= 0) continue;
    const operador = operadores[i];
    try {
      const resultado = (await rpc(SUPABASE_RPC_GERAR_LOTE, {
        p_operador: operador.nome,
        p_assignee_clickup_id: Number(operador.assigneeId),
        p_tamanho: fatia,
        p_lote_data: loteData,
      })) ?? {};
      criadas += Number(resultado.criadas ?? 0);
      outboxInseridos += Number(resultado.outbox_inseridos ?? 0);
      console.log(
        `  gerar_lote (operador "${operador.nome}", fatia ${fatia}) -> ${resultado.criadas ?? 0} criada(s), ${resultado.outbox_inseridos ?? 0} linha(s) de outbox.`,
      );
    } catch (e) {
      falhasRpc += 1;
      console.error(
        `  [erro] gerar_lote falhou para o operador "${operador.nome}" (fatia ${fatia}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const { scriptsGerados, scriptsFalhos } = await materializarScriptsDoLote({
    operadores: operadores.map((o) => o.nome),
    loteData,
    deps,
  });

  return { criadas, outboxInseridos, scriptsGerados, scriptsFalhos, falhasRpc };
}

async function main() {
  console.log('=== Gerar lote diário (RomeroCall — skill gerar-lote-diario) ===');
  if (DRY_RUN) console.log('(modo --dry-run: nada será escrito — só imprime o preview)');

  // Passo 1: resolver modo de seleção + resolver a lista de operadores —
  // tudo isso ANTES de tocar o ClickUp/Supabase (falha-claro barato, sem
  // gastar uma chamada de rede à toa).
  const selecao = resolverModoSelecao();
  const operadores = resolverOperadores();

  if (FONTE_LEADS === 'supabase') {
    // LEITURA-06 (20-06): a seleção priorizada automática é a que gerar_lote
    // reproduz por SQL — --telefones/--tag dependem de dado só disponível no
    // ClickUp (tag nativa da task / telefone colado contra a Lista 01
    // inteira), então ficam restritos ao caminho ClickUp (documentado no
    // header do arquivo).
    if (selecao.modo !== 'tamanho') {
      throw new Error(
        `[gerar-lote] FONTE_LEADS=supabase só suporta o modo de seleção --tamanho N (a seleção priorizada é a que ` +
          `gerar_lote reproduz por SQL, LEITURA-06) — --telefones/--tag dependem de dado só disponível no ClickUp; ` +
          'rode com FONTE_LEADS=clickup para usá-los.',
      );
    }
    console.log(
      `Modo de seleção: tamanho (FONTE_LEADS=supabase, sem paginar a Lista 01). Operador(es) da rodada: ` +
        `${operadores.map((o) => o.nome || '(vazio)').join(', ')}.`,
    );
    const loteData = new Date().toISOString().slice(0, 10);
    const resultado = await gerarLoteSupabase({
      operadores,
      tamanho: selecao.tamanho,
      loteData,
      dryRun: DRY_RUN,
    });
    console.log(
      `\n=== Resumo (supabase): ${resultado.criadas} ligação(ões) criada(s), ${resultado.outboxInseridos} linha(s) de outbox, ` +
        `${resultado.scriptsGerados} roteiro(s) gerado(s), ${resultado.scriptsFalhos} roteiro(s) pendente(s) (falha — pode ` +
        `ser regenerado depois), ${resultado.falhasRpc} falha(s) de RPC. ===`,
    );
    process.exit(resultado.falhasRpc > 0 ? 1 : 0);
    return;
  }

  // ===== Caminho FONTE_LEADS=clickup (default) — comportamento de hoje =====
  const scriptDoArquivo = lerScriptDoArquivo();
  console.log(
    `Modo de seleção: ${selecao.modo}. Operador(es) da rodada: ${operadores.map((o) => o.nome || '(vazio)').join(', ')}.`,
  );

  // Passo 2: ler a Lista 01 LEADS paginada.
  console.log(`Lendo Lista 01 LEADS (lista ${CLICKUP_LIST_LEADS})...`);
  const tasksLeads = await lerTodasAsTasks(CLICKUP_LIST_LEADS);
  console.log(`  ${tasksLeads.length} lead(s) lido(s) da Lista 01 (contagem apenas, sem PII).`);

  // Passo 4 (adiantado para servir de insumo ao modo "quantidade"): ler as
  // Ligações ABERTAS da Lista 02 para o dedupe (D5, universal aos 3 modos).
  console.log(`Lendo Ligações ABERTAS da Lista 02 (lista ${CLICKUP_LIST_LIGACOES}) para o dedupe...`);
  const ligacoesAbertas = await lerTodasAsTasks(CLICKUP_LIST_LIGACOES, { includeClosed: false });
  console.log(`  ${ligacoesAbertas.length} Ligação(ões) aberta(s) encontrada(s).`);

  // Passo 3: aplicar o modo de seleção escolhido para obter os LeadLote candidatos.
  let candidatos;
  if (selecao.modo === 'telefones') {
    const leads = tasksLeads.map((task) => parseLeadDaTask(task, CAMPOS_LEADS));
    candidatos = filtrarLeadsPorTelefones(leads, selecao.telefonesColados);
  } else if (selecao.modo === 'tag') {
    const tasksFiltradas = filtrarTasksPorTag(tasksLeads, selecao.tagNome);
    candidatos = tasksFiltradas.map((task) => parseLeadDaTask(task, CAMPOS_LEADS));
  } else {
    const leads = tasksLeads.map((task) => parseLeadDaTask(task, CAMPOS_LEADS));
    candidatos = selecionarPorQuantidade(leads, selecao.tamanho, ligacoesAbertas, CAMPOS_LIGACOES.ID_LEAD);
  }
  console.log(`Seleção "${selecao.modo}": ${candidatos.length} lead(s) candidato(s).`);

  // Passo 5: dedupe universal (D5/deveCriar) — para o modo "quantidade" já
  // veio deduplicado (selecionarPorQuantidade reusa deveCriar internamente);
  // para "telefones"/"tag" é aqui que o dedupe efetivamente acontece.
  const elegiveisParaCriar = candidatos.filter((lead) => deveCriar(lead, ligacoesAbertas, CAMPOS_LIGACOES.ID_LEAD));
  const puladosPorDedupe = candidatos.length - elegiveisParaCriar.length;
  console.log(
    `A processar: ${elegiveisParaCriar.length} lead(s) novo(s) (${puladosPorDedupe} pulado(s) — já tem Ligação aberta, dedupe D5).`,
  );

  // Passo 6: distribuir os leads elegíveis entre os operadores da rodada (D6).
  const pares = distribuirRoundRobin(elegiveisParaCriar, operadores);

  let criadas = 0;
  let falhas = 0;

  for (const { lead, operador } of pares) {
    const identificador = `${lead.nome || '(sem nome)'} (${mascararTelefone(lead.telefone)})`;
    try {
      if (DRY_RUN) {
        console.log(`  [dry-run] ${identificador} -> operador "${operador.nome}"; Ligação seria criada com o script do arquivo, nada escrito.`);
        continue;
      }

      const payload = montarTaskLigacao(lead, scriptDoArquivo, operador.assigneeId, CAMPOS_LIGACOES);
      const novaTask = await criarTask(CLICKUP_LIST_LIGACOES, payload);
      if (!novaTask?.id) {
        throw new Error('criarTask retornou sem id — não dá para vincular LEAD_REL');
      }

      try {
        await setCustomField(novaTask.id, CAMPOS_LIGACOES.LEAD_REL, { add: [lead.taskId] });
      } catch (e) {
        // D-P2-06/open_decisions: se o shape do relationship falhar, seguir —
        // ID_LEAD já foi gravado no payload, o vínculo textual não se perde.
        console.warn(
          `  [aviso] Ligação criada (${novaTask.id}) mas LEAD_REL não foi setado: ${e instanceof Error ? e.message : String(e)} ` +
            '(ID_LEAD já gravado — vínculo textual mantido).',
        );
      }

      console.log(`  Ligação criada para ${identificador} (operador "${operador.nome}") -> task ${novaTask.id}`);
      criadas += 1;
    } catch (e) {
      // T-02-02-E: nunca colapsar erro em sucesso silencioso — reporta e conta a falha.
      falhas += 1;
      console.error(
        `  [erro] falha ao criar Ligação para ${identificador} (operador "${operador.nome}"): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  console.log(`\n=== Resumo: ${criadas} criada(s), ${falhas} falha(s), ${puladosPorDedupe} pulada(s) por dedupe. ===`);
  process.exit(falhas > 0 ? 1 : 0);
}

// Só auto-executa quando rodado diretamente (`node scripts/gerar-lote.mjs`) —
// nunca ao ser IMPORTADO (ex.: `scripts/gerar-lote-supabase.smoke.mjs`
// importa `gerarLoteSupabase`/`distribuirTamanhoPorOperador` deste mesmo
// arquivo). `pathToFileURL` (não uma comparação de string crua) porque o
// caminho do repo pode ter espaços/caracteres especiais — comparação de
// string com `file://${process.argv[1]}` quebraria nesse caso.
const ehExecucaoDireta = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (ehExecucaoDireta) {
  main().catch((e) => {
    const mensagem = e instanceof Error ? e.message : String(e);
    console.error(`\n=== FALHA ao gerar o lote — ${mensagem} ===`);
    process.exit(1);
  });
}
