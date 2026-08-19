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

   Cada número vem da fonte correta (correção de 18/08/2026):
     · Cadastros na base -> POSTGRES (users_romero). Antes vinha do task_count da
       Lista 01 do ClickUp e mostrava 100.007, escondendo 124 mil pessoas.
     · Votos/apoiadores  -> CLICKUP ao vivo. Antes vinha do espelho, congelado em
       17/08 15:30 — voto novo nunca aparecia na tela.
     · Ligações de hoje  -> CLICKUP ao vivo. Bloco NOVO: o painel nunca leu a Lista 02,
       embora as ligações estivessem sendo gravadas, transcritas e analisadas.
   Quando uma fonte não responde, o número vira "—" (honesto), nunca zero enganoso.
   O hook revalida sozinho a cada 20s — o painel muda sem ninguém recarregar.

   A Central de Campanha chega por `children` (componente de servidor). */

export function Inicio({ children }: { children?: React.ReactNode }) {
  const [nome, setNome] = React.useState("");
  const relogio = useRelogio();
  const fila = useFilaReal();
  const num = useNumerosCampanha();
  /* Denominador honesto da taxa de atendimento — o mesmo que a Central de Campanha usa. */
  const comDesfechoHoje = num.ligacoes ? num.ligacoes.hoje - num.ligacoes.semDesfechoHoje : 0;

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

      {/* métricas — cadastros (Postgres) · apoiadores (ClickUp ao vivo) · fila */}
      <div className="mrow">
        <Metrica
          valor={num.cadastros === null ? "—" : <Contador valor={num.cadastros} />}
          label="Cadastros na base"
          href="/base"
        />
        <Metrica
          valor={num.votosPopulados ? <Contador valor={num.apoiadores} /> : "—"}
          label="Apoiadores ativos"
          delta={num.votosPopulados ? undefined : "não foi possível ler os votos"}
          alerta={!num.votosPopulados}
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

      {/* ligações de hoje — o registro que o painel nunca mostrou até 18/08/2026.
          `hoje` usa o dia de Brasília (não UTC): senão o dia vira às 21h e as ligações
          da noite caem no dia seguinte. */}
      {num.ligacoes && (
        <>
          <div className="mrow">
            <Metrica
              valor={<Contador valor={num.ligacoes.hoje} />}
              label="Ligações hoje"
              delta={
                num.ligacoes.ultimaEm
                  ? `última às ${new Date(num.ligacoes.ultimaEm).toLocaleTimeString("pt-BR", {
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone: "America/Sao_Paulo",
                    })}`
                  : undefined
              }
            />
            {/* A taxa divide pelas ligações COM DESFECHO, não pelo total do dia — a mesma
                conta que a Central de Campanha faz. Dividir pelo total media o REGISTRO,
                não o atendimento: hoje a maioria das ligações não grava desfecho (o
                contador só sobe quando o closer escolhe o motivo na tela), e medido em
                19/08 as duas telas publicavam "taxa de atendimento" a 23x de distância —
                1% aqui contra 23% na Central, para a mesma operação. O denominador vai no
                rótulo para ninguém precisar adivinhar sobre o que é a porcentagem. */}
            <Metrica
              valor={<Contador valor={num.ligacoes.atendidasHoje} />}
              label="Atendidas hoje"
              delta={
                comDesfechoHoje > 0
                  ? `${Math.round((num.ligacoes.atendidasHoje / comDesfechoHoje) * 100)}% das ${comDesfechoHoje} com desfecho`
                  : num.ligacoes.hoje > 0
                    ? `nenhuma das ${num.ligacoes.hoje} de hoje tem desfecho gravado`
                    : undefined
              }
            />
            <Metrica
              valor={<Contador valor={num.ligacoes.comAnaliseIa} />}
              label="Analisadas pela IA"
              delta={`${num.ligacoes.comTranscricao} transcritas · ${num.ligacoes.total}${
                num.ligacoes.parcial ? "+" : ""
              } no total`}
              full
            />
          </div>
        </>
      )}

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
