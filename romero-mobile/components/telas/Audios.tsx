"use client";

import * as React from "react";
import { Mic, Pause, Play, RotateCcw, Square } from "lucide-react";
// Helper PURO de iniciais — fora de qualquer store/localStorage.
import { iniciais } from "@/lib/leads-util";
import { fmtTelefone } from "@/lib/contato";
import { enviarAudioParaLead, useAudiosReais } from "@/lib/audios-real";
import type { LeadAudioReal } from "@/lib/audios-real";
import { Autobox, BlocoLista, Skels, Vhead } from "./blocos";

/* TELA · LISTA DE ÁUDIOS (Fase 12, canal de envio Evolution API)
   Única superfície de UI da fase (12-UI-SPEC.md). Fonte: `useAudiosReais`
   (leads nunca-ligados + origens + status da instância dedicada), servida
   por `/api/mobile/audios*` (rotas-ponte romero-only, 12-04).

   Ordem topo → base (12-UI-SPEC §"Screen /audios"): Vhead → banner de conexão
   (D-08, SEMPRE visível) → chips de ORIGEM (D-04/D-05, "Todos" primeiro) →
   cartão "Áudio pronto" (gravação/preview, MediaRecorder, D-01/D-02/D-03) →
   lista de leads com envio por linha (D-06/D-07/D-08). Erro/vazio POR BLOCO —
   a lista falhar não derruba banner nem cartão (item 6 do UI-SPEC).

   Peso local 700 (não o 800 herdado de `h1`/`.qtop b`/`.igv`): esta tela
   colapsa pra 2 pesos (400/700, ver 12-UI-SPEC §Typography) — override só
   aqui, `@layer base` global não muda.

   LGPD: telefone sempre mascarado (`fmtTelefone`); nunca logar
   telefone/leadId/base64 do áudio. */

/** mm:ss, tabular-nums (Display do 12-UI-SPEC). */
function fmtMMSS(ms: number): string {
  const totalSeg = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeg / 60);
  const s = totalSeg % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

type EstadoGravacao = "vazio" | "gravando" | "preview";

/** Estado de envio de UMA linha — badge/erro por lead, nunca trava a lista (D-07). */
type EstadoEnvioLinha =
  | { tipo: "idle" }
  | { tipo: "enviando" }
  | { tipo: "enviado"; hora: string }
  | { tipo: "desconectado" }
  | { tipo: "sem-whatsapp" }
  | { tipo: "erro" };

const ENVIO_IDLE: EstadoEnvioLinha = { tipo: "idle" };

export function Audios() {
  const { leads, origens, carregando, erro, recarregar, conectado } = useAudiosReais();
  const [origemAtiva, setOrigemAtiva] = React.useState<string>("todos");

  // Recorte por ORIGEM é client-side (mesmo molde de Base.tsx/RECORTES) — o
  // backend já entrega só os leads nunca-ligados; o chip só filtra a página.
  const leadsFiltrados = React.useMemo(
    () => (origemAtiva === "todos" ? leads : leads.filter((l) => l.origem === origemAtiva)),
    [leads, origemAtiva],
  );

  /* ── Cartão "Áudio pronto" (D-01/D-02/D-03) — o "compositor": grava uma vez,
     o mesmo áudio serve pra vários leads sem regravar. ────────────────────── */
  const [estadoGravacao, setEstadoGravacao] = React.useState<EstadoGravacao>("vazio");
  const [erroMic, setErroMic] = React.useState<string | null>(null);
  const [duracaoMs, setDuracaoMs] = React.useState(0); // cronômetro ao vivo (gravando)
  const [duracaoPreviewMs, setDuracaoPreviewMs] = React.useState(0);
  const [audioUrl, setAudioUrl] = React.useState<string | null>(null);
  const [audioBase64, setAudioBase64] = React.useState<string | null>(null);
  const [audioMime, setAudioMime] = React.useState("audio/webm");
  const [tocando, setTocando] = React.useState(false);

  const streamRef = React.useRef<MediaStream | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const cronometroRef = React.useRef<number | null>(null);
  const inicioGravacaoRef = React.useRef(0);
  const audioElRef = React.useRef<HTMLAudioElement | null>(null);
  // WR-04: guarda os setState assíncronos (onstop/FileReader) contra a tela já
  // desmontada — parar o recorder no cleanup dispara `onstop` DEPOIS do
  // unmount, então sem essa flag o montarPreview faria setState num componente
  // morto.
  const montadoRef = React.useRef(true);

  const pararCronometro = React.useCallback(() => {
    if (cronometroRef.current != null) {
      window.clearInterval(cronometroRef.current);
      cronometroRef.current = null;
    }
  }, []);

  const montarPreview = React.useCallback((blob: Blob, decorridoMs: number) => {
    // WR-04: se a tela desmontou antes do `onstop` chegar aqui, não toca em
    // state — só libera o blob e sai (senão vaza o object URL sem preview).
    if (!montadoRef.current) return;
    const url = URL.createObjectURL(blob);
    setAudioUrl((antiga) => {
      if (antiga) URL.revokeObjectURL(antiga);
      return url;
    });
    setAudioMime(blob.type || "audio/webm");
    setDuracaoPreviewMs(decorridoMs);
    const reader = new FileReader();
    reader.onloadend = () => {
      if (!montadoRef.current) return;
      const resultado = reader.result;
      if (typeof resultado === "string") {
        setAudioBase64(resultado.split(",")[1] ?? "");
      }
    };
    reader.readAsDataURL(blob);
    setEstadoGravacao("preview");
  }, []);

  // Toque em "Gravar áudio": getUserMedia SÍNCRONO dentro do gesto, SEM
  // await antes — restrição de iOS (web/app.js `iniciarLigacao`). O
  // MediaRecorder é criado só quando a Promise resolve; o gesto em si já
  // disparou getUserMedia antes de qualquer await.
  function iniciarGravacao() {
    setErroMic(null);
    let promessa: Promise<MediaStream>;
    try {
      promessa = navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      promessa = Promise.reject(e);
    }
    promessa
      .then((stream) => {
        streamRef.current = stream;
        chunksRef.current = [];
        const mimeAlvo = "audio/webm;codecs=opus";
        const opcoes =
          typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(mimeAlvo)
            ? { mimeType: mimeAlvo }
            : undefined;
        const rec = new MediaRecorder(stream, opcoes);
        recorderRef.current = rec;
        rec.ondataavailable = (ev) => {
          if (ev.data.size > 0) chunksRef.current.push(ev.data);
        };
        rec.onstop = () => {
          const decorridoMs = Date.now() - inicioGravacaoRef.current;
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || mimeAlvo });
          montarPreview(blob, decorridoMs);
          stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        };
        rec.start();
        inicioGravacaoRef.current = Date.now();
        setDuracaoMs(0);
        setEstadoGravacao("gravando");
        pararCronometro();
        cronometroRef.current = window.setInterval(() => {
          setDuracaoMs(Date.now() - inicioGravacaoRef.current);
        }, 250);
      })
      .catch(() => {
        // NotAllowedError/SecurityError (permissão negada) ou qualquer outra
        // falha de captura caem na mesma copy do 12-UI-SPEC — a causa
        // provável pro usuário é sempre "permissão do navegador".
        setErroMic(
          "Não conseguimos acessar o microfone. Verifique a permissão do navegador para gravar.",
        );
      });
  }

  function pararGravacao() {
    pararCronometro();
    recorderRef.current?.stop();
  }

  function regravar() {
    setAudioUrl((antiga) => {
      if (antiga) URL.revokeObjectURL(antiga);
      return null;
    });
    setAudioBase64(null);
    setDuracaoPreviewMs(0);
    setTocando(false);
    setEstadoGravacao("vazio");
  }

  function alternarReproducao() {
    const el = audioElRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }

  // Limpa recursos vivos (recorder + stream de mic + object URL) ao desmontar
  // a tela. WR-04: para o MediaRecorder ANTES dos tracks (senão fica em
  // `recording` com a fonte encerrada por baixo) e marca a tela como desmontada
  // pra que o `onstop`/FileReader assíncronos não façam setState num componente
  // morto (guardados em montarPreview).
  React.useEffect(
    () => () => {
      montadoRef.current = false;
      pararCronometro();
      try {
        recorderRef.current?.stop();
      } catch {
        /* recorder já parado/inativo — ignora */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      setAudioUrl((atual) => {
        if (atual) URL.revokeObjectURL(atual);
        return atual;
      });
    },
    [pararCronometro],
  );

  /* ── Envio por linha (D-06/D-07/D-08) ─────────────────────────────────── */
  const [enviosPorLead, setEnviosPorLead] = React.useState<Record<string, EstadoEnvioLinha>>({});
  const [avisoSemAudioLead, setAvisoSemAudioLead] = React.useState<string | null>(null);
  const avisoTimeoutRef = React.useRef<number | null>(null);

  const audioPronto = estadoGravacao === "preview" && !!audioBase64;

  async function enviarParaLead(lead: LeadAudioReal) {
    const jaEnviando = enviosPorLead[lead.leadTaskId]?.tipo === "enviando";
    if (jaEnviando) return;
    if (!audioPronto || !conectado) {
      // Toast leve: só o hint "grave um áudio primeiro" (a causa mais comum
      // de o botão estar "desabilitado") — não bloqueia navegação nem trava
      // a linha; some sozinho.
      setAvisoSemAudioLead(lead.leadTaskId);
      if (avisoTimeoutRef.current != null) window.clearTimeout(avisoTimeoutRef.current);
      avisoTimeoutRef.current = window.setTimeout(() => setAvisoSemAudioLead(null), 2200);
      return;
    }
    setEnviosPorLead((prev) => ({ ...prev, [lead.leadTaskId]: { tipo: "enviando" } }));
    // A espera do rate limiter (D-06/D-07) acontece DENTRO desta chamada — a
    // linha fica com o badge "Aguardando ritmo seguro…" (tipo "enviando")
    // pelo tempo que ela durar, sem travar o resto da lista.
    const resultado = await enviarAudioParaLead(lead.leadTaskId, audioBase64!, audioMime);
    if (resultado.tipo === "sucesso") {
      const hora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      setEnviosPorLead((prev) => ({ ...prev, [lead.leadTaskId]: { tipo: "enviado", hora } }));
    } else if (resultado.tipo === "desconectado") {
      setEnviosPorLead((prev) => ({ ...prev, [lead.leadTaskId]: { tipo: "desconectado" } }));
    } else if (resultado.tipo === "sem_whatsapp") {
      // Estado TERMINAL (D-decisão 2, quick 260818-mv2): sem fila automática,
      // sem botão de retry — o operador segue pelo contato manual.
      setEnviosPorLead((prev) => ({ ...prev, [lead.leadTaskId]: { tipo: "sem-whatsapp" } }));
    } else {
      setEnviosPorLead((prev) => ({ ...prev, [lead.leadTaskId]: { tipo: "erro" } }));
    }
  }

  return (
    <div className="view">
      <Vhead
        titulo={<span style={{ fontWeight: 700 }}>Lista de Áudios</span>}
        sub={`${leadsFiltrados.length} ${leadsFiltrados.length === 1 ? "lead" : "leads"}`}
      />

      {/* Banner de conexão (D-08) — SEMPRE visível, nunca colapsável/omitido,
          independente do estado da lista/cartão abaixo. */}
      <Autobox
        tom={conectado ? "go" : "warn"}
        titulo={conectado ? "Número conectado" : "Número desconectado"}
      >
        {conectado
          ? "Os áudios estão saindo normalmente."
          : "Reconecte o WhatsApp dedicado — nenhum áudio sai enquanto a sessão estiver fora."}
      </Autobox>

      {/* Tira de chips de ORIGEM (D-04/D-05) — "Todos" primeiro + valores
          distintos vindos do endpoint, sem rótulo hardcoded além de "Todos". */}
      <div className="scroll-x">
        <button
          type="button"
          className={origemAtiva === "todos" ? "seg on" : "seg"}
          style={{ fontWeight: 700 }}
          onClick={() => setOrigemAtiva("todos")}
        >
          Todos
        </button>
        {origens.map((o) => (
          <button
            key={o}
            type="button"
            className={origemAtiva === o ? "seg on" : "seg"}
            style={{ fontWeight: 700 }}
            onClick={() => setOrigemAtiva(o)}
          >
            {o}
          </button>
        ))}
      </div>

      {/* Cartão "Áudio pronto" — o compositor. Fica ANTES da lista, nunca faz
          parte dela; o mesmo áudio em preview serve pra vários leads (D-03). */}
      <BlocoLista titulo="Áudio pronto">
        {estadoGravacao === "vazio" && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
            <Mic size={40} style={{ color: "var(--romero)", marginBottom: 14 }} />
            {erroMic && (
              <div style={{ fontSize: 12, marginBottom: 10, color: "#ff9b9b", lineHeight: 1.5 }}>
                {erroMic}
              </div>
            )}
            <button
              type="button"
              className="cta"
              onClick={iniciarGravacao}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
            >
              <Mic size={18} />
              Gravar áudio
            </button>
            <div className="dim2" style={{ fontSize: "var(--t-body)", fontWeight: 400, lineHeight: 1.5, marginTop: 12 }}>
              Grave uma vez — o mesmo áudio fica pronto para os próximos leads.
            </div>
          </div>
        )}

        {estadoGravacao === "gravando" && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 16 }}>
              <span className="pulse" style={{ background: "var(--alert)", boxShadow: "0 0 0 0 rgba(255,107,107,.55)" }} />
              <span
                style={{
                  fontSize: "var(--t-num)",
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: "-0.03em",
                }}
              >
                {fmtMMSS(duracaoMs)}
              </span>
            </div>
            <button
              type="button"
              className="cta"
              onClick={pararGravacao}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
            >
              <Square size={18} />
              Parar
            </button>
          </div>
        )}

        {estadoGravacao === "preview" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                type="button"
                onClick={alternarReproducao}
                aria-label={tocando ? "Pausar" : "Reproduzir"}
                style={{
                  flex: "none",
                  minWidth: 44,
                  minHeight: 44,
                  borderRadius: "50%",
                  background: "rgba(255,255,255,.08)",
                  border: "1px solid var(--line-2)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--ink)",
                }}
              >
                {tocando ? <Pause size={20} /> : <Play size={20} />}
              </button>
              <span
                style={{
                  fontSize: "var(--t-num)",
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: "-0.03em",
                }}
              >
                {fmtMMSS(duracaoPreviewMs)}
              </span>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption -- nota de voz curta, sem faixa de legenda aplicável */}
              <audio
                ref={audioElRef}
                src={audioUrl ?? undefined}
                onPlay={() => setTocando(true)}
                onPause={() => setTocando(false)}
                onEnded={() => setTocando(false)}
                style={{ display: "none" }}
              />
            </div>
            <div className="acts">
              <button
                type="button"
                className="act cl"
                onClick={regravar}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
              >
                <RotateCcw size={16} />
                Regravar
              </button>
            </div>
          </div>
        )}
      </BlocoLista>

      {carregando ? (
        <div className="stack">
          <Skels alturas={[64, 64, 64]} />
        </div>
      ) : erro ? (
        <div className="empty">
          <b>Não deu para carregar a lista</b>
          <button type="button" className="seg" style={{ marginTop: 10 }} onClick={recarregar}>
            tentar de novo
          </button>
        </div>
      ) : leadsFiltrados.length === 0 ? (
        <div className="empty">
          <b>Nenhum lead pendente aqui</b>
          Todos os leads desta aba já foram contatados ou não há leads dessa origem ainda. Troque de
          aba ou volte mais tarde.
        </div>
      ) : (
        <div className="stack">
          {leadsFiltrados.map((lead) => (
            <LinhaLead
              key={lead.leadTaskId}
              lead={lead}
              estadoEnvio={enviosPorLead[lead.leadTaskId] ?? ENVIO_IDLE}
              habilitado={audioPronto && conectado}
              avisoAtivo={avisoSemAudioLead === lead.leadTaskId}
              onEnviar={() => void enviarParaLead(lead)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Uma linha de lead com badge de envio (idle/enviando/enviado/desconectado/erro) e botão à direita. */
function LinhaLead({
  lead,
  estadoEnvio,
  habilitado,
  avisoAtivo,
  onEnviar,
}: {
  lead: LeadAudioReal;
  estadoEnvio: EstadoEnvioLinha;
  habilitado: boolean;
  avisoAtivo: boolean;
  onEnviar: () => void;
}) {
  return (
    <div className="task" style={{ alignItems: "center" }}>
      <span className="av">{iniciais(lead.nome)}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="tn trunc" style={{ display: "block" }}>
          {lead.nome}
        </span>
        <span className="tm trunc" style={{ display: "block" }}>
          {fmtTelefone(lead.telefone)}
        </span>
        {lead.origem && (
          <span className="tags" style={{ marginTop: 7 }}>
            <span className="tag">{lead.origem}</span>
          </span>
        )}

        {estadoEnvio.tipo === "enviando" && (
          <span className="tags" style={{ marginTop: 7 }}>
            <span className="tag pe">Aguardando ritmo seguro…</span>
          </span>
        )}
        {estadoEnvio.tipo === "enviado" && (
          <span className="tags" style={{ marginTop: 7 }}>
            <span className="tag ok">Áudio enviado · {estadoEnvio.hora}</span>
          </span>
        )}
        {estadoEnvio.tipo === "desconectado" && (
          <div style={{ fontSize: 11.5, marginTop: 6, color: "#ff9b9b", lineHeight: 1.4 }}>
            Não foi possível enviar — o número está desconectado. Reconecte o WhatsApp e tente de
            novo.
          </div>
        )}
        {estadoEnvio.tipo === "sem-whatsapp" && (
          <div style={{ fontSize: 11.5, marginTop: 6, color: "#ff9b9b", lineHeight: 1.4 }}>
            Sem WhatsApp — pulado. Este número não tem WhatsApp; siga pelo contato manual.
          </div>
        )}
        {estadoEnvio.tipo === "erro" && (
          <button
            type="button"
            onClick={onEnviar}
            style={{ fontSize: 11.5, marginTop: 6, color: "#ff9b9b", textAlign: "left" }}
          >
            O envio falhou. Toque para tentar de novo.
          </button>
        )}
        {avisoAtivo && (
          <div className="dim2" style={{ fontSize: 11, marginTop: 6 }}>
            grave um áudio primeiro
          </div>
        )}
      </span>
      <button
        type="button"
        className="cta"
        onClick={onEnviar}
        disabled={estadoEnvio.tipo === "enviando"}
        aria-label="Enviar áudio"
        style={{
          flex: "none",
          width: "auto",
          padding: "9px 14px",
          fontSize: "var(--t-micro)",
          minWidth: 44,
          minHeight: 44,
          opacity: habilitado || estadoEnvio.tipo === "enviando" ? 1 : 0.4,
        }}
      >
        Enviar áudio
      </button>
    </div>
  );
}
