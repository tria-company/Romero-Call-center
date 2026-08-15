"use client";

import * as React from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
import { iniciais, resumoLead, useBanco, useLeads } from "@/lib/db";
import { fmtInt } from "@/lib/format";
import { Esqueleto, Vhead } from "./blocos";

/* TELA · BASE
   A porta de entrada do perfil do lead: busca, recortes e a lista. */

const RECORTES: readonly { id: string; label: string }[] = [
  { id: "todos", label: "Todos" },
  { id: "multiplicadoras", label: "Multiplicadoras" },
  { id: "romero", label: "Confirmou 40000" },
  { id: "andreza", label: "Confirmou 4020" },
  { id: "sem-contato", label: "Sem contato" },
];

const PAGINA = 25;

export function Base() {
  const banco = useBanco();
  const [busca, setBusca] = React.useState("");
  const [debounce, setDebounce] = React.useState("");
  const [recorte, setRecorte] = React.useState("todos");
  const [visiveis, setVisiveis] = React.useState(PAGINA);

  React.useEffect(() => {
    const t = setTimeout(() => setDebounce(busca), 180);
    return () => clearTimeout(t);
  }, [busca]);

  const leads = useLeads({ busca: debounce, recorte });

  React.useEffect(() => setVisiveis(PAGINA), [debounce, recorte]);

  // rolagem infinita: uma sentinela no fim da lista
  const sentinela = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = sentinela.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && setVisiveis((v) => v + PAGINA), {
      rootMargin: "320px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [leads]);

  if (!banco || !leads) return <Esqueleto alturas={[64, 46, 44, 300]} />;

  const lista = leads.slice(0, visiveis);

  return (
    <div className="view">
      <Vhead
        titulo="Base"
        sub={`${fmtInt(banco.painel.cadastros)} cadastros · ${fmtInt(banco.leads.length)} carregados no aparelho`}
      />

      <label style={{ position: "relative", display: "block" }}>
        <Search
          size={15}
          style={{
            position: "absolute",
            left: 12,
            top: "50%",
            transform: "translateY(-50%)",
            color: "var(--dim-2)",
            pointerEvents: "none",
          }}
        />
        <input
          className="field"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Nome, bairro, pet ou telefone"
          type="search"
          inputMode="search"
          aria-label="Buscar na base"
          style={{ paddingLeft: 34, paddingRight: busca ? 36 : 13 }}
        />
        {busca && (
          <button
            type="button"
            onClick={() => setBusca("")}
            aria-label="Limpar busca"
            style={{
              position: "absolute",
              right: 8,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--dim-2)",
              display: "inline-flex",
            }}
          >
            <X size={15} />
          </button>
        )}
      </label>

      <div className="scroll-x">
        {RECORTES.map((rc) => (
          <button
            key={rc.id}
            type="button"
            className={recorte === rc.id ? "seg on" : "seg"}
            onClick={() => setRecorte(rc.id)}
          >
            {rc.label}
          </button>
        ))}
      </div>

      <p className="dim2" style={{ fontSize: 11, padding: "0 2px" }}>
        {fmtInt(leads.length)} {leads.length === 1 ? "pessoa" : "pessoas"}
      </p>

      {lista.length === 0 ? (
        <div className="empty">
          <b>Ninguém com esse recorte</b>
          Ajuste a busca ou troque o filtro.
        </div>
      ) : (
        <div className="stack">
          {lista.map((l, i) => {
            const pet = l.pets[0];
            return (
              <Link
                key={l.id}
                href={`/base/${l.id}`}
                className="task"
                style={{
                  animation: `reveal-up 360ms var(--ease-out-soft) ${Math.min(i, 8) * 35}ms backwards`,
                }}
              >
                <span className="av">{iniciais(l.nome)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="tn trunc" style={{ display: "block" }}>
                    {l.nome}
                  </span>
                  <span className="tm trunc" style={{ display: "block" }}>
                    {resumoLead(l)}
                    {pet ? ` · ${pet.nome}` : ""}
                  </span>
                  <span className="tags" style={{ marginTop: 7 }}>
                    {l.multiplicadora && <span className="tag t3">Multiplicadora</span>}
                    {l.confirmou.includes("romero") && <span className="tag pe">40000</span>}
                    {l.confirmou.includes("andreza") && <span className="tag t3">4020</span>}
                    {!l.ultimoContatoEm && <span className="tag">Sem contato</span>}
                  </span>
                </span>
                <span className="go">›</span>
              </Link>
            );
          })}
          <div ref={sentinela} style={{ height: 1 }} />
        </div>
      )}
    </div>
  );
}
