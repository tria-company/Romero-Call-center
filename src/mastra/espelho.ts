// Sincronizador ClickUp -> ESPELHO (u10): copia os leads da Lista 01 pro read-model
// Postgres (`discador_leads_espelho`) pra a Base do painel ser rápida (ms em vez de
// ~2,7s/página no ClickUp). O ClickUp CONTINUA a fonte da verdade — este é só um
// cache de leitura, sincronizado em 2º plano + write-through no voto.
//
// Reusa `listarLeadsResumo` (o MESMO parse que a Base já usava) e `upsertLeadsEspelho`
// (merge por clickup_task_id). NUNCA loga telefone/cpf (LGPD) — só contagem/página.
// Erro PROPAGA (WR-03): o caller (script/cron) decide retry/abort.

import { listarLeadsResumo } from './clickup.ts';
import { upsertLeadsEspelho, type LeadEspelhoRow } from './supabase.ts';

export interface ResultadoSyncEspelho {
  paginas: number;
  leads: number;
  ultimaPagina: number;
}

/** Mapeia o LeadResumo (ClickUp) -> linha do espelho. `nome_lower` alimenta a busca. */
function paraLinhaEspelho(
  l: {
    leadTaskId: string;
    nome: string;
    telefone: string;
    cpf: string;
    bairro: string;
    cidade: string;
    confirmouRomero: string | null;
    confirmouAndressa: string | null;
    militante: boolean;
    semContato: boolean;
  },
  agora: string,
): LeadEspelhoRow {
  return {
    clickup_task_id: l.leadTaskId,
    nome: l.nome,
    nome_lower: (l.nome || '').toLowerCase(),
    telefone: l.telefone,
    cpf: l.cpf,
    bairro: l.bairro,
    cidade: l.cidade,
    confirmou_romero: l.confirmouRomero,
    confirmou_andressa: l.confirmouAndressa,
    militante: l.militante,
    sem_contato: l.semContato,
    atualizado_em: agora,
  };
}

/**
 * Sincroniza o espelho a partir do ClickUp, página a página (100 leads/página,
 * upsert por `clickup_task_id`). `maxPaginas` limita (0/undefined = tudo até a última
 * página). `dryRun` lê do ClickUp e monta as linhas mas NÃO grava (validação sem
 * mexer no banco). `onProgress(pagina, leadsAcumulados)` para log externo. LANÇA em
 * erro de ClickUp/Supabase (WR-03).
 */
export async function sincronizarEspelhoLeads(
  opts: {
    maxPaginas?: number;
    dryRun?: boolean;
    onProgress?: (pagina: number, leadsAcumulados: number) => void;
  } = {},
): Promise<ResultadoSyncEspelho> {
  const agora = new Date().toISOString();
  let page = 0;
  let paginas = 0;
  let leadsTotal = 0;
  const limite = opts.maxPaginas && opts.maxPaginas > 0 ? opts.maxPaginas : Infinity;
  while (paginas < limite) {
    const { leads, cursor } = await listarLeadsResumo({ page, limit: 100 });
    if (leads.length > 0 && !opts.dryRun) {
      await upsertLeadsEspelho(leads.map((l) => paraLinhaEspelho(l, agora)));
    }
    paginas += 1;
    leadsTotal += leads.length;
    opts.onProgress?.(paginas, leadsTotal);
    if (!cursor) break;
    page = Number(cursor);
  }
  return { paginas, leads: leadsTotal, ultimaPagina: page };
}
