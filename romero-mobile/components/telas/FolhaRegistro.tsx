"use client";

import * as React from "react";
import {
  empurrarParaFila,
  marcarItemFila,
  registrarInteracao,
  salvarAnotacao,
  useBanco,
  type AutorInteracao,
  type Lead,
  type StatusEnvio,
  type TipoInteracao,
} from "@/lib/db";
import { vibrar } from "@/lib/contato";
import { Folha } from "./Folha";

/**
 * "Registrar interação" — o que fecha o contato da fila.
 *
 * Tudo em botão, como o resto do sistema: canal, desfecho e a pergunta que
 * decide o próximo passo ("pediu algo?"). Responder SIM leva direto para a
 * tela de nova solicitação; responder NÃO fecha o item da fila e sai.
 */

/**
 * A LISTA CONTINUA COM QUATRO. Aqui não se dispara nada — só se anota o que já
 * aconteceu, e mensagem, áudio e vídeo continuam acontecendo pelo WhatsApp do
 * próprio operador, mesmo agora que o app só sabe ligar. Tirar as opções
 * tornaria impossível registrar a verdade.
 */
const CANAIS: { id: TipoInteracao; label: string; autor: AutorInteracao; titulo: string }[] = [
  { id: "ligacao", label: "Ligação", autor: "voce", titulo: "Você ligou" },
  { id: "mensagem", label: "Mensagem", autor: "voce", titulo: "Você enviou mensagem" },
  { id: "audio", label: "Áudio", autor: "voce", titulo: "Você enviou áudio" },
  { id: "video", label: "Vídeo", autor: "voce", titulo: "Você enviou vídeo" },
];

const DESFECHOS: { id: StatusEnvio | "sem-resposta-ainda"; label: string }[] = [
  { id: "visto-respondeu", label: "Respondeu" },
  { id: "visto-sem-resposta", label: "Viu e não respondeu" },
  { id: "nao-visto", label: "Ainda não viu" },
];

export function FolhaRegistro({
  aberto,
  lead,
  onFechar,
  onPedido,
}: {
  aberto: boolean;
  lead: Lead;
  onFechar: () => void;
  onPedido: () => void;
}) {
  const banco = useBanco();
  // padrão "ligação": é o único canal que o app dispara desde que os botões de
  // mensagem e vídeo saíram do perfil
  const [canal, setCanal] = React.useState<TipoInteracao>("ligacao");
  const [desfecho, setDesfecho] = React.useState<StatusEnvio>("visto-respondeu");
  const [nota, setNota] = React.useState("");
  const [salvando, setSalvando] = React.useState(false);

  React.useEffect(() => {
    if (!aberto) return;
    setCanal("ligacao");
    setDesfecho("visto-respondeu");
    setNota("");
    setSalvando(false);
  }, [aberto]);

  const gravar = React.useCallback(async () => {
    const c = CANAIS.find((x) => x.id === canal) ?? CANAIS[0];
    await registrarInteracao({
      leadId: lead.id,
      tipo: c.id,
      autor: c.autor,
      titulo: c.titulo,
      subtitulo: nota.trim() || undefined,
      status: desfecho,
    });
    if (nota.trim()) await salvarAnotacao(lead.id, nota.trim());

    // fecha o item da fila deste lead, se houver um aberto
    const item = banco?.fila.find((f) => f.leadId === lead.id && !f.feito);
    if (item) await marcarItemFila(item.id, true);
  }, [banco, canal, desfecho, lead.id, nota]);

  async function concluir(pediu: boolean) {
    if (salvando) return;
    setSalvando(true);
    vibrar(12);
    await gravar();

    if (pediu) {
      onPedido();
      return;
    }
    // Sem pedido: se a conversa não engatou, o sistema já reprograma um
    // reaquecimento — é o que impede o lead de sumir da fila para sempre.
    if (desfecho !== "visto-respondeu") {
      await empurrarParaFila({
        leadId: lead.id,
        motivo: "reaquecimento",
        detalhe: "Não respondeu no último contato",
      });
    }
    onFechar();
  }

  return (
    <Folha
      aberto={aberto}
      onFechar={onFechar}
      titulo="Registrar interação"
      sub={lead.nome}
      rodape={
        <div className="stack" style={{ gap: 8 }}>
          <div className="flabel" style={{ marginBottom: 0 }}>
            Pediu algo?
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="cta red"
              style={{ flex: 1 }}
              disabled={salvando}
              onClick={() => concluir(true)}
            >
              Sim, abrir solicitação
            </button>
            <button
              type="button"
              className="cta ghost"
              style={{ flex: 1 }}
              disabled={salvando}
              onClick={() => concluir(false)}
            >
              Não
            </button>
          </div>
        </div>
      }
    >
      <div>
        <div className="flabel">Canal</div>
        <div className="segs">
          {CANAIS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={canal === c.id ? "seg on" : "seg"}
              onClick={() => setCanal(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flabel">Desfecho</div>
        <div className="segs">
          {DESFECHOS.map((d) => (
            <button
              key={d.id}
              type="button"
              className={desfecho === d.id ? "seg on" : "seg"}
              onClick={() => setDesfecho(d.id as StatusEnvio)}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flabel">Anotação</div>
        <textarea
          className="field"
          value={nota}
          onChange={(e) => setNota(e.target.value)}
          placeholder="O que ela falou? O que ficou combinado?"
          maxLength={400}
          data-autofocus
        />
      </div>
    </Folha>
  );
}
