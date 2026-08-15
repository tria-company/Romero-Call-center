"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  MOTIVO_CLASSE,
  MOTIVO_LABEL,
  iniciais,
  marcarItemFila,
  useBanco,
  useFila,
  useIndicadores,
  type ItemFila,
  type Lead,
} from "@/lib/db";
import { fmtDuracaoCurta, fmtInt } from "@/lib/format";
import { vibrar } from "@/lib/contato";
import { Esqueleto, Vhead } from "./blocos";

/* TELA 02 · FILA DE HOJE
   Ordenada pelo motor: retorno de entrega vem antes de aniversário, primeiro
   contato e reaquecimento. */

export function Fila() {
  const banco = useBanco();
  const { itens, feitas, total } = useFila();
  const ind = useIndicadores();
  const router = useRouter();
  const [mostrarFeitas, setMostrarFeitas] = React.useState(false);
  const [largura, setLargura] = React.useState(0);

  const pct = total > 0 ? (feitas / total) * 100 : 0;

  // a barra sobe do zero depois da montagem, como no mockup
  React.useEffect(() => {
    const t = setTimeout(() => setLargura(pct), 260);
    return () => clearTimeout(t);
  }, [pct]);

  if (!banco || !ind) return <Esqueleto alturas={[64, 78, 86, 86, 86, 86]} />;

  const porId = new Map(banco.leads.map((l) => [l.id, l]));
  const visiveis = mostrarFeitas ? itens : itens.filter((i) => !i.feito);

  return (
    <div className="view">
      <Vhead titulo="Fila de hoje" sub="ordenada pelo sistema" live="ao vivo" />

      <div className="qbar">
        <div className="qtop">
          <b>
            {fmtInt(feitas)} / {fmtInt(total)}
          </b>
          <span>
            {total - feitas > 0
              ? `faltam ${fmtInt(total - feitas)} · ~${fmtDuracaoCurta(ind.minutosRestantes)}`
              : "fila zerada hoje"}
          </span>
        </div>
        <div className="track">
          <i style={{ width: `${largura}%` }} />
        </div>
      </div>

      <div className="row" style={{ padding: "2px 2px 0" }}>
        <span className="dim2" style={{ fontSize: 11, flex: 1 }}>
          {mostrarFeitas ? "mostrando tudo" : `${fmtInt(feitas)} feitas escondidas`}
        </span>
        <button
          type="button"
          className="seg"
          aria-pressed={mostrarFeitas}
          style={{ padding: "6px 11px", fontSize: 11 }}
          onClick={() => setMostrarFeitas((v) => !v)}
        >
          {mostrarFeitas ? "Esconder feitas" : "Ver feitas"}
        </button>
      </div>

      {visiveis.length === 0 ? (
        <div className="empty">
          <b>Fila zerada</b>
          Você falou com todo mundo que o sistema separou para hoje.
        </div>
      ) : (
        visiveis.map((item, i) => (
          <ItemDaFila
            key={item.id}
            item={item}
            lead={porId.get(item.leadId)}
            indice={i}
            onAbrir={() => router.push(`/base/${item.leadId}?de=fila`)}
            onAlternar={() => {
              vibrar(12);
              void marcarItemFila(item.id, !item.feito);
            }}
          />
        ))
      )}
    </div>
  );
}

function ItemDaFila({
  item,
  lead,
  indice,
  onAbrir,
  onAlternar,
}: {
  item: ItemFila;
  lead?: Lead;
  indice: number;
  onAbrir: () => void;
  onAlternar: () => void;
}) {
  if (!lead) return null;
  // "quente" é só o retorno de entrega em aberto: é a única linha que perde
  // valor se esperar — o apoiador acabou de receber algo do gabinete.
  const quente = item.motivo === "retorno" && !item.feito;

  return (
    <div
      className={`task${quente ? " hot" : ""}${item.feito ? " feita" : ""}`}
      style={{ animation: `reveal-up 380ms var(--ease-out-soft) ${Math.min(indice, 8) * 40}ms backwards` }}
    >
      <button
        type="button"
        onClick={onAlternar}
        className="av"
        aria-label={item.feito ? "Reabrir contato" : "Marcar como feito"}
        aria-pressed={item.feito}
        style={{ cursor: "pointer" }}
      >
        {item.feito ? "✓" : iniciais(lead.nome)}
      </button>

      <button
        type="button"
        onClick={onAbrir}
        style={{ flex: 1, minWidth: 0, textAlign: "left" }}
      >
        <div className="tn trunc">{lead.nome}</div>
        <div className="tm trunc">{item.detalhe}</div>
        <div className={`why ${MOTIVO_CLASSE[item.motivo]}`}>{MOTIVO_LABEL[item.motivo]}</div>
      </button>

      <button type="button" onClick={onAbrir} className="go" aria-label="Abrir perfil">
        ›
      </button>
    </div>
  );
}
