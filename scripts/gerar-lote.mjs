#!/usr/bin/env node
// scripts/gerar-lote.mjs
//
// Runner impuro da skill "gerar-lote-diario" (LOTE-02/03, Fase 02 Plano 02):
// lê a Lista 01 (LEADS), prioriza (src/mastra/lote.ts), gera um roteiro
// estruturado por lead via LLM (Agente Script) e cria uma task por lead na
// Lista 02 (LIGACOES) com o script na descrição, vínculo ao lead
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
// LGPD (T-02-02-I): logs só imprimem contagens/ids/nome — telefone MASCARADO,
// nunca CPF, nunca o token do ClickUp.

import {
  listarTasks,
  criarTask,
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
import { assigneeDoOperador } from '../src/mastra/operadores.ts';
import { LOTE_LIMITE_TENTATIVAS, LOTE_TAMANHO_DEFAULT } from '../src/mastra/config.ts';

const DRY_RUN = process.argv.includes('--dry-run');

function lerTamanhoArgv() {
  const idx = process.argv.indexOf('--tamanho');
  if (idx === -1) return LOTE_TAMANHO_DEFAULT;
  const valor = Number(process.argv[idx + 1]);
  return Number.isFinite(valor) && valor > 0 ? valor : LOTE_TAMANHO_DEFAULT;
}

/** Mascara o telefone (LGPD, T-02-02-I) — só os últimos 4 dígitos aparecem. */
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

async function main() {
  const tamanho = lerTamanhoArgv();
  console.log('=== Gerar lote diário (RomeroCall — skill gerar-lote-diario, LOTE-02/03) ===');
  if (DRY_RUN) console.log('(modo --dry-run: nada será escrito no ClickUp — só gera os scripts em memória)');

  console.log(`Lendo Lista 01 LEADS (lista ${CLICKUP_LIST_LEADS})...`);
  const tasksLeads = await lerTodasAsTasks(CLICKUP_LIST_LEADS);
  console.log(`  ${tasksLeads.length} lead(s) lido(s) da Lista 01 (contagem apenas, sem PII).`);

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
      const { system, prompt } = montarPromptScript(lead);
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
