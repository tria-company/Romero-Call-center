#!/usr/bin/env node
// scripts/gerar-lote.mjs
//
// Runner impuro da skill "gerar-lote-diario", ClickUp-only (Quick 260815-hea,
// decisões travadas D1-D6): a Lista 01 (LEADS) já vem preenchida à mão pelo
// gestor; este runner faz SELEÇÃO EXPLÍCITA (um dos 3 modos abaixo) ->
// DISTRIBUI em round-robin entre os operadores da rodada (D6) -> cria uma
// Ligação por lead na Lista 02 (LIGACOES) com o roteiro que o gestor escreveu
// num arquivo .md (D3). Não lê nenhuma fonte externa, não gera nada por conta
// própria: nem prioriza, nem escreve na descrição do lead (D2 — o dossiê é
// read-only, quem digita é o gestor).
//
// Uso:
//   node --env-file=.env --experimental-strip-types scripts/gerar-lote.mjs \
//     (--telefones "<lista>" | --tag [nome] | --tamanho N) \
//     --script <caminho.md> [--operadores nome1,nome2,...] [--dry-run]
//
// Modos de seleção (D4, exatamente UM é obrigatório):
//   --telefones "<lista>"  casa cada telefone colado (vírgula/espaço/quebra
//                          de linha) contra a Lista 01, via filtrarLeadsPorTelefones.
//   --tag [nome]           puxa só os leads marcados com a tag do ClickUp
//                          (default "lote-hoje" ou LOTE_TAG_DEFAULT).
//   --tamanho N            pega os primeiros N leads em ordem de lista (sem
//                          scoring/priorização — sem N usa LOTE_TAMANHO_DEFAULT).
//
// --script <caminho.md> é OBRIGATÓRIA: o texto do arquivo vira a description
// de TODAS as Ligações criadas nesta execução (D3, script único do dia).
//
// --operadores nome1,nome2,... distribui as Ligações em round-robin entre os
// operadores da rodada (D6); sem a flag, cai no fallback single-operator
// LOTE_OPERADOR_DEFAULT. Se QUALQUER operador não resolver o memberId (via
// DISCADOR_ASSIGNEES), a execução real PARA ANTES DE ESCREVER; em --dry-run
// segue com um assignee de exemplo '0' só para o preview.
//
// Backend REST direto (via clickup.ts, token .env) — mesmo choke point de
// escrita usado pelo resto do projeto (D-07: custom fields sempre por field-id).
//
// LGPD: logs só imprimem contagens/nome/nome-do-operador — telefone SEMPRE
// mascarado (mascararTelefone), nunca CPF (a skill não lê/escreve o CPF do
// lead — dossiê é read-only), token do ClickUp nunca aparece em log/erro.

import { readFileSync } from 'node:fs';
import {
  listarTasks,
  criarTask,
  setCustomField,
  CLICKUP_LIST_LEADS,
  CLICKUP_LIST_LIGACOES,
  CAMPOS_LEADS,
  CAMPOS_LIGACOES,
} from '../src/mastra/clickup.ts';
import {
  parseLeadDaTask,
  montarTaskLigacao,
  deveCriar,
  filtrarLeadsPorTelefones,
  filtrarTasksPorTag,
  selecionarPorQuantidade,
  distribuirRoundRobin,
} from '../src/mastra/lote.ts';
import { assigneeDoOperador } from '../src/mastra/operadores.ts';
import { LOTE_TAMANHO_DEFAULT } from '../src/mastra/config.ts';
import { mascararTelefone } from '../src/mastra/mascarar.ts';

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

async function main() {
  console.log('=== Gerar lote diário (RomeroCall — skill gerar-lote-diario, ClickUp-only) ===');
  if (DRY_RUN) console.log('(modo --dry-run: nada será escrito no ClickUp — só imprime o preview)');

  // Passo 1: resolver modo de seleção + ler o arquivo de script + resolver a
  // lista de operadores — tudo isso ANTES de tocar o ClickUp (falha-claro
  // barato, sem gastar uma chamada de rede à toa).
  const selecao = resolverModoSelecao();
  const scriptDoArquivo = lerScriptDoArquivo();
  const operadores = resolverOperadores();
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

main().catch((e) => {
  const mensagem = e instanceof Error ? e.message : String(e);
  console.error(`\n=== FALHA ao gerar o lote — ${mensagem} ===`);
  process.exit(1);
});
