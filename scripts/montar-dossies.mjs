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
  atualizarTask,
  CAMPOS_LEADS,
  CLICKUP_LIST_LEADS,
} from '../src/mastra/clickup.ts';
import { chamarLLM } from '../src/mastra/llm.ts';
import { parseLeadDaTask } from '../src/mastra/lote.ts';
import { montarPromptDossie } from '../src/mastra/dossie.ts';
import { buscarMilitante, listarFollowUps, listarServicosPrestados } from '../src/mastra/supabase.ts';
import { buscarContactIdPorTelefone, buscarConversasWhatsApp, buscarOportunidades } from '../src/mastra/ghl.ts';
import { SUPABASE_COL_ID } from '../src/mastra/config.ts';

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

/** Mascara o telefone (LGPD, T-DA-01) — só os últimos 4 dígitos aparecem. */
function mascararTelefone(telefone) {
  const digitos = String(telefone || '').replace(/\D/g, '');
  if (digitos.length === 0) return '(sem telefone)';
  if (digitos.length <= 4) return `****${digitos}`;
  return `${'*'.repeat(digitos.length - 4)}${digitos.slice(-4)}`;
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

/**
 * Lê um custom field bruto de uma TaskClickUp por field-id (D-07) — usado só
 * para ler CPF/ID_SUPABASE/OBSERVACAO_CONSOLIDADA/ULTIMO_RESULTADO da própria
 * task do lead já carregada (histórico RomeroCall, seções 3/6 do dossiê —
 * D-P4-03). CPF NUNCA é logado por este runner — só usado como chave de
 * identidade para o lookup no Supabase (D-P4-08).
 */
function valorCampoTask(task, fieldId) {
  const campo = task?.custom_fields?.find((c) => c.id === fieldId);
  const v = campo?.value;
  return v === null || v === undefined ? '' : String(v);
}

/** `true` se o valor está ausente/vazio (mesmo racional de statusFonte em dossie.ts, sem importá-lo — só para o log de diagnóstico do dry-run). */
function fonteVaziaOuAusente(valor) {
  if (valor === null || valor === undefined) return true;
  if (Array.isArray(valor)) return valor.length === 0;
  if (typeof valor === 'string') return valor.trim() === '';
  if (typeof valor === 'object') return Object.keys(valor).length === 0;
  return false;
}

/** Lista os rótulos das seções do dossiê que ficaram degradadas (sem dado) — só para o log do --dry-run, nunca imprime CPF/PII. */
function secoesDegradadas(fontes) {
  const rotulos = [];
  if (fonteVaziaOuAusente(fontes.ghlContato)) rotulos.push('contato GHL');
  if (fonteVaziaOuAusente(fontes.supabaseMilitante)) rotulos.push('militante Supabase');
  if (fonteVaziaOuAusente(fontes.ghlOportunidades)) rotulos.push('oportunidades GHL');
  if (fonteVaziaOuAusente(fontes.ghlConversas)) rotulos.push('conversas GHL');
  if (fonteVaziaOuAusente(fontes.supabaseFollowUps)) rotulos.push('follow-ups Supabase');
  if (fonteVaziaOuAusente(fontes.servicosPrestados)) rotulos.push('serviços prestados');
  if (fonteVaziaOuAusente(fontes.observacaoConsolidada) && fonteVaziaOuAusente(fontes.ultimoResultado)) {
    rotulos.push('histórico RomeroCall');
  }
  return rotulos;
}

/** `true` se a descrição (não-vazia) já contém o marcador do dossiê (case-insensitive). */
function jaTemDossie(descricao) {
  if (!descricao) return false;
  return descricao.toLowerCase().includes(MARCADOR_DOSSIE.toLowerCase());
}

/**
 * Reúne as fontes do dossiê de UM lead (GHL + Supabase + histórico
 * RomeroCall, D-P4-04), monta o dossiê via Agente Contexto
 * (`montarPromptDossie` + `chamarLLM`) e grava na descrição da task do lead
 * na Lista 01 (D-P4-01, sobrescreve SEMPRE — D-P4-05).
 *
 * Cada leitura Supabase (buscarMilitante/listarFollowUps — LANÇA, WR-03) é
 * isolada em try/catch local: on-throw, a seção correspondente vira `null`
 * (degradação explícita — D-P4-06), sem abortar a montagem do dossiê deste
 * lead. As leituras GHL de enriquecimento (buscarConversasWhatsApp/
 * buscarOportunidades) já degradam sozinhas (nunca lançam — ghl.ts).
 *
 * `ghlContato` (seção 1/Perfil) é montado a partir do próprio `lead` (nome/
 * telefone), que já reflete o GHL via ID_LEAD_GHL — este runner não chama um
 * endpoint dedicado de "contato" (não existe hoje em ghl.ts; fora do escopo).
 *
 * Em `--dry-run`, monta o dossiê em memória (loga tamanho + seções
 * degradadas) mas NÃO grava (`atualizarTask`).
 */
async function montarDossieDoLead(lead, taskLead, identificador) {
  const cpf = valorCampoTask(taskLead, CAMPOS_LEADS.CPF);
  const idSupabase = valorCampoTask(taskLead, CAMPOS_LEADS.ID_SUPABASE);
  const observacaoConsolidada = valorCampoTask(taskLead, CAMPOS_LEADS.OBSERVACAO_CONSOLIDADA);
  const ultimoResultado = valorCampoTask(taskLead, CAMPOS_LEADS.ULTIMO_RESULTADO);

  // GHL: resolve o contactId uma vez (D-P4-12); sem contactId, conversas/
  // oportunidades ficam indisponíveis (null) — não há como tentar a leitura.
  const contactId = await buscarContactIdPorTelefone(lead.telefone);
  const ghlContato = lead.nome ? { nome: lead.nome, telefone: lead.telefone } : null;
  let ghlConversas = null;
  let ghlOportunidades = null;
  if (contactId) {
    const mensagens = await buscarConversasWhatsApp(contactId);
    ghlConversas = mensagens.length > 0 ? { mensagens } : {};
    ghlOportunidades = await buscarOportunidades(contactId);
  }

  // Supabase: LANÇA em falha de config/infra (WR-03) — converte o throw na
  // degradação de seção que o dossiê exige (D-P4-06), sem abortar o lead.
  const chaveSupabase = {
    idSupabase: idSupabase || undefined,
    cpf: cpf || undefined,
    telefone: lead.telefone || undefined,
  };

  let supabaseMilitante = null;
  try {
    supabaseMilitante = await buscarMilitante(chaveSupabase);
  } catch (e) {
    console.warn(`  [aviso] militante Supabase indisponível para ${identificador}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // refMilitante (CR-02, 04-VERIFICATION.md): a FK correta pra filtrar a seção 5
  // (follow-ups) é o id DO MILITANTE — nunca id/cpf/telefone do lead misturados.
  // Fonte primária: a linha real retornada por buscarMilitante (SUPABASE_COL_ID);
  // fallback: o ID_SUPABASE já lido da task do lead (todo lead ingerido tem um).
  // Sem nenhum dos dois, listarFollowUps LANÇA "referência do militante ausente"
  // — o try/catch abaixo converte isso em seção 5 degradada (D-P4-06), NUNCA em
  // dado de outra pessoa.
  const refMilitante = supabaseMilitante?.[SUPABASE_COL_ID]
    ? String(supabaseMilitante[SUPABASE_COL_ID])
    : idSupabase || undefined;

  let supabaseFollowUps = null;
  try {
    supabaseFollowUps = await listarFollowUps({ refMilitante });
  } catch (e) {
    console.warn(`  [aviso] follow-ups Supabase indisponíveis para ${identificador}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Serviços prestados (seção 5, quick 260811-l7k): lê TODAS as tabelas
  // romero_db_* (SUPABASE_TABLES_SERVICOS) por telefone (variantes BR) +
  // refMilitante (mesmo id de identidade já usado pelos follow-ups acima —
  // sem introduzir nova chave). Degradação por tabela já vem embutida em
  // tabelasComErro; on-throw (config ausente, WR-03) a fonte inteira degrada
  // sem abortar o dossiê deste lead (D-P4-06).
  let servicosPrestados = null;
  let tabelasComErro = null;
  try {
    const resultadoServicos = await listarServicosPrestados({ telefone: lead.telefone, idContato: refMilitante });
    servicosPrestados = resultadoServicos.servicos;
    tabelasComErro = resultadoServicos.tabelasComErro.length > 0 ? resultadoServicos.tabelasComErro : null;
  } catch (e) {
    console.warn(`  [aviso] serviços prestados Supabase indisponíveis para ${identificador}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const fontes = {
    ghlContato,
    ghlConversas,
    ghlOportunidades,
    supabaseMilitante,
    supabaseFollowUps,
    servicosPrestados,
    tabelasComErro,
    observacaoConsolidada: observacaoConsolidada || null,
    ultimoResultado: ultimoResultado || null,
  };

  const { system, prompt } = montarPromptDossie(fontes);
  const dossieMarkdown = await chamarLLM(prompt, system);

  if (DRY_RUN) {
    const degradadas = secoesDegradadas(fontes);
    console.log(
      `  [dry-run] dossiê de ${identificador} montado em memória (${dossieMarkdown.length} caractere(s)); ` +
        `seções degradadas: ${degradadas.length ? degradadas.join(', ') : 'nenhuma'}.`,
    );
  } else {
    // D-P4-01/05: grava as 6 seções na descrição da task do lead — sempre
    // sobrescreve (nunca faz merge parcial).
    await atualizarTask(lead.taskId, { description: dossieMarkdown });
  }

  return dossieMarkdown;
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
      await montarDossieDoLead(lead, mapaTasksLeads.get(lead.taskId), identificador);
      console.log(`  Dossiê montado para ${identificador}.`);
      montados += 1;
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
