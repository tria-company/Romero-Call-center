"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  SERVICO_LABEL,
  iniciais,
  registrarInteracao,
  resumoLead,
  salvarAnotacao,
  useAtendimentos,
  useBloqueioRepeticao,
  useFila,
  useInteracoes,
  useLead,
  useSolicitacoesDoLead,
} from "@/lib/db";
import { fmtDataCurta, fmtRelativo } from "@/lib/format";
import {
  fmtTelefone,
  linkWhatsapp,
  modeloMensagem,
  urlCallCenter,
  vibrar,
} from "@/lib/contato";
import { Autobox, BlocoLista, Esqueleto, Voltar } from "./blocos";
import { FolhaRegistro } from "./FolhaRegistro";

/* TELA 03 · PERFIL DO LEAD
   O pet em destaque, o histórico de atendimento e a última anotação dele.

   Dois canais e um registro. O mockup tinha três (Mensagem, Vídeo, Ligar); os
   dois de WhatsApp saíram a pedido, e depois o WhatsApp voltou — agora como
   "conversar", que abre a conversa da pessoa com a mensagem-modelo pronta para
   editar. Só o Vídeo continua fora, e com ele `modeloConvite` segue sem
   chamador em `lib/contato.ts`. */

export function PerfilLead({ id, de }: { id: string; de?: string }) {
  const router = useRouter();
  const lead = useLead(id);
  const atendimentos = useAtendimentos(id);
  const interacoes = useInteracoes(id);
  const solicitacoes = useSolicitacoesDoLead(id);
  const { bloqueado, ultimo } = useBloqueioRepeticao(id);
  // o motivo pelo qual esta pessoa está na fila hoje — é ele que escolhe a
  // mensagem-modelo do WhatsApp. `undefined` quando ela não está na fila, e aí
  // `modeloMensagem` cai no cumprimento genérico.
  const { itens } = useFila();
  const motivoNaFila = itens.find((i) => i.leadId === id && !i.feito)?.motivo;

  const [registrando, setRegistrando] = React.useState(false);
  const [anotacao, setAnotacao] = React.useState("");
  const [editandoNota, setEditandoNota] = React.useState(false);

  /* Token do call center, buscado ao ABRIR a ficha e não ao tocar em "Ligar".
     O motivo é o bloqueador de pop-ups: `window.open` só passa se for chamado
     dentro do gesto do usuário, e um `await` no meio já o invalida — o iPhone
     em PWA é o mais rígido nisso. Com o token pronto, o toque abre a aba de
     forma síncrona. Sem token, abre a URL nua e o operador digita a senha. */
  const [tokenCC, setTokenCC] = React.useState<string | null>(null);

  React.useEffect(() => {
    let vivo = true;
    fetch("/api/callcenter/token", { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (vivo) setTokenCC(d?.token ?? null);
      })
      .catch(() => {
        /* call center fora do ar: o botão degrada para login manual */
      });
    return () => {
      vivo = false;
    };
  }, []);

  React.useEffect(() => {
    if (lead?.anotacao) setAnotacao(lead.anotacao.texto);
  }, [lead?.anotacao]);

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
  if (!lead) return <Esqueleto alturas={[64, 40, 62, 120, 90, 74]} />;

  const voltarPara = de === "fila" ? "/fila" : "/base";
  const abertas = solicitacoes.filter((s) => s.status !== "resolvida");

  /**
   * Abre a conversa daquela pessoa no WhatsApp, com a mensagem-modelo do MOTIVO
   * pelo qual ela está na fila já digitada no campo — pronta para editar, não
   * enviada. É para isso que `modeloMensagem` existe.
   *
   * O registro na linha do tempo diz "abriu conversa", e não "enviou mensagem",
   * porque abrir o WhatsApp não é enviar nada: o app não tem como saber se a
   * mensagem saiu. Pelo mesmo motivo vai SEM `status` — "Ainda não visto"
   * afirmaria uma entrega que talvez nunca tenha acontecido.
   */
  async function abrirWhatsapp() {
    if (!lead) return;
    vibrar();
    const texto = modeloMensagem(lead, motivoNaFila);
    const href = linkWhatsapp(lead, texto);
    if (!href) return;
    await registrarInteracao({
      leadId: lead.id,
      tipo: "mensagem",
      autor: "voce",
      titulo: "Você abriu conversa no WhatsApp",
      subtitulo: texto.slice(0, 90),
    });
    window.open(href, "_blank", "noopener,noreferrer");
  }

  /**
   * Abre o CALL CENTER, não o discador do aparelho. A ligação passa a
   * acontecer lá — com gravação, transcrição e análise —, e o número vai no
   * subtítulo porque é ele que o operador precisa ter à mão ao chegar.
   *
   * Mesma honestidade do WhatsApp: registrar "Você abriu o call center" e não
   * "Você ligou", porque o app não tem como saber se a chamada aconteceu.
   *
   * Em aba nova, para a ficha da pessoa não se perder atrás do call center.
   */
  function ligar() {
    if (!lead) return;
    vibrar();
    // A aba abre PRIMEIRO, ainda dentro do gesto do toque. O registro na linha
    // do tempo vai depois, sem `await` — ele não pode atrasar a navegação, ou
    // o bloqueador de pop-ups mata a janela.
    window.open(urlCallCenter(tokenCC), "_blank", "noopener,noreferrer");
    void registrarInteracao({
      leadId: lead.id,
      tipo: "ligacao",
      autor: "voce",
      titulo: "Você abriu o call center",
      subtitulo: fmtTelefone(lead.whatsapp),
    });
  }

  return (
    <div className="view">
      <Voltar href={voltarPara}>{de === "fila" ? "Fila de hoje" : "Base"}</Voltar>

      <div className="prof">
        <div className="pav">{iniciais(lead.nome)}</div>
        <div style={{ minWidth: 0 }}>
          <div className="pn">{lead.nome}</div>
          <div className="pm">
            {resumoLead(lead)}
          </div>
        </div>
      </div>

      <div className="tags">
        {lead.multiplicadora && <span className="tag t3">Multiplicadora</span>}
        {lead.confirmou.includes("romero") && <span className="tag pe">Confirmou 40000</span>}
        {lead.confirmou.includes("andreza") && <span className="tag t3">Confirmou 4020</span>}
        {lead.indicacoes > 0 && (
          <span className="tag ok">
            {lead.indicacoes} {lead.indicacoes === 1 ? "indicação" : "indicações"}
          </span>
        )}
        {!lead.ultimoContatoEm && <span className="tag">Nunca contatada</span>}
      </div>

      {lead.pets.map((p) => (
        <div key={p.id} className="pet">
          <span className="ic">{p.especie === "cao" ? "🐕" : "🐈"}</span>
          <div style={{ minWidth: 0 }}>
            <div className="pt trunc">{p.nome}</div>
            <div className="ps trunc">
              {p.especie === "cao" ? "Cão" : "Gato"} · {p.raca} · {p.idadeAnos}{" "}
              {p.idadeAnos === 1 ? "ano" : "anos"}
            </div>
          </div>
          <span className={p.vivo ? "st" : "st obito"}>{p.vivo ? "Vivo" : "Óbito"}</span>
        </div>
      ))}

      <BlocoLista titulo="Atendimentos" contador={atendimentos.length}>
        {atendimentos.length === 0 ? (
          <div className="dim2" style={{ fontSize: 11.5 }}>
            Nenhum atendimento registrado ainda.
          </div>
        ) : (
          atendimentos.slice(0, 5).map((a) => (
            <div key={a.id} className="lrow">
              <span className="dot" />
              <span className="nm">
                {SERVICO_LABEL[a.servico]}
                {a.detalhe ? ` — ${a.detalhe}` : ""}
              </span>
              <span className="tm">{fmtDataCurta(a.em)}</span>
            </div>
          ))
        )}
      </BlocoLista>

      {abertas.length > 0 && (
        <BlocoLista titulo="Solicitações em aberto" contador={abertas.length}>
          {abertas.map((s) => (
            <div key={s.id} className="lrow">
              <span className={s.prioridade === 1 ? "dot rd" : s.prioridade === 2 ? "dot am" : "dot"} />
              <span className="nm">
                #{s.codigo} · {SERVICO_LABEL[s.qual]}
              </span>
              <span className="tm">{s.status === "assumida" ? s.responsavel : "aberta"}</span>
            </div>
          ))}
        </BlocoLista>
      )}

      <BlocoLista
        titulo="Sua última anotação"
        contador={lead.anotacao ? fmtDataCurta(lead.anotacao.em) : "—"}
      >
        {editandoNota ? (
          <>
            <textarea
              className="field"
              value={anotacao}
              onChange={(e) => setAnotacao(e.target.value)}
              placeholder="O que ficou combinado?"
              autoFocus
            />
            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              <button
                type="button"
                className="seg on"
                onClick={async () => {
                  await salvarAnotacao(lead.id, anotacao.trim());
                  setEditandoNota(false);
                }}
              >
                Salvar
              </button>
              <button type="button" className="seg" onClick={() => setEditandoNota(false)}>
                Cancelar
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setEditandoNota(true)}
            style={{
              fontSize: 11.5,
              color: lead.anotacao ? "var(--dim)" : "var(--dim-2)",
              lineHeight: 1.5,
              textAlign: "left",
              width: "100%",
            }}
          >
            {lead.anotacao?.texto || "Toque para escrever a primeira anotação."}
          </button>
        )}
      </BlocoLista>

      <Link
        href={`/base/${lead.id}/linha-do-tempo`}
        className="lblk"
        style={{ display: "flex", alignItems: "center", gap: 10 }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="lttl" style={{ marginBottom: 3 }}>
            <span>Linha do tempo</span>
          </span>
          <span className="dim" style={{ fontSize: 11.5 }}>
            {interacoes.length} {interacoes.length === 1 ? "registro" : "registros"}
            {ultimo ? ` · último ${fmtRelativo(ultimo.em)}` : ""}
          </span>
        </span>
        <span className="go">›</span>
      </Link>

      {bloqueado && (
        <Autobox titulo="🔒 Bloqueio de repetição ativo" tom="warn">
          {/* volta a ser neutro entre canais: são dois de novo (WhatsApp e Ligar) */}
          Já houve contato com {lead.nome.split(" ")[0]} hoje. Procurar de novo agora costuma
          queimar o canal — o sistema avisa antes de deixar você repetir.
        </Autobox>
      )}

      <div className="grow" />

      {/* Dois CANAIS lado a lado e o registro embaixo — a estrutura do mockup,
          com dois no lugar de três. Quando só sobrou "Ligar", a hierarquia
          precisou ser vertical (primário + ghost empilhados) porque não havia
          par; com o WhatsApp de volta há par, e a fileira volta a ser a forma
          certa: canais são IRMÃOS, e "Registrar interação" é o que fecha o
          contato — por isso ele retoma o gradiente primário. */}
      <div className="acts">
        <button type="button" className="act wa" onClick={abrirWhatsapp}>
          <span className="ai">💬</span>WhatsApp
        </button>
        <button type="button" className="act cl" onClick={ligar}>
          <span className="ai">📞</span>Ligar
        </button>
      </div>

      <button type="button" className="cta" onClick={() => setRegistrando(true)}>
        Registrar interação
      </button>

      <FolhaRegistro
        aberto={registrando}
        lead={lead}
        onFechar={() => setRegistrando(false)}
        onPedido={() => {
          setRegistrando(false);
          router.push(`/base/${lead.id}/solicitacao`);
        }}
      />
    </div>
  );
}
