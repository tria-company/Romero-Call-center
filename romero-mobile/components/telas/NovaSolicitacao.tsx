"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  PRIORIDADE_LABEL,
  QUAIS_POR_TIPO,
  SERVICO_LABEL,
  TIPO_SOLICITACAO_LABEL,
  criarSolicitacao,
  useBanco,
  useLead,
  type Prioridade,
  type Servico,
  type TipoSolicitacao,
} from "@/lib/db";
import { vibrar } from "@/lib/contato";
import { Autobox, Esqueleto, Vhead, Voltar } from "./blocos";

/* TELA 05 · NOVA SOLICITAÇÃO
   Tudo em botão, nada digitado — só a observação aceita texto. O aviso deixa
   explícito que a automação dispara nas três prioridades. */

const PRIORIDADES: Prioridade[] = [1, 2, 3];

export function NovaSolicitacao({ id }: { id: string }) {
  const router = useRouter();
  const lead = useLead(id);
  const banco = useBanco();

  const [pediu, setPediu] = React.useState(true);
  const [tipo, setTipo] = React.useState<TipoSolicitacao>("veterinaria");
  const [qual, setQual] = React.useState<Servico>("castracao");
  const [observacao, setObservacao] = React.useState("");
  const [prioridade, setPrioridade] = React.useState<Prioridade>(1);
  const [enviando, setEnviando] = React.useState(false);

  // trocar o tipo troca a lista de "qual": manter a escolha antiga deixaria
  // um par impossível (ex.: financeira + cirurgia)
  React.useEffect(() => {
    const opcoes = QUAIS_POR_TIPO[tipo];
    if (!opcoes.includes(qual)) setQual(opcoes[0]);
  }, [tipo, qual]);

  if (lead === null) {
    return (
      <div className="view">
        <Voltar href="/base">Base</Voltar>
        <div className="empty">
          <b>Pessoa não encontrada</b>
          Volte para a base e escolha de novo.
        </div>
      </div>
    );
  }
  if (!lead || !banco) return <Esqueleto alturas={[64, 62, 62, 62, 74, 62, 84]} />;

  async function enviar() {
    if (!lead || enviando) return;
    setEnviando(true);
    vibrar(14);
    const s = await criarSolicitacao({
      leadId: lead.id,
      tipo,
      qual,
      observacao: observacao.trim(),
      prioridade,
    });
    /* Era `/equipe?novo=${s.id}`, a tela que confirmava o envio. Sem ela, o
       destino é a ficha de quem pediu — é lá que a solicitação recém-criada
       aparece em aberto.

       VOLTAR, e não `replace` para a mesma URL. Chega-se aqui por um `push` a
       partir da própria ficha, então `replace('/base/[id]')` deixaria duas
       entradas idênticas no histórico: no app instalado, onde o botão voltar do
       sistema é a navegação principal, o primeiro toque não faria nada. E a
       ficha perderia o `?de=fila`, trocando o link de voltar de "Fila de hoje"
       para "Base" justo para quem veio da fila.

       O `replace` fica como saída para quem abriu esta tela direto, sem
       histórico para desfazer (link colado, atalho). */
    if (window.history.length > 1) router.back();
    else router.replace(`/base/${s.leadId}`);
  }

  return (
    <div className="view">
      <Voltar href={`/base/${id}`}>{lead.nome.split(" ")[0]}</Voltar>

      <Vhead titulo="Nova solicitação" sub={lead.nome} />

      <div>
        <div className="flabel">Pediu algo?</div>
        <div className="segs">
          <button type="button" className={pediu ? "seg on" : "seg"} onClick={() => setPediu(true)}>
            Sim
          </button>
          <button type="button" className={!pediu ? "seg on" : "seg"} onClick={() => setPediu(false)}>
            Não
          </button>
        </div>
      </div>

      {!pediu ? (
        <>
          <Autobox titulo="Nada a abrir" tom="info">
            Sem pedido, não há solicitação para a equipe. O contato já ficou registrado na linha
            do tempo de {lead.nome.split(" ")[0]}.
          </Autobox>
          <div className="grow" />
          <button type="button" className="cta ghost" onClick={() => router.push(`/base/${id}`)}>
            Voltar ao perfil
          </button>
        </>
      ) : (
        <>
          <div>
            <div className="flabel">Tipo</div>
            <div className="segs">
              {(Object.keys(TIPO_SOLICITACAO_LABEL) as TipoSolicitacao[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={tipo === t ? "seg on" : "seg"}
                  onClick={() => setTipo(t)}
                >
                  {TIPO_SOLICITACAO_LABEL[t]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flabel">Qual</div>
            <div className="segs">
              {QUAIS_POR_TIPO[tipo].map((q) => (
                <button
                  key={q}
                  type="button"
                  className={qual === q ? "seg on" : "seg"}
                  onClick={() => setQual(q)}
                >
                  {SERVICO_LABEL[q]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flabel">Observação</div>
            <textarea
              className="field"
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
              placeholder="Ex.: gata da vizinha, ninhada recente"
              maxLength={280}
              style={{ minHeight: 58 }}
            />
          </div>

          <div>
            <div className="flabel">Prioridade</div>
            <div className="segs">
              {PRIORIDADES.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={prioridade === p ? (p === 1 ? "seg p1" : "seg on") : "seg"}
                  onClick={() => setPrioridade(p)}
                >
                  {PRIORIDADE_LABEL[p]}
                </button>
              ))}
            </div>
          </div>

          <Autobox titulo="⚡ Dispara ao enviar">
            Grupo Operação Central Animal · {banco.painel.equipeTamanho} pessoas · com link do CRM.
            Vale para as três prioridades.
          </Autobox>

          <div className="grow" />

          <button type="button" className="cta red" onClick={enviar} disabled={enviando}>
            {enviando ? "Enviando…" : "Enviar para a equipe"}
          </button>
        </>
      )}
    </div>
  );
}
