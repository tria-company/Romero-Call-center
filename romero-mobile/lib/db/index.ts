/**
 * SUPERFÍCIE PÚBLICA DA CAMADA DE DADOS.
 *
 * Telas importam SOMENTE daqui. Hoje `store.ts` guarda tudo em localStorage;
 * trocar por Postgres/Supabase é reescrever aquele arquivo (ou apontar cada
 * função para uma rota `/api/*`) sem tocar em mais nada.
 */

export * from "./schema";
export * from "./hooks";
export {
  inicializar,
  registrarInteracao,
  salvarAnotacao,
  confirmarApoio,
  marcarItemFila,
  empurrarParaFila,
  criarSolicitacao,
  assumirSolicitacao,
  resolverSolicitacao,
  ressemear,
  exportarJson,
  novoId,
} from "./store";
export type { NovaSolicitacao } from "./store";
export { ordenarFila, VERSAO_BANCO } from "./seed";
