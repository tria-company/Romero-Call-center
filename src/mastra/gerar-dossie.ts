// Fonte ÚNICA da geração do Dossiê 360° do lead (Fase 3 do board do Miro —
// "Agente Contexto atualiza a Lista 01"), reusada pelos DOIS callers:
//   - o runner avulso `scripts/montar-dossies.mjs` (via
//     `node --experimental-strip-types`, importando este `.ts` diretamente);
//   - o `processador.ts` (bundle do worker), regenerando o dossiê APÓS CADA
//     LIGAÇÃO.
//
// Módulo APP (não puro): faz I/O (ClickUp/GHL/Supabase/LLM). Reúne as MESMAS
// fontes do lote diário, monta via `montarPromptDossie` (dossie.ts, INALTERADO)
// + `chamarLLM`, e grava a `description` da task do lead na Lista 01.
//
// Invariantes:
// - Degradação POR FONTE (D-P4-06): cada fonte de rede é isolada num try/catch
//   próprio → on-throw a seção degrada para `null`, NUNCA abortando o dossiê
//   inteiro. Mesmo comportamento do lote diário.
// - LLM vazio/whitespace → retorna `null` e NÃO chama `atualizarTask` — nunca
//   zera a `description` existente numa falha do LLM (T-pxq-04).
// - `opts.dryRun` → devolve o markdown SEM gravar (atualizarTask não é chamado).
// - Contrato de erro: as fontes degradam por-fonte; os passos GLOBAIS
//   (lerTask/chamarLLM/atualizarTask) podem LANÇAR em falha de infra (WR-03) —
//   os DOIS callers envolvem a chamada em try/catch, então propagar é o
//   contrato.
// - LGPD/WR-01: nada de telefone/CPF/transcrição em log — só ids/flags e
//   mensagens de erro sem PII. O CPF é usado APENAS como chave de identidade no
//   lookup do Supabase, NUNCA impresso.

import type { FontesDossie } from './dossie.ts';

import {
  lerTask,
  atualizarTask,
  buscarLigacoesDoLead,
  CAMPOS_LEADS,
} from './clickup.ts';
import {
  buscarContactIdPorTelefone,
  buscarConversasWhatsApp,
  buscarOportunidades,
} from './ghl.ts';
import {
  buscarMilitante,
  listarFollowUps,
  listarServicosPrestados,
} from './supabase.ts';
import { montarPromptDossie } from './dossie.ts';
import { chamarLLM } from './llm.ts';
import { SUPABASE_COL_ID } from './config.ts';

/**
 * Lê um custom field bruto da própria task do lead por field-id (D-07). Usado
 * só para as chaves de identidade / histórico RomeroCall já gravados na task
 * (CPF/ID_SUPABASE/OBSERVACAO_CONSOLIDADA/ULTIMO_RESULTADO). `''` quando
 * null/undefined. CPF NUNCA é logado — só chave de lookup no Supabase.
 */
function valorCampoTask(task: Awaited<ReturnType<typeof lerTask>>, fieldId: string): string {
  const campo = task?.custom_fields?.find((c) => c.id === fieldId);
  const v = campo?.value;
  return v === null || v === undefined ? '' : String(v);
}

/**
 * Regenera o Dossiê 360° completo (6 seções do modelo do Miro) na `description`
 * da task do lead (Lista 01), a partir do `leadTaskId`. Reúne GHL (contato/
 * conversas/oportunidades) + Supabase (militante/follow-ups/serviços) + Ligações
 * da Lista 02 + observação consolidada / último resultado, monta via
 * `montarPromptDossie` + `chamarLLM` e grava com `atualizarTask` — a MESMA
 * orquestração do lote diário, agora fonte única.
 *
 * @param leadTaskId task da Lista 01 (LEADS) a regenerar.
 * @param opts.dryRun quando `true`, devolve o markdown SEM gravar.
 * @returns o markdown do dossiê, ou `null` quando a task não existe OU o LLM
 *   devolveu vazio/whitespace (nesse caso NÃO grava — nunca zera a description).
 */
export async function regenerarDossieDoLead(
  leadTaskId: string,
  opts?: { dryRun?: boolean },
): Promise<string | null> {
  // lerTask LANÇA em falha de infra (WR-03); `null` só para task inexistente.
  const task = await lerTask(leadTaskId);
  if (!task) return null;

  // Identidade / histórico RomeroCall lidos por field-id da própria task.
  const telefone = valorCampoTask(task, CAMPOS_LEADS.TELEFONE);
  const nome = valorCampoTask(task, CAMPOS_LEADS.NOME);
  const cpf = valorCampoTask(task, CAMPOS_LEADS.CPF); // só chave de lookup — NUNCA logar.
  const idSupabase = valorCampoTask(task, CAMPOS_LEADS.ID_SUPABASE);
  const observacaoConsolidada = valorCampoTask(task, CAMPOS_LEADS.OBSERVACAO_CONSOLIDADA);
  const ultimoResultado = valorCampoTask(task, CAMPOS_LEADS.ULTIMO_RESULTADO);

  // Perfil GHL (seção 1) — derivado do próprio lead, sem rede: fica FORA do try.
  const ghlContato = nome ? { nome, telefone } : null;

  // GHL (rede): degrada TODA a fonte GHL para null sem abortar o dossiê
  // (D-P4-06) — a fn compartilhada NUNCA pode abortar por uma fonte externa.
  let ghlConversas: FontesDossie['ghlConversas'] = null;
  let ghlOportunidades: FontesDossie['ghlOportunidades'] = null;
  try {
    const contactId = await buscarContactIdPorTelefone(telefone);
    if (contactId) {
      const mensagens = await buscarConversasWhatsApp(contactId);
      ghlConversas = mensagens.length > 0 ? { mensagens } : {};
      ghlOportunidades = await buscarOportunidades(contactId);
    }
  } catch (e) {
    console.error('[gerar-dossie] fonte GHL indisponível (segue):', e instanceof Error ? e.message : String(e));
  }

  // Supabase militante (LANÇA em falha de config/infra — WR-03): degrada seção.
  const chaveSupabase = {
    idSupabase: idSupabase || undefined,
    cpf: cpf || undefined,
    telefone: telefone || undefined,
  };
  let supabaseMilitante: FontesDossie['supabaseMilitante'] = null;
  try {
    supabaseMilitante = await buscarMilitante(chaveSupabase);
  } catch (e) {
    console.error('[gerar-dossie] militante Supabase indisponível (segue):', e instanceof Error ? e.message : String(e));
  }

  // refMilitante (CR-02): FK correta do militante — a linha real do Supabase
  // (SUPABASE_COL_ID) ou o ID_SUPABASE já lido da task; NUNCA id/cpf/telefone do
  // lead misturados (evita contaminação cruzada de PII entre follow-ups).
  const refMilitante = supabaseMilitante?.[SUPABASE_COL_ID]
    ? String(supabaseMilitante[SUPABASE_COL_ID])
    : idSupabase || undefined;

  // Supabase follow-ups (LANÇA sem refMilitante — WR-03/CR-02): degrada seção.
  let supabaseFollowUps: FontesDossie['supabaseFollowUps'] = null;
  try {
    supabaseFollowUps = await listarFollowUps({ refMilitante });
  } catch (e) {
    console.error('[gerar-dossie] follow-ups Supabase indisponíveis (segue):', e instanceof Error ? e.message : String(e));
  }

  // Serviços prestados (romero_db_*): degradação por tabela embutida em
  // tabelasComErro; on-throw a fonte inteira degrada sem abortar o dossiê.
  let servicosPrestados: FontesDossie['servicosPrestados'] = null;
  let tabelasComErro: FontesDossie['tabelasComErro'] = null;
  try {
    const r = await listarServicosPrestados({ telefone, idContato: refMilitante });
    servicosPrestados = r.servicos;
    tabelasComErro = r.tabelasComErro.length > 0 ? r.tabelasComErro : null;
  } catch (e) {
    console.error('[gerar-dossie] serviços prestados Supabase indisponíveis (segue):', e instanceof Error ? e.message : String(e));
  }

  // Seção 4 — Ligações RomeroCall (Lista 02): LANÇA em falha de infra (WR-03),
  // degrada por fonte sem abortar o dossiê deste lead (D-P4-06).
  let ligacoesRomeroCall: FontesDossie['ligacoesRomeroCall'] = null;
  try {
    ligacoesRomeroCall = await buscarLigacoesDoLead(leadTaskId, telefone);
  } catch (e) {
    console.error('[gerar-dossie] ligações RomeroCall (Lista 02) indisponíveis (segue):', e instanceof Error ? e.message : String(e));
  }

  const fontes: FontesDossie = {
    ghlContato,
    ghlConversas,
    ghlOportunidades,
    ligacoesRomeroCall,
    supabaseMilitante,
    supabaseFollowUps,
    servicosPrestados,
    tabelasComErro,
    observacaoConsolidada: observacaoConsolidada || null,
    ultimoResultado: ultimoResultado || null,
  };

  const { system, prompt } = montarPromptDossie(fontes);
  const dossieMarkdown = await chamarLLM(prompt, system);

  // LLM vazio/whitespace → NÃO escreve, nunca zera o dossiê existente (T-pxq-04).
  if (!dossieMarkdown || !dossieMarkdown.trim()) return null;

  // Dry-run: devolve sem gravar (atualizarTask não é chamado).
  if (opts?.dryRun) return dossieMarkdown;

  // D-P4-01/05: grava as 6 seções na description — sempre sobrescreve.
  await atualizarTask(leadTaskId, { description: dossieMarkdown });
  return dossieMarkdown;
}
