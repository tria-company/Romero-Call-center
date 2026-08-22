// Checagem periódica de threshold + alerta Slack (Fase 10 Plano 04, D-07,
// OBS-02).
//
// DLQ > 0 já alerta evento-a-evento (fila.ts:alertarDLQ, D-05). Este módulo
// cobre o outro lado: profundidade de fila, taxa de erro por etapa e 429s do
// ClickUp ACIMA de um limite configurado (config.ts METRICAS_*) disparam uma
// notificação pelo MESMO canal Slack (ALERT_WEBHOOK_URL) — sem isso o painel
// só exibe, não avisa (D-07). Roda como setInterval dentro do processo
// worker (serviço único, replicas:1) — nunca no processo web, que pode ter
// múltiplas réplicas e spammaria o mesmo alerta em duplicidade (T-10-04-I2,
// aceito: lock Redis por tick fica documentado abaixo como opção futura SE
// o worker um dia escalar para >1 réplica).
//
// LGPD/OBS-03: o payload Slack de threshold NUNCA carrega telefone/CPF/voto
// — só o nome da métrica (ou da etapa), o valor atual e o limite configurado
// (T-10-04-I1). alertarThreshold() segue o MOLDE EXATO de alertarDLQ()
// (fila.ts:221-251): console.error estruturado primeiro (sempre, mesmo sem
// ALERT_WEBHOOK_URL), depois POST best-effort dentro de try/catch que só
// loga em falha e NUNCA relança — a checagem de threshold é observabilidade,
// nunca pode derrubar o worker (T-10-04-D2).
//
// Anti-flood/dedup (T-10-04-D1): a checagem roda a cada
// METRICAS_ALERTA_INTERVALO_MS. Sem dedup, uma métrica presa acima do limite
// por horas dispararia um alerta Slack POR TICK. Em vez de cooldown por
// tempo, uso edge-trigger por métrica: um Set de módulo guarda quais chaves
// (ex. 'fila', 'etapa:transcricao', '429') já estão em estado "alertado";
// só dispara de novo quando a métrica volta abaixo do limite e sobe outra
// vez (a chave sai do Set quando cai abaixo, entra quando sobe acima). Mais
// simples que cooldown por tempo e garante zero alerta duplicado enquanto a
// condição persiste.

import { lerMetricas, type MetricasSnapshot, type EtapaMetrica } from './metricas.ts';
import {
  ALERT_WEBHOOK_URL,
  METRICAS_FILA_ALERTA,
  METRICAS_ERRO_TAXA_ALERTA,
  METRICAS_429_ALERTA,
  METRICAS_ALERTA_INTERVALO_MS,
} from './config.ts';

/**
 * Total mínimo de amostras (erros+sucessos) numa etapa antes de considerar a
 * taxa de erro representativa o bastante para alertar — evita ruído de
 * amostra pequena (ex.: 1 erro em 1 tentativa = 100% de taxa, mas não é
 * sinal de problema real). Não é uma env var (D-07 não pediu configuração
 * fina aqui) — valor fixo conservador.
 */
const MIN_TOTAL_ETAPA_ALERTA = 10;

export interface AlertaThreshold {
  chave: string; // identifica a métrica p/ dedup edge-trigger — ex. 'fila', 'etapa:transcricao', '429'
  titulo: string;
  detalhe: string;
}

/**
 * Compara o snapshot de métricas contra os thresholds configurados e
 * retorna a lista de alertas que DEVERIAM disparar agora (função pura,
 * testável sem rede/timer — usada pelo smoke). Não faz I/O nem lida com
 * dedup/estado — isso é responsabilidade do chamador (tick do setInterval).
 */
export function avaliarThresholds(snapshot: MetricasSnapshot): AlertaThreshold[] {
  const alertas: AlertaThreshold[] = [];

  if (snapshot.profundidadeFila > METRICAS_FILA_ALERTA) {
    alertas.push({
      chave: 'fila',
      titulo: '⚠️ Profundidade da fila acima do limite',
      detalhe: `atual ${snapshot.profundidadeFila} vs. limite ${METRICAS_FILA_ALERTA}`,
    });
  }

  for (const etapa of Object.keys(snapshot.taxaErroPorEtapa) as EtapaMetrica[]) {
    const { taxa, total } = snapshot.taxaErroPorEtapa[etapa];
    if (total >= MIN_TOTAL_ETAPA_ALERTA && taxa > METRICAS_ERRO_TAXA_ALERTA) {
      alertas.push({
        chave: `etapa:${etapa}`,
        titulo: `⚠️ Taxa de erro na ${etapa} acima do limite`,
        detalhe: `atual ${(taxa * 100).toFixed(1)}% (${total} amostras) vs. limite ${(METRICAS_ERRO_TAXA_ALERTA * 100).toFixed(1)}%`,
      });
    }
  }

  if (snapshot.contagem429 > METRICAS_429_ALERTA) {
    alertas.push({
      chave: '429',
      titulo: '⚠️ 429s do ClickUp acima do limite',
      detalhe: `atual ${snapshot.contagem429} vs. limite ${METRICAS_429_ALERTA}`,
    });
  }

  return alertas;
}

/**
 * Alerta best-effort de threshold — MESMO molde de alertarDLQ()
 * (fila.ts:221-251): console.error estruturado ANTES do POST (sempre, nunca
 * PII), depois no-op se ALERT_WEBHOOK_URL vazio, depois POST dentro de
 * try/catch que só loga em falha e NUNCA relança.
 */
export async function alertarThreshold(titulo: string, detalhe: string): Promise<void> {
  console.error(`[ALERTA][THRESHOLD] titulo=${titulo} detalhe=${detalhe}`);

  if (!ALERT_WEBHOOK_URL) return;

  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `${titulo}\n${detalhe}` }),
    });
  } catch (e) {
    console.error(
      '[alertas] falha ao enviar alerta de threshold via webhook (degradando p/ so-log):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Cooldown (ms) por operador do alerta de degradação de device (A2, Pacote A
 * / incidente 2026-08-22, T-mfp-05) — molde fixo de MIN_TOTAL_ETAPA_ALERTA
 * acima (não é env, D-07 não pediu configuração fina aqui). Evita flood: sem
 * isso, cada /api/discador/config de um operador em modo degradado dispararia
 * um alerta Slack POR REQUISIÇÃO.
 */
const DEVICE_ALERTA_COOLDOWN_MS = 15 * 60_000;

/** Último disparo (epoch ms) de alertarDeviceDegradado por operador — dedup por cooldown, não edge-trigger (chave = usuario). */
const ultimoAlertaDevicePorOperador = new Map<string, number>();

/**
 * Alerta best-effort de degradação de device (A2, Pacote A / incidente
 * 2026-08-22): dispara quando `resolverConfigDoUsuario` resolve 'global' (chip
 * órfão compartilhado) ou 'indisponivel' (device dedicado sem token) — MESMO
 * MOLDE de `alertarThreshold` acima: console.error estruturado ANTES do POST
 * (sempre, mesmo sem ALERT_WEBHOOK_URL), depois no-op se ALERT_WEBHOOK_URL
 * vazio, depois POST best-effort dentro de try/catch que só loga em falha e
 * NUNCA relança. LGPD/segredo (T-mfp-01): log e payload carregam SOMENTE
 * usuario/modo/deviceId — NUNCA token/telefone/CPF.
 *
 * Cooldown por operador (T-mfp-05, 15min): se o mesmo operador já alertou
 * dentro da janela, retorna sem alertar (nem log nem POST) — evita flood de
 * um operador preso em modo degradado batendo /config repetidamente. Nota
 * (mesmo espírito do T-10-04-I2 de alertas.ts): o cooldown é POR-PROCESSO —
 * o web pode ter réplicas, então até N alertas/15min/operador (N = número de
 * réplicas) é aceitável, não um lock distribuído.
 */
export async function alertarDeviceDegradado(usuario: string, modo: string, deviceId: string | null): Promise<void> {
  const agora = Date.now();
  const ultimo = ultimoAlertaDevicePorOperador.get(usuario);
  if (ultimo !== undefined && agora - ultimo < DEVICE_ALERTA_COOLDOWN_MS) return;
  ultimoAlertaDevicePorOperador.set(usuario, agora);

  console.error(`[ALERTA][DEVICE] usuario=${usuario} modo=${modo} deviceId=${deviceId ?? ''}`);

  if (!ALERT_WEBHOOK_URL) return;

  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `⚠️ Device degradado — operador ${usuario} em modo '${modo}'${deviceId ? ` (deviceId ${deviceId})` : ''}`,
      }),
    });
  } catch (e) {
    console.error(
      '[alertas] falha ao enviar alerta de device degradado via webhook (degradando p/ so-log):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

// ===== Checagem periódica — setInterval de módulo, idempotente =====

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Chaves atualmente em estado "alertado" (edge-trigger dedup, T-10-04-D1). */
const chavesAlertadas = new Set<string>();

async function tick(): Promise<void> {
  try {
    const snapshot = await lerMetricas();
    const alertasAtivos = avaliarThresholds(snapshot);
    const chavesAtivasAgora = new Set(alertasAtivos.map((a) => a.chave));

    for (const alerta of alertasAtivos) {
      if (!chavesAlertadas.has(alerta.chave)) {
        chavesAlertadas.add(alerta.chave);
        await alertarThreshold(alerta.titulo, alerta.detalhe);
      }
    }

    // Métrica voltou abaixo do limite — libera a chave p/ poder re-alertar
    // se subir de novo (edge-trigger).
    for (const chave of chavesAlertadas) {
      if (!chavesAtivasAgora.has(chave)) chavesAlertadas.delete(chave);
    }
  } catch (e) {
    // Nunca deixa o loop lançar — degradação graciosa (T-10-04-D2), o
    // checador simplesmente tenta de novo no próximo tick.
    console.error('[alertas] falha na checagem periódica (tentando de novo no próximo tick):', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Inicia a checagem periódica de threshold (setInterval de
 * METRICAS_ALERTA_INTERVALO_MS). Idempotente — uma segunda chamada não cria
 * um segundo interval. `unref()` no timer para não segurar o processo vivo
 * (o graceful shutdown do worker chama fecharAlertas() explicitamente).
 *
 * Se o worker um dia escalar para >1 réplica (hoje replicas:1 é o default),
 * um lock Redis curto por tick (ex. SET NX PX no início de tick())
 * evitaria múltiplas réplicas disparando o mesmo alerta em paralelo — não
 * implementado agora porque não é necessário (T-10-04-I2, accept).
 */
export function iniciarChecagemAlertas(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => void tick(), METRICAS_ALERTA_INTERVALO_MS);
  intervalHandle.unref?.();
  console.log(`[alertas] checagem periódica de threshold ativa (intervalo=${METRICAS_ALERTA_INTERVALO_MS}ms)`);
}

/** Para a checagem periódica (graceful shutdown do worker). No-op se não iniciada. */
export function fecharAlertas(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
