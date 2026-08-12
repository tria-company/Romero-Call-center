#!/usr/bin/env node
// scripts/reprocessar-eventos.mjs
//
// CLI SERVER-SIDE de reprocesso da DLQ/pendentes a partir de `webhook_eventos`
// (FILA-06/FILA-04, Fase 06 Plano 05). O gestor roda este script na VPS
// (SUPABASE_SERVICE_KEY + REDIS_URL do ambiente — o MESMO Redis compartilhado
// que guarda a correlação call->telefone, INFRA-01/Fase 05) para recuperar
// eventos que ficaram 'recebido' (nunca processados) ou 'erro' (esgotaram
// FILA_ATTEMPTS e caíram na DLQ). Não há rota HTTP equivalente — reprocesso
// exige shell/segredo na VPS (T-06-05-AUTH).
//
// Fluxo por evento:
//   - RECORD (READY, record_url presente): RECUPERA o telefone via
//     `lerCorrelacao(whatsapp_call_id)` — Redis GET, TTL 6h, o MESMO caminho
//     que o webhook usa no branch RECORD. Só PULA (não reprocessa às cegas,
//     não marca processado) quando `lerCorrelacao` retorna null — edge case
//     estreito de correlação expirada (>6h) ou CALL ausente.
//   - CALL terminal (`ehStatusFalhaTerminal`): telefone via
//     `telefoneDoEventoCall`.
//   - Outros tipos (DEVICE, CALL não-terminal, RECORD não-READY): ignorados —
//     não têm processamento pesado associado.
// CR-03: reprocessa SEMPRE INLINE (chama `processar*Job` direto), NAO enfileira.
// A DLQ e o set `failed` do BullMQ, mantido por `removeOnFail:false` (fila.ts) —
// re-enfileirar com o MESMO `jobId` (whatsappCallId) e um NO-OP: o BullMQ retorna
// o job falho existente sem re-executa-lo, entao a ferramenta cujo proposito e
// DRENAR a DLQ nao recuperaria nada em modo bullmq. Rodar inline (esta e uma
// ferramenta server-side de recuperacao em lote — inline e correto) re-executa
// de fato; combinado com o dedup CRASH-SAFE do processador (CR-02: a marca de
// "processado" so e gravada apos o efeito terminal), um evento em DLQ/'erro'
// nunca foi marcado e re-roda por inteiro, enquanto um evento ja concluido com
// sucesso e pulado pelo check read-only no inicio do job. Log-e-segue por evento
// — uma falha isolada não aborta os demais. NUNCA loga telefone/CPF/payload — só
// contagem/ids/status (LGPD, T-06-05-INFO).
//
// Uso: node --experimental-strip-types scripts/reprocessar-eventos.mjs
//        [--status erro,recebido] [--limite N] [--call <whatsapp_call_id>]

import { listarEventosParaReprocesso } from '../src/mastra/supabase.ts';
import { lerCorrelacao } from '../src/mastra/estado-webhook.ts';
import { modoFila } from '../src/mastra/fila.ts';
import { processarRecordJob, processarFalhaTerminalJob } from '../src/mastra/processador.ts';
import { ehStatusFalhaTerminal } from '../src/mastra/analise.ts';

// telefoneDoEventoCall é replicada aqui (não importada de src/mastra/index.ts)
// — desvio documentado do plano (que previa import, com esta réplica como
// fallback explícito "se não for exportável"). `index.ts` é o ENTRYPOINT HTTP
// do Mastra: várias de suas importações relativas (`./config`,
// `./discador-auth`, `./ghl`, `./operadores`, `./analise`, `./discador-pwa`,
// `./supabase`) são SEM extensão — resolvidas pelo bundler do Mastra
// (`mastra dev`/`build`), mas o loader ESM nativo do Node
// (`--experimental-strip-types`, usado por este CLI standalone) EXIGE
// extensão explícita e falha com `ERR_MODULE_NOT_FOUND` ao carregar
// `index.ts` fora do Mastra. Consertar as extensões em `index.ts` está fora
// do escopo deste plano (não está em `files_modified`) e arriscaria alterar
// o entrypoint do servidor por um efeito colateral do CLI. Cópia fiel,
// byte-a-byte, da função em `src/mastra/index.ts`.
function telefoneDoEventoCall(payload) {
  const direction = String(payload.direction || '').toUpperCase();
  const raw = direction === 'INCOMING'
    ? String(payload.caller || '')
    : String(payload.receiver || payload.caller || '');
  return raw.replace(/[^\d]/g, '');
}

function parseArgs(argv) {
  const opts = { status: ['erro', 'recebido'], limite: 100, call: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--status') {
      opts.status = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--limite') {
      opts.limite = Number(argv[++i]) || 100;
    } else if (arg === '--call') {
      opts.call = String(argv[++i] || '') || undefined;
    }
  }
  return opts;
}

/** RECORD com gravação pronta (mesmo gate do branch RECORD do webhook). */
function ehRecordPronto(payload) {
  if (String(payload?.type || '').toUpperCase() !== 'RECORD') return false;
  const recordStatus = String(payload?.record_status || payload?.status || '').toUpperCase();
  const recordUrl = String(payload?.record_url || payload?.recordUrl || '');
  return recordStatus === 'READY' && Boolean(recordUrl);
}

/** CALL com falha terminal CONFIRMADA (mesmo gate CR-01 do branch CALL do webhook). */
function ehCallFalhaTerminal(payload) {
  return String(payload?.type || '').toUpperCase() === 'CALL' && ehStatusFalhaTerminal(payload);
}

/**
 * CR-03: reprocessa SEMPRE INLINE — chama a MESMA função que o worker chamaria
 * (`processar*Job`), independente de `modoFila()`. NAO enfileira: re-adicionar
 * um job com `jobId` ainda presente no set `failed` (removeOnFail:false) e um
 * no-op no BullMQ (retorna o job falho sem re-executar), o que faria a
 * ferramenta reportar sucesso sem recuperar nada. Inline re-executa de fato; o
 * dedup crash-safe do processador (CR-02) garante que so jobs ja concluidos com
 * sucesso sao pulados.
 */
async function despachar(job, dados) {
  if (job === 'record') await processarRecordJob(dados);
  else await processarFalhaTerminalJob(dados);
  return 'processado-inline';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `[reprocessar-eventos] modo=${modoFila()} status=[${opts.status.join(',')}] limite=${opts.limite}` +
      (opts.call ? ` call=${opts.call}` : ''),
  );

  let eventos = await listarEventosParaReprocesso({ status: opts.status, limite: opts.limite });
  if (opts.call) eventos = eventos.filter((e) => e.whatsapp_call_id === opts.call);
  console.log(`[reprocessar-eventos] ${eventos.length} evento(s) a avaliar`);

  let reprocessados = 0;
  let puladosSemCorrelacao = 0;
  let ignorados = 0;
  let falharam = 0;

  for (const evento of eventos) {
    const payload = evento.payload;
    try {
      if (ehRecordPronto(payload)) {
        if (!evento.whatsapp_call_id) {
          console.warn(`[reprocessar-eventos] RECORD id=${evento.id} sem whatsapp_call_id — pulando`);
          puladosSemCorrelacao++;
          continue;
        }
        // Fonte PRIMÁRIA do telefone: recupera a correlação call->telefone
        // (Redis compartilhado, TTL 6h) — idêntico ao branch RECORD do
        // webhook em produção. SÓ pula quando expirou/ausente (edge case
        // estreito e documentado) — o caminho normal é RECUPERAR e reprocessar.
        const telefone = await lerCorrelacao(evento.whatsapp_call_id);
        if (!telefone) {
          console.warn(
            `[reprocessar-eventos] RECORD id=${evento.id} sem correlação (TTL 6h expirado ou CALL ausente) — pulando`,
          );
          puladosSemCorrelacao++;
          continue;
        }
        const recordUrl = String(payload.record_url || payload.recordUrl || '');
        const dados = {
          whatsappCallId: evento.whatsapp_call_id,
          telefone,
          recordUrl,
          payload,
          eventoDuravelId: evento.id,
        };
        const desfecho = await despachar('record', dados);
        console.log(`[reprocessar-eventos] RECORD id=${evento.id} call=${evento.whatsapp_call_id} -> ${desfecho}`);
        reprocessados++;
      } else if (ehCallFalhaTerminal(payload)) {
        const telefone = telefoneDoEventoCall(payload);
        if (!telefone) {
          console.warn(`[reprocessar-eventos] CALL id=${evento.id} sem telefone derivável — pulando`);
          puladosSemCorrelacao++;
          continue;
        }
        const dados = {
          whatsappCallId: evento.whatsapp_call_id || '',
          telefone,
          payload,
          eventoDuravelId: evento.id,
        };
        const desfecho = await despachar('falha-terminal', dados);
        console.log(
          `[reprocessar-eventos] CALL(falha-terminal) id=${evento.id} call=${evento.whatsapp_call_id} -> ${desfecho}`,
        );
        reprocessados++;
      } else {
        // DEVICE, CALL não-terminal, RECORD não-pronto etc — sem
        // processamento pesado associado, nada a reprocessar.
        ignorados++;
      }
    } catch (e) {
      falharam++;
      console.error(
        `[reprocessar-eventos] falha ao reprocessar id=${evento.id}:`,
        e instanceof Error ? e.message : String(e),
      );
      // Log-e-segue: um evento que falha não aborta os demais.
    }
  }

  console.log(
    `[reprocessar-eventos] resumo: reprocessados=${reprocessados} ` +
      `pulados-sem-correlacao=${puladosSemCorrelacao} ignorados=${ignorados} falharam=${falharam}`,
  );
}

main();
