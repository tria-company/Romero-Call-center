#!/usr/bin/env node
// scripts/gerar-lote.mjs
//
// Runner impuro da skill "gerar-lote-diario" (LOTE-02/03, Fase 02 Plano 02;
// Dossiê 360 DOSS-01, Fase 04 Plano 04): lê a Lista 01 (LEADS), prioriza
// (src/mastra/lote.ts), monta o Dossiê 360° de cada lead (GHL + Supabase +
// histórico RomeroCall, D-P4-01/04) e grava na descrição do lead, gera um
// roteiro estruturado por lead via LLM (Agente Script, agora nascendo do
// Gancho do dossiê — D-P4-02) e cria uma task por lead na Lista 02
// (LIGACOES) com o script na descrição, vínculo ao lead
// (LEAD_REL/ID_LEAD/TELEFONE) e assignee do operador — de forma idempotente
// (D-P2-03): pula lead que já tem Ligação ABERTA referenciando-o.
//
// Uso:
//   node --env-file=.env --experimental-strip-types scripts/gerar-lote.mjs [--tamanho N] [--dry-run]
//
// Backend plugável (D-P2-02): a implementação abaixo é REST, via clickup.ts
// (token .env, já provado na workspace 9014971829) — o default executável
// desta fase. O MCP do ClickUp fica documentado no SKILL.md como alternativa
// futura (NÃO implementada aqui): só entra se o usuário conectar essa
// workspace ao conector MCP do claude.ai. O ponto de extensão é a interface
// `BackendLote` (src/mastra/lote.ts) — este runner implementa esse contrato
// inline com clickup.ts abaixo (ligacoesAbertasDoLead/criarLigacao).
//
// LGPD (T-02-02-I / T-04-04-I1): logs só imprimem contagens/ids/nome —
// telefone MASCARADO, CPF NUNCA aparece em log (nem mascarado — o dossiê
// passa a manipular CPF como chave de identidade Supabase, D-P4-08), nunca o
// token do ClickUp/Supabase.

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
import { chamarLLM } from '../src/mastra/llm.ts';
import {
  parseLeadDaTask,
  selecionarLoteElegivel,
  montarPromptScript,
  montarTaskLigacao,
  deveCriar,
} from '../src/mastra/lote.ts';
import { montarPromptDossie } from '../src/mastra/dossie.ts';
import { buscarMilitante, listarFollowUps, listarServicosPrestados } from '../src/mastra/supabase.ts';
import { buscarContactIdPorTelefone, buscarConversasWhatsApp, buscarOportunidades } from '../src/mastra/ghl.ts';
import { assigneeDoOperador } from '../src/mastra/operadores.ts';
import { LOTE_LIMITE_TENTATIVAS, LOTE_TAMANHO_DEFAULT, SUPABASE_COL_ID } from '../src/mastra/config.ts';
import { mascararTelefone } from '../src/mastra/mascarar.ts';

const DRY_RUN = process.argv.includes('--dry-run');

function lerTamanhoArgv() {
  const idx = process.argv.indexOf('--tamanho');
  if (idx === -1) return LOTE_TAMANHO_DEFAULT;
  const valor = Number(process.argv[idx + 1]);
  return Number.isFinite(valor) && valor > 0 ? valor : LOTE_TAMANHO_DEFAULT;
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

/**
 * Reúne as fontes do dossiê de UM lead (GHL + Supabase + histórico
 * RomeroCall, D-P4-04), monta o dossiê via Agente Contexto
 * (`montarPromptDossie` + `chamarLLM`) e grava na descrição da task do lead
 * na Lista 01 (D-P4-01, sobrescreve SEMPRE — D-P4-05). Roda ANTES do
 * `montarPromptScript` para o roteiro poder nascer do Gancho (D-P4-02).
 *
 * Cada leitura Supabase (buscarMilitante/listarFollowUps — LANÇA, WR-03) é
 * isolada em try/catch local: on-throw, a seção correspondente vira `null`
 * (degradação explícita — D-P4-06), sem abortar a montagem do dossiê deste
 * lead. As leituras GHL de enriquecimento (buscarConversasWhatsApp/
 * buscarOportunidades) já degradam sozinhas (nunca lançam — ghl.ts).
 *
 * `ghlContato` (seção 1/Perfil) é montado a partir do próprio `lead` (nome/
 * telefone), que já reflete o GHL via ID_LEAD_GHL — este runner não chama um
 * endpoint dedicado de "contato" (não existe hoje em ghl.ts; fora do escopo
 * desta fatia).
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
    // sobrescreve (remontado a cada rodada do lote, nunca faz merge parcial).
    await atualizarTask(lead.taskId, { description: dossieMarkdown });
  }

  return dossieMarkdown;
}

async function main() {
  const tamanho = lerTamanhoArgv();
  console.log('=== Gerar lote diário (RomeroCall — skill gerar-lote-diario, LOTE-02/03) ===');
  if (DRY_RUN) console.log('(modo --dry-run: nada será escrito no ClickUp — só gera os scripts em memória)');

  console.log(`Lendo Lista 01 LEADS (lista ${CLICKUP_LIST_LEADS})...`);
  const tasksLeads = await lerTodasAsTasks(CLICKUP_LIST_LEADS);
  console.log(`  ${tasksLeads.length} lead(s) lido(s) da Lista 01 (contagem apenas, sem PII).`);

  // Mapa taskId -> TaskClickUp bruta (Lista 01 já carregada) — usado só pelo
  // passo de dossiê pra ler CPF/ID_SUPABASE/OBSERVACAO_CONSOLIDADA/
  // ULTIMO_RESULTADO por field-id (D-P4-03), sem reler a task da API.
  const mapaTasksLeads = new Map(tasksLeads.map((task) => [task.id, task]));

  const leads = tasksLeads.map((task) => parseLeadDaTask(task, CAMPOS_LEADS));
  const lote = selecionarLoteElegivel(leads, {
    hoje: new Date(),
    limiteTentativas: LOTE_LIMITE_TENTATIVAS,
    tamanho,
  });
  console.log(`Lote priorizado: ${lote.length} lead(s) elegível(is) (tamanho máx. ${tamanho}).`);

  console.log(`Lendo Ligações ABERTAS da Lista 02 (lista ${CLICKUP_LIST_LIGACOES}) para o dedupe...`);
  const ligacoesAbertas = await lerTodasAsTasks(CLICKUP_LIST_LIGACOES, { includeClosed: false });
  console.log(`  ${ligacoesAbertas.length} Ligação(ões) aberta(s) encontrada(s).`);

  const usuarioOperador = process.env.LOTE_OPERADOR_DEFAULT || '';
  let assigneeId = assigneeDoOperador(usuarioOperador);
  if (!assigneeId) {
    const mensagem =
      `[gerar-lote] não foi possível resolver o assignee do operador "${usuarioOperador || '(vazio)'}" — ` +
      'configure LOTE_OPERADOR_DEFAULT e DISCADOR_ASSIGNEES ("usuario:memberId,...") no .env.';
    if (DRY_RUN) {
      console.warn(`${mensagem}\n(preview segue com um assignee de exemplo — nada será escrito.)`);
      assigneeId = '0';
    } else {
      throw new Error(mensagem);
    }
  }

  const elegiveisParaCriar = lote.filter((lead) => deveCriar(lead, ligacoesAbertas, CAMPOS_LIGACOES.ID_LEAD));
  const puladosPorDedupe = lote.length - elegiveisParaCriar.length;
  console.log(
    `A processar: ${elegiveisParaCriar.length} lead(s) novo(s) (${puladosPorDedupe} pulado(s) — já tem Ligação aberta, dedupe D-P2-03).`,
  );

  let criadas = 0;
  let falhas = 0;

  for (const lead of elegiveisParaCriar) {
    const identificador = `${lead.nome || '(sem nome)'} (${mascararTelefone(lead.telefone)})`;
    try {
      // Passo de dossiê (D-P4-04): roda ANTES do script, monta e grava as 6
      // seções na descrição do lead (D-P4-01/05). Falha na montagem/gravação
      // NÃO aborta o lead — o script segue sendo gerado sem dossiê (D-P4-06,
      // padrão Fase 2 de nunca abortar o lote inteiro por um lead).
      let dossieMarkdown;
      try {
        dossieMarkdown = await montarDossieDoLead(lead, mapaTasksLeads.get(lead.taskId), identificador);
      } catch (e) {
        console.warn(
          `  [aviso] falha ao montar/gravar o dossiê de ${identificador}: ${e instanceof Error ? e.message : String(e)} ` +
            '(o script seguirá sem dossiê — D-P4-06).',
        );
      }

      const { system, prompt } = montarPromptScript(lead, dossieMarkdown);
      const script = await chamarLLM(prompt, system);

      if (DRY_RUN) {
        console.log(`\n[dry-run] ${identificador} — roteiro gerado (${script.length} caractere(s)), nada escrito.`);
        continue;
      }

      const payload = montarTaskLigacao(lead, script, assigneeId, CAMPOS_LIGACOES);
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

      console.log(`  Ligação criada para ${identificador} -> task ${novaTask.id}`);
      criadas += 1;
    } catch (e) {
      // T-02-02-E: nunca colapsar erro em sucesso silencioso — reporta e conta a falha.
      falhas += 1;
      console.error(
        `  [erro] falha ao gerar/criar Ligação para ${identificador}: ${e instanceof Error ? e.message : String(e)}`,
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
