"use client";

import * as React from "react";
import { useCandidatos, useIndicadores, type Candidato } from "@/lib/db";
import { FOTO_ANDREZA, FOTO_ROMERO } from "@/lib/fotos";
import { fmtDiaPorExtenso, fmtInt, saudacao } from "@/lib/format";
import { operadorAtual } from "@/components/shell/BootDados";
import { InstallBanner } from "@/components/shell/InstallPrompt";
import { Contador, Metrica, Skels, Vhead } from "./blocos";
import { Foguete } from "./Foguete";

/* TELA 01 · INÍCIO
   Seguidores, base, fila do dia e as duas urnas com o mesmo peso na tela.
   Depois de tudo isso vem a Central de Campanha, que chega por `children`.

   O `children` NÃO É ENFEITE DE API: ele é o que permite a seção de campanha
   ser um componente de SERVIDOR dentro desta tela, que é cliente. Importá-la
   aqui a arrastaria para o cliente e ela passaria a esperar a hidratação junto
   com o resto — que é exatamente o problema que tirar aqueles números do
   localStorage resolveu. Quem monta o par é `app/(app)/page.tsx`.

   Por isso também o esqueleto virou PARCIAL: enquanto a base local hidrata,
   só os blocos daqui viram barras; a campanha já está desenhada embaixo. */

const FOTOS: Record<string, string> = { romero: FOTO_ROMERO, andreza: FOTO_ANDREZA };

export function Inicio({ children }: { children?: React.ReactNode }) {
  const candidatos = useCandidatos();
  const ind = useIndicadores();
  const [nome, setNome] = React.useState("");
  const relogio = useRelogio();

  React.useEffect(() => setNome(operadorAtual()), []);

  // `ind` só existe quando o banco existe (useIndicadores devolve null sem ele),
  // então testar `ind` no JSX já estreita o tipo e cobre os dois
  const carregando = !ind;

  /* UM return só, e o `{children}` SEMPRE no mesmo índice.
     Com dois `return` de formas diferentes ([Skels, children] contra
     [Vhead, igrow, mrow, banner, urnas, children]), o React casa filhos sem
     `key` POR ÍNDICE: na virada do esqueleto para o conteúdo ele comparava o
     `<section class="cc">` com um `<div class="igrow">`, via tipos diferentes,
     e DESTRUÍA a campanha inteira para remontá-la três posições adiante — 577
     elementos e 17 SVGs reconstruídos no mesmo quadro da hidratação, e a
     escolha do `<select>` do ranking perdida. Assim o array é sempre
     [miolo, children]: só o índice 0 troca de tipo, que é o que de fato muda. */
  return (
    <div className="view" aria-busy={carregando || undefined}>
      {ind ? (
        <>
          <Vhead
            titulo={`${saudacao()}, ${nome || "equipe"}`}
            sub={fmtDiaPorExtenso()}
            live={relogio}
          />

          {/* faixa do instagram */}
          <div className="igrow">
            {candidatos.map((c) => (
              <div key={c.id} className={c.id === "romero" ? "ig r" : "ig a"}>
                <div className="iga" style={{ backgroundImage: `url(${FOTOS[c.id]})` }} />
                <div style={{ minWidth: 0 }}>
                  <div className="igh">{c.instagram}</div>
                  <div className="igv">
                    <Contador valor={c.seguidores} />
                  </div>
                  <div className="igd">▲ {fmtInt(c.seguidoresHoje)} seguidores hj</div>
                </div>
              </div>
            ))}
          </div>

          {/* métricas */}
          <div className="mrow">
            <Metrica
              valor={<Contador valor={ind.cadastros} />}
              label="Cadastros na base"
              href="/base"
            />
            <Metrica
              valor={<Contador valor={ind.apoiadoresAtivos} />}
              label="Apoiadores ativos"
              delta={`▲ ${fmtInt(ind.apoiadoresHoje)} hoje`}
            />
            <Metrica
              valor={<Contador valor={ind.filaTotal} />}
              label="Sua fila de hoje"
              delta={`${fmtInt(ind.filaFeitas)} já feitas`}
              href="/fila"
            />
            {/* sem `href`: a tela de Equipe, que era o destino, foi removida.
                O número continua informando, mas não há mais para onde ir. */}
            <Metrica
              valor={<Contador valor={ind.abertas} />}
              label="Solicitações abertas"
              delta={
                ind.vencendoHoje > 0
                  ? `${fmtInt(ind.vencendoHoje)} vencendo hoje`
                  : "nenhuma vencendo"
              }
              alerta={ind.vencendoHoje > 0}
            />
          </div>

          {/* convite de instalação — some quando dispensado ou já instalado */}
          <InstallBanner />

          {/* as duas urnas */}
          {candidatos.map((c) => (
            <CardCandidato key={c.id} c={c} />
          ))}
        </>
      ) : (
        <Skels alturas={[64, 62, 132, 172, 172]} />
      )}

      {/* a Central de Campanha, depois de tudo o que já existia.
          FORA do condicional de propósito — ver o comentário acima. */}
      {children}
    </div>
  );
}

function CardCandidato({ c }: { c: Candidato }) {
  const pct = c.meta > 0 ? (c.apoio / c.meta) * 100 : 0;
  return (
    <div className={c.id === "romero" ? "cand r" : "cand a"}>
      <div className="cand-main">
        <div className="who">
          {c.emoji} {c.cargo}
        </div>
        <div className="nm">{c.nome}</div>
        <div className="num">{c.numero}</div>
        <div className="big">
          <Contador valor={c.apoio} />
        </div>
        <div className="goal">
          apoio confirmado · rumo a <b>{fmtInt(c.meta)}</b> ·{" "}
          {pct.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
        </div>
        <div className="today">🔥 +{fmtInt(c.apoioHoje)} hoje</div>
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
