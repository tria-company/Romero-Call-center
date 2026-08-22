"use client";

import * as React from "react";
import { Copy, Phone, SkipForward } from "lucide-react";
// Helper PURO de iniciais — fora de qualquer store/localStorage.
import { iniciais } from "@/lib/leads-util";
import type { ItemFilaReal, VotoReal } from "@/lib/discador-servidor";
import { pularLigacao, useFilaReal } from "@/lib/fila-real";
import { copiarTelefone, fmtTelefone, linkTelefone, urlCallCenter, vibrar } from "@/lib/contato";
import {
  lerLigacaoTelPendente,
  limparLigacaoTelPendente,
  marcarLigacaoTelPendente,
  registrarDesfechoTel,
  registrarVotoTel,
  type LigacaoTelPendente,
} from "@/lib/fallback-tel";
import { Autobox, Esqueleto, Vhead } from "./blocos";
import { Audios } from "./Audios";

/* TELA 02 · AÇÕES DE HOJE (ex-Fila)
   Fonte da fila: a fila REAL do discador (Ligações abertas do dia do Romero),
   servida por /api/mobile/fila. Sem localStorage, sem selo de motivo (o backend
   não manda), sem marcar-feito: quando a Ligação recebe desfecho ela some no
   próximo fetch. O visual (Vhead, qbar, cards `.task`) segue o mockup.

   2026-08-19 (sem dropdown): para o Romero, a FILA DE LIGAÇÕES É A LISTA DE
   ÁUDIOS — cada Ligação criada pra ele vira uma linha do <Audios embutido/>
   (fonte "fila"), com chat, envio de áudio e ligação direta. O gate real é o
   backend (`exigirRomero`). Atendente vê só a fila clássica (podeAudios=false,
   título "Fila de hoje").

   u14: o CARD INTEIRO liga — tocar em qualquer lugar do card faz a mesma ação do
   botão "Ligar" (handoff pro discador). A ficha do lead saiu da Fila; o botão
   "Ligar" segue como affordance explícita.

   quick-260822-pzh (D-01): fallback de ligação nativa (`tel:`) — plano B pro
   ATENDENTE quando o Wavoip falha. Botão SECUNDÁRIO "Ligar pelo telefone" +
   "Copiar número" abaixo de Ligar/Pular; abre o discador nativo e o app cobra
   o retorno (atendeu→voto / não atendeu→motivo / não consegui ligar). Não
   altera o fluxo Wavoip/WhatsApp (Romero, `<Audios embutido/>`, segue intacto). */

const CATEGORIAS_NAO_ATENDIDA = ["Não atende", "Ocupado", "Número errado", "Chamou e caiu"] as const;

export function Fila({
  papel = "atendente",
  podeAudios = false,
}: {
  papel?: "gestor" | "atendente";
  podeAudios?: boolean;
} = {}) {
  const { itens, carregando, erro, semMapeamento, recarregar } = useFilaReal();

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

  // Chamado no gesto do toque. MESMO ENDERECO (u7): navega na MESMA aba pro
  // discador (mesma origem) — sem abrir aba nova órfã. A fila já tem a Ligação
  // (item.taskId), então passa &task pro discador abrir a chamada exata (auto-
  // loga por #token). Ao VOLTAR, o discador devolve o gestor pra ESTA fila (/fila).
  function ligar(item: ItemFilaReal) {
    vibrar();
    window.location.href = urlCallCenter(tokenCC, item.taskId);
  }

  /* Pular contato (2026-08-19 — TODOS os operadores): tira a Ligação da fila
     explicando o motivo (vira comentário na task e ela FECHA no ClickUp). O
     backend valida que a Ligação é do PRÓPRIO operador; sucesso → recarrega e
     o próximo lead vira o topo. */
  const [pularAlvo, setPularAlvo] = React.useState<ItemFilaReal | null>(null);
  const [pularMotivo, setPularMotivo] = React.useState("");
  const [pulando, setPulando] = React.useState(false);
  const [pularErro, setPularErro] = React.useState(false);
  function abrirPular(item: ItemFilaReal) {
    vibrar();
    setPularAlvo(item);
    setPularMotivo("");
    setPularErro(false);
  }
  async function confirmarPular() {
    if (!pularAlvo || pulando) return;
    const motivo = pularMotivo.trim();
    if (!motivo) return;
    setPulando(true);
    setPularErro(false);
    const ok = await pularLigacao(pularAlvo.taskId, motivo);
    setPulando(false);
    if (!ok) {
      setPularErro(true);
      return;
    }
    setPularAlvo(null);
    setPularMotivo("");
    recarregar();
  }

  const modalPular = pularAlvo && (
    <div
      className="fp-pmodal"
      role="dialog"
      aria-modal="true"
      aria-label="Pular contato"
      onClick={() => {
        if (!pulando) setPularAlvo(null);
      }}
    >
      <div className="fp-pcard" onClick={(e) => e.stopPropagation()}>
        <div className="fp-ptit">
          <SkipForward size={17} /> Pular contato
        </div>
        <div className="fp-pnome">{pularAlvo.nome}</div>
        <div className="fp-phint">A Ligação sai da sua fila e o motivo fica registrado na task do ClickUp.</div>
        <textarea
          className="fp-ptxt"
          value={pularMotivo}
          onChange={(e) => setPularMotivo(e.target.value)}
          placeholder="Explique o motivo (obrigatório)…"
          rows={3}
          maxLength={500}
          autoFocus
        />
        {pularErro && <div className="fp-perro">Não deu para pular — tente de novo.</div>}
        <div className="fp-pacts">
          <button type="button" className="seg" onClick={() => setPularAlvo(null)} disabled={pulando}>
            Cancelar
          </button>
          <button type="button" className="fp-pgo" onClick={() => void confirmarPular()} disabled={pulando || !pularMotivo.trim()}>
            {pulando ? <span className="fp-spin" /> : <SkipForward size={15} />} Pular contato
          </button>
        </div>
      </div>
    </div>
  );

  /* ── Fallback de ligação nativa (tel:) — plano B (quick-260822-pzh) ─────
     D-03 (guard-rail): se o atendente saiu no meio de uma ligação `tel:` e
     voltou, `alvoTel` reaparece no MOUNT a partir do localStorage — a tela de
     retorno cobre a Ligação pendente até ele responder ou tocar "Não
     consegui ligar". */
  const [alvoTel, setAlvoTel] = React.useState<LigacaoTelPendente | null>(null);
  const [faseTel, setFaseTel] = React.useState<"escolha" | "voto" | "motivo">("escolha");
  const [votoRomero, setVotoRomero] = React.useState<VotoReal | undefined>(undefined);
  const [votoAndressa, setVotoAndressa] = React.useState<VotoReal | undefined>(undefined);
  const [categoriaTel, setCategoriaTel] = React.useState("");
  const [obsTel, setObsTel] = React.useState("");
  const [enviandoTel, setEnviandoTel] = React.useState(false);
  const [erroTel, setErroTel] = React.useState(false);
  const [copiadoId, setCopiadoId] = React.useState<string | null>(null);
  const [avisoTelId, setAvisoTelId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const pendente = lerLigacaoTelPendente();
    if (pendente) {
      setAlvoTel(pendente);
      setFaseTel("escolha");
    }
  }, []);

  function ligarPeloTelefone(item: ItemFilaReal) {
    vibrar();
    const link = linkTelefone(item.telefone);
    if (!link) {
      setAvisoTelId(item.taskId);
      window.setTimeout(() => setAvisoTelId((atual) => (atual === item.taskId ? null : atual)), 2500);
      return;
    }
    const pendente: LigacaoTelPendente = { taskId: item.taskId, nome: item.nome, telefone: item.telefone };
    marcarLigacaoTelPendente(pendente);
    setAlvoTel(pendente);
    setFaseTel("escolha");
    setVotoRomero(undefined);
    setVotoAndressa(undefined);
    setCategoriaTel("");
    setObsTel("");
    setErroTel(false);
    // Abre o discador NATIVO do aparelho (iOS confirma, Android disca direto).
    window.location.href = link;
  }

  async function copiar(item: ItemFilaReal) {
    const ok = await copiarTelefone(item.telefone);
    if (!ok) return;
    setCopiadoId(item.taskId);
    window.setTimeout(() => setCopiadoId((atual) => (atual === item.taskId ? null : atual)), 1500);
  }

  function fecharRetornoTel() {
    setAlvoTel(null);
    setErroTel(false);
  }

  // D-03: "Não consegui ligar" limpa SÓ o estado local — SEM desfecho. A
  // Ligação segue acionável na fila (o plano B nem chegou a discar de fato).
  function naoConsegui() {
    limparLigacaoTelPendente();
    fecharRetornoTel();
  }

  // D-04 (atendeu): voto → desfecho 'atendida'. Falha em qualquer um dos dois
  // preserva o guard-rail (retry sem perder o estado pendente).
  async function concluirVoto() {
    if (!alvoTel || enviandoTel) return;
    setEnviandoTel(true);
    setErroTel(false);
    const okVoto = await registrarVotoTel(alvoTel.taskId, { romero: votoRomero, andressa: votoAndressa });
    const okDesfecho = okVoto && (await registrarDesfechoTel(alvoTel.taskId, "atendida"));
    setEnviandoTel(false);
    if (!okVoto || !okDesfecho) {
      setErroTel(true);
      return;
    }
    limparLigacaoTelPendente();
    fecharRetornoTel();
    recarregar();
  }

  // D-04/D-05 (não atendeu): desfecho 'nao_atendida' com categoria + marca de
  // canal "[tel]" na observação (convenção, sem coluna dedicada — D-05).
  async function concluirMotivo() {
    if (!alvoTel || enviandoTel || !categoriaTel) return;
    setEnviandoTel(true);
    setErroTel(false);
    const observacao = ("[tel] " + obsTel).trim();
    const ok = await registrarDesfechoTel(alvoTel.taskId, "nao_atendida", { categoria: categoriaTel, observacao });
    setEnviandoTel(false);
    if (!ok) {
      setErroTel(true);
      return;
    }
    limparLigacaoTelPendente();
    fecharRetornoTel();
    recarregar();
  }

  const retornoTel = alvoTel && (
    <div
      className="fp-telmodal"
      role="dialog"
      aria-modal="true"
      aria-label="Retorno da ligação por telefone"
      onClick={() => {
        if (!enviandoTel) fecharRetornoTel();
      }}
    >
      <div className="fp-telcard" onClick={(e) => e.stopPropagation()}>
        <div className="fp-ptit">
          <Phone size={17} /> Conseguiu falar com {alvoTel.nome}?
        </div>

        {faseTel === "escolha" && (
          <div className="fp-telesc">
            <button type="button" className="fp-telchoice fp-telchoice--ok" onClick={() => setFaseTel("voto")}>
              Atendeu
            </button>
            <button type="button" className="fp-telchoice" onClick={() => setFaseTel("motivo")}>
              Não atendeu
            </button>
            <button type="button" className="seg" onClick={naoConsegui}>
              Não consegui ligar
            </button>
          </div>
        )}

        {faseTel === "voto" && (
          <div className="fp-telform">
            <div className="fp-telq">
              <div className="fp-tellbl">Romero</div>
              <div className="fp-telseg">
                {(["sim", "nao", "naoDeclarou"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`fp-telsegbtn${votoRomero === v ? " active" : ""}`}
                    onClick={() => setVotoRomero(votoRomero === v ? undefined : v)}
                    disabled={enviandoTel}
                  >
                    {v === "sim" ? "Sim" : v === "nao" ? "Não" : "Não declarou"}
                  </button>
                ))}
              </div>
            </div>
            <div className="fp-telq">
              <div className="fp-tellbl">Andressa</div>
              <div className="fp-telseg">
                {(["sim", "nao", "naoDeclarou"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`fp-telsegbtn${votoAndressa === v ? " active" : ""}`}
                    onClick={() => setVotoAndressa(votoAndressa === v ? undefined : v)}
                    disabled={enviandoTel}
                  >
                    {v === "sim" ? "Sim" : v === "nao" ? "Não" : "Não declarou"}
                  </button>
                ))}
              </div>
            </div>
            {erroTel && <div className="fp-perro">Não deu para registrar — tente de novo.</div>}
            <div className="fp-pacts">
              <button type="button" className="seg" onClick={() => setFaseTel("escolha")} disabled={enviandoTel}>
                Voltar
              </button>
              <button type="button" className="fp-pgo" onClick={() => void concluirVoto()} disabled={enviandoTel}>
                {enviandoTel ? <span className="fp-spin" /> : null} Concluir
              </button>
            </div>
          </div>
        )}

        {faseTel === "motivo" && (
          <div className="fp-telform">
            <div className="fp-telq">
              <div className="fp-tellbl">Motivo</div>
              <div className="fp-telseg fp-telseg--wrap">
                {CATEGORIAS_NAO_ATENDIDA.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`fp-telsegbtn${categoriaTel === c ? " active" : ""}`}
                    onClick={() => setCategoriaTel(c)}
                    disabled={enviandoTel}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              className="fp-ptxt"
              value={obsTel}
              onChange={(e) => setObsTel(e.target.value)}
              placeholder="Observação (opcional)…"
              rows={3}
              maxLength={500}
            />
            {erroTel && <div className="fp-perro">Não deu para registrar — tente de novo.</div>}
            <div className="fp-pacts">
              <button type="button" className="seg" onClick={() => setFaseTel("escolha")} disabled={enviandoTel}>
                Voltar
              </button>
              <button
                type="button"
                className="fp-pgo"
                onClick={() => void concluirMotivo()}
                disabled={enviandoTel || !categoriaTel}
              >
                {enviandoTel ? <span className="fp-spin" /> : null} Concluir
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  /* Conteúdo da vista LIGAR (atendentes) — estados inline. */
  const secaoLigar = carregando ? (
    <Esqueleto alturas={[64, 86]} />
  ) : erro ? (
    <div className="empty">
      <b>Não deu para carregar a fila</b>
      <button type="button" className="seg" style={{ marginTop: 10 }} onClick={recarregar}>
        toque para tentar de novo
      </button>
    </div>
  ) : semMapeamento ? (
    <Autobox tom="warn" titulo="Fila não configurada">
      Configure o mapeamento do operador no discador (painel /admin do call center).
    </Autobox>
  ) : (
    <>
      <div className="qbar">
        <div className="qtop">
          <b>{itens.length}</b>
          <span>
            {itens.length > 0
              ? itens.length === 1
                ? "última ligação de hoje"
                : "na fila hoje — ligue a próxima"
              : "fila zerada hoje"}
          </span>
        </div>
      </div>

      {itens.length === 0 ? (
        <div className="empty">
          <b>Fila zerada</b>
          Você falou com todo mundo que o sistema separou para hoje.
        </div>
      ) : (
        /* u14: mostra só o PRÓXIMO lead (o backend já ordena por prioridade).
           Ao ligar e voltar pra cá, a fila recarrega e o próximo vira o topo. */
        <CardFila
          key={itens[0].taskId}
          item={itens[0]}
          indice={0}
          onLigar={ligar}
          onPular={abrirPular}
          onLigarTel={ligarPeloTelefone}
          onCopiar={copiar}
          copiado={copiadoId === itens[0].taskId}
          avisoTelInvalido={avisoTelId === itens[0].taskId}
        />
      )}
    </>
  );

  // Atendente (e gestor sem áudios): a tela de sempre, sem dropdown.
  if (!podeAudios) {
    return (
      <div className="view">
        <style>{FP_CSS}</style>
        <Vhead titulo={papel === "gestor" ? "Ações de hoje" : "Fila de hoje"} sub="ordenada pelo sistema" live="ao vivo" />
        {secaoLigar}
        {modalPular}
        {retornoTel}
      </div>
    );
  }

  // Romero (2026-08-19): SEM dropdown — a fila de Ligações É a lista de áudios.
  // Cada Ligação criada pra ele vira uma linha com chat, áudio e ligação direta
  // (fonte "fila" do <Audios>, que traz a ligacaoTaskId pro handoff).
  return (
    <div className="view">
      <Vhead titulo="Ações de hoje" sub="sua fila — mensagem, áudio e ligação" live="ao vivo" />
      <Audios embutido />
    </div>
  );
}

function CardFila({
  item,
  indice,
  onLigar,
  onPular,
  onLigarTel,
  onCopiar,
  copiado,
  avisoTelInvalido,
}: {
  item: ItemFilaReal;
  indice: number;
  onLigar: (item: ItemFilaReal) => void;
  onPular: (item: ItemFilaReal) => void;
  onLigarTel: (item: ItemFilaReal) => void;
  onCopiar: (item: ItemFilaReal) => void;
  copiado: boolean;
  avisoTelInvalido: boolean;
}) {
  // u14: o CARD INTEIRO liga. Tocar em qualquer lugar do card dispara `onLigar`
  // (mesma ação do botão). O botão "Ligar" fica como affordance explícita e
  // dá stopPropagation pra não disparar duas vezes. A ficha saiu da Fila.
  // 2026-08-19: "Pular" embaixo do Ligar — tira o contato da fila COM motivo
  // (modal), sem discar; também stopPropagation (senão o card ligaria junto).
  // quick-260822-pzh (D-01): "Ligar pelo telefone" + "Copiar número" ficam
  // SUBORDINADOS (visual discreto, `fp-tel-sec`) — plano B, não o caminho
  // principal.
  return (
    <div
      className="task"
      onClick={() => onLigar(item)}
      style={{
        cursor: "pointer",
        animation: `reveal-up 380ms var(--ease-out-soft) ${Math.min(indice, 8) * 40}ms backwards`,
      }}
    >
      <div className="av">{iniciais(item.nome)}</div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="tn trunc">{item.nome}</div>
        {/* Telefone exibido ao operador autorizado — nunca logar (LGPD). */}
        <div className="tm trunc">{fmtTelefone(item.telefone)}</div>
        <div className="fp-telrow" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="fp-tel-sec" onClick={() => onLigarTel(item)}>
            <Phone size={11} /> Ligar pelo telefone
          </button>
          <button type="button" className="fp-tel-sec" onClick={() => onCopiar(item)}>
            <Copy size={11} /> {copiado ? "Copiado" : "Copiar número"}
          </button>
        </div>
        {avisoTelInvalido && <div className="fp-teleravi">Telefone inválido para ligar.</div>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onLigar(item);
          }}
          className="go"
          aria-label="Ligar"
        >
          Ligar
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPular(item);
          }}
          className="fp-pular"
          aria-label={`Pular ${item.nome}`}
        >
          <SkipForward size={12} /> Pular
        </button>
      </div>
    </div>
  );
}

/* CSS do PULAR na fila clássica (2026-08-19) — o modal/chip do Audios (AU_CSS)
   não monta nesta vista, então os estilos vivem aqui com prefixo fp-.
   quick-260822-pzh: classes fp-tel-sec / fp-telmodal / fp-telcard / fp-telseg
   (fallback de ligação tel:) somadas ao bloco abaixo. */
const FP_CSS = `
.fp-pular{ display:inline-flex; align-items:center; justify-content:center; gap:4px; font-size:10px; font-weight:800; letter-spacing:.03em; text-transform:uppercase; padding:5px 10px; border-radius:999px; border:1px solid color-mix(in srgb, var(--alert) 45%, transparent); background:transparent; color:var(--alert); cursor:pointer; -webkit-tap-highlight-color:transparent; }
.fp-pular:active{ background:color-mix(in srgb, var(--alert) 14%, transparent); }
.fp-pmodal{ position:fixed; inset:0; z-index:300; background:rgba(0,0,0,.55); display:flex; align-items:flex-end; justify-content:center; padding:0 12px calc(24px + var(--safe-b)); }
.fp-pcard{ width:min(520px, 100%); background:var(--bg-1); border:1px solid var(--line); border-radius:18px; padding:16px; display:flex; flex-direction:column; gap:10px; animation:fpUp .18s ease both; }
@keyframes fpUp{ from{ opacity:0; transform:translateY(10px); } to{ opacity:1; transform:none; } }
.fp-ptit{ display:flex; align-items:center; gap:8px; font-size:15px; font-weight:800; color:var(--alert); }
.fp-pnome{ font-size:14px; font-weight:700; color:var(--ink); }
.fp-phint{ font-size:12.5px; color:var(--dim); line-height:1.5; }
.fp-ptxt{ width:100%; box-sizing:border-box; resize:none; background:var(--bg-2); border:1px solid var(--line); border-radius:12px; padding:10px 12px; color:var(--ink); font-size:14px; line-height:1.5; outline:none; font-family:inherit; }
.fp-ptxt:focus{ border-color:var(--alert); }
.fp-perro{ font-size:12.5px; color:var(--alert); font-weight:700; }
.fp-pacts{ display:flex; gap:8px; justify-content:flex-end; align-items:center; }
.fp-pgo{ display:inline-flex; align-items:center; gap:6px; border:none; border-radius:12px; padding:10px 14px; background:var(--alert); color:#fff; font-weight:800; font-size:13px; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.fp-pgo:disabled{ opacity:.55; cursor:default; }
.fp-spin{ width:16px; height:16px; border-radius:50%; flex:none; border:2px solid rgba(255,255,255,.45); border-top-color:#fff; animation:fpSpin .7s linear infinite; }
@keyframes fpSpin{ to{ transform:rotate(360deg); } }
@media (prefers-reduced-motion:reduce){ .fp-spin,.fp-pcard{ animation:none!important; } }

/* Fallback tel: (quick-260822-pzh) — botão secundário/discreto no card (D-01). */
.fp-telrow{ display:flex; gap:10px; margin-top:4px; flex-wrap:wrap; }
.fp-tel-sec{ display:inline-flex; align-items:center; gap:4px; font-size:10.5px; font-weight:700; color:var(--dim); background:none; border:none; padding:2px 0; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.fp-tel-sec:active{ opacity:.65; }
.fp-teleravi{ font-size:11px; color:var(--alert); font-weight:700; margin-top:2px; }

/* Tela de retorno (D-04) — mesmo molde visual do modalPular. */
.fp-telmodal{ position:fixed; inset:0; z-index:310; background:rgba(0,0,0,.55); display:flex; align-items:flex-end; justify-content:center; padding:0 12px calc(24px + var(--safe-b)); }
.fp-telcard{ width:min(520px, 100%); background:var(--bg-1); border:1px solid var(--line); border-radius:18px; padding:16px; display:flex; flex-direction:column; gap:12px; animation:fpUp .18s ease both; }
.fp-telesc{ display:flex; flex-direction:column; gap:8px; }
.fp-telchoice{ border:1px solid var(--line); background:var(--bg-2); color:var(--ink); border-radius:12px; padding:12px; font-size:14px; font-weight:700; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.fp-telchoice--ok{ border-color:color-mix(in srgb, var(--ok, #2ecc71) 45%, var(--line)); }
.fp-telform{ display:flex; flex-direction:column; gap:10px; }
.fp-telq{ display:flex; flex-direction:column; gap:6px; }
.fp-tellbl{ font-size:12px; font-weight:800; color:var(--dim); text-transform:uppercase; letter-spacing:.03em; }
.fp-telseg{ display:flex; gap:6px; flex-wrap:wrap; }
.fp-telsegbtn{ border:1px solid var(--line); background:var(--bg-2); color:var(--ink); border-radius:999px; padding:6px 12px; font-size:12.5px; font-weight:700; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.fp-telsegbtn.active{ background:var(--accent); border-color:var(--accent); color:#fff; }
.fp-telsegbtn:disabled{ opacity:.55; cursor:default; }
`;
