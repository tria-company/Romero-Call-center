"use client";

import * as React from "react";
import { CANDIDATOS, type CandidatoInfo } from "@/lib/candidatos-config";
import { fmtDiaPorExtenso, fmtInt, saudacao } from "@/lib/format";
import { operadorAtual } from "@/components/shell/BootDados";
import { InstallBanner } from "@/components/shell/InstallPrompt";
import { useFilaReal } from "@/lib/fila-real";
import { useNumerosCampanha } from "@/lib/numeros-campanha";
import { Contador, Metrica, Vhead } from "./blocos";
import { Foguete } from "./Foguete";

/* TELA 01 · INÍCIO (dashboard rico, u10 — SÓ dado real)
   Faixa do Instagram (seguidores reais, config — sem integração automática),
   as métricas de operação (cadastros/apoiadores/fila) do ClickUp ao vivo, e as
   duas urnas com o foguete (votos confirmados vs meta). Nada de mock.

   Votos/apoiadores contam no ESPELHO (Postgres rápido). Enquanto o espelho não
   estiver backfillado (reload do PostgREST pendente), esses números aparecem
   como "—" (honesto), não como zero enganoso. Cadastros e fila já são reais.

   A Central de Campanha chega por `children` (componente de servidor). */

export function Inicio({ children }: { children?: React.ReactNode }) {
  const [nome, setNome] = React.useState("");
  const relogio = useRelogio();
  const fila = useFilaReal();
  const num = useNumerosCampanha();

  React.useEffect(() => setNome(operadorAtual()), []);

  return (
    <div className="view">
      <Vhead
        titulo={`${saudacao()}, ${nome || "equipe"}`}
        sub={fmtDiaPorExtenso()}
        live={relogio}
      />

      {/* faixa do instagram — seguidores REAIS (config, você atualiza) */}
      <div className="igrow">
        {CANDIDATOS.map((c) => (
          <div key={c.id} className={c.id === "romero" ? "ig r" : "ig a"}>
            <div className="iga" style={{ backgroundImage: `url(${c.foto})` }} />
            <div style={{ minWidth: 0 }}>
              <div className="igh">{c.instagram}</div>
              <div className="igv">
                <Contador valor={c.seguidores} />
              </div>
              <div className="igd">seguidores</div>
            </div>
          </div>
        ))}
      </div>

      {/* métricas — cadastros (ClickUp) · apoiadores (espelho) · fila (ao vivo) */}
      <div className="mrow">
        <Metrica
          valor={num.cadastros === null ? "—" : <Contador valor={num.cadastros} />}
          label="Cadastros na base"
          href="/base"
        />
        <Metrica
          valor={num.votosPopulados ? <Contador valor={num.apoiadores} /> : "—"}
          label="Apoiadores ativos"
          delta={num.votosPopulados ? undefined : "aguardando base rápida"}
        />
        <Metrica
          valor={<Contador valor={fila.itens.length} />}
          label="Sua fila de hoje"
          delta={fila.erro ? "não foi possível carregar" : undefined}
          alerta={fila.erro}
          href="/fila"
          full
        />
      </div>

      {/* convite de instalação — some quando dispensado ou já instalado */}
      <InstallBanner />

      {/* as duas urnas com o foguete — votos confirmados (real) vs meta */}
      {CANDIDATOS.map((c) => (
        <CardCandidato
          key={c.id}
          c={c}
          apoio={c.id === "romero" ? num.votosRomero : num.votosAndressa}
          populado={num.votosPopulados}
        />
      ))}

      {/* a Central de Campanha (componente de servidor via children) */}
      {children}
    </div>
  );
}

function CardCandidato({
  c,
  apoio,
  populado,
}: {
  c: CandidatoInfo;
  apoio: number;
  populado: boolean;
}) {
  const pct = populado && c.meta > 0 ? (apoio / c.meta) * 100 : 0;
  return (
    <div className={c.id === "romero" ? "cand r" : "cand a"}>
      <div className="cand-main">
        <div className="who">
          {c.emoji} {c.cargo}
        </div>
        <div className="nm">{c.nome}</div>
        <div className="num">{c.numero}</div>
        <div className="big">{populado ? <Contador valor={apoio} /> : "—"}</div>
        <div className="goal">
          apoio confirmado · rumo a <b>{fmtInt(c.meta)}</b>
          {populado
            ? ` · ${pct.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
            : ""}
        </div>
        {!populado && <div className="today">votos aparecem quando a base rápida ligar</div>}
      </div>
      <Foguete pct={pct} />
    </div>
  );
}

/** Relógio da barra ao vivo. Atualiza no minuto, não no segundo. */
function useRelogio(): string {
  const [hora, setHora] = React.useState("");
  React.useEffect(() => {
    const tick = () =>
      setHora(
        new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      );
    tick();
    const id = setInterval(tick, 20_000);
    return () => clearInterval(id);
  }, []);
  return hora;
}
