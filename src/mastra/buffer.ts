// Buffer de mensagens — acumula mensagens do mesmo numero por TEMPO_ESPERA
// antes de processar, pra capturar contexto completo quando o usuario
// envia varias mensagens em sequencia.
//
// Fix #2 do review de prod: persistencia paralela no Supabase (tabela
// webhook_buffer_roberth). Cada msg adicionada ao buffer em memoria tambem
// e gravada no DB. Quando o timer dispara, lemos do DB com PATCH atomico
// (consumirBufferPendente) — captura msgs do nosso container OU de outros.
// Worker recovery (em follow-up.ts) pega orfas se o container que recebeu
// caiu antes do timer disparar.

import { inserirBufferRow, consumirBufferPendente } from './supabase';

type BufferEntry = {
  timer: ReturnType<typeof setTimeout>;
  nome: string;
};

const buffers = new Map<string, BufferEntry>();

export const TEMPO_ESPERA = 10_000; // 10 segundos

export type OnProcessarFn = (numero: string, textoCompleto: string, nome: string) => void;

/**
 * Adiciona mensagem ao buffer do numero.
 * - Persiste a msg no Supabase em paralelo (sobrevive restart).
 * - Mantem timer em memoria pro disparo rapido (otimizacao local).
 * - Quando o timer dispara, le do DB e processa todas as pendentes.
 *
 * @returns true se e a primeira mensagem do buffer (mostrar "digitando...")
 */
export function adicionarAoBuffer(
  numero: string,
  texto: string,
  nome: string,
  onProcessar: OnProcessarFn,
): boolean {
  const processarApos = new Date(Date.now() + TEMPO_ESPERA).toISOString();

  // Persistencia paralela (fire-and-forget — nao bloqueia o webhook).
  // Se o Supabase falhar, perdemos o recovery mas o buffer in-memory
  // continua funcionando pro fluxo normal.
  inserirBufferRow({ telefone: numero, texto, nome, processar_apos: processarApos })
    .catch((e) => console.error('[buffer] Erro persistir msg:', e));

  const existente = buffers.get(numero);

  if (existente) {
    existente.nome = nome;
    clearTimeout(existente.timer);
    existente.timer = setTimeout(() => disparar(numero, onProcessar), TEMPO_ESPERA);
    console.log(`[Buffer] +1 msg de ${numero}, timer resetado`);
    return false;
  }

  const entry: BufferEntry = {
    nome,
    timer: setTimeout(() => disparar(numero, onProcessar), TEMPO_ESPERA),
  };
  buffers.set(numero, entry);
  console.log(`[Buffer] Nova entrada para ${numero}, aguardando ${TEMPO_ESPERA / 1000}s`);
  return true;
}

/**
 * Disparado pelo timer (ou pelo worker de recovery em follow-up.ts).
 * Le do DB todas as msgs pendentes do telefone, marca processadas, e chama
 * onProcessar com o texto concatenado. PATCH atomico garante que se 2
 * processos chegarem ao mesmo tempo, so um pega as rows.
 */
export async function disparar(numero: string, onProcessar: OnProcessarFn): Promise<void> {
  const entry = buffers.get(numero);
  buffers.delete(numero);

  const result = await consumirBufferPendente(numero);
  if (!result || result.quantidade === 0) {
    // Outro processo (ou recovery) ja consumiu — nao processa de novo.
    return;
  }

  const nome = result.nome || entry?.nome || '';
  console.log(`[Buffer] Disparando ${numero} com ${result.quantidade} msg(s) consolidadas`);
  onProcessar(numero, result.textoConcatenado, nome);
}

/**
 * Cancela e remove o buffer pendente de um numero, sem disparar onProcessar.
 * Usado pelo comando de reset (#55555). Limpa apenas in-memory — as rows
 * no DB sao limpas pela rotina de cleanup periodica (limparBufferAntigo).
 */
export function removerBuffer(numero: string): void {
  const existente = buffers.get(numero);
  if (!existente) return;
  clearTimeout(existente.timer);
  buffers.delete(numero);
  console.log(`[Buffer] Cancelado e descartado: ${numero}`);
}
