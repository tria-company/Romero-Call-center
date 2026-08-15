"use client";

import { useBloqueioRepeticao, useInteracoes, useLead, type Interacao } from "@/lib/db";
import { fmtHora, fmtDataCurta, fmtRelativo, mesmoDia, nomeCurto } from "@/lib/format";
import { Autobox, Esqueleto, Vhead, Voltar } from "./blocos";

/* TELA 04 · LINHA DO TEMPO
   Todo envio fica registrado, com visualização e resposta. É o que impede o
   contato repetido. */

/** A cor do marcador conta QUEM falou: você, Andreza ou ninguém (sem resposta). */
function classeDoItem(i: Interacao): string {
  if (i.autor === "andreza") return "tli gold";
  if (i.status === "visto-sem-resposta" || i.status === "nao-visto") return "tli mute";
  return "tli";
}

function selo(i: Interacao): { texto: string; classe: string } | null {
  if (i.selo) return { texto: i.selo, classe: "tlbadge seen" };
  if (i.status === "visto-respondeu") {
    return {
      texto: i.respostaMin ? `Visto · respondeu em ${i.respostaMin}min` : "Visto · respondeu",
      classe: "tlbadge seen",
    };
  }
  if (i.status === "visto-sem-resposta") return { texto: "Visto · sem resposta", classe: "tlbadge no" };
  if (i.status === "nao-visto") return { texto: "Ainda não visto", classe: "tlbadge" };
  return null;
}

/**
 * A linha do tempo atravessa anos. Sem o ano, "25/07" logo abaixo de "05/04"
 * parece fora de ordem — está certo, é do ano passado. O ano só aparece
 * quando não é o corrente, para não poluir o caso comum.
 */
function quando(em: string): string {
  const d = new Date(em);
  const agora = new Date();
  if (mesmoDia(d, agora)) return `Hoje · ${fmtHora(d)}`;
  const data =
    d.getFullYear() === agora.getFullYear()
      ? fmtDataCurta(d)
      : `${fmtDataCurta(d)}/${String(d.getFullYear()).slice(2)}`;
  return `${data} · ${fmtHora(d)}`;
}

export function LinhaDoTempo({ id }: { id: string }) {
  const lead = useLead(id);
  const interacoes = useInteracoes(id);
  const { bloqueado, ultimo } = useBloqueioRepeticao(id);

  if (lead === null) {
    return (
      <div className="view">
        <Voltar href="/base">Base</Voltar>
        <div className="empty">
          <b>Pessoa não encontrada</b>
          O cadastro pode ter sido removido deste aparelho.
        </div>
      </div>
    );
  }
  if (!lead) return <Esqueleto alturas={[64, 260, 74]} />;

  return (
    <div className="view">
      <Voltar href={`/base/${id}`}>{lead.nome.split(" ")[0]}</Voltar>

      <Vhead
        titulo="Linha do tempo"
        sub={`${nomeCurto(lead.nome)} · ${interacoes.length} ${
          interacoes.length === 1 ? "registro" : "registros"
        }`}
      />

      {interacoes.length === 0 ? (
        <div className="empty">
          <b>Nada registrado ainda</b>
          Todo contato feito pelo app entra aqui automaticamente.
        </div>
      ) : (
        <div className="tl">
          {interacoes.map((i, k) => {
            const s = selo(i);
            return (
              <div
                key={i.id}
                className={classeDoItem(i)}
                style={{
                  animation: `reveal-up 360ms var(--ease-out-soft) ${Math.min(k, 8) * 45}ms backwards`,
                }}
              >
                <div className="tld">{quando(i.em)}</div>
                <div className="tlt">{i.titulo}</div>
                {i.subtitulo && <div className="tls">{i.subtitulo}</div>}
                {s && <div className={s.classe}>{s.texto}</div>}
              </div>
            );
          })}
        </div>
      )}

      <div className="grow" />

      {bloqueado ? (
        <Autobox titulo="🔒 Bloqueio de repetição ativo">
          Último contato foi hoje. O sistema avisa antes de deixar você enviar de novo.
        </Autobox>
      ) : (
        <Autobox titulo="✅ Livre para novo contato" tom="info">
          {ultimo
            ? `Último envio ${fmtRelativo(ultimo.em)}. Pode falar com ${lead.nome.split(" ")[0]} sem repetir.`
            : "Nenhum envio registrado ainda — este será o primeiro contato."}
        </Autobox>
      )}
    </div>
  );
}
