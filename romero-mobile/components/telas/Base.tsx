"use client";

import * as React from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
// Só o helper PURO de iniciais — direto do schema, NÃO do barrel `@/lib/db`
// (que arrasta o store localStorage). A Base agora vive fora do localStorage.
import { iniciais } from "@/lib/db/schema";
import { useLeadsReais } from "@/lib/leads-real";
import { Autobox, Esqueleto, Vhead } from "./blocos";

/* TELA · BASE
   A porta de entrada do perfil do lead. Fonte: a Lista 01 REAL do discador
   (`useLeadsReais`), servida por /api/mobile/leads. Busca por NOME vai no hook
   (server-side via `q`, já debouncado); o recorte é filtro CLIENT-SIDE sobre a
   página retornada. Telefone SEMPRE mascarado — nunca em claro, nunca logado. */

const RECORTES = [
  { id: "todos", label: "Todos" },
  { id: "romero", label: "Confirmou 40000" },
  { id: "andressa", label: "Confirmou 4020" },
  { id: "militante", label: "Militante" },
  { id: "sem-contato", label: "Sem contato" },
] as const;

type RecorteId = (typeof RECORTES)[number]["id"];

const PAGINA = 25;

export function Base() {
  const [busca, setBusca] = React.useState("");
  const [recorte, setRecorte] = React.useState<RecorteId>("todos");
  const [visiveis, setVisiveis] = React.useState(PAGINA);

  // O hook já debouncia a busca (~300ms) — passar `busca` direto, sem debounce local.
  const { leads, carregando, erro, semAcesso, recarregar } = useLeadsReais({ busca });

  // Recorte é CLIENT-SIDE: o backend só filtra por nome, não por recorte.
  const filtrados = React.useMemo(() => {
    switch (recorte) {
      case "romero":
        return leads.filter((l) => l.confirmouRomero === "sim");
      case "andressa":
        return leads.filter((l) => l.confirmouAndressa === "sim");
      case "militante":
        return leads.filter((l) => l.militante);
      case "sem-contato":
        return leads.filter((l) => l.semContato);
      default:
        return leads;
    }
  }, [leads, recorte]);

  React.useEffect(() => setVisiveis(PAGINA), [busca, recorte]);

  // rolagem infinita: uma sentinela no fim da lista revela a página aos poucos
  const sentinela = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = sentinela.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (e) => e[0]?.isIntersecting && setVisiveis((v) => v + PAGINA),
      { rootMargin: "320px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [filtrados]);

  if (carregando) return <Esqueleto alturas={[64, 46, 44, 300]} />;

  if (semAcesso) {
    return (
      <div className="view">
        <Vhead titulo="Base" />
        <Autobox tom="warn" titulo="Base não liberada">
          O acesso à base de leads não está habilitado (DISCADOR_LEAD_BROWSE no discador).
        </Autobox>
      </div>
    );
  }

  const lista = filtrados.slice(0, visiveis);

  return (
    <div className="view">
      <Vhead
        titulo="Base"
        sub={`${filtrados.length} ${filtrados.length === 1 ? "pessoa" : "pessoas"}`}
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
          placeholder="Nome"
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

      {erro ? (
        <div className="empty">
          <b>Não deu para carregar</b>
          <button type="button" className="seg" style={{ marginTop: 10 }} onClick={recarregar}>
            tentar de novo
          </button>
        </div>
      ) : lista.length === 0 ? (
        <div className="empty">
          <b>Ninguém com esse recorte</b>
          Ajuste a busca ou troque o filtro.
        </div>
      ) : (
        <div className="stack">
          {lista.map((l, i) => (
            <Link
              key={l.leadTaskId}
              href={`/base/${l.leadTaskId}`}
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
                {/* Bairro · cidade quando houver; senão o telefone MASCARADO — nunca claro/logado. */}
                <span className="tm trunc" style={{ display: "block" }}>
                  {[l.bairro, l.cidade].filter(Boolean).join(" · ") || l.telefoneMascarado}
                </span>
                <span className="tags" style={{ marginTop: 7 }}>
                  {l.confirmouRomero === "sim" && <span className="tag pe">40000</span>}
                  {l.confirmouAndressa === "sim" && <span className="tag t3">4020</span>}
                  {l.militante && <span className="tag">Militante</span>}
                  {l.semContato && <span className="tag">Sem contato</span>}
                </span>
              </span>
              <span className="go">›</span>
            </Link>
          ))}
          <div ref={sentinela} style={{ height: 1 }} />
        </div>
      )}
    </div>
  );
}
