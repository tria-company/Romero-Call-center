"use client";

import * as React from "react";
import Link from "next/link";
// Helper PURO de iniciais — fora de qualquer store/localStorage.
import { iniciais } from "@/lib/leads-util";
import type { ItemFilaReal } from "@/lib/discador-servidor";
import { useFilaReal } from "@/lib/fila-real";
import { fmtTelefone, urlCallCenter, vibrar } from "@/lib/contato";
import { Autobox, Esqueleto, Vhead } from "./blocos";

/* TELA 02 · FILA DE HOJE
   Fonte: a fila REAL do discador (Ligações abertas do dia do Romero), servida
   por /api/mobile/fila. Sem localStorage, sem selo de motivo (o backend não
   manda), sem marcar-feito: quando a Ligação recebe desfecho ela some no
   próximo fetch. O visual (Vhead, qbar, cards `.task`) segue o mockup.

   u12 (pedido do gestor): tocar no NOME abre a ficha do lead (`/base/:id?de=fila`
   — o voltar devolve pra cá), onde vivem o WhatsApp e o resto do contexto.
   O botão "Ligar" continua como atalho direto pro call center. */

export function Fila() {
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

  if (carregando) return <Esqueleto alturas={[64, 86, 86, 86]} />;

  if (erro) {
    return (
      <div className="view">
        <Vhead titulo="Fila de hoje" sub="ordenada pelo sistema" live="ao vivo" />
        <div className="empty">
          <b>Não deu para carregar</b>
          <button
            type="button"
            className="seg"
            style={{ marginTop: 10 }}
            onClick={recarregar}
          >
            toque para tentar de novo
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="view">
      <Vhead titulo="Fila de hoje" sub="ordenada pelo sistema" live="ao vivo" />

      {semMapeamento ? (
        <Autobox tom="warn" titulo="Fila não configurada">
          Configure o mapeamento do operador no discador (painel /admin do call center).
        </Autobox>
      ) : (
        <>
          <div className="qbar">
            <div className="qtop">
              <b>{itens.length}</b>
              <span>{itens.length > 0 ? "ligações na fila hoje" : "fila zerada hoje"}</span>
            </div>
          </div>

          {itens.length === 0 ? (
            <div className="empty">
              <b>Fila zerada</b>
              Você falou com todo mundo que o sistema separou para hoje.
            </div>
          ) : (
            itens.map((item, i) => (
              <CardFila key={item.taskId} item={item} indice={i} onLigar={ligar} />
            ))
          )}
        </>
      )}
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
  // Toque no nome/avatar abre a ficha real (u12). A chave é `leadTaskId`
  // (LEAD_REL — task-id real do lead), NUNCA `idLead` (chave de dedupe/GHL,
  // que a ficha /base/:id não aceita). Sem vínculo → sem link, resta o Ligar.
  const hrefFicha = item.leadTaskId
    ? `/base/${encodeURIComponent(item.leadTaskId)}?de=fila`
    : null;

  const corpo = (
    <>
      <div className="av">{iniciais(item.nome)}</div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="tn trunc">{item.nome}</div>
        {/* Telefone exibido ao operador autorizado — nunca logar (LGPD). */}
        <div className="tm trunc">{fmtTelefone(item.telefone)}</div>
      </div>
    </>
  );

  return (
    <div
      className="task"
      style={{
        animation: `reveal-up 380ms var(--ease-out-soft) ${Math.min(indice, 8) * 40}ms backwards`,
      }}
    >
      {hrefFicha ? (
        <Link
          href={hrefFicha}
          aria-label={`Abrir a ficha de ${item.nome}`}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "inherit",
            flex: 1,
            minWidth: 0,
            color: "inherit",
            textDecoration: "none",
          }}
        >
          {corpo}
        </Link>
      ) : (
        corpo
      )}

      <button type="button" onClick={() => onLigar(item)} className="go" aria-label="Ligar">
        Ligar
      </button>
    </div>
  );
}
