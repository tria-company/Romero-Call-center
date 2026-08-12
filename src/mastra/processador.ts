// Processador do trabalho pesado do webhook Wavoip (Fase 6 — fila assincrona,
// escala-150-atendentes).
//
// Extrai para ca a logica que hoje roda inline no handler do webhook
// (index.ts): transcricao (Deepgram) + Agente Analise (aderencia ao script) +
// Agente Contexto (consolidacao do lead) + fechamento da Ligacao, e o
// caminho de CALL nao-atendida terminal (sem gravacao). Estas duas funcoes
// (`processarRecordJob`/`processarFalhaTerminalJob`) sao o UNICO lugar desta
// logica — o worker (06-04) as chama fora do caminho da requisicao, e o
// webhook (06-03) as chama inline quando nao ha fila (REDIS_URL vazio).
//
// Dedup (FILA-05): o SETNX atomico (`marcarRecordProcessado`/
// `marcarCallFalhaProcessada`, sobrevive a restart via Redis) mora AQUI
// DENTRO, nao no webhook — vale igual para o job (worker) e para o inline
// (mesma chamada de funcao), fechando a lacuna de duplicidade sob
// retry/replica que so proteger no request handler nao cobriria.
//
// Semantica de falha: retentavel (transcricao falhou, avulsa nao criada)
// LANCA (`throw`) para o BullMQ retentar (FILA-03) — em modo inline o
// webhook (06-03) traduz o throw em 502 (mesmo efeito do 502 de hoje: Wavoip
// retenta). Passos isolados (LLM da Analise/Contexto) continuam log-e-segue
// (D-P3-08), nunca lancam.
//
// LGPD/WR-01: nenhuma transcricao/telefone/CPF em log — so ids/flags/status;
// telefone so aparece MASCARADO quando necessario (mesmo padrao do webhook).

import type { DadosJobFalhaTerminal } from './fila.ts';

import {
  OPER_RETORNO_NAO_ATENDEU_DIAS,
  OPER_RETORNO_DEFAULT_DIAS,
} from './config.ts';

import {
  gravarMetadadosLigacao,
  buscarLigacaoAbertaPorTelefone,
  lerTask,
  CAMPOS_LEADS,
  resolverLeadDaLigacao,
  consolidarLead,
  fecharLigacao,
} from './clickup.ts';

import { derivarMotivoFalha, derivarDuracao } from './analise.ts';

import { montarPromptContexto, proximoContato, derivarContadores } from './contexto.ts';

import { chamarLLM } from './llm.ts';

import { marcarEventoWebhook } from './supabase.ts';

import {
  lerTaskAtiva,
  limparTaskAtiva,
  marcarCallFalhaProcessada,
} from './estado-webhook.ts';

// ===== Agente Contexto — consolidacao do lead + fechamento da Ligacao =====
// (OPER-05, D-P3-06/12/13/14/15, Fase 03 Plano 04 — fecha o loop diario;
// movido de index.ts sem mudar comportamento, Fase 06 Plano 02)

/** Le os valores atuais do lead (Lista 01) que `derivarContadores`/`consolidarLead` precisam. Defaults seguros quando o campo ainda nao tem valor (primeira ligacao do lead). */
function valoresAtuaisDoLead(lead: Awaited<ReturnType<typeof lerTask>>): {
  observacaoAtual: string;
  tentativasAtuais: number;
  atendimentosAtuais: number;
  naoAtendimentosAtuais: number;
} {
  const campo = (id: string) => lead?.custom_fields?.find((c) => c.id === id)?.value;
  const numero = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    observacaoAtual: String(campo(CAMPOS_LEADS.OBSERVACAO_CONSOLIDADA) ?? ''),
    tentativasAtuais: numero(campo(CAMPOS_LEADS.QTD_TENTATIVAS)),
    atendimentosAtuais: numero(campo(CAMPOS_LEADS.QTD_ATENDIMENTOS)),
    naoAtendimentosAtuais: numero(campo(CAMPOS_LEADS.QTD_NAO_ATENDIMENTOS)),
  };
}

/**
 * Consolida o resultado da ligacao no lead (Lista 01) e fecha a task de
 * Ligacao (Lista 02) — usado nos DOIS caminhos do processador (atendida, apos
 * o Agente Analise; nao-atendida, sem transcricao/LLM de analise). Resolve o
 * lead via `resolverLeadDaLigacao` (LEAD_REL, fallback telefone); le os
 * valores atuais do lead; chama o Agente Contexto (`montarPromptContexto` +
 * `chamarLLM`) pra reescrever o resumo vivo (D-P3-13) — falha do LLM loga e
 * MANTEM a observacao anterior (nao trava a consolidacao dos contadores/
 * proximo contato); calcula `proximoContato` (D-P3-14) e `derivarContadores`;
 * grava tudo via `consolidarLead`. Fecha a Ligacao (`fecharLigacao`, D-P3-06)
 * SEMPRE ao final, mesmo se a consolidacao do lead falhar (a task nao pode
 * ficar aberta pra sempre so por causa de uma falha isolada de escrita no
 * lead — cada passo loga-e-segue, WR-03/D-P3-08). Nenhuma PII em log — so
 * ids/flags.
 */
async function consolidarEFecharLigacao(
  taskLigacaoId: string,
  opts: {
    atendeu: boolean;
    resumoAnalise: string;
    aderencia: number | null;
    retorno: { necessario: boolean; data: Date | null };
  },
): Promise<void> {
  try {
    const leadTaskId = await resolverLeadDaLigacao(taskLigacaoId);
    if (!leadTaskId) {
      console.warn(`[processador] consolidacao: lead nao resolvido a partir da Ligacao ${taskLigacaoId} — pulando consolidarLead`);
    } else {
      const lead = await lerTask(leadTaskId);
      const atuais = valoresAtuaisDoLead(lead);
      const hoje = new Date();

      // D-P3-13: reescreve o resumo vivo. Falha do LLM (indisponibilidade/
      // erro de parse-livre, este prompt nao pede JSON) loga e mantem a
      // observacao anterior — os contadores/proximo contato ainda sao
      // gravados abaixo, a cadeia nao trava (mesmo racional do Agente Analise).
      let observacaoConsolidada = atuais.observacaoAtual;
      try {
        const { system, prompt } = montarPromptContexto({
          observacaoAtual: atuais.observacaoAtual,
          atendeu: opts.atendeu,
          resumoAnalise: opts.resumoAnalise,
          aderencia: opts.aderencia,
          retorno: opts.retorno,
        });
        const textoLLM = await chamarLLM(prompt, system);
        if (textoLLM) observacaoConsolidada = textoLLM.trim();
      } catch (e) {
        console.error('[processador] falha no Agente Contexto (LLM) — mantendo observacao anterior:', e);
      }

      const proximoContatoData = proximoContato({
        dataRetorno: opts.retorno.data,
        atendeu: opts.atendeu,
        hoje,
        diasNaoAtendeu: OPER_RETORNO_NAO_ATENDEU_DIAS,
        diasDefault: OPER_RETORNO_DEFAULT_DIAS,
      });
      const contadores = derivarContadores({
        atendeu: opts.atendeu,
        tentativasAtuais: atuais.tentativasAtuais,
        atendimentosAtuais: atuais.atendimentosAtuais,
        naoAtendimentosAtuais: atuais.naoAtendimentosAtuais,
        hoje,
      });

      await consolidarLead(leadTaskId, {
        observacaoConsolidada,
        proximoContato: proximoContatoData.getTime(),
        contadores,
      });
    }
  } catch (e) {
    console.error('[processador] falha ao consolidar o lead — a Ligacao ainda sera fechada:', e);
  }

  // D-P3-06: a task fecha sozinha no pos-processamento, mesmo se a
  // consolidacao do lead falhou acima — "Proxima" no discador so avanca a UI.
  try {
    await fecharLigacao(taskLigacaoId);
  } catch (e) {
    console.error('[processador] falha ao fechar a Ligacao:', e);
  }
}

// ===== processarFalhaTerminalJob — CALL nao-atendida terminal =====
// (CR-01/CR-02, D-P3-05/06/12/14, FILA-05)

/**
 * Processa o caminho terminal NAO-ATENDIDO de uma CALL do Wavoip: deduplica
 * (SETNX, FILA-05), resolve a task da Ligacao (map ativo -> fallback
 * ClickUp), grava os metadados de falha, consolida o lead (sem Agente
 * Analise — nao ha gravacao pra avaliar) e fecha a Ligacao. Chamavel tanto
 * pelo worker (06-04) quanto inline pelo webhook (06-03) — mesma sequencia
 * de efeitos nos dois modos. Passos internos logam-e-seguem (raramente
 * lancam) — nao ha retry retentavel aqui (sem I/O externo perecivel como
 * transcricao).
 */
export async function processarFalhaTerminalJob(dados: DadosJobFalhaTerminal): Promise<void> {
  // FILA-05: dedup atomico no INICIO — se ja processada (ou sem callId,
  // mesma semantica de hoje), return silencioso.
  if (!(await marcarCallFalhaProcessada(dados.whatsappCallId))) return;

  // D-P3-01: resolve a task via 1) map in-memory (task reportada em
  // /api/discador/ligando) OU, quando o map nao tem entrada (restart/
  // hot-reload), 2) fallback persistido — a Ligacao aberta com o mesmo
  // TELEFONE ja gravada no ClickUp por `iniciarLigacao`.
  let taskId = await lerTaskAtiva(dados.telefone);
  if (!taskId) {
    try {
      taskId = await buscarLigacaoAbertaPorTelefone(dados.telefone);
    } catch (e) {
      // Loga-e-segue (WR-03: o helper subjacente ja lancou em erro de
      // infra) — o processador nunca lanca por uma leitura isolada aqui.
      console.error('[processador] falha ao buscar Ligacao aberta por telefone (falha terminal):', e);
    }
  }
  if (!taskId) {
    const telefone = dados.telefone;
    const mascarado = telefone.length > 4 ? `${'*'.repeat(telefone.length - 4)}${telefone.slice(-4)}` : telefone;
    console.warn(`[processador] falha terminal sem Ligacao aberta correlacionavel (telefone=${mascarado})`);
    return;
  }

  try {
    await gravarMetadadosLigacao(taskId, {
      atendeu: false,
      motivoFalha: derivarMotivoFalha(dados.payload),
      fim: Date.now(),
      duracao: derivarDuracao(dados.payload),
    });
  } catch (e) {
    // Loga-e-segue (a cadeia nao pode travar por uma escrita isolada) — o
    // helper subjacente JA lancou (WR-03), este catch so evita propagar.
    console.error('[processador] falha ao gravar metadados de nao-atendida:', e);
  }

  // ---- Agente Contexto (OPER-05, D-P3-06/12/14) — caminho NAO-ATENDIDO ----
  // Sem gravacao/transcricao, PULA o Agente Analise (aderencia) — nao ha o
  // que avaliar. Consolida direto com atendeu:false (observacao objetiva;
  // proximoContato = D+OPER_RETORNO_NAO_ATENDEU_DIAS, D-P3-14) e fecha a
  // Ligacao (D-P3-06).
  await consolidarEFecharLigacao(taskId, {
    atendeu: false,
    resumoAnalise: `Não atendida em ${new Date().toISOString().slice(0, 10)}.`,
    aderencia: null,
    retorno: { necessario: false, data: null },
  });

  // CR-02: limpa a entrada telefone->task apos consolidar/fechar — uma
  // ligacao futura ao mesmo telefone nunca re-consolida sobre esta task ja
  // fechada.
  await limparTaskAtiva(dados.telefone);

  // Fecha o desfecho durave do evento cru (Fase 2 — durabilidade).
  try {
    await marcarEventoWebhook(dados.eventoDuravelId, 'processado');
  } catch (e) {
    console.error('[processador] falha ao marcar evento falha-terminal processado:', e);
  }
}
