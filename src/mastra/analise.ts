// Lógica pura de derivação de metadados da ligação (OPER-02, Fase 03 Plano 02).
//
// MÓDULO PURO: sem imports (nem relativos, nem de pacotes) — precisa ser
// importável via `node --experimental-strip-types` a partir dos scripts de
// smoke/runner sem depender de resolução de módulo do bundler. Mapas de
// field-id (CAMPOS_LIGACOES) são injetados pelo caller, nunca importados de
// clickup.ts.
//
// Regras de negócio (D-P3-05, ver 03-CONTEXT.md):
// - ATENDEU, MOTIVO_FALHA e DURACAO derivam do payload Wavoip (evento CALL
//   traz `status`/`direction`/`duration`; RECORD só existe quando houve
//   gravação) — preenchimento 100% automático, o operador não digita nada.
// - Vocabulário de `status` assumido (ACCEPT/ACTIVE/ANSWERED = atendido;
//   NOT_ANSWERED/UNANSWERED/REJECTED/MISSED = não atendido), combinado com
//   `duration > 0` E/OU a existência de gravação. Cada derivação é uma
//   função nomeada/isolada — o vocabulário real (confirmado nos logs do
//   webhook, checkpoint 03-05) pode ser ajustado sem tocar no resto.
// - Limitação aceita: caixa postal pode contar como "atendeu" (D-P3-05).

/** Subconjunto do payload Wavoip (eventos CALL/RECORD) que este módulo lê. */
export interface PayloadCallWavoip {
  status?: string;
  direction?: string;
  duration?: number | string;
  caller?: string;
  receiver?: string;
  record_url?: string;
}

/** Statuses que indicam que a ligação foi atendida (vocabulário assumido — D-P3-05). */
const STATUS_ATENDIDA = new Set(['ACCEPT', 'ACTIVE', 'ANSWERED']);

/** Statuses que indicam que a ligação NÃO foi atendida (vocabulário assumido — D-P3-05). */
const STATUS_NAO_ATENDIDA = new Set(['NOT_ANSWERED', 'UNANSWERED', 'REJECTED', 'MISSED']);

function paraNumero(valor: unknown): number {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

function statusNormalizado(payload: PayloadCallWavoip): string {
  return String(payload.status || '').toUpperCase();
}

/**
 * Deriva `duracao` (segundos) a partir de `duration` do payload Wavoip — 0
 * se ausente/inválido. Isolada/nomeada para o cálculo poder mudar sem tocar
 * no resto (mesmo racional de `derivarRetornoNecessario` em lote.ts).
 */
export function derivarDuracao(payload: PayloadCallWavoip): number {
  return paraNumero(payload.duration);
}

/**
 * Deriva se a ligação foi ATENDIDA (D-P3-05): true quando o `status` do
 * payload indica atendida OU (`duration > 0` OU `teveGravacao === true`).
 * false quando o `status` indica explicitamente não-atendida, mesmo com
 * duration > 0 (ex.: toque residual antes de rejeitar). Isolada/nomeada —
 * o vocabulário de `status` pode ser ajustado após confirmação nos logs
 * (checkpoint 03-05) sem tocar no resto da cadeia.
 */
export function derivarAtendeu(payload: PayloadCallWavoip, teveGravacao: boolean): boolean {
  const status = statusNormalizado(payload);
  if (STATUS_NAO_ATENDIDA.has(status)) return false;
  if (STATUS_ATENDIDA.has(status)) return true;
  return derivarDuracao(payload) > 0 || teveGravacao === true;
}

/**
 * Deriva o motivo de falha (D-P3-05) quando a ligação NÃO foi atendida —
 * string vazia quando atendeu. Mapeamento do `status` normalizado para um
 * texto em português; status desconhecido cai num motivo genérico (nunca
 * some silenciosamente, T-02-02-E). Diferente de `derivarAtendeu`, esta
 * função não recebe `teveGravacao` — quando o `status` não indica nem
 * atendida nem não-atendida, usa `duration > 0` como sinal de atendida
 * (mesma heurística, sem o sinal extra de gravação).
 */
export function derivarMotivoFalha(payload: PayloadCallWavoip): string {
  const status = statusNormalizado(payload);
  if (STATUS_ATENDIDA.has(status)) return '';
  if (status === 'NOT_ANSWERED' || status === 'UNANSWERED') return 'não atendida';
  if (status === 'REJECTED') return 'recusada';
  if (status === 'MISSED') return 'perdida';
  if (derivarDuracao(payload) > 0) return '';
  if (!status) return 'motivo desconhecido (status ausente)';
  return `não atendida (status=${status})`;
}
