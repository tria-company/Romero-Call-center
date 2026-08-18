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

/** Um lead da Lista 01 que nunca teve Ligação — espelha `LeadNuncaLigado` do backend (12-03/buscarLeadsNuncaLigados). */
export type LeadAudioReal = {
  leadTaskId: string;
  nome: string;
  telefone: string;
  /** `CAMPOS_LEADS.ORIGEM` cru (pode ser "") — alimenta os chips dinâmicos (ENVIO-04, D-04/D-05). */
  origem: string;
};

export type EstadoAudiosReais = {
  leads: LeadAudioReal[];
  origens: string[];
  carregando: boolean; // carga inicial da lista
  erro: boolean; // falhou ao carregar a lista (erro só no bloco da lista, item 6)
  recarregar: () => void;
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
export function useAudiosReais(): EstadoAudiosReais {
  const [leads, setLeads] = React.useState<LeadAudioReal[]>([]);
  const [origens, setOrigens] = React.useState<string[]>([]);
  const [carregando, setCarregando] = React.useState(true);
  const [erro, setErro] = React.useState(false);
  const [conectado, setConectado] = React.useState(false);

  const geracaoRef = React.useRef(0);

  const carregarLista = React.useCallback(async () => {
    const g = ++geracaoRef.current;
    setCarregando(true);
    setErro(false);
    try {
      const r = await fetch("/api/mobile/audios", { cache: "no-store" });
      if (geracaoRef.current !== g) return;
      if (!r.ok) {
        setErro(true);
        setLeads([]);
        setOrigens([]);
        return;
      }
      const d = (await r.json().catch(() => null)) as {
        leads?: LeadAudioReal[];
        origens?: string[];
      } | null;
      if (geracaoRef.current !== g) return;
      setLeads(d?.leads ?? []);
      setOrigens(d?.origens ?? []);
    } catch {
      if (geracaoRef.current === g) {
        setErro(true);
        setLeads([]);
        setOrigens([]);
      }
    } finally {
      if (geracaoRef.current === g) setCarregando(false);
    }
  }, []);

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

  React.useEffect(() => {
    void consultarStatus();
    const id = window.setInterval(() => void consultarStatus(), INTERVALO_POLL_STATUS_MS);
    return () => window.clearInterval(id);
  }, [consultarStatus]);

  const recarregar = React.useCallback(() => {
    void carregarLista();
  }, [carregarLista]);

  return { leads, origens, carregando, erro, recarregar, conectado };
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
