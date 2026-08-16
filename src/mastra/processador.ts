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
// Dedup (FILA-05) CRASH-SAFE (CR-02): a marca duravel de "processado"
// (`marcarRecordProcessado`/`marcarCallFalhaProcessada`, SETNX via Redis,
// sobrevive a restart) so e setada DEPOIS do efeito terminal (consolidacao +
// marcarEventoWebhook 'processado'). No INICIO apenas CHECAMOS (read-only,
// `recordJaProcessado`/`callFalhaJaProcessada`) pra pular uma reentrega de um
// job JA concluido. Assim um SIGKILL no meio do job (deploy durante chamada
// longa, stop_grace_period estourado pelo Deepgram) NAO deixa nada marcado —
// a reentrega do BullMQ (stalled) ou o reprocesso via CLI (06-05) re-rodam o
// job inteiro e o consolidam. Isto mora AQUI DENTRO (nao no webhook) pra valer
// igual no worker e no inline. TRADE-OFF aceito: sob entrega duplicada
// TRULY-concorrente (duas replicas processando o mesmo call_id ao mesmo tempo,
// antes de qualquer uma marcar) pode haver dupla-transcricao rara — o mesmo
// que o caminho throw/retry ja tolera, e minimizado pelo dedup de enqueue
// (jobId) da fila.
//
// Semantica de falha: retentavel (transcricao falhou, avulsa nao criada)
// LANCA (`throw`) para o BullMQ retentar (FILA-03) — em modo inline o
// webhook (06-03) traduz o throw em 502 (mesmo efeito do 502 de hoje: Wavoip
// retenta). Passos isolados (LLM da Analise/Contexto) continuam log-e-segue
// (D-P3-08), nunca lancam.
//
// LGPD/WR-01: nenhuma transcricao/telefone/CPF em log — so ids/flags/status;
// telefone so aparece MASCARADO quando necessario (mesmo padrao do webhook).

import type { DadosJobRecord, DadosJobFalhaTerminal } from './fila.ts';

import {
  ANALISE_ADERENCIA_MINIMA,
  OPER_RETORNO_NAO_ATENDEU_DIAS,
  OPER_RETORNO_DEFAULT_DIAS,
} from './config.ts';

import {
  gravarTranscricao,
  gravarMetadadosLigacao,
  buscarLigacaoAbertaPorTelefone,
  criarLigacaoAvulsa,
  lerTask,
  setCustomField,
  CAMPOS_LIGACOES,
  CAMPOS_LEADS,
  resolverLeadDaLigacao,
  consolidarLead,
  resolverVotoAtualLead,
  definirVotoLeadCampo,
  fecharLigacao,
  type EscolhaVoto,
} from './clickup.ts';

import { transcreverCallUrl } from './deepgram.ts';

import { mascararTelefone } from './mascarar.ts';

import { registrarErroEtapa, registrarSucessoEtapa } from './metricas.ts';

import {
  derivarAtendeu,
  derivarMotivoFalha,
  derivarDuracao,
  montarPromptAnalise,
  parseResultadoAnalise,
  necessitaRevisao,
  extrairRetorno,
  decidirAcaoVoto,
  montarLinhaLogVoto,
  montarSecaoLogVoto,
  type VotoIA,
} from './analise.ts';

import { montarPromptContexto, proximoContato, derivarContadores } from './contexto.ts';

import { chamarLLM } from './llm.ts';

import { regenerarDossieDoLead } from './gerar-dossie.ts';

import { marcarEventoWebhook } from './supabase.ts';

import {
  lerTaskAtiva,
  limparTaskAtiva,
  marcarRecordProcessado,
  recordJaProcessado,
  marcarCallFalhaProcessada,
  callFalhaJaProcessada,
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

/** Rótulo PT-BR de uma escolha de voto — só para a nota de divergência (sem PII). */
const ROTULO_VOTO: Record<EscolhaVoto, string> = { sim: 'Sim', nao: 'Não', naoDeclarou: 'Não declarou' };
function rotuloVoto(v: EscolhaVoto | null): string {
  return v ? ROTULO_VOTO[v] : '—';
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
    /** Voto extraído pela IA (só no caminho ATENDIDO/transcrito) — preenche vazio, valida preenchido; ausente = não mexe no voto. */
    voto?: { romero: VotoIA; andressa: VotoIA };
    /** Evidência (trecho da transcrição) por candidato que embasou a leitura da IA — D2, quick-260815-oq4. Ausente = linha de log sem evidência. */
    votoEvidencia?: { romero: string | null; andressa: string | null };
    /** Texto BASE do ANALISE_IA (resumoAnalise cru, sem sinaisTexto) sobre o qual a seção "Voto (IA × closer)" é composta — D3, quick-260815-oq4. Ausente = não grava a seção (mantém o comportamento de hoje). */
    analiseIaBase?: string;
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

      // Voto (OPER-04b): o Agente Análise PREENCHE o campo de voto vazio e
      // VALIDA o já-preenchido pelo closer — nunca sobrescreve a marcação
      // manual. Divergência (IA≠humano) marca NECESSITA_REVISAO na Ligação e
      // entra no resumo consolidado, sem alterar o voto. Log-e-segue: nunca
      // trava a consolidação/fechamento (WR-03/D-P3-08). Sem PII em log.
      const divergenciasVoto: string[] = [];
      // D1 (quick-260815-oq4): uma linha de log por candidato SEMPRE (não só
      // na divergência) — montada aqui, gravada no ANALISE_IA da Ligação
      // depois do loop (log-e-segue, nunca trava a consolidação/fechamento).
      const linhasLog: string[] = [];
      if (opts.voto) {
        try {
          const votoAtual = resolverVotoAtualLead(lead);
          const candidatos = [
            { chave: 'romero' as const, nome: 'Romero' },
            { chave: 'andressa' as const, nome: 'Andressa' },
          ];
          for (const { chave, nome } of candidatos) {
            const ia = opts.voto[chave];
            const { definido, escolha } = votoAtual[chave];
            const evidencia = opts.votoEvidencia?.[chave] ?? null;
            // Campo com valor que não conseguimos traduzir: não arrisca
            // sobrescrever nem gerar falso-positivo de divergência — registra
            // honestamente no log ("valor não reconhecido") e segue pro
            // próximo candidato SEM chamar decidirAcaoVoto.
            if (definido && escolha === null) {
              linhasLog.push(
                montarLinhaLogVoto({
                  candidato: nome,
                  ia,
                  closerDefinido: definido,
                  closerEscolha: escolha,
                  closerIrressoluvel: true,
                  evidencia,
                }),
              );
              continue;
            }
            linhasLog.push(
              montarLinhaLogVoto({
                candidato: nome,
                ia,
                closerDefinido: definido,
                closerEscolha: escolha,
                closerIrressoluvel: false,
                evidencia,
              }),
            );
            const acao = decidirAcaoVoto(ia, definido ? escolha : null);
            if (acao === 'preencher') {
              await definirVotoLeadCampo(leadTaskId, chave, ia as EscolhaVoto);
              console.log(`[processador] voto ${nome} preenchido pela IA (${ia}) no lead ${leadTaskId}`);
            } else if (acao === 'divergencia') {
              divergenciasVoto.push(`${nome}: closer marcou "${rotuloVoto(escolha)}", IA ouviu "${rotuloVoto(ia)}"`);
            }
          }
        } catch (e) {
          console.error('[processador] falha ao preencher/validar voto pela IA (segue):', e instanceof Error ? e.message : String(e));
        }
      }

      // D1/D3 (quick-260815-oq4): compõe base + seção "Voto (IA × closer)" e
      // grava no ANALISE_IA da Ligação — SEMPRE que houve leitura de voto
      // (não só na divergência). Esta escrita SOBRESCREVE intencionalmente a
      // base já gravada em processarRecordJob (~linha 490): aquela gravação
      // continua sendo a rede de segurança pro caso do lead não resolver
      // (leadTaskId ausente, bloco acima nem roda); quando o lead resolve, o
      // resultado final do campo é base + seção de voto. Log-e-segue (WR-03/
      // D-P3-08): nunca trava a consolidação/fechamento. LGPD: a evidência
      // (trecho da transcrição) só vai pro ClickUp, nunca pro console.
      if (linhasLog.length > 0 && opts.analiseIaBase !== undefined) {
        try {
          const analiseComLog = opts.analiseIaBase + montarSecaoLogVoto(linhasLog);
          await setCustomField(taskLigacaoId, CAMPOS_LIGACOES.ANALISE_IA, analiseComLog);
        } catch (e) {
          console.error('[processador] falha ao gravar log de voto no ANALISE_IA (segue):', e instanceof Error ? e.message : String(e));
        }
      }

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

      // Divergência de voto IA×closer: anexa ao resumo vivo do lead (visível no
      // dossiê/preview) e força NECESSITA_REVISAO na Ligação — sem tocar no voto.
      if (divergenciasVoto.length > 0) {
        observacaoConsolidada = `${observacaoConsolidada}\n\n⚠️ Voto — divergência IA×closer (revisar): ${divergenciasVoto.join('; ')}.`.trim();
        try {
          await setCustomField(taskLigacaoId, CAMPOS_LIGACOES.NECESSITA_REVISAO, true);
        } catch (e) {
          console.error('[processador] falha ao marcar NECESSITA_REVISAO por divergencia de voto (segue):', e);
        }
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

      // Fase 3 do board do Miro aplicada POR-LIGACAO: o Agente Contexto
      // regenera o Dossie 360 completo (6 secoes) na description do lead
      // (Lista 01) LOGO APOS a consolidacao — o dossie ja incorpora o
      // historico de Ligacoes (Secao 4, Lista 02) + a observacao consolidada
      // recem-escrita acima; e ESSE dossie que aparece no preview do discador.
      // Log-e-segue: NUNCA bloqueia fecharLigacao — a task nao pode ficar
      // aberta por uma falha isolada de regeneracao (WR-03/D-P3-08).
      // CAVEAT (aceito, T-pxq-03): regenerar o dossie inteiro a cada ligacao
      // re-consulta GHL/Supabase; se uma fonte externa estiver instavel, a
      // secao dela degrada ("sem dados") ate a proxima regeneracao/lote —
      // trade-off aceito por um dossie fresco a cada ligacao (auto-cura na
      // proxima remontagem; mesma degradacao por fonte do lote diario).
      try {
        await regenerarDossieDoLead(leadTaskId);
      } catch (e) {
        console.error('[processador] falha ao regenerar dossie pos-ligacao (segue):', e instanceof Error ? e.message : String(e));
      }
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
  // CR-02: dedup CRASH-SAFE — CHECA (read-only) se ja foi processada numa run
  // anterior e pula; NAO reivindica a marca aqui. A marca duravel so e setada
  // no FIM, apos o efeito terminal (consolidacao + marcarEventoWebhook). Assim
  // um SIGKILL no meio nao deixa a falha "marcada como feita" bloqueando a
  // reentrega/reprocesso. (callId vazio -> callFalhaJaProcessada retorna false,
  // sempre processa — mesma semantica de hoje.)
  if (await callFalhaJaProcessada(dados.whatsappCallId)) return;

  // D-P3-01: resolve a task via 1) map in-memory (task reportada em
  // /api/discador/ligando) OU, quando o map nao tem entrada (restart/
  // hot-reload), 2) fallback persistido — a Ligacao aberta com o mesmo
  // TELEFONE ja gravada no ClickUp por `iniciarLigacao`.
  let taskId = await lerTaskAtiva(dados.telefone, dados.deviceId);
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
    const mascarado = mascararTelefone(dados.telefone);
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
  // fechada. CR-01 (Fase 07): simetria com a leitura acima
  // (`lerTaskAtiva(dados.telefone, dados.deviceId)`) — limpa tambem a chave
  // COMPOSTA (deviceId|telefone) escrita por `guardarTaskAtiva`, senao ela
  // vazava ate o TTL de 6h. Sem deviceId o comportamento e identico ao de antes.
  await limparTaskAtiva(dados.telefone, dados.deviceId);

  // Fecha o desfecho durave do evento cru (Fase 2 — durabilidade).
  try {
    await marcarEventoWebhook(dados.eventoDuravelId, 'processado');
  } catch (e) {
    console.error('[processador] falha ao marcar evento falha-terminal processado:', e);
  }

  // CR-02: SO AGORA (efeito terminal concluido) grava a marca duravel de
  // dedup — uma reentrega futura do MESMO call_id sera pulada pelo check no
  // inicio. Um crash antes daqui nao deixa marca, permitindo re-rodar limpo.
  await marcarCallFalhaProcessada(dados.whatsappCallId);
}

// ===== processarRecordJob — transcricao + Agente Analise + Agente Contexto =====
// (OPER-01..05, D-P3-01..15, FILA-02/FILA-05)

/**
 * Processa o RECORD (gravacao pronta) de uma call Wavoip: deduplica (SETNX,
 * FILA-05), transcreve (Deepgram), resolve/cria a task da Ligacao, grava
 * transcricao + metadados, roda o Agente Analise (aderencia ao script) e o
 * Agente Contexto (consolidacao do lead + fechamento da Ligacao). Chamavel
 * tanto pelo worker (06-04) quanto inline pelo webhook (06-03).
 *
 * Diferenca de fronteira request->job (unica mudanca de semantica vs. o
 * inline de ontem): usa `dados.telefone` (capturado no enqueue, imune ao TTL
 * da correlacao) em vez de re-ler `lerCorrelacao(callId)`; nao revalida
 * record_status/recordUrl/callId (o webhook ja validou antes de enfileirar).
 * Falhas RETENTAVEIS (transcricao null, avulsa nao criada) LANCAM — em modo
 * fila o BullMQ retenta (FILA-03), em modo inline o webhook (06-03) traduz o
 * throw em 502 (mesmo efeito do 502 de hoje: Wavoip retenta).
 */
export async function processarRecordJob(dados: DadosJobRecord): Promise<void> {
  const { whatsappCallId: callId, telefone, recordUrl, payload } = dados;

  // CR-02: dedup CRASH-SAFE — CHECA (read-only) se este RECORD ja foi
  // consolidado numa run anterior e pula; NAO reivindica a marca aqui. A marca
  // duravel so e setada no FIM (apos consolidar/fechar + marcarEventoWebhook).
  // Um SIGKILL no meio (deploy durante chamada longa) nao deixa nada marcado —
  // a reentrega do BullMQ/reprocesso re-transcreve e consolida do zero.
  if (await recordJaProcessado(callId)) return;

  // D-06: instrumenta a etapa 'transcricao' — o try/catch preserva a
  // propagacao pro BullMQ contar a tentativa (nao muda semantica de
  // throw/retry); transcreverCallUrl hoje engole falhas internas e retorna
  // null (nao lanca), entao o path "!transcricao" abaixo TAMBEM conta como
  // erro real da etapa (o unico sinal de falha que este helper expoe).
  let transcricao: Awaited<ReturnType<typeof transcreverCallUrl>>;
  try {
    transcricao = await transcreverCallUrl(recordUrl);
  } catch (e) {
    registrarErroEtapa('transcricao');
    throw e;
  }
  if (!transcricao) {
    // Retentavel: nada foi marcado (a marca so vem no fim) — o retry futuro
    // simplesmente re-roda e transcreve. WR-01: nunca telefone cru, so o call.
    registrarErroEtapa('transcricao');
    console.warn(`[processador] transcricao falhou (call=${callId})`);
    throw new Error(`transcricao falhou call=${callId}`);
  }
  registrarSucessoEtapa('transcricao');

  // D-P3-01: resolve a task da Ligacao — 1) map in-memory (task reportada em
  // /api/discador/ligando), 2) fallback persistido no ClickUp (Ligacao
  // aberta com o mesmo TELEFONE), 3) D-P3-03: nao casou nenhuma -> cria uma
  // Ligacao avulsa (nenhuma ligacao real fica sem registro).
  let taskId = await lerTaskAtiva(telefone, dados.deviceId);
  if (!taskId) {
    try {
      taskId = await buscarLigacaoAbertaPorTelefone(telefone);
    } catch (e) {
      console.error('[processador] falha ao buscar Ligacao aberta por telefone:', e);
    }
  }
  if (!taskId) {
    try {
      const avulsa = await criarLigacaoAvulsa(telefone);
      taskId = avulsa.id;
    } catch (e) {
      // Criar a avulsa e o unico jeito de nao perder o registro desta
      // gravacao (D-P3-03) — se ISSO falhar, lanca (retentavel, mesmo efeito
      // do 502 de hoje). CR-02: nada foi marcado ainda, o retry re-roda limpo.
      console.error('[processador] falha ao criar Ligacao avulsa:', e);
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  // D-P3-04: grava a transcricao (field TRANSCRICAO + comentario),
  // substituindo a nota no GHL. Loga-e-segue (nao trava a cadeia por uma
  // falha de escrita isolada) — o helper LANCA em falha de infra (WR-03),
  // este catch so evita propagar.
  try {
    await gravarTranscricao(taskId, transcricao);
  } catch (e) {
    console.error('[processador] falha ao gravar transcricao na Ligacao:', e);
  }

  // D-P3-05, OPER-02: metadados 100% automaticos — ATENDEU=true porque
  // houve gravacao (teveGravacao=true).
  try {
    await gravarMetadadosLigacao(taskId, {
      atendeu: derivarAtendeu(payload, true),
      fim: Date.now(),
      duracao: derivarDuracao(payload),
      urlGravacao: recordUrl,
    });
  } catch (e) {
    console.error('[processador] falha ao gravar metadados na Ligacao:', e);
  }

  // ---- Agente Analise (OPER-03/04, D-P3-08/09/10/11/15) ----
  // Encadeado automaticamente logo apos a transcricao+metadados. Falha de
  // LLM/parse NAO trava a cadeia (D-P3-08): marca NECESSITA_REVISAO=true e
  // segue. Nada de transcricao/PII em log — so ids/flags/status.
  // `resultadoAnalise`/`retornoAnalise` ficam fora do try (hoisted) pro
  // passo do Agente Contexto (abaixo) poder consolidar o lead mesmo quando a
  // Analise falhou (valores ficam `null`).
  let resultadoAnalise: ReturnType<typeof parseResultadoAnalise> | null = null;
  let retornoAnalise: ReturnType<typeof extrairRetorno> | null = null;
  try {
    const task = await lerTask(taskId);
    const script = task?.description ?? task?.text_content ?? '';
    const { system, prompt } = montarPromptAnalise({ script, transcricao });
    const textoLLM = await chamarLLM(prompt, system);
    const resultado = parseResultadoAnalise(textoLLM);
    const revisao = necessitaRevisao({
      aderencia: resultado.aderencia,
      limiar: ANALISE_ADERENCIA_MINIMA,
      sinaisAlerta: resultado.sinaisAlerta,
      falhaTecnica: resultado.falhaTecnica,
    });
    const retorno = extrairRetorno(resultado, { hoje: new Date(), defaultDias: 2 });
    resultadoAnalise = resultado;
    retornoAnalise = retorno;

    await setCustomField(taskId, CAMPOS_LIGACOES.ADERENCIA_SCRIPT, resultado.aderencia);
    await setCustomField(taskId, CAMPOS_LIGACOES.NECESSITA_REVISAO, revisao);
    await setCustomField(taskId, CAMPOS_LIGACOES.RETORNO_NECESSARIO, retorno.necessario);
    await setCustomField(
      taskId,
      CAMPOS_LIGACOES.DATA_RETORNO,
      retorno.data ? retorno.data.getTime() : null,
    );
    await setCustomField(taskId, CAMPOS_LIGACOES.ANALISE_IA, resultado.resumoAnalise);
    await setCustomField(taskId, CAMPOS_LIGACOES.OBSERVACOES_EXTRAIDAS, resultado.observacoesExtraidas);
    registrarSucessoEtapa('analise');
  } catch (e) {
    // D-P3-08: LLM fora do ar (ou parse/escrita falhou) — marca revisao e
    // segue, nunca trava a cadeia do processador. O helper de ClickUp
    // subjacente ainda lanca em falha de infra (WR-03); aqui so
    // distinguimos "precisa de revisao humana" de um erro que travaria o
    // job inteiro.
    registrarErroEtapa('analise');
    console.error('[processador] falha no Agente Analise, marcando NECESSITA_REVISAO:', e);
    try {
      await setCustomField(taskId, CAMPOS_LIGACOES.NECESSITA_REVISAO, true);
    } catch (e2) {
      console.error('[processador] falha ao marcar NECESSITA_REVISAO apos erro do Agente Analise:', e2);
    }
  }

  // ---- Agente Contexto (OPER-05, D-P3-06/12/13/14/15) — caminho ATENDIDO ----
  // Consolida o lead com o resultado da Analise (quando disponivel) e fecha
  // a Ligacao (D-P3-06). D-P3-15: sinais de alerta (opt-out inclusive)
  // entram no resumo consolidado — NUNCA removem o lead nem o tornam
  // inelegivel automaticamente, so a decisao humana (via NECESSITA_REVISAO,
  // ja gravado acima) faz isso.
  const sinaisTexto = resultadoAnalise?.sinaisAlerta?.length
    ? ` Sinais de alerta: ${resultadoAnalise.sinaisAlerta.join('; ')}.`
    : '';
  await consolidarEFecharLigacao(taskId, {
    atendeu: true,
    resumoAnalise: (resultadoAnalise?.resumoAnalise ?? '') + sinaisTexto,
    aderencia: resultadoAnalise?.aderencia ?? null,
    retorno: retornoAnalise ?? { necessario: false, data: null },
    voto: resultadoAnalise?.voto,
    votoEvidencia: resultadoAnalise?.votoEvidencia,
    analiseIaBase: resultadoAnalise?.resumoAnalise,
  });

  // CR-02: limpa a entrada telefone->task apos consolidar/fechar — uma
  // ligacao futura ao mesmo telefone nunca re-consolida sobre esta task ja
  // fechada. CR-01 (Fase 07): passa o mesmo deviceId usado na leitura acima
  // (`lerTaskAtiva(telefone, dados.deviceId)`) pra que a chave COMPOSTA
  // (deviceId|telefone) escrita por `guardarTaskAtiva` seja limpa junto — sem
  // isso a composta sobrevivia ate o TTL de 6h e um RECORD futuro do mesmo
  // (device, telefone) re-consolidava sobre esta Ligacao ja fechada. Sem
  // deviceId (modo telefone-so) o comportamento e identico ao de antes.
  await limparTaskAtiva(telefone, dados.deviceId);

  // Fecha o desfecho duravel do evento cru (Fase 2 — durabilidade).
  try {
    await marcarEventoWebhook(dados.eventoDuravelId, 'processado');
  } catch (e) {
    console.error('[processador] falha ao marcar evento record processado:', e);
  }

  // CR-02: SO AGORA (transcricao + analise + consolidacao + fechamento +
  // evento durave concluidos) grava a marca duravel de dedup. Uma reentrega
  // futura do MESMO call_id sera pulada pelo check read-only no inicio; um
  // crash antes daqui nao deixa marca, permitindo re-rodar o job por inteiro.
  await marcarRecordProcessado(callId);
}

// ===== finalizarRecordSemTranscricao — desfecho gracioso quando os retries esgotam =====
// (FILA-04, OPER-05; wired no worker.on('failed')/branch tentativasEsgotadas/job.name==='record')

/**
 * Desfecho GRACIOSO de um RECORD cuja transcricao esgotou as 3 tentativas do
 * BullMQ (transcreverCallUrl devolveu null a cada retry -> processarRecordJob
 * lancou -> tentativas esgotadas -> DLQ). Em vez de deixar a Ligacao ZUMBI
 * presa em "em processamento" para sempre (observado em producao), FECHA a
 * Ligacao (status complete), sinaliza NECESSITA_REVISAO=true + MOTIVO_FALHA e
 * MANTEM a URL da gravacao gravada na Ligacao para reprocesso manual futuro.
 *
 * ADITIVA, nao substitui a auditoria: o worker so chama esta funcao DEPOIS de
 * ja ter registrado o job na DLQ + disparado o alerta + marcado o evento cru
 * como 'erro'. Aqui apenas fechamos a Ligacao alem desse registro.
 *
 * Mesmo estilo de processarRecordJob: cada passo loga-e-segue, nunca lanca
 * (WR-03/D-P3-08); CR-02 crash-safe — recordJaProcessado no inicio (read-only)
 * e marcarRecordProcessado SO no FIM (um crash no meio deixa reprocessavel).
 *
 * LGPD/WR-01: nenhum telefone/CPF/transcricao/payload em log — so ids/flags/
 * status; telefone so aparece MASCARADO no caso de task nao resolvivel.
 */
export async function finalizarRecordSemTranscricao(dados: DadosJobRecord): Promise<void> {
  const { whatsappCallId: callId, telefone, recordUrl, payload } = dados;

  // CR-02: dedup CRASH-SAFE — mesmo check read-only do processarRecordJob.
  // Pula reentrega de um job JA concluido sem reivindicar a marca (a marca so
  // e setada no FIM, apos todo o efeito terminal).
  if (await recordJaProcessado(callId)) return;

  // D-P3-01: resolve a task da Ligacao exatamente como processarRecordJob —
  // 1) map in-memory (task reportada em /api/discador/ligando), 2) fallback
  // persistido no ClickUp (Ligacao aberta com o mesmo TELEFONE), 3) fallback
  // Ligacao avulsa. Sem nenhuma delas nao ha task a fechar — a DLQ/alerta ja
  // cobrem a auditoria; loga MASCARADO e retorna.
  let taskId = await lerTaskAtiva(telefone, dados.deviceId);
  if (!taskId) {
    try {
      taskId = await buscarLigacaoAbertaPorTelefone(telefone);
    } catch (e) {
      console.error('[processador] falha ao buscar Ligacao aberta por telefone (finalize sem transcricao):', e);
    }
  }
  if (!taskId) {
    try {
      const avulsa = await criarLigacaoAvulsa(telefone);
      taskId = avulsa.id;
    } catch (e) {
      console.error('[processador] falha ao criar Ligacao avulsa (finalize sem transcricao):', e);
    }
  }
  if (!taskId) {
    const mascarado = mascararTelefone(telefone);
    console.warn(`[processador] finalize sem transcricao sem Ligacao correlacionavel (telefone=${mascarado})`);
    return;
  }

  // Marca no field TRANSCRICAO o motivo — ajuda o operador que abrir a Ligacao
  // marcada NECESSITA_REVISAO a saber que a gravacao existe e pode ser
  // reprocessada. Loga-e-segue (o helper LANCA em falha de infra, WR-03).
  try {
    await gravarTranscricao(
      taskId,
      '(transcrição não obtida automaticamente após 3 tentativas — revisar manualmente)',
    );
  } catch (e) {
    console.error('[processador] falha ao gravar transcricao (finalize sem transcricao):', e);
  }

  // HOUVE gravacao (teveGravacao=true -> atendeu=true) — so a transcricao
  // falhou. Mantem urlGravacao na Ligacao para reprocesso manual futuro.
  try {
    await gravarMetadadosLigacao(taskId, {
      atendeu: derivarAtendeu(payload, true),
      fim: Date.now(),
      duracao: derivarDuracao(payload),
      urlGravacao: recordUrl,
    });
  } catch (e) {
    console.error('[processador] falha ao gravar metadados (finalize sem transcricao):', e);
  }

  // Sinaliza revisao humana + o motivo objetivo da falha. Cada um loga-e-segue.
  try {
    await setCustomField(taskId, CAMPOS_LIGACOES.NECESSITA_REVISAO, true);
  } catch (e) {
    console.error('[processador] falha ao marcar NECESSITA_REVISAO (finalize sem transcricao):', e);
  }
  try {
    await setCustomField(taskId, CAMPOS_LIGACOES.MOTIVO_FALHA, 'Transcrição não obtida após 3 tentativas');
  } catch (e) {
    console.error('[processador] falha ao gravar MOTIVO_FALHA (finalize sem transcricao):', e);
  }

  // Agente Contexto: consolida o lead (contadores/proximo contato; o LLM roda
  // com este resumo) E fecha a Ligacao (status complete) — o passo que tira a
  // task de "em processamento". atendeu:true (houve gravacao), sem aderencia
  // (nao houve analise de script).
  await consolidarEFecharLigacao(taskId, {
    atendeu: true,
    resumoAnalise:
      'Ligação atendida, mas a transcrição automática falhou após 3 tentativas — sem análise de script.',
    aderencia: null,
    retorno: { necessario: false, data: null },
  });

  // CR-01/CR-02: simetria com a leitura acima — limpa tambem a chave COMPOSTA
  // (deviceId|telefone) escrita por guardarTaskAtiva, senao ela vaza ate o TTL.
  await limparTaskAtiva(telefone, dados.deviceId);

  // Fecha o desfecho duravel do evento cru (Fase 2 — durabilidade).
  try {
    await marcarEventoWebhook(dados.eventoDuravelId, 'processado');
  } catch (e) {
    console.error('[processador] falha ao marcar evento record processado (finalize sem transcricao):', e);
  }

  // CR-02: SO AGORA (efeito terminal concluido) grava a marca duravel de dedup
  // — POR ULTIMO. Um crash antes daqui nao deixa marca, permitindo re-rodar.
  await marcarRecordProcessado(callId);
}
