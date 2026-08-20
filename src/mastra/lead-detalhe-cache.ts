// Cache resiliente do DETALHE do lead (Lista 01), quick 260819-v2a.
//
// Espelha FIELMENTE o precedente sancionado da fila resiliente
// (index.ts:455-484 — filaMem/buscarFilaResiliente/derrubarFilaMem):
// stale-while-revalidate + dedup em-voo, colchão do processo em memória
// (existe mesmo sem Redis; v2 = Redis `cache:lead:<taskId>`).
//
// Módulo FOLHA de propósito (D-1): importa só de `./clickup.ts` (que não
// importa nada deste arquivo nem de `index.ts`/`gerar-dossie.ts`) — assim
// tanto `index.ts` quanto `gerar-dossie.ts` podem importar daqui sem criar
// ciclo (gerar-dossie precisa invalidar o cache após regenerar o dossiê).
//
// Fresco por 30s (mesma faixa de PAINEL_TTL_CLICKUP_MS) — a leitura do
// detalhe do lead (card + overlay + timeline) deixa de bater o ClickUp a
// cada abertura. Falha de INFRA com cópia existente serve a última cópia
// boa (de QUALQUER idade) em vez de 502 — sem cópia, relança (WR-03,
// primeiro load). Falha de VALIDAÇÃO (lead inexistente / fora da Lista 01)
// SEMPRE relança — nunca stale-serve, nunca cacheia: mascarar um 404 com
// cópia velha seria servir um lead que não existe (T-v2a-01).
//
// LGPD: warn de stale-serve só com leadTaskId + idade em segundos — nunca
// telefone/CPF/conteúdo de ficha ou dossiê.

import { lerLeadDetalhe } from './clickup.ts';

type ValorLeadDetalhe = Awaited<ReturnType<typeof lerLeadDetalhe>>;

const memoria = new Map<string, { valor: ValorLeadDetalhe; em: number }>();
const emVoo = new Map<string, Promise<ValorLeadDetalhe>>();

const TTL_LEAD_DETALHE_MS = 30_000; // fresco por 30s, faixa PAINEL_TTL_CLICKUP_MS
const CAP_MEMORIA = 500; // T-v2a-03: evita crescimento ilimitado do Map (evict do mais antigo)

/** Mensagens de erro de VALIDAÇÃO — as MESMAS strings de clickup.ts:2129/2132
 * e do mapeamento 404 em index.ts:1445. Erro de validação nunca é mascarado
 * por cópia velha (T-v2a-01). */
function ehErroDeValidacao(msg: string): boolean {
  return msg.includes('nao encontrada') || msg.includes('nao e um Lead da Lista 01');
}

/**
 * Lê o detalhe do lead com cache stale-while-revalidate + dedup em-voo
 * (espelho de `buscarFilaResiliente`, index.ts:468-485). `ler` e `agora` são
 * seams de teste (D-3) — em produção usam os defaults reais.
 */
export async function lerLeadDetalheResiliente(
  leadTaskId: string,
  ler: (id: string) => Promise<ValorLeadDetalhe> = lerLeadDetalhe,
  agora: () => number = Date.now,
): Promise<ValorLeadDetalhe> {
  const copia = memoria.get(leadTaskId);
  if (copia && agora() - copia.em < TTL_LEAD_DETALHE_MS) return copia.valor;

  const jaEmVoo = emVoo.get(leadTaskId);
  if (jaEmVoo) return jaEmVoo;

  const p = (async () => {
    try {
      const valor = await ler(leadTaskId);
      memoria.set(leadTaskId, { valor, em: agora() });
      if (memoria.size > CAP_MEMORIA) {
        const chaveMaisAntiga = memoria.keys().next().value;
        if (chaveMaisAntiga !== undefined) memoria.delete(chaveMaisAntiga);
      }
      return valor;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (ehErroDeValidacao(msg)) throw e; // T-v2a-01: nunca stale-serve, nunca cacheia.
      if (copia) {
        console.warn(
          `[discador] detalhe do lead ${leadTaskId} falhou — servindo cópia de ${Math.round((agora() - copia.em) / 1000)}s atrás:`,
          msg,
        );
        return copia.valor;
      }
      throw e; // primeiro load, sem cópia: relança (WR-03).
    } finally {
      emVoo.delete(leadTaskId);
    }
  })();

  emVoo.set(leadTaskId, p);
  return p;
}

/** Derruba a cópia em memória de um lead (read-your-writes: voto, anotação,
 * regeneração do dossiê). Espelho de `derrubarFilaMem` (index.ts:465-467). */
export function derrubarLeadDetalheMem(leadTaskId: string): void {
  memoria.delete(leadTaskId);
  emVoo.delete(leadTaskId);
}
