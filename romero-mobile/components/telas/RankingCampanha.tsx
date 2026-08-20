"use client";

import * as React from "react";
import {
  METRICAS_RANKING,
  METRICA_LABEL,
  METRICA_UNIDADE,
  ordenarRanking,
  tomAderencia,
  type MetricaRanking,
  type Telefonista,
} from "@/lib/campanha";
import { fmtInt, fmtMinSeg } from "@/lib/format";
import { COR, Retrato } from "./CampanhaGraficos";

/* Ranking dos telefonistas — a ÚNICA parte cliente da Central de Campanha.
   O resto da tela é número fixo e renderiza no servidor; aqui existe estado
   (a métrica escolhida) e por isso este arquivo é separado.

   Componente cliente ainda passa pelo servidor na primeira pintura, então a
   ordenação inicial (por votos) já sai pronta do HTML: a lista não se
   reorganiza sozinha quando o JavaScript chega. */

/** As métricas que acompanham o número grande, fora a que está ordenando. */
const SECUNDARIAS: MetricaRanking[] = ["conv", "ader", "tsec", "votos"];

function valorMetrica(o: Telefonista, k: MetricaRanking): string {
  switch (k) {
    case "votos":
      return fmtInt(o.votos);
    case "conv":
      return `${o.conv}%`;
    case "lig":
      return fmtInt(o.lig);
    case "ader":
      // "—" e não "0%": sem ligação analisada não há aderência a mostrar, e o zero era
      // lido como desempenho péssimo por quem olha a tela.
      return o.aderAmostra > 0 ? `${o.ader}%` : "—";
    case "tsec":
      return fmtMinSeg(o.tsec);
    case "ligh":
      return o.ligh.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
}

export function Ranking({
  telefonistas,
  equipeTotal,
  semOperador,
}: {
  telefonistas: readonly Telefonista[];
  equipeTotal: number;
  /** Ligações sem OPERADOR gravado: ficam fora do ranking mas dentro dos totais. */
  semOperador: { lig: number; cont: number };
}) {
  const [por, setPor] = React.useState<MetricaRanking>("votos");
  const linhas = React.useMemo(() => ordenarRanking(telefonistas, por), [telefonistas, por]);

  return (
    <div className="card">
      <div className="rk-head">
        <div>
          <div className="rk-title">Ranking dos telefonistas</div>
          <div className="rk-sub">
            {equipeTotal > 0
              ? `${fmtInt(equipeTotal)} colaboradores`
              : `${telefonistas.length} com ligação registrada`}
          </div>
        </div>
        <label className="sortwrap">
          Ordenar por
          <select
            className="sort"
            value={por}
            onChange={(e) => setPor(e.target.value as MetricaRanking)}
          >
            {METRICAS_RANKING.map((k) => (
              <option key={k} value={k}>
                {METRICA_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="rlist">
        {linhas.length === 0 ? (
          <div className="rk-sub" style={{ padding: "14px 0", opacity: 0.7 }}>
            Nenhuma ligação registrada ainda — o ranking se preenche conforme a
            operação roda.
          </div>
        ) : (
          linhas.map((o, idx) => (
            <LinhaRanking key={o.id} o={o} posicao={idx + 1} por={por} />
          ))
        )}
      </div>

      <div className="rk-sub legenda">
        ● verde aderência ≥80% · ● âmbar 70–79% · ● vermelho &lt;70% (treino) · ● cinza sem
        ligação analisada
      </div>

      {/* Por que a soma das linhas NÃO bate com os totais do painel. Ligação sem OPERADOR
          gravado não tem a quem ser atribuída e sai do ranking, mas continua nos totais —
          e ela não é resíduo: medido em 19/08, eram 25 ligações carregando 22 dos 56
          contatos da operação inteira. Sem esta linha, quem conferir a conta encontra 34
          contatos no ranking contra 56 no painel e não tem como saber para onde foram. */}
      {semOperador.lig > 0 && (
        <div className="rk-sub legenda">
          {fmtInt(semOperador.lig)} ligação(ões) sem operador gravado ({fmtInt(semOperador.cont)}{" "}
          contato(s)) ficam fora do ranking, mas contam nos totais do painel.
        </div>
      )}
    </div>
  );
}

function LinhaRanking({
  o,
  posicao,
  por,
}: {
  o: Telefonista;
  posicao: number;
  por: MetricaRanking;
}) {
  const podio = posicao <= 3;
  // `aro` e não `ring`: `ring` é utilitário do Tailwind e venceria este CSS
  const anel = podio ? `avwrap aro s${posicao}` : "avwrap";

  return (
    <div className={podio ? "rrow top" : "rrow"}>
      {podio ? (
        <span className={`medal m${posicao}`}>{posicao}</span>
      ) : (
        <span className="rk">{posicao}</span>
      )}
      <div className={anel}>
        <Retrato id={o.id} />
      </div>
      <div className="rinfo">
        <div className="rn">
          <span className="rstat" style={{ background: COR[tomAderencia(o.ader, o.aderAmostra)] }} />
          {o.nome}
        </div>
        {/* "na fila" é o que sobrou do lote sem ser discado. Fica ao lado das discadas de
            propósito: as duas juntas são o número que o painel publicava sozinho como
            "ligações", e mostrá-las separadas é o que deixa a diferença auditável. */}
        <div className="rs">
          {o.turno || (
            <>
              {fmtInt(o.lig)} lig. · {fmtInt(o.cont)} contatos
              {o.fila > 0 ? ` · ${fmtInt(o.fila)} na fila` : ""}
            </>
          )}
        </div>
      </div>
      <div className="rmet">
        <div className="rsm">
          {SECUNDARIAS.filter((k) => k !== por).map((k) => (
            <span key={k}>
              <b>{valorMetrica(o, k)}</b> {METRICA_UNIDADE[k]}
            </span>
          ))}
        </div>
        <div className="rbig">
          <b>{valorMetrica(o, por)}</b>
          <small>{METRICA_UNIDADE[por]}</small>
        </div>
      </div>
    </div>
  );
}
