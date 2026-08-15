"use client";

/* ══════════════════════════════════════════════════════════════════════════
   STORE — o ÚNICO arquivo do app que conhece localStorage.

   Contrato deliberado: toda operação de escrita é `async` e devolve Promise,
   mesmo sendo síncrona hoje. É isso que permite trocar esta implementação por
   `fetch('/api/…')` (Postgres/Supabase) sem tocar em nenhuma tela.

   Reatividade via `useSyncExternalStore`: qualquer mutação notifica todos os
   assinantes na mesma aba, e o evento `storage` sincroniza entre abas.
   ══════════════════════════════════════════════════════════════════════════ */

import { criarBancoReal, temBaseReal } from "./reais";
import { criarBancoSemente, ordenarFila, VERSAO_BANCO } from "./seed";
import {
  PRAZO_HORAS,
  type Banco,
  type CandidatoId,
  type Interacao,
  type ItemFila,
  type Lead,
  type Prioridade,
  type Servico,
  type Solicitacao,
  type TipoSolicitacao,
} from "./schema";

const CHAVE = "ca.db.v2";

let banco: Banco | null = null;
const assinantes = new Set<() => void>();

const notificar = () => assinantes.forEach((fn) => fn());

function ler(): Banco | null {
  if (typeof window === "undefined") return null;
  try {
    const cru = window.localStorage.getItem(CHAVE);
    if (!cru) return null;
    const parsed = JSON.parse(cru) as Banco;
    if (parsed?.versao !== VERSAO_BANCO) return null; // schema mudou → re-semeia
    return parsed;
  } catch {
    return null;
  }
}

function gravar(b: Banco) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAVE, JSON.stringify(b));
  } catch (e) {
    // cota estourada é o único erro plausível; o app segue com o estado em
    // memória em vez de morrer no meio de uma edição
    console.warn("[db] falha ao gravar no localStorage:", e);
  }
}

/**
 * A base real do ClickUp tem precedência sobre a semente fictícia. Quando
 * `lib/db/reais.json` não existe ou veio vazio (clone novo, script ainda não
 * rodado), cai na semente — o app nunca fica sem base.
 *
 * A escolha mora AQUI, e não em `seed.ts`, para não criar ciclo de import:
 * `reais.ts` precisa de VERSAO_BANCO, que é de `seed.ts`.
 */
export function inicializar(): Banco {
  if (banco) return banco;
  const existente = ler();
  banco = existente ?? (temBaseReal() ? criarBancoReal() : criarBancoSemente());
  if (!existente) gravar(banco);
  return banco;
}

/**
 * Toda mutação produz um snapshot NOVO — objeto raiz e coleções.
 * Sem isso, `useSyncExternalStore` compara a mesma referência com Object.is,
 * não vê mudança nenhuma e a tela não repinta.
 */
function mutar(fn: (b: Banco) => void) {
  const atual = inicializar();
  const copia: Banco = {
    ...atual,
    painel: { ...atual.painel },
    candidatos: atual.candidatos.map((c) => ({ ...c })),
    leads: [...atual.leads],
    atendimentos: [...atual.atendimentos],
    fila: [...atual.fila],
    interacoes: [...atual.interacoes],
    solicitacoes: [...atual.solicitacoes],
  };
  fn(copia);
  banco = copia;
  gravar(copia);
  notificar();
}

/* ── Assinatura ────────────────────────────────────────────────────────── */

function aoMudarOutraAba(e: StorageEvent) {
  if (e.key !== CHAVE) return;
  banco = ler();
  notificar();
}

export function subscribe(cb: () => void): () => void {
  assinantes.add(cb);
  if (assinantes.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", aoMudarOutraAba);
  }
  return () => {
    assinantes.delete(cb);
    if (assinantes.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", aoMudarOutraAba);
    }
  };
}

export function getSnapshot(): Banco | null {
  if (typeof window === "undefined") return null;
  if (!banco) inicializar();
  return banco;
}

/** No servidor não existe base — as telas mostram esqueleto até hidratar. */
export function getServerSnapshot(): Banco | null {
  return null;
}

let seq = 0;
export function novoId(prefixo: string): string {
  seq += 1;
  return `${prefixo}_${Date.now().toString(36)}${seq.toString(36)}`;
}

/* ══════════════════════════════════════════════════════════════════════════
   API — é isto que as telas importam (via lib/db/index.ts)
   ══════════════════════════════════════════════════════════════════════════ */

export async function registrarInteracao(
  entrada: Omit<Interacao, "id" | "em"> & { em?: string },
): Promise<Interacao> {
  const it: Interacao = { ...entrada, id: novoId("it"), em: entrada.em ?? new Date().toISOString() };
  mutar((b) => {
    b.interacoes = [it, ...b.interacoes];
    const i = b.leads.findIndex((l) => l.id === it.leadId);
    if (i >= 0) b.leads[i] = { ...b.leads[i], ultimoContatoEm: it.em };
  });
  return it;
}

export async function salvarAnotacao(leadId: string, texto: string): Promise<void> {
  const em = new Date().toISOString();
  mutar((b) => {
    const i = b.leads.findIndex((l) => l.id === leadId);
    if (i >= 0) b.leads[i] = { ...b.leads[i], anotacao: { texto, em } };
  });
}

export async function confirmarApoio(leadId: string, candidato: CandidatoId): Promise<void> {
  mutar((b) => {
    const i = b.leads.findIndex((l) => l.id === leadId);
    if (i < 0) return;
    const atual = b.leads[i];
    const tinha = atual.confirmou.includes(candidato);
    b.leads[i] = {
      ...atual,
      confirmou: tinha
        ? atual.confirmou.filter((c) => c !== candidato)
        : [...atual.confirmou, candidato],
    };
    // o número do foguete acompanha a confirmação, é o mesmo dado
    const c = b.candidatos.findIndex((x) => x.id === candidato);
    if (c >= 0) {
      const delta = tinha ? -1 : 1;
      b.candidatos[c] = {
        ...b.candidatos[c],
        apoio: b.candidatos[c].apoio + delta,
        apoioHoje: Math.max(0, b.candidatos[c].apoioHoje + delta),
      };
    }
  });
}

/* ── Fila ──────────────────────────────────────────────────────────────── */

export async function marcarItemFila(id: string, feito: boolean): Promise<void> {
  mutar((b) => {
    const i = b.fila.findIndex((f) => f.id === id);
    if (i < 0) return;
    b.fila[i] = {
      ...b.fila[i],
      feito,
      feitoEm: feito ? new Date().toISOString() : undefined,
    };
    ordenarFila(b.fila);
  });
}

/** Empurra um item novo para a fila de hoje (usado pelo retorno da equipe). */
export async function empurrarParaFila(
  entrada: Omit<ItemFila, "id" | "feito" | "dia">,
): Promise<void> {
  const d = new Date();
  const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  mutar((b) => {
    b.fila = [{ ...entrada, id: novoId("fl"), feito: false, dia }, ...b.fila];
    ordenarFila(b.fila);
  });
}

/* ── Solicitações ──────────────────────────────────────────────────────── */

export type NovaSolicitacao = {
  leadId: string;
  tipo: TipoSolicitacao;
  qual: Servico;
  observacao: string;
  prioridade: Prioridade;
};

export async function criarSolicitacao(entrada: NovaSolicitacao): Promise<Solicitacao> {
  const agora = new Date();
  const prazo = new Date(agora.getTime() + PRAZO_HORAS[entrada.prioridade] * 3_600_000);
  let criada!: Solicitacao;
  mutar((b) => {
    const codigo = b.ultimoCodigo + 1;
    b.ultimoCodigo = codigo;
    criada = {
      ...entrada,
      id: novoId("sl"),
      codigo,
      status: "aberta",
      criadaEm: agora.toISOString(),
      prazo: prazo.toISOString(),
    };
    b.solicitacoes = [criada, ...b.solicitacoes];
    // o pedido também entra na linha do tempo do lead
    b.interacoes = [
      {
        id: novoId("it"),
        leadId: entrada.leadId,
        tipo: "nota",
        autor: "voce",
        titulo: "Solicitação registrada",
        subtitulo: entrada.observacao || undefined,
        em: agora.toISOString(),
        selo: `Virou solicitação #${codigo}`,
      },
      ...b.interacoes,
    ];
  });
  return criada;
}

/* ── SEM CHAMADOR desde que a tela de Equipe foi removida ──────────────────
   `assumirSolicitacao` e `resolverSolicitacao` continuam aqui porque são regra
   de DOMÍNIO, não código de tela: a segunda é o gancho documentado que fecha o
   ciclo (grava o atendimento, registra na linha do tempo e devolve o retorno
   para o topo da fila). Sem UI que as chame, hoje uma solicitação nasce e não
   tem como ser resolvida — o ciclo termina em "solicitação". Apagá-las
   apagaria a regra junto; devolver a Equipe é religar as duas.
   Na mesma situação: `useSolicitacoes`, `fmtPrazoCurto`, `dentroDoPrazoPct` e
   `painel.equipeOnline`. ────────────────────────────────────────────────── */
export async function assumirSolicitacao(id: string, responsavel: string): Promise<void> {
  mutar((b) => {
    const i = b.solicitacoes.findIndex((s) => s.id === id);
    if (i < 0) return;
    b.solicitacoes[i] = {
      ...b.solicitacoes[i],
      status: "assumida",
      responsavel,
      assumidaEm: new Date().toISOString(),
    };
  });
}

/**
 * Resolver fecha o ciclo: marca a solicitação, registra o atendimento na ficha
 * do lead e DEVOLVE uma tarefa de retorno para a fila. É esse gancho que o
 * mockup descreve em "ao marcar como resolvida, gera retorno para Romero".
 */
export async function resolverSolicitacao(id: string): Promise<void> {
  const agora = new Date();
  const dia = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}-${String(agora.getDate()).padStart(2, "0")}`;
  mutar((b) => {
    const i = b.solicitacoes.findIndex((s) => s.id === id);
    if (i < 0) return;
    const s = b.solicitacoes[i];
    b.solicitacoes[i] = {
      ...s,
      status: "resolvida",
      resolvidaEm: agora.toISOString(),
      retornoGerado: true,
    };

    const lead = b.leads.find((l) => l.id === s.leadId);
    const rotulo = ROTULO_SERVICO[s.qual] ?? "Atendimento";

    b.atendimentos = [
      {
        id: novoId("at"),
        leadId: s.leadId,
        servico: s.qual,
        detalhe: lead?.pets[0]?.nome,
        em: agora.toISOString(),
      },
      ...b.atendimentos,
    ];

    b.interacoes = [
      {
        id: novoId("it"),
        leadId: s.leadId,
        tipo: "atendimento",
        autor: "equipe",
        titulo: `${rotulo} concluída`,
        subtitulo: s.responsavel ? `resolvida por ${s.responsavel}` : undefined,
        em: agora.toISOString(),
        selo: "Gerou tarefa de retorno",
      },
      ...b.interacoes,
    ];

    if (!b.fila.some((f) => f.leadId === s.leadId && f.motivo === "retorno" && !f.feito)) {
      b.fila = [
        {
          id: novoId("fl"),
          leadId: s.leadId,
          motivo: "retorno",
          detalhe: `${lead?.pets[0]?.nome ? `${lead.pets[0].nome} · ` : ""}${rotulo.toLowerCase()} entregue`,
          feito: false,
          dia,
        },
        ...b.fila,
      ];
      ordenarFila(b.fila);
    }
  });
}

const ROTULO_SERVICO: Record<string, string> = {
  castracao: "Castração",
  consulta: "Consulta",
  exame: "Exame",
  cirurgia: "Cirurgia",
  racao: "Ração",
  resgate: "Resgate",
  denuncia: "Denúncia",
  medicacao: "Medicação",
  outro: "Atendimento",
};

/* ── Manutenção ────────────────────────────────────────────────────────── */

export async function ressemear(): Promise<void> {
  banco = criarBancoSemente();
  gravar(banco);
  notificar();
}

export async function exportarJson(): Promise<string> {
  return JSON.stringify(inicializar(), null, 2);
}

export type { Lead };
