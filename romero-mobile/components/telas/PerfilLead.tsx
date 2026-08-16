"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
// Helper PURO de iniciais — fora de qualquer store/localStorage.
import { iniciais } from "@/lib/leads-util";
import { fmtTelefone, urlCallCenter, vibrar } from "@/lib/contato";
import { useLeadReal, salvarVotoReal, salvarAnotacaoReal } from "@/lib/leads-real";
import type { VotoReal } from "@/lib/discador-servidor";
import { Autobox, BlocoLista, Esqueleto, Voltar } from "./blocos";

/* TELA 03 · FICHA DO LEAD (dado REAL)
   Fonte: `useLeadReal` (ClickUp via /api/mobile/lead/:id). Sem localStorage,
   sem pets/atendimentos/solicitações/bloqueio-de-repetição/WhatsApp.

   Duas gravações de volta no ClickUp: o APOIO (voto Romero/Andressa) e a
   ANOTAÇÃO (comentário append-only). O telefone aparece em claro para o
   operador discar — NUNCA logado (LGPD). */

const CHIPS: { valor: VotoReal; rotulo: string }[] = [
  { valor: "sim", rotulo: "Sim" },
  { valor: "nao", rotulo: "Não" },
  { valor: "naoDeclarou", rotulo: "Não declarou" },
];

export function PerfilLead({ id }: { id: string; de?: string }) {
  const de = useSearchParams().get("de");
  const { ficha, carregando, erro, semAcesso, recarregar } = useLeadReal(id);

  /* Token do call center, buscado ao MONTAR e não ao tocar em "Ligar": o
     bloqueador de pop-ups só deixa `window.open` passar dentro do gesto, e um
     `await` no meio já o invalida. Com o token pronto, o toque abre a aba
     síncrono. Sem token, abre a URL nua e o operador digita a senha. */
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

  const [salvando, setSalvando] = React.useState(false);
  const [anotacao, setAnotacao] = React.useState("");
  const [enviandoNota, setEnviandoNota] = React.useState(false);
  const [avisoNota, setAvisoNota] = React.useState<string | null>(null);

  const voltarPara = de === "fila" ? "/fila" : "/base";

  // Chamado no gesto do toque — NÃO async, para o `window.open` ser síncrono.
  function ligar() {
    vibrar();
    window.open(urlCallCenter(tokenCC), "_blank", "noopener,noreferrer");
  }

  async function votar(patch: { romero?: VotoReal; andressa?: VotoReal }) {
    if (salvando) return;
    setSalvando(true);
    try {
      await salvarVotoReal(id, patch);
      recarregar();
    } finally {
      setSalvando(false);
    }
  }

  async function enviarAnotacao() {
    const texto = anotacao.trim();
    if (!texto || enviandoNota) return;
    setEnviandoNota(true);
    setAvisoNota(null);
    try {
      const ok = await salvarAnotacaoReal(id, texto);
      if (ok) {
        setAnotacao("");
        setAvisoNota("Anotação enviada ao ClickUp.");
      } else {
        setAvisoNota("Não deu para enviar. Tente de novo.");
      }
    } finally {
      setEnviandoNota(false);
    }
  }

  if (carregando) return <Esqueleto alturas={[64, 40, 120, 120, 90]} />;

  if (semAcesso) {
    return (
      <div className="view">
        <Voltar href={voltarPara}>{de === "fila" ? "Fila de hoje" : "Base"}</Voltar>
        <Autobox tom="warn" titulo="Ficha não liberada">
          Acesso à base não habilitado no discador.
        </Autobox>
      </div>
    );
  }

  if (erro || !ficha) {
    return (
      <div className="view">
        <Voltar href={voltarPara}>{de === "fila" ? "Fila de hoje" : "Base"}</Voltar>
        <div className="empty">
          <b>Não deu para carregar</b>
          <button type="button" className="seg" style={{ marginTop: 10 }} onClick={recarregar}>
            toque para tentar de novo
          </button>
        </div>
      </div>
    );
  }

  const { lead, timeline } = ficha;
  const endereco =
    [lead.bairro, lead.cidade, lead.uf].filter(Boolean).join(" · ") || "Sem endereço na base";
  const dossie = typeof ficha.dossie === "string" ? ficha.dossie : "";
  const primeiraLigacao = timeline[0]?.data;

  return (
    <div className="view">
      <Voltar href={voltarPara}>{de === "fila" ? "Fila de hoje" : "Base"}</Voltar>

      <div className="prof">
        <div className="pav">{iniciais(lead.nome)}</div>
        <div style={{ minWidth: 0 }}>
          <div className="pn">{lead.nome}</div>
          <div className="pm">{endereco}</div>
        </div>
      </div>

      <div className="tags">
        {lead.confirmouRomero === "sim" && <span className="tag pe">Confirmou 40000</span>}
        {lead.confirmouAndressa === "sim" && <span className="tag t3">Confirmou 4020</span>}
        {!!lead.militante && <span className="tag">Militante</span>}
        {!lead.ultimoContato && <span className="tag">Nunca contatada</span>}
      </div>

      {/* Telefone em claro para o operador discar — nunca logar (LGPD). */}
      <div className="dim2">{fmtTelefone(lead.telefone)}</div>

      <BlocoLista titulo="Apoio confirmado">
        <LinhaApoio
          rotulo="Romero · 40000"
          valor={lead.confirmouRomero}
          salvando={salvando}
          onVotar={(v) => votar({ romero: v })}
        />
        <LinhaApoio
          rotulo="Andressa · 4020"
          valor={lead.confirmouAndressa}
          salvando={salvando}
          onVotar={(v) => votar({ andressa: v })}
        />
      </BlocoLista>

      <BlocoLista titulo="Dossiê">
        {dossie ? (
          <div className="dim" style={{ whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.5 }}>
            {dossie}
          </div>
        ) : (
          <div className="dim2" style={{ fontSize: 11.5 }}>
            Sem dossiê ainda.
          </div>
        )}
      </BlocoLista>

      {lead.observacao && (
        <BlocoLista titulo="Observação">
          <div className="dim" style={{ whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.5 }}>
            {lead.observacao}
          </div>
        </BlocoLista>
      )}

      <Link
        href={`/base/${id}/linha-do-tempo`}
        className="lblk"
        style={{ display: "flex", alignItems: "center", gap: 10 }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="lttl" style={{ marginBottom: 3 }}>
            <span>Últimas ligações</span>
          </span>
          <span className="dim" style={{ fontSize: 11.5 }}>
            {timeline.length} {timeline.length === 1 ? "ligação" : "ligações"}
            {primeiraLigacao ? ` · ${primeiraLigacao}` : ""}
          </span>
        </span>
        <span className="go">›</span>
      </Link>

      <BlocoLista titulo="Adicionar anotação">
        <textarea
          className="field"
          value={anotacao}
          onChange={(e) => {
            setAnotacao(e.target.value);
            if (avisoNota) setAvisoNota(null);
          }}
          placeholder="O que ficou combinado?"
          disabled={enviandoNota}
        />
        <div className="row" style={{ marginTop: 8, gap: 6, alignItems: "center" }}>
          <button
            type="button"
            className="seg on"
            onClick={enviarAnotacao}
            disabled={enviandoNota || !anotacao.trim()}
          >
            Enviar
          </button>
          {avisoNota && (
            <span className="dim2" style={{ fontSize: 11.5 }}>
              {avisoNota}
            </span>
          )}
        </div>
      </BlocoLista>

      <div className="grow" />

      <div className="acts">
        <button type="button" className="act cl" onClick={ligar}>
          <span className="ai">📞</span>Ligar
        </button>
      </div>
    </div>
  );
}

/** Uma linha de apoio: candidato + 3 chips (Sim/Não/Não declarou). */
function LinhaApoio({
  rotulo,
  valor,
  salvando,
  onVotar,
}: {
  rotulo: string;
  valor: VotoReal;
  salvando: boolean;
  onVotar: (v: VotoReal) => void;
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div className="dim2" style={{ fontSize: 11.5, marginBottom: 6 }}>
        {rotulo}
      </div>
      <div className="row" style={{ gap: 6 }}>
        {CHIPS.map((c) => (
          <button
            key={c.valor}
            type="button"
            className={valor === c.valor ? "seg on" : "seg"}
            onClick={() => onVotar(c.valor)}
            disabled={salvando}
          >
            {c.rotulo}
          </button>
        ))}
      </div>
    </div>
  );
}
