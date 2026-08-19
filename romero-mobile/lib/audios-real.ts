"use client";

import * as React from "react";

/* ══════════════════════════════════════════════════════════════════════════
   audios-real — hook de dados da tela `/audios` (canal de envio Evolution,
   Fase 12). Fonte: `/api/mobile/audios*` (rotas-ponte romero-only, 12-04) —
   nunca fala direto com o backend do discador nem com a Evolution.

   `useAudiosReais()` cobre os dois blocos INDEPENDENTES da tela (D-08, item 6
   do 12-UI-SPEC): a lista de leads nunca-ligados + origens (ENVIO-03/04,
   recarregada por `recarregar()`) e o status de conexão (poll leve, ciclo
   próprio) — uma falha na lista NUNCA derruba o banner, e vice-versa.
   `enviarAudioParaLead` é uma ação solta (não fica no estado do hook) que a
   UI chama por linha, com resultado discriminado (D-07/D-08).

   LGPD: nunca loga telefone/leadId/áudio — o base64 só trafega no corpo do
   POST.
   ══════════════════════════════════════════════════════════════════════════ */

const CABECALHO_JSON = { "Content-Type": "application/json" } as const;

// Poll leve do banner de conexão (D-08) — não é tempo-real, é "reflete o
// estado real dentro de uma janela curta", mesmo espírito de
// heartbeat/presença já usado no discador (web/CONTEXT.md).
const INTERVALO_POLL_STATUS_MS = 18_000;

// Auto-reload SILENCIOSO da lista de leads (stale-while-revalidate) — mantém o
// lote fresco e se recupera sozinho de falha transitória, sem piscar a tela.
const INTERVALO_POLL_LISTA_MS = 30_000;

/** Um lead da Lista 01 que nunca teve Ligação — espelha `LeadNuncaLigado` do backend (12-03/buscarLeadsNuncaLigados). */
export type LeadAudioReal = {
  leadTaskId: string;
  /** Task da LIGAÇÃO (Lista 02) quando a linha vem da fila do Romero (fonte
   *  "fila", 2026-08-19) — o botão de ligar abre ESSA Ligação direto no
   *  discador (auto=1), sem criar avulsa. Ausente na fonte nunca-ligados. */
  ligacaoTaskId?: string;
  nome: string;
  telefone: string;
  /** `CAMPOS_LEADS.ORIGEM` cru (pode ser "") — alimenta os chips dinâmicos (ENVIO-04, D-04/D-05). */
  origem: string;
  /** Selo da conversa (Fase 13 fatia 2): pode ligar? Avaliado no backend
   *  (LLM com debounce de 60s por mensagem do lead; heurística de fallback).
   *  Ausente em backends antigos → a linha rende sem selo. */
  conversa?: { status: "ligar" | "nao_ligar" | "indefinido" | "aguardando" | "enviar_audio"; motivo: string };
  /** Última mensagem da conversa (2026-08-19): ordena a lista como WhatsApp
   *  (o backend já manda ordenado) e acende a bolinha quando `deNos` é false
   *  E `lida` é false (abrir a conversa marca como lida no banco). `preview`
   *  já vem limpo de rótulos. */
  ultima?: { ts: number; deNos: boolean; tipo: string; preview: string; lida?: boolean } | null;
};

export type EstadoAudiosReais = {
  leads: LeadAudioReal[];
  origens: string[];
  carregando: boolean; // carga inicial da lista
  erro: boolean; // falhou ao carregar a lista (erro só no bloco da lista, item 6)
  /** fonte "fila": o operador não tem mapeamento de assignee configurado —
   *  distinto de fila vazia (mesma régua da fila clássica, WR-03). */
  semMapeamento: boolean;
  recarregar: () => void;
  /** Recarrega a lista SEM piscar "carregando" (stale-while-revalidate) — o
   *  sinal de novidade usa isto pra refletir mensagem nova na hora. */
  recarregarSilencioso: () => void;
  /**
   * Estado REAL da instância dedicada (D-08). Começa `false` (nunca finge
   * conectado enquanto a primeira consulta está em voo) — mesmo racional do
   * backend: uma falha de consulta também vira `false`, nunca um `true`
   * mascarado.
   */
  conectado: boolean;
};

/**
 * Leads nunca-ligados + origens (ENVIO-03/04) e status de conexão da
 * instância dedicada (D-08, poll leve). Os dois ciclos são INDEPENDENTES.
 */
export function useAudiosReais(
  /** "fila" (default, 2026-08-19): a fila de Ligações do Romero É a lista —
   *  cada task de Ligação criada pra ele vira linha com chat/áudio/ligação.
   *  "nunca-ligados": o lote da campanha (fonte antiga, rota /audios). */
  fonte: "fila" | "nunca-ligados" = "fila",
): EstadoAudiosReais {
  const [leads, setLeads] = React.useState<LeadAudioReal[]>([]);
  const [origens, setOrigens] = React.useState<string[]>([]);
  const [carregando, setCarregando] = React.useState(true);
  const [erro, setErro] = React.useState(false);
  const [semMapeamento, setSemMapeamento] = React.useState(false);
  const [conectado, setConectado] = React.useState(false);

  const geracaoRef = React.useRef(0);

  // `silencioso`: reload em SEGUNDO PLANO (auto-refresh) — não pisca "carregando"
  // nem esvazia a lista atual numa falha transitória; mantém o que está na tela
  // e tenta de novo no próximo ciclo (stale-while-revalidate). Um sucesso, mesmo
  // silencioso, CURA um `erro` anterior (a tela se recupera sozinha).
  const carregarLista = React.useCallback(async (silencioso = false) => {
    const g = ++geracaoRef.current;
    if (!silencioso) {
      setCarregando(true);
      setErro(false);
    }
    try {
      const r = await fetch(fonte === "fila" ? "/api/mobile/audios/fila" : "/api/mobile/audios", { cache: "no-store" });
      if (geracaoRef.current !== g) return;
      if (!r.ok) {
        if (!silencioso) {
          setErro(true);
          setLeads([]);
          setOrigens([]);
        }
        return;
      }
      const d = (await r.json().catch(() => null)) as {
        leads?: LeadAudioReal[];
        origens?: string[];
        semMapeamento?: boolean;
      } | null;
      if (geracaoRef.current !== g) return;
      setLeads(d?.leads ?? []);
      setOrigens(d?.origens ?? []);
      setSemMapeamento(d?.semMapeamento === true);
      setErro(false);
    } catch {
      if (geracaoRef.current === g && !silencioso) {
        setErro(true);
        setLeads([]);
        setOrigens([]);
      }
    } finally {
      if (geracaoRef.current === g && !silencioso) setCarregando(false);
    }
  }, [fonte]);

  const consultarStatus = React.useCallback(async () => {
    try {
      const r = await fetch("/api/mobile/audios/status", { cache: "no-store" });
      if (!r.ok) {
        setConectado(false); // consulta falhou = trata como desconectado (D-08)
        return;
      }
      const d = (await r.json().catch(() => null)) as { conectado?: boolean } | null;
      setConectado(d?.conectado === true);
    } catch {
      setConectado(false);
    }
  }, []);

  React.useEffect(() => {
    void carregarLista();
  }, [carregarLista]);

  // Auto-reload da lista (silencioso): mantém o lote fresco — leads que ganharam
  // Ligação (ex.: "Sem WhatsApp") saem, e a tela se recupera sozinha de uma falha
  // transitória sem o operador tocar "tentar de novo".
  React.useEffect(() => {
    const id = window.setInterval(() => void carregarLista(true), INTERVALO_POLL_LISTA_MS);
    return () => window.clearInterval(id);
  }, [carregarLista]);

  React.useEffect(() => {
    void consultarStatus();
    const id = window.setInterval(() => void consultarStatus(), INTERVALO_POLL_STATUS_MS);
    return () => window.clearInterval(id);
  }, [consultarStatus]);

  const recarregar = React.useCallback(() => {
    void carregarLista();
  }, [carregarLista]);

  const recarregarSilencioso = React.useCallback(() => {
    void carregarLista(true);
  }, [carregarLista]);

  return { leads, origens, carregando, erro, semMapeamento, recarregar, recarregarSilencioso, conectado };
}

/**
 * SINAL DE NOVIDADE (2026-08-19): ts (ms) da última mensagem de WhatsApp
 * persistida (`GET /api/mobile/audios/novidades`). O Audios sonda a cada ~4s;
 * mudou → recarrega lista/conversa na hora. 0 em falha (o poll de 30s segue
 * como fallback). Nunca lança; nada logado.
 */
export async function buscarNovidades(): Promise<number> {
  try {
    const r = await fetch("/api/mobile/audios/novidades", { cache: "no-store" });
    if (!r.ok) return 0;
    const d = (await r.json().catch(() => null)) as { ultimoTs?: number } | null;
    return typeof d?.ultimoTs === "number" ? d.ultimoTs : 0;
  } catch {
    return 0;
  }
}

/* ── Envio ───────────────────────────────────────────────────────────────── */

export type ResultadoEnvioAudio =
  | { tipo: "sucesso" }
  | { tipo: "desconectado" }
  | { tipo: "sem_whatsapp" }
  | { tipo: "erro" };

/**
 * Envia o áudio (base64) pro lead pelo canal dedicado
 * (`POST /api/mobile/audios/:leadId/enviar`). Resultado DISCRIMINADO — a UI
 * traduz cada `tipo` num badge/erro diferente (D-07/D-08): `sucesso` (2xx),
 * `desconectado` (o backend sinaliza sessão fora — falha ALTA, nunca
 * mascarada, D-08) ou `erro` (qualquer outra falha: rede, HTTP, ou o teto de
 * espera do rate limiter do backend estourando, evolution.ts).
 *
 * O tempo de espera do rate limiter (D-06/D-07) já acontece DENTRO desta
 * chamada — o backend segura a resposta até um token ficar disponível ou o
 * teto de espera estourar. É por isso que a UI (Audios.tsx) marca a linha
 * como "enviando" (badge "Aguardando ritmo seguro…") assim que o toque
 * acontece, e só resolve quando esta Promise volta — não há um sinal
 * separado de "throttle" no corpo da resposta, a espera EM SI é o throttle
 * visível.
 *
 * `sem_whatsapp` (o backend AFIRMA, via pré-check Evolution, que o número não
 * tem WhatsApp — quick 260818-mv2; estado TERMINAL, sem retry, distinto de
 * `erro`) chega como `{ status: 'sem_whatsapp' }` com HTTP 200 — por isso o
 * corpo precisa ser lido ANTES do short-circuit de `r.ok`.
 *
 * Nunca lança — sempre devolve um `tipo`. LGPD: nunca loga leadId/base64.
 */
export async function enviarAudioParaLead(
  leadId: string,
  audioBase64: string,
  mimetype?: string,
): Promise<ResultadoEnvioAudio> {
  try {
    const r = await fetch(`/api/mobile/audios/${encodeURIComponent(leadId)}/enviar`, {
      method: "POST",
      headers: CABECALHO_JSON,
      body: JSON.stringify({ audioBase64, ...(mimetype ? { mimetype } : {}) }),
    });
    const d = (await r.json().catch(() => null)) as { status?: string; desconectado?: boolean } | null;
    if (d?.status === "sem_whatsapp") return { tipo: "sem_whatsapp" };
    if (r.ok) return { tipo: "sucesso" };
    if (d?.desconectado === true) return { tipo: "desconectado" };
    return { tipo: "erro" };
  } catch {
    return { tipo: "erro" };
  }
}

/**
 * Envia uma mensagem de TEXTO pro lead (Fase 13 fatia 2 — chat de verdade).
 * Mesmo contrato discriminado do envio de áudio.
 */
export async function enviarTextoParaLead(leadId: string, texto: string): Promise<ResultadoEnvioAudio> {
  try {
    const r = await fetch(`/api/mobile/audios/${encodeURIComponent(leadId)}/mensagem`, {
      method: "POST",
      headers: CABECALHO_JSON,
      body: JSON.stringify({ texto }),
    });
    const d = (await r.json().catch(() => null)) as { status?: string; desconectado?: boolean } | null;
    if (d?.status === "sem_whatsapp") return { tipo: "sem_whatsapp" };
    if (r.ok) return { tipo: "sucesso" };
    if (d?.desconectado === true) return { tipo: "desconectado" };
    return { tipo: "erro" };
  } catch {
    return { tipo: "erro" };
  }
}

/**
 * PULA o contato (2026-08-19): fecha a Ligação da fila no ClickUp com o
 * motivo explicado pelo Romero (`POST /api/mobile/audios/pular`). true = a
 * linha pode sair da lista. Nunca lança. LGPD: nada logado.
 */
export async function pularContato(ligacaoTaskId: string, motivo: string): Promise<boolean> {
  try {
    const r = await fetch("/api/mobile/audios/pular", {
      method: "POST",
      headers: CABECALHO_JSON,
      body: JSON.stringify({ taskId: ligacaoTaskId, motivo }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Uma mensagem da conversa REAL de WhatsApp com o lead (Fase 13, fatia 1). */
export type MensagemConversa = {
  id: string;
  /** true = mensagem NOSSA; false = resposta do LEAD. */
  deNos: boolean;
  /** timestamp em ms. */
  ts: number;
  tipo: "texto" | "audio" | "outro";
  texto: string | null;
  /** transcrição (Deepgram) quando a mensagem é de áudio; null se indisponível. */
  transcricao: string | null;
};

/**
 * A conversa real com o lead (ponte `/api/mobile/audios/:leadId/conversa`) —
 * mensagens dos DOIS lados, com transcrição dos áudios. `null` em falha
 * (a conversa segue com as bolhas da sessão). LGPD: nada logado.
 */
export async function buscarConversaLead(leadTaskId: string): Promise<MensagemConversa[] | null> {
  try {
    const r = await fetch(`/api/mobile/audios/${encodeURIComponent(leadTaskId)}/conversa`, { cache: "no-store" });
    if (!r.ok) return null;
    const d = (await r.json().catch(() => null)) as { mensagens?: MensagemConversa[] } | null;
    return Array.isArray(d?.mensagens) ? d.mensagens : null;
  } catch {
    return null;
  }
}

/**
 * Mídia (base64→data-URI) de uma mensagem de áudio — o ▶ das bolhas usa isso
 * sob demanda. `null` em falha (o botão simplesmente não toca).
 */
export async function buscarMidiaMensagem(mensagemId: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/mobile/audios/mensagem/${encodeURIComponent(mensagemId)}/midia`, { cache: "no-store" });
    if (!r.ok) return null;
    const d = (await r.json().catch(() => null)) as { base64?: string; mimetype?: string } | null;
    if (!d?.base64) return null;
    return `data:${d.mimetype || "audio/ogg"};base64,${d.base64}`;
  } catch {
    return null;
  }
}

/** Um envio registrado na Lista 03, na visão da conversa (bolha persistente). */
export type EnvioHistorico = {
  /** DATA_DO_ENVIO em ms (0 quando o registro não tem data). */
  em: number;
  por: string;
  /** URL assinada do anexo de áudio (null = registro sem anexo → bolha sem player). */
  audioUrl: string | null;
};

/**
 * Histórico de envios do lead (ponte `/api/mobile/audios/:leadId/historico`).
 * `null` em qualquer falha — a conversa segue só com as bolhas da sessão
 * (best-effort; nunca lança). LGPD: nada logado.
 */
export async function buscarHistoricoLead(leadTaskId: string): Promise<EnvioHistorico[] | null> {
  try {
    const r = await fetch(`/api/mobile/audios/${encodeURIComponent(leadTaskId)}/historico`, { cache: "no-store" });
    if (!r.ok) return null;
    const d = (await r.json().catch(() => null)) as { envios?: EnvioHistorico[] } | null;
    return Array.isArray(d?.envios) ? d.envios : null;
  } catch {
    return null;
  }
}
