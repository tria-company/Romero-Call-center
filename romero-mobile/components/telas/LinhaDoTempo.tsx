"use client";

import { useLeadReal } from "@/lib/leads-real";
import { Esqueleto, Vhead, Voltar } from "./blocos";

/* TELA 04 · LINHA DO TEMPO (dado REAL)
   As ligações do lead vindas do ClickUp (via `useLeadReal`). Sem cores por
   autor/visto, sem bloqueio-de-repetição: cada item é uma ligação com desfecho
   e o que a análise da IA extraiu (texto já scrub de PII pelo backend). */

export function LinhaDoTempo({ id }: { id: string }) {
  const { ficha, carregando, erro, semAcesso } = useLeadReal(id);

  if (carregando) return <Esqueleto alturas={[64, 260, 74]} />;

  if (semAcesso || erro || !ficha) {
    return (
      <div className="view">
        <Voltar href={`/base/${id}`}>Voltar</Voltar>
        <div className="empty">
          <b>Não deu para carregar</b>
          A linha do tempo deste lead não está disponível agora.
        </div>
      </div>
    );
  }

  const { lead, timeline } = ficha;

  return (
    <div className="view">
      <Voltar href={`/base/${id}`}>{lead.nome.split(" ")[0]}</Voltar>

      <Vhead
        titulo="Linha do tempo"
        sub={`${lead.nome} · ${timeline.length} ${
          timeline.length === 1 ? "ligação" : "ligações"
        }`}
      />

      {timeline.length === 0 ? (
        <div className="empty">
          <b>Nenhuma ligação registrada ainda.</b>
        </div>
      ) : (
        <div className="tl">
          {timeline.map((item, k) => (
            <div
              key={k}
              className="tli"
              style={{
                animation: `reveal-up 360ms var(--ease-out-soft) ${Math.min(k, 8) * 45}ms backwards`,
              }}
            >
              <div className="tld">{item.data}</div>
              <div className="tlt">{item.atendeu ? "Atendeu" : "Não atendeu"}</div>
              {/* Duração: atendeu = tempo de conversa; não atendeu = tempo que
                  o operador ficou tentando (u13). Só aparece quando há valor. */}
              {item.duracao && (
                <div className="tls">
                  {item.atendeu ? "Conversa" : "Tentativa"}: {item.duracao}
                </div>
              )}
              {item.aderencia && (
                <div className="tls">Aderência: {item.aderencia}</div>
              )}
              {item.motivoFalha && <div className="tls">{item.motivoFalha}</div>}
              {item.resumoAnalise && <div className="tls">{item.resumoAnalise}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
