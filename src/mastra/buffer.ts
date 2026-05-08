// Buffer de mensagens — acumula mensagens do mesmo numero por TEMPO_ESPERA
// antes de processar, para capturar contexto completo quando o usuario
// envia varias mensagens em sequencia.

type BufferEntry = {
  mensagens: string[];
  timer: ReturnType<typeof setTimeout>;
  nome: string;
};

const buffers = new Map<string, BufferEntry>();

const TEMPO_ESPERA = 10_000; // 10 segundos

/**
 * Adiciona mensagem ao buffer do numero.
 * - Se ja tem buffer: acumula e reseta o timer.
 * - Se nao tem: cria novo buffer com timer de 30s.
 * - Quando o timer dispara, chama onProcessar com todas as mensagens juntas.
 * @returns true se e a primeira mensagem (mostrar "digitando...")
 */
export function adicionarAoBuffer(
  numero: string,
  texto: string,
  nome: string,
  onProcessar: (numero: string, textoCompleto: string, nome: string) => void,
): boolean {
  const existente = buffers.get(numero);

  if (existente) {
    existente.mensagens.push(texto);
    existente.nome = nome;
    clearTimeout(existente.timer);
    existente.timer = setTimeout(() => {
      const textoFinal = existente.mensagens.join('\n');
      buffers.delete(numero);
      onProcessar(numero, textoFinal, existente.nome);
    }, TEMPO_ESPERA);
    console.log(`[Buffer] +1 msg de ${numero} (total: ${existente.mensagens.length}), timer resetado`);
    return false;
  }

  const entry: BufferEntry = {
    mensagens: [texto],
    nome,
    timer: setTimeout(() => {
      const textoFinal = entry.mensagens.join('\n');
      buffers.delete(numero);
      onProcessar(numero, textoFinal, entry.nome);
    }, TEMPO_ESPERA),
  };
  buffers.set(numero, entry);
  console.log(`[Buffer] Nova entrada para ${numero}, aguardando ${TEMPO_ESPERA / 1000}s`);
  return true;
}

/**
 * Cancela e remove o buffer pendente de um numero, sem disparar onProcessar.
 * Usado pelo comando de reset (#55555) e em outros casos onde queremos
 * descartar mensagens em transito.
 */
export function removerBuffer(numero: string): void {
  const existente = buffers.get(numero);
  if (!existente) return;
  clearTimeout(existente.timer);
  buffers.delete(numero);
  console.log(`[Buffer] Cancelado e descartado: ${numero} (${existente.mensagens.length} msg)`);
}
