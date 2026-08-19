// Edge-trigger de alerta de queda do device Wavoip de um ATENDENTE (Quick
// 260819-p1r). Generaliza pro DEVICE do webhook Wavoip o mesmo padrão
// anti-flap já usado pra queda do CHIP global (index.ts ~2236: cooldown +
// "só a transição dispara, heartbeat repetido não").
//
// Função PURA: sem I/O, sem rede, sem env, sem Date.now() interno (recebe
// `agora` do caller) — mesmo estilo de mascarar.ts/dispositivos.ts. Isso
// deixa o webhook fino (extrai, mapeia, chama esta função, posta se mandar)
// e o teste determinístico sem rede (scripts/alerta-queda-device.smoke.mjs).
//
// RESSALVA (mesma limitação do alerta de chip atual): o Map que guarda
// EstadoDeviceAlerta por device vive em memória NO CALLER (index.ts),
// por-réplica/por-processo. Em multi-réplica cada réplica tem seu próprio
// estado — uma queda pode, no pior caso, ser anunciada mais de uma vez (uma
// por réplica que receber o evento DEVICE). O cooldown (ALERTA_QUEDA_COOLDOWN_MS)
// limita a repetição dentro da janela; resolver de vez pediria estado
// compartilhado (Redis), fora de escopo desta quick task — fica pra depois.

/** Estado acumulado de alerta de um device específico. */
export interface EstadoDeviceAlerta {
  /** true quando o device está atualmente considerado caído (não-'open'). */
  caido: boolean;
  /** epoch ms do último alerta efetivamente disparado para este device (0 = nunca). */
  ultimoAlertaTs: number;
}

/** Decisão retornada pela função pura de edge-trigger. */
export interface DecisaoAlertaDevice {
  /** true quando o caller deve postar no grupo (queda ou volta). */
  disparar: boolean;
  /** tipo do alerta a postar quando disparar=true; null quando disparar=false. */
  tipo: 'queda' | 'volta' | null;
  /** novo estado a persistir no Map do caller (chave = deviceId/chave conhecida). */
  novoEstado: EstadoDeviceAlerta;
}

const ESTADO_INICIAL: EstadoDeviceAlerta = { caido: false, ultimoAlertaTs: 0 };

/**
 * Decide se a transição de conectividade de um device deve disparar alerta
 * no grupo — edge-trigger (só a TRANSIÇÃO conectado->caído ou caído->conectado
 * dispara) + cooldown por-device (não re-alerta a mesma queda em aberto dentro
 * da janela).
 *
 * @param estadoAtual Estado anterior deste device (undefined = device nunca
 *   visto antes; tratado como { caido:false, ultimoAlertaTs:0 }).
 * @param conectado true quando o evento atual reporta o device 'open';
 *   false para qualquer outro status (hibernating/close/connecting/etc).
 * @param agora epoch ms do evento atual (injetado pelo caller — sem Date.now() aqui).
 * @param cooldownMs janela mínima entre alertas de QUEDA consecutivos para o mesmo device.
 */
export function decidirAlertaQuedaDevice(
  estadoAtual: EstadoDeviceAlerta | undefined,
  conectado: boolean,
  agora: number,
  cooldownMs: number,
): DecisaoAlertaDevice {
  const estado = estadoAtual ?? ESTADO_INICIAL;

  if (!estado.caido && conectado) {
    // CASO 1 (1º 'open' de device novo) / CASO 5 (heartbeat 'open' repetido,
    // já conectado): nunca dispara — não há transição.
    return { disparar: false, tipo: null, novoEstado: { caido: false, ultimoAlertaTs: estado.ultimoAlertaTs } };
  }

  if (!estado.caido && !conectado) {
    // Transição open -> caído.
    const dentroDoCooldown = agora - estado.ultimoAlertaTs < cooldownMs;
    if (dentroDoCooldown) {
      // CASO 2b: marca caído mas NÃO dispara (ainda dentro do cooldown do
      // alerta anterior — mesmo racional do anti-flap do chip).
      return { disparar: false, tipo: null, novoEstado: { caido: true, ultimoAlertaTs: estado.ultimoAlertaTs } };
    }
    // CASO 2: fora do cooldown — dispara queda.
    return { disparar: true, tipo: 'queda', novoEstado: { caido: true, ultimoAlertaTs: agora } };
  }

  if (estado.caido && !conectado) {
    // CASO 3 (heartbeat caído repetido): não re-dispara.
    return { disparar: false, tipo: null, novoEstado: { caido: true, ultimoAlertaTs: estado.ultimoAlertaTs } };
  }

  // estado.caido && conectado — CASO 4 (reconexão): dispara volta e reseta.
  return { disparar: true, tipo: 'volta', novoEstado: { caido: false, ultimoAlertaTs: agora } };
}
