"use client";

import * as React from "react";
// Helper PURO de iniciais — fora de qualquer store/localStorage.
import { iniciais } from "@/lib/leads-util";
import { fmtTelefone } from "@/lib/contato";
import { useAudiosReais } from "@/lib/audios-real";
import type { LeadAudioReal } from "@/lib/audios-real";
import { Autobox, Skels, Vhead } from "./blocos";

/* TELA · LISTA DE ÁUDIOS (Fase 12, canal de envio Evolution API)
   Única superfície de UI da fase (12-UI-SPEC.md). Fonte: `useAudiosReais`
   (leads nunca-ligados + origens + status da instância dedicada), servida
   por `/api/mobile/audios*` (rotas-ponte romero-only, 12-04).

   Ordem topo → base (12-UI-SPEC §"Screen /audios"): Vhead → banner de conexão
   (D-08, SEMPRE visível) → chips de ORIGEM (D-04/D-05, "Todos" primeiro) →
   cartão "Áudio pronto" (gravação/preview/envio, Task 3 desta plan) → lista
   de leads com envio por linha (Task 3). Erro/vazio POR BLOCO — a lista
   falhar não derruba banner nem cartão (item 6 do UI-SPEC).

   Peso local 700 (não o 800 herdado de `h1`): esta tela colapsa pra 2 pesos
   (400/700, ver 12-UI-SPEC §Typography) — override só aqui, `@layer base`
   global não muda.

   LGPD: telefone sempre mascarado (`fmtTelefone`); nunca logar telefone/leadId. */

export function Audios() {
  const { leads, origens, carregando, erro, recarregar, conectado } = useAudiosReais();
  const [origemAtiva, setOrigemAtiva] = React.useState<string>("todos");

  // Recorte por ORIGEM é client-side (mesmo molde de Base.tsx/RECORTES) — o
  // backend já entrega só os leads nunca-ligados; o chip só filtra a página.
  const leadsFiltrados = React.useMemo(
    () => (origemAtiva === "todos" ? leads : leads.filter((l) => l.origem === origemAtiva)),
    [leads, origemAtiva],
  );

  return (
    <div className="view">
      <Vhead
        titulo={<span style={{ fontWeight: 700 }}>Lista de Áudios</span>}
        sub={`${leadsFiltrados.length} ${leadsFiltrados.length === 1 ? "lead" : "leads"}`}
      />

      {/* Banner de conexão (D-08) — SEMPRE visível, nunca colapsável/omitido,
          independente do estado da lista abaixo. */}
      <Autobox
        tom={conectado ? "go" : "warn"}
        titulo={conectado ? "Número conectado" : "Número desconectado"}
      >
        {conectado
          ? "Os áudios estão saindo normalmente."
          : "Reconecte o WhatsApp dedicado — nenhum áudio sai enquanto a sessão estiver fora."}
      </Autobox>

      {/* Tira de chips de ORIGEM (D-04/D-05) — "Todos" primeiro + valores
          distintos vindos do endpoint, sem rótulo hardcoded além de "Todos". */}
      <div className="scroll-x">
        <button
          type="button"
          className={origemAtiva === "todos" ? "seg on" : "seg"}
          style={{ fontWeight: 700 }}
          onClick={() => setOrigemAtiva("todos")}
        >
          Todos
        </button>
        {origens.map((o) => (
          <button
            key={o}
            type="button"
            className={origemAtiva === o ? "seg on" : "seg"}
            style={{ fontWeight: 700 }}
            onClick={() => setOrigemAtiva(o)}
          >
            {o}
          </button>
        ))}
      </div>

      {/* Cartão "Áudio pronto" (gravação/preview/MediaRecorder) entra na Task 3
          desta plan — logo acima da lista, fora dela (é o "compositor"). */}

      {carregando ? (
        <div className="stack">
          <Skels alturas={[64, 64, 64]} />
        </div>
      ) : erro ? (
        <div className="empty">
          <b>Não deu para carregar a lista</b>
          <button type="button" className="seg" style={{ marginTop: 10 }} onClick={recarregar}>
            tentar de novo
          </button>
        </div>
      ) : leadsFiltrados.length === 0 ? (
        <div className="empty">
          <b>Nenhum lead pendente aqui</b>
          Todos os leads desta aba já foram contatados ou não há leads dessa origem ainda. Troque de
          aba ou volte mais tarde.
        </div>
      ) : (
        <div className="stack">
          {leadsFiltrados.map((lead) => (
            <LinhaLead key={lead.leadTaskId} lead={lead} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Uma linha de lead com o botão de envio à direita. Nesta task o botão ainda
 * não está com o envio ligado (áudio/throttle/estado por linha entram na
 * Task 3, junto com o cartão de gravação — o botão não tem áudio pra enviar
 * até lá).
 */
function LinhaLead({ lead }: { lead: LeadAudioReal }) {
  return (
    <div className="task" style={{ alignItems: "center" }}>
      <span className="av">{iniciais(lead.nome)}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="tn trunc" style={{ display: "block" }}>
          {lead.nome}
        </span>
        <span className="tm trunc" style={{ display: "block" }}>
          {fmtTelefone(lead.telefone)}
        </span>
        {lead.origem && (
          <span className="tags" style={{ marginTop: 7 }}>
            <span className="tag">{lead.origem}</span>
          </span>
        )}
      </span>
      <button
        type="button"
        className="cta"
        disabled
        aria-label="Enviar áudio"
        style={{
          flex: "none",
          width: "auto",
          padding: "9px 14px",
          fontSize: "var(--t-micro)",
          minWidth: 44,
          minHeight: 44,
        }}
      >
        Enviar áudio
      </button>
    </div>
  );
}
