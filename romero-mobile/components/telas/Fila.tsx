"use client";

import * as React from "react";
// Helper PURO de iniciais — fora de qualquer store/localStorage.
import { iniciais } from "@/lib/leads-util";
import type { ItemFilaReal } from "@/lib/discador-servidor";
import { useFilaReal } from "@/lib/fila-real";
import { fmtTelefone, urlCallCenter, vibrar } from "@/lib/contato";
import { Autobox, Esqueleto, Vhead } from "./blocos";
import { Audios } from "./Audios";

/* TELA 02 · AÇÕES DE HOJE (ex-Fila)
   Fonte da fila: a fila REAL do discador (Ligações abertas do dia do Romero),
   servida por /api/mobile/fila. Sem localStorage, sem selo de motivo (o backend
   não manda), sem marcar-feito: quando a Ligação recebe desfecho ela some no
   próximo fetch. O visual (Vhead, qbar, cards `.task`) segue o mockup.

   2026-08-19 (sem dropdown): para o Romero, a FILA DE LIGAÇÕES É A LISTA DE
   ÁUDIOS — cada Ligação criada pra ele vira uma linha do <Audios embutido/>
   (fonte "fila"), com chat, envio de áudio e ligação direta. O gate real é o
   backend (`exigirRomero`). Atendente vê só a fila clássica (podeAudios=false,
   título "Fila de hoje").

   u14: o CARD INTEIRO liga — tocar em qualquer lugar do card faz a mesma ação do
   botão "Ligar" (handoff pro discador). A ficha do lead saiu da Fila; o botão
   "Ligar" segue como affordance explícita. */


export function Fila({
  papel = "atendente",
  podeAudios = false,
}: {
  papel?: "gestor" | "atendente";
  podeAudios?: boolean;
} = {}) {
  const { itens, carregando, erro, semMapeamento, recarregar } = useFilaReal();

  /* Token do call center, buscado ao MONTAR e não ao tocar em "Ligar": o
     bloqueador de pop-ups só deixa `window.open` passar dentro do gesto, e um
     `await` no meio já o invalida. Com o token pronto, o toque abre a aba
     síncrono. Sem token, abre a URL nua e o operador digita a senha. */
  const [tokenCC, setTokenCC] = React.useState<string | null>(null);

  React.useEffect(() => {
    let vivo = true;
    fetch("/api/callcenter/token", { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (vivo) setTokenCC(d?.token ?? null);
      })
      .catch(() => {
        /* call center fora do ar: o botão degrada para login manual */
      });
    return () => {
      vivo = false;
    };
  }, []);

  // Chamado no gesto do toque. MESMO ENDERECO (u7): navega na MESMA aba pro
  // discador (mesma origem) — sem abrir aba nova órfã. A fila já tem a Ligação
  // (item.taskId), então passa &task pro discador abrir a chamada exata (auto-
  // loga por #token). Ao VOLTAR, o discador devolve o gestor pra ESTA fila (/fila).
  function ligar(item: ItemFilaReal) {
    vibrar();
    window.location.href = urlCallCenter(tokenCC, item.taskId);
  }

  /* Conteúdo da vista LIGAR (atendentes) — estados inline. */
  const secaoLigar = carregando ? (
    <Esqueleto alturas={[64, 86]} />
  ) : erro ? (
    <div className="empty">
      <b>Não deu para carregar a fila</b>
      <button type="button" className="seg" style={{ marginTop: 10 }} onClick={recarregar}>
        toque para tentar de novo
      </button>
    </div>
  ) : semMapeamento ? (
    <Autobox tom="warn" titulo="Fila não configurada">
      Configure o mapeamento do operador no discador (painel /admin do call center).
    </Autobox>
  ) : (
    <>
      <div className="qbar">
        <div className="qtop">
          <b>{itens.length}</b>
          <span>
            {itens.length > 0
              ? itens.length === 1
                ? "última ligação de hoje"
                : "na fila hoje — ligue a próxima"
              : "fila zerada hoje"}
          </span>
        </div>
      </div>

      {itens.length === 0 ? (
        <div className="empty">
          <b>Fila zerada</b>
          Você falou com todo mundo que o sistema separou para hoje.
        </div>
      ) : (
        /* u14: mostra só o PRÓXIMO lead (o backend já ordena por prioridade).
           Ao ligar e voltar pra cá, a fila recarrega e o próximo vira o topo. */
        <CardFila key={itens[0].taskId} item={itens[0]} indice={0} onLigar={ligar} />
      )}
    </>
  );

  // Atendente (e gestor sem áudios): a tela de sempre, sem dropdown.
  if (!podeAudios) {
    return (
      <div className="view">
        <Vhead titulo={papel === "gestor" ? "Ações de hoje" : "Fila de hoje"} sub="ordenada pelo sistema" live="ao vivo" />
        {secaoLigar}
      </div>
    );
  }

  // Romero (2026-08-19): SEM dropdown — a fila de Ligações É a lista de áudios.
  // Cada Ligação criada pra ele vira uma linha com chat, áudio e ligação direta
  // (fonte "fila" do <Audios>, que traz a ligacaoTaskId pro handoff).
  return (
    <div className="view">
      <Vhead titulo="Ações de hoje" sub="sua fila — mensagem, áudio e ligação" live="ao vivo" />
      <Audios embutido />
    </div>
  );
}

function CardFila({
  item,
  indice,
  onLigar,
}: {
  item: ItemFilaReal;
  indice: number;
  onLigar: (item: ItemFilaReal) => void;
}) {
  // u14: o CARD INTEIRO liga. Tocar em qualquer lugar do card dispara `onLigar`
  // (mesma ação do botão). O botão "Ligar" fica como affordance explícita e
  // dá stopPropagation pra não disparar duas vezes. A ficha saiu da Fila.
  return (
    <div
      className="task"
      onClick={() => onLigar(item)}
      style={{
        cursor: "pointer",
        animation: `reveal-up 380ms var(--ease-out-soft) ${Math.min(indice, 8) * 40}ms backwards`,
      }}
    >
      <div className="av">{iniciais(item.nome)}</div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="tn trunc">{item.nome}</div>
        {/* Telefone exibido ao operador autorizado — nunca logar (LGPD). */}
        <div className="tm trunc">{fmtTelefone(item.telefone)}</div>
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onLigar(item);
        }}
        className="go"
        aria-label="Ligar"
      >
        Ligar
      </button>
    </div>
  );
}
