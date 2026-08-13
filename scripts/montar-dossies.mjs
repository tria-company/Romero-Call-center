#!/usr/bin/env node
// scripts/montar-dossies.mjs
//
// Runner avulso do "Dossiê 360°" — Fase 1 "Contexto" do board do Miro (DOSS-AVULSO-01):
// monta o Dossiê 360° dos leads da Lista 01 (LEADS) do ClickUp (Supabase
// militante/follow-ups + GHL conversas WhatsApp/oportunidades + histórico
// RomeroCall quando houver) e grava na descrição da task do lead — SEM criar
// Ligações na Lista 02 e SEM passar pela elegibilidade/priorização do lote
// (isso é `gerar-lote.mjs`). Reusa o mesmo bloco de coleta+montagem+gravação
// de `gerar-lote.mjs` (`montarDossieDoLead`), só isolado da seleção de lote.
//
// Uso:
//   node --env-file=.env --experimental-strip-types scripts/montar-dossies.mjs [--dry-run] [--tamanho N] [--lead <taskId>] [--forcar]
//
//   --dry-run        monta o dossiê com o LLM real e imprime preview (tamanho
//                     + seções degradadas), mas NÃO escreve no ClickUp.
//   --tamanho N       limita quantos leads processar nesta rodada; sem a
//                     flag, processa TODOS os que passarem no filtro. Como
//                     não há priorização/elegibilidade de lote aqui, o corte
//                     é simplesmente os primeiros N na ordem retornada por
//                     lerTodasAsTasks — sem priorização, intencional.
//   --lead <taskId>   processa só essa task da Lista 01 (ignora --tamanho).
//   --forcar          remonta o dossiê mesmo de quem já tem (pula o filtro
//                     de detecção "já tem dossiê").
//
// Default (sem --forcar): só processa leads cuja descrição AINDA NÃO contém
// o marcador do dossiê (título da seção 1 do modelo do Miro, "Perfil e
// classificação" — emitido por `montarPromptDossie` e gravado na description
// por este runner/gerar-lote.mjs).
//
// LGPD (T-DA-01): logs só imprimem contagens/ids/nome — telefone SEMPRE
// mascarado (mascararTelefone), CPF NUNCA aparece em log (nem mascarado), o
// token do ClickUp/Supabase nunca aparece em mensagem de log/erro.

import {
  listarTasks,
  lerTask,
  CAMPOS_LEADS,
  CLICKUP_LIST_LEADS,
} from '../src/mastra/clickup.ts';
import { parseLeadDaTask } from '../src/mastra/lote.ts';
// Fonte ÚNICA da geração do dossiê — a orquestração gather+build+write
// (antes duplicada aqui em `montarDossieDoLead`) mora agora no módulo app
// compartilhado, reusado também pelo processador (pós-ligação).
import { regenerarDossieDoLead } from '../src/mastra/gerar-dossie.ts';
import { mascararTelefone } from '../src/mastra/mascarar.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const FORCAR = process.argv.includes('--forcar');

/** Marcador de "já tem dossiê" — título da seção 1 emitido por `montarPromptDossie`. */
const MARCADOR_DOSSIE = 'Perfil e classificação';

function lerTamanhoArgv() {
  const idx = process.argv.indexOf('--tamanho');
  if (idx === -1) return null; // sem default implícito — processa todos os que passarem no filtro.
  const valor = Number(process.argv[idx + 1]);
  return Number.isFinite(valor) && valor > 0 ? valor : null;
}

function lerLeadArgv() {
  const idx = process.argv.indexOf('--lead');
  if (idx === -1) return null;
  const taskId = process.argv[idx + 1];
  return taskId && !taskId.startsWith('--') ? taskId : null;
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

/** `true` se a descrição (não-vazia) já contém o marcador do dossiê (case-insensitive). */
function jaTemDossie(descricao) {
  if (!descricao) return false;
  return descricao.toLowerCase().includes(MARCADOR_DOSSIE.toLowerCase());
}

async function main() {
  const tamanho = lerTamanhoArgv();
  const leadIdArgv = lerLeadArgv();

  console.log('=== Montar dossiês avulso (RomeroCall — Fase 1 Contexto) ===');
  if (DRY_RUN) console.log('(modo --dry-run: nada será escrito no ClickUp — só monta o dossiê em memória)');

  let tasksLeads;
  if (leadIdArgv) {
    console.log(`Lendo a task ${leadIdArgv} (--lead)...`);
    const taskLead = await lerTask(leadIdArgv);
    if (!taskLead) {
      throw new Error(`[montar-dossies] task ${leadIdArgv} não encontrada (--lead)`);
    }
    tasksLeads = [taskLead];
  } else {
    console.log(`Lendo Lista 01 LEADS (lista ${CLICKUP_LIST_LEADS})...`);
    tasksLeads = await lerTodasAsTasks(CLICKUP_LIST_LEADS);
    console.log(`  ${tasksLeads.length} lead(s) lido(s) da Lista 01 (contagem apenas, sem PII).`);
  }

  // Mapa taskId -> TaskClickUp bruta (Lista 01 já carregada) — usado pelo
  // dossiê pra ler CPF/ID_SUPABASE/OBSERVACAO_CONSOLIDADA/ULTIMO_RESULTADO por
  // field-id (D-P4-03), sem reler a task da API.
  const mapaTasksLeads = new Map(tasksLeads.map((task) => [task.id, task]));
  const leads = tasksLeads.map((task) => parseLeadDaTask(task, CAMPOS_LEADS));

  let pulados = 0;
  let candidatos = leads;

  if (!FORCAR) {
    candidatos = [];
    for (const lead of leads) {
      const task = mapaTasksLeads.get(lead.taskId);
      let descricao = task?.description || task?.text_content || '';
      // `listarTasks` pode não trazer a description — refazer a checagem com
      // `lerTask` (autoritativa) SÓ quando ela veio vazia e não estamos no
      // caminho --lead (a description já veio autoritativa do lerTask inicial).
      if (!descricao && !leadIdArgv) {
        const taskCompleta = await lerTask(lead.taskId);
        descricao = taskCompleta?.description || taskCompleta?.text_content || '';
      }
      if (jaTemDossie(descricao)) {
        pulados += 1;
      } else {
        candidatos.push(lead);
      }
    }
  }

  if (!leadIdArgv && tamanho !== null) {
    candidatos = candidatos.slice(0, tamanho);
  }

  console.log(
    `A processar: ${candidatos.length} lead(s)` +
      (FORCAR ? ' (--forcar: filtro de dossiê existente ignorado).' : ` (${pulados} pulado(s) — já tinham dossiê).`),
  );

  let montados = 0;
  let falhas = 0;

  for (const lead of candidatos) {
    const identificador = `${lead.nome || '(sem nome)'} (${mascararTelefone(lead.telefone)})`;
    try {
      // Fonte única: delega gather+build+write ao módulo compartilhado.
      // CAVEATS aceitos (fonte única > microtrade-off): (a) a fn re-lê a task
      // por taskId (1 lerTask extra por lead — o runner já a tinha em
      // mapaTasksLeads); (b) o log de --dry-run reporta o TAMANHO do markdown,
      // não mais a lista por-seção de "seções degradadas" — a degradação POR
      // FONTE continua idêntica, só o detalhamento do log foi simplificado.
      const md = await regenerarDossieDoLead(lead.taskId, { dryRun: DRY_RUN });
      if (md) {
        console.log(
          DRY_RUN
            ? `  [dry-run] dossiê de ${identificador} montado em memória (${md.length} caractere(s)) — não gravado.`
            : `  Dossiê montado para ${identificador}.`,
        );
        montados += 1;
      } else {
        console.warn(`  [aviso] dossiê de ${identificador} não gerado (LLM vazio) — description preservada.`);
        falhas += 1;
      }
    } catch (e) {
      // T-DA-03: nunca colapsar erro em sucesso silencioso — reporta e conta a falha.
      falhas += 1;
      console.warn(`  [aviso] falha ao montar/gravar o dossiê de ${identificador}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\n=== Resumo: ${montados} montado(s), ${falhas} falha(s), ${pulados} pulado(s) (já tinham dossiê). ===`);
  process.exit(falhas > 0 ? 1 : 0);
}

main().catch((e) => {
  const mensagem = e instanceof Error ? e.message : String(e);
  console.error(`\n=== FALHA ao montar dossiês — ${mensagem} ===`);
  process.exit(1);
});
