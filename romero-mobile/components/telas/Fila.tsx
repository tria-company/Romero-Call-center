"use client";

import * as React from "react";
import {
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Copy,
  Phone,
  PhoneCall,
  SkipForward,
  XCircle,
} from "lucide-react";
// Helper PURO de iniciais — fora de qualquer store/localStorage.
import { iniciais } from "@/lib/leads-util";
import type { ItemFilaReal, VotoReal } from "@/lib/discador-servidor";
import { pularLigacao, useFilaReal } from "@/lib/fila-real";
import { copiarTelefone, fmtTelefone, linkTelefone, urlCallCenter, vibrar } from "@/lib/contato";
import {
  carregarContextoLead,
  carregarLigacaoDetalhe,
  lerLigacaoTelPendente,
  limparLigacaoTelPendente,
  marcarLigacaoTelPendente,
  montarMarcadores,
  registrarAnotacaoLigacao,
  registrarDesfechoTel,
  registrarSuperFa,
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
   altera o fluxo Wavoip/WhatsApp (Romero, `<Audios embutido/>`, segue intacto).

   quick-260822-rr6 (iteração de UX pós-produção): R1 (card não pisca durante
   refetch, indicador "Atualizando…"), R2 (botões de ação ≥48px/ícone/full-
   width), R3 (chegada por `?telapos=<taskId>` — gancho do discador WhatsApp
   quando a chamada não é atendida, MESMA task, sem desfecho terminal), R4/R5/
   R6 (observação/demanda/classificação no retorno), R7 (roteiro+dossiê
   recolhíveis no card ANTES de ligar, buscados via fallback-tel.ts), R8
   (origem `[tel direto]`/`[tel apos-whatsapp]` nos marcadores). */

const CATEGORIAS_NAO_ATENDIDA = ["Não atende", "Ocupado", "Número errado", "Chamou e caiu"] as const;
const CLASSIFICACOES = ["Receptiva", "Indecisa", "Negativa"] as const;

export function Fila({
  papel = "atendente",
  podeAudios = false,
}: {
  papel?: "gestor" | "atendente";
  podeAudios?: boolean;
} = {}) {
  const { itens, carregando, atualizando, erro, semMapeamento, recarregar } = useFilaReal();

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
          <button type="button" className="seg fp-btn48" onClick={() => setPularAlvo(null)} disabled={pulando}>
            Cancelar
          </button>
          <button type="button" className="fp-pgo" onClick={() => void confirmarPular()} disabled={pulando || !pularMotivo.trim()}>
            {pulando ? <span className="fp-spin" /> : <SkipForward size={15} />} Pular contato
          </button>
        </div>
      </div>
    </div>
  );

  /* ── Fallback de ligação nativa (tel:) — plano B (quick-260822-pzh, iterado
     no rr6) ──────────────────────────────────────────────────────────────
     D-03 (guard-rail): se o atendente saiu no meio de uma ligação `tel:` e
     voltou, `alvoTel` reaparece no MOUNT a partir do localStorage — a tela de
     retorno cobre a Ligação pendente até ele responder ou tocar "Não
     consegui ligar".
     R3/R8 (rr6): chegar com `?telapos=<taskId>` (gancho do discador WhatsApp
     na tela de motivo) abre o MESMO fluxo com `origem:"apos-whatsapp"`, sem
     precisar do guard-rail (a Ligação ainda não foi discada pelo tel: — só a
     chamada WhatsApp não foi atendida). */
  const [alvoTel, setAlvoTel] = React.useState<LigacaoTelPendente | null>(null);
  const [faseTel, setFaseTel] = React.useState<"escolha" | "voto" | "motivo">("escolha");
  const [votoRomero, setVotoRomero] = React.useState<VotoReal | undefined>(undefined);
  const [votoAndressa, setVotoAndressa] = React.useState<VotoReal | undefined>(undefined);
  const [categoriaTel, setCategoriaTel] = React.useState("");
  const [classificacaoTel, setClassificacaoTel] = React.useState("");
  const [demandaTel, setDemandaTel] = React.useState("");
  const [obsTel, setObsTel] = React.useState("");
  // R9 (quick-260822-rr6): "⭐ Super fã" — opcional, disponível nos dois
  // caminhos do retorno (atendeu/não atendeu). Persistência em 2 partes: tag
  // permanente no lead (registrarSuperFa, item 1) + marcador no comentário/
  // observação (montarMarcadores, item 2).
  const [superFaTel, setSuperFaTel] = React.useState(false);
  const [enviandoTel, setEnviandoTel] = React.useState(false);
  const [erroTel, setErroTel] = React.useState(false);
  const [copiadoId, setCopiadoId] = React.useState<string | null>(null);
  const [avisoTelId, setAvisoTelId] = React.useState<string | null>(null);

  // Abre a tela de retorno tel: pra uma Ligação — reseta TODO o formulário
  // (compartilhado pelo card, "Ligar pelo telefone", E a chegada por telapos).
  function abrirRetornoTel(p: LigacaoTelPendente) {
    marcarLigacaoTelPendente(p);
    setAlvoTel(p);
    setFaseTel("escolha");
    setVotoRomero(undefined);
    setVotoAndressa(undefined);
    setCategoriaTel("");
    setClassificacaoTel("");
    setDemandaTel("");
    setObsTel("");
    setSuperFaTel(false);
    setErroTel(false);
  }

  React.useEffect(() => {
    // R3/R8 (rr6): gancho "Tentar pelo telefone" do discador WhatsApp — o
    // taskId volta na query da MESMA Ligação (full-page, D-03). Precede o
    // guard-rail: uma chegada nova por telapos vale mais que um pendente
    // antigo (raro dois ao mesmo tempo, mas se acontecer, o mais recente
    // ganha). `replaceState` evita reabrir o fluxo num refresh da página.
    const telapos = new URLSearchParams(window.location.search).get("telapos");
    if (telapos) {
      window.history.replaceState(null, "", window.location.pathname);
      let vivo = true;
      void carregarLigacaoDetalhe(telapos).then((detalhe) => {
        if (!vivo) return;
        abrirRetornoTel({
          taskId: telapos,
          nome: detalhe?.nome ?? "",
          telefone: detalhe?.telefone ?? "",
          origem: "apos-whatsapp",
        });
      });
      return () => {
        vivo = false;
      };
    }
    const pendente = lerLigacaoTelPendente();
    if (pendente) {
      setAlvoTel(pendente);
      setFaseTel("escolha");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function ligarPeloTelefone(item: ItemFilaReal) {
    vibrar();
    const link = linkTelefone(item.telefone);
    if (!link) {
      setAvisoTelId(item.taskId);
      window.setTimeout(() => setAvisoTelId((atual) => (atual === item.taskId ? null : atual)), 2500);
      return;
    }
    // D-08: ligação iniciada pelo botão do card = origem "direto".
    abrirRetornoTel({ taskId: item.taskId, nome: item.nome, telefone: item.telefone, origem: "direto" });
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

  // R6 (obrigatória): voto + anotação (classificação/demanda/observação) →
  // desfecho 'atendida'. Falha em qualquer uma das 3 etapas preserva o
  // guard-rail (retry sem perder o estado pendente) — ORDEM: anotação →
  // voto → desfecho.
  async function concluirVoto() {
    if (!alvoTel || enviandoTel || !classificacaoTel) return;
    setEnviandoTel(true);
    setErroTel(false);
    // R9: tag no lead é best-effort — não bloqueia/gate o resto do fluxo
    // (a Ligação pode não ter lead vinculado; o backend já trata isso).
    if (superFaTel) await registrarSuperFa(alvoTel.taskId);
    const textoAnotacao =
      "📞 Atendida (tel)\n" +
      montarMarcadores({
        origem: alvoTel.origem,
        classificacao: classificacaoTel,
        demanda: demandaTel,
        observacao: obsTel,
        superFa: superFaTel,
      });
    // Quick-260822-tdj: escrita dupla best-effort em anotacoes_ligacao — o
    // gate de sucesso (okAnotacao) continua igual (só falha se o
    // ClickUp/rota falhar; a linha Supabase é best-effort NO BACKEND).
    const okAnotacao = await registrarAnotacaoLigacao(alvoTel.taskId, textoAnotacao, {
      classificacao: classificacaoTel,
      demanda: demandaTel || undefined,
      observacao: obsTel || undefined,
      canal: "telefone",
      aposWhatsapp: alvoTel.origem === "apos-whatsapp",
      resultado: "atendida",
      superFa: superFaTel,
    });
    const okVoto = okAnotacao && (await registrarVotoTel(alvoTel.taskId, { romero: votoRomero, andressa: votoAndressa }));
    const okDesfecho = okVoto && (await registrarDesfechoTel(alvoTel.taskId, "atendida"));
    setEnviandoTel(false);
    if (!okAnotacao || !okVoto || !okDesfecho) {
      setErroTel(true);
      return;
    }
    limparLigacaoTelPendente();
    fecharRetornoTel();
    recarregar();
  }

  // R5/R6 (não atendeu, opcionais): desfecho 'nao_atendida' — a lib compõe os
  // marcadores (origem + classificação + demanda + observação) via
  // montarMarcadores, substituindo o antigo prefixo fixo "[tel] " do pzh.
  async function concluirMotivo() {
    if (!alvoTel || enviandoTel || !categoriaTel) return;
    setEnviandoTel(true);
    setErroTel(false);
    // R9: tag no lead é best-effort — não bloqueia/gate o desfecho.
    if (superFaTel) await registrarSuperFa(alvoTel.taskId);
    // Quick-260822-tdj: persiste os campos estruturados em anotacoes_ligacao,
    // best-effort e SEM gate (não pode bloquear o `ok` do desfecho) — texto
    // VAZIO porque o comentário ClickUp já sai pelo /desfecho abaixo (evita
    // comentário duplicado).
    void registrarAnotacaoLigacao(alvoTel.taskId, "", {
      classificacao: classificacaoTel || undefined,
      demanda: demandaTel || undefined,
      observacao: obsTel || undefined,
      canal: "telefone",
      aposWhatsapp: alvoTel.origem === "apos-whatsapp",
      resultado: "nao_atendida",
      superFa: superFaTel,
    });
    const ok = await registrarDesfechoTel(alvoTel.taskId, "nao_atendida", {
      categoria: categoriaTel,
      classificacao: classificacaoTel || undefined,
      demanda: demandaTel || undefined,
      observacao: obsTel || undefined,
      origem: alvoTel.origem,
      superFa: superFaTel || undefined,
    });
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
          <Phone size={17} /> Conseguiu falar com {alvoTel.nome || "o lead"}?
        </div>

        {faseTel === "escolha" && (
          <div className="fp-telesc">
            {/* R3 (rr6): cobre o re-discar E a chegada apos-whatsapp (ainda
               não discou pelo tel: nesse caminho). Gesto do usuário — abre o
               discador nativo do aparelho. */}
            <button
              type="button"
              className="fp-telchoice fp-telchoice--tel fp-btn48"
              onClick={() => {
                const link = linkTelefone(alvoTel.telefone);
                if (link) window.location.href = link;
              }}
            >
              <Phone size={17} /> Ligar pelo telefone
            </button>
            <button type="button" className="fp-telchoice fp-telchoice--ok fp-btn48" onClick={() => setFaseTel("voto")}>
              <CheckCircle2 size={17} /> Atendeu
            </button>
            <button type="button" className="fp-telchoice fp-btn48" onClick={() => setFaseTel("motivo")}>
              <XCircle size={17} /> Não atendeu
            </button>
            <button type="button" className="seg fp-btn48" onClick={naoConsegui}>
              <Ban size={15} /> Não consegui ligar
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
                    className={`fp-telsegbtn fp-btn48${votoRomero === v ? " active" : ""}`}
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
                    className={`fp-telsegbtn fp-btn48${votoAndressa === v ? " active" : ""}`}
                    onClick={() => setVotoAndressa(votoAndressa === v ? undefined : v)}
                    disabled={enviandoTel}
                  >
                    {v === "sim" ? "Sim" : v === "nao" ? "Não" : "Não declarou"}
                  </button>
                ))}
              </div>
            </div>
            <div className="fp-telq">
              <div className="fp-tellbl">Classificação (obrigatória)</div>
              <div className="fp-telseg">
                {CLASSIFICACOES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`fp-telsegbtn fp-btn48${classificacaoTel === c ? " active" : ""}`}
                    onClick={() => setClassificacaoTel(c)}
                    disabled={enviandoTel}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="fp-telq">
              <div className="fp-tellbl">Demanda (opcional)</div>
              <input
                className="fp-ptxt fp-ptxt--input"
                type="text"
                value={demandaTel}
                onChange={(e) => setDemandaTel(e.target.value)}
                placeholder="O que o lead pediu/precisa…"
                maxLength={200}
                disabled={enviandoTel}
              />
            </div>
            <div className="fp-telq">
              <div className="fp-tellbl">Observação (opcional)</div>
              <textarea
                className="fp-ptxt"
                value={obsTel}
                onChange={(e) => setObsTel(e.target.value)}
                placeholder="Observação livre…"
                rows={3}
                maxLength={500}
                disabled={enviandoTel}
              />
            </div>
            <button
              type="button"
              className={`fp-superfa fp-btn48${superFaTel ? " active" : ""}`}
              onClick={() => setSuperFaTel((v) => !v)}
              disabled={enviandoTel}
              aria-pressed={superFaTel}
            >
              {superFaTel ? <CheckCircle2 size={18} /> : <Circle size={18} />} ⭐ Super fã
            </button>
            {erroTel && <div className="fp-perro">Não deu para registrar — tente de novo.</div>}
            <div className="fp-pacts">
              <button type="button" className="seg fp-btn48" onClick={() => setFaseTel("escolha")} disabled={enviandoTel}>
                Voltar
              </button>
              <button
                type="button"
                className="fp-pgo fp-btn48"
                onClick={() => void concluirVoto()}
                disabled={enviandoTel || !classificacaoTel}
              >
                {enviandoTel ? <span className="fp-spin" /> : <Check size={16} />} Concluir
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
                    className={`fp-telsegbtn fp-btn48${categoriaTel === c ? " active" : ""}`}
                    onClick={() => setCategoriaTel(c)}
                    disabled={enviandoTel}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="fp-telq">
              <div className="fp-tellbl">Classificação (opcional)</div>
              <div className="fp-telseg">
                {CLASSIFICACOES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`fp-telsegbtn fp-btn48${classificacaoTel === c ? " active" : ""}`}
                    onClick={() => setClassificacaoTel(classificacaoTel === c ? "" : c)}
                    disabled={enviandoTel}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="fp-telq">
              <div className="fp-tellbl">Demanda (opcional)</div>
              <input
                className="fp-ptxt fp-ptxt--input"
                type="text"
                value={demandaTel}
                onChange={(e) => setDemandaTel(e.target.value)}
                placeholder="O que o lead pediu/precisa…"
                maxLength={200}
                disabled={enviandoTel}
              />
            </div>
            <textarea
              className="fp-ptxt"
              value={obsTel}
              onChange={(e) => setObsTel(e.target.value)}
              placeholder="Observação (opcional)…"
              rows={3}
              maxLength={500}
              disabled={enviandoTel}
            />
            <button
              type="button"
              className={`fp-superfa fp-btn48${superFaTel ? " active" : ""}`}
              onClick={() => setSuperFaTel((v) => !v)}
              disabled={enviandoTel}
              aria-pressed={superFaTel}
            >
              {superFaTel ? <CheckCircle2 size={18} /> : <Circle size={18} />} ⭐ Super fã
            </button>
            {erroTel && <div className="fp-perro">Não deu para registrar — tente de novo.</div>}
            <div className="fp-pacts">
              <button type="button" className="seg fp-btn48" onClick={() => setFaseTel("escolha")} disabled={enviandoTel}>
                Voltar
              </button>
              <button
                type="button"
                className="fp-pgo fp-btn48"
                onClick={() => void concluirMotivo()}
                disabled={enviandoTel || !categoriaTel}
              >
                {enviandoTel ? <span className="fp-spin" /> : <Check size={16} />} Concluir
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  /* R7/D-07 (rr6): script (roteiro) + dossiê do lead — busca PREGUIÇOSA,
     keyed no taskId do PRÓXIMO lead da fila. Não bloqueia o card (renderiza
     de imediato com skeleton próprio nas seções) nem atrasa o toque em
     "Ligar". Nunca lança (fallback-tel.ts). LGPD: nunca logar. */
  const taskIdAtual = itens[0]?.taskId;
  const [scriptTexto, setScriptTexto] = React.useState<string | null>(null);
  const [scriptCarregando, setScriptCarregando] = React.useState(false);
  const [dossieTexto, setDossieTexto] = React.useState<string | null>(null);
  const [dossieCarregando, setDossieCarregando] = React.useState(false);

  React.useEffect(() => {
    if (!taskIdAtual) {
      setScriptTexto(null);
      setDossieTexto(null);
      return;
    }
    let vivo = true;
    setScriptTexto(null);
    setDossieTexto(null);
    setScriptCarregando(true);
    setDossieCarregando(true);
    void carregarLigacaoDetalhe(taskIdAtual).then((d) => {
      if (!vivo) return;
      setScriptTexto(d?.script ?? "");
      setScriptCarregando(false);
    });
    void carregarContextoLead(taskIdAtual).then((c) => {
      if (!vivo) return;
      setDossieTexto(c ?? "");
      setDossieCarregando(false);
    });
    return () => {
      vivo = false;
    };
  }, [taskIdAtual]);

  /* Conteúdo da vista LIGAR (atendentes) — estados inline.
     R1 (rr6): o esqueleto CHEIO só aparece na primeira carga (sem itens
     ainda) — com o card já visível, um refetch (`atualizando`) mostra só o
     indicador discreto na `qbar`, o card do lead NUNCA some/pisca. */
  const secaoLigar = carregando && itens.length === 0 ? (
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
        {atualizando && (
          <div className="fp-atualizando">
            <span className="fp-spin fp-spin--dim" /> Atualizando…
          </div>
        )}
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
          scriptTexto={scriptTexto}
          scriptCarregando={scriptCarregando}
          dossieTexto={dossieTexto}
          dossieCarregando={dossieCarregando}
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

/** Seção recolhível do card (R7/D-07) — "Roteiro" e "Dossiê", cada uma com o
 *  próprio skeleton enquanto carrega. Texto longo em bloco rolável, quebra de
 *  linha preservada (`white-space:pre-wrap`). */
function SecaoRecolhivel({
  titulo,
  aberto,
  onToggle,
  carregando,
  texto,
  vazio,
}: {
  titulo: string;
  aberto: boolean;
  onToggle: () => void;
  carregando: boolean;
  texto: string | null;
  vazio: string;
}) {
  return (
    <div className="fp-secao">
      <button type="button" className="fp-secao-head" onClick={onToggle} aria-expanded={aberto}>
        <span>{titulo}</span>
        <ChevronDown size={17} className={aberto ? "fp-chev fp-chev--aberto" : "fp-chev"} />
      </button>
      {aberto && (
        <div className="fp-secao-body">
          {carregando ? (
            <div className="skel" style={{ height: 52, borderRadius: 10 }} />
          ) : texto ? (
            <div className="fp-secao-texto">{texto}</div>
          ) : (
            <div className="fp-secao-vazio">{vazio}</div>
          )}
        </div>
      )}
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
  scriptTexto,
  scriptCarregando,
  dossieTexto,
  dossieCarregando,
}: {
  item: ItemFilaReal;
  indice: number;
  onLigar: (item: ItemFilaReal) => void;
  onPular: (item: ItemFilaReal) => void;
  onLigarTel: (item: ItemFilaReal) => void;
  onCopiar: (item: ItemFilaReal) => void;
  copiado: boolean;
  avisoTelInvalido: boolean;
  scriptTexto: string | null;
  scriptCarregando: boolean;
  dossieTexto: string | null;
  dossieCarregando: boolean;
}) {
  // u14: o CARD INTEIRO liga. Tocar em qualquer lugar do card dispara `onLigar`
  // (mesma ação do botão). "Ligar" fica como affordance explícita.
  // 2026-08-19: "Pular" tira o contato da fila COM motivo (modal), sem discar.
  // R7 (rr6): "Roteiro" e "Dossiê" recolhíveis — fecham por padrão, abrem sob
  // toque (cada card novo reseta o estado, já que a key muda por taskId).
  const [abertoScript, setAbertoScript] = React.useState(false);
  const [abertoDossie, setAbertoDossie] = React.useState(false);

  return (
    <div
      className="task fp-card"
      onClick={() => onLigar(item)}
      style={{
        cursor: "pointer",
        animation: `reveal-up 380ms var(--ease-out-soft) ${Math.min(indice, 8) * 40}ms backwards`,
      }}
    >
      <div className="fp-card-head">
        <div className="av">{iniciais(item.nome)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tn trunc">{item.nome}</div>
          {/* Telefone exibido ao operador autorizado — nunca logar (LGPD). */}
          <div className="tm trunc">{fmtTelefone(item.telefone)}</div>
        </div>
      </div>

      <div className="fp-secoes" onClick={(e) => e.stopPropagation()}>
        <SecaoRecolhivel
          titulo="Roteiro"
          aberto={abertoScript}
          onToggle={() => setAbertoScript((a) => !a)}
          carregando={scriptCarregando}
          texto={scriptTexto}
          vazio="Sem roteiro disponível para esta ligação."
        />
        <SecaoRecolhivel
          titulo="Dossiê"
          aberto={abertoDossie}
          onToggle={() => setAbertoDossie((a) => !a)}
          carregando={dossieCarregando}
          texto={dossieTexto}
          vazio="Sem dossiê disponível para este lead."
        />
      </div>

      <div className="fp-acoes" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="fp-ligar" onClick={() => onLigar(item)} aria-label="Ligar">
          <PhoneCall size={19} /> Ligar
        </button>
        <button type="button" className="fp-ligar-tel" onClick={() => onLigarTel(item)}>
          <Phone size={17} /> Ligar pelo telefone
        </button>
        {avisoTelInvalido && <div className="fp-teleravi">Telefone inválido para ligar.</div>}
        <div className="fp-acoes-row">
          <button type="button" className="fp-acao-sec" onClick={() => onCopiar(item)}>
            <Copy size={16} /> {copiado ? "Copiado" : "Copiar número"}
          </button>
          <button
            type="button"
            className="fp-acao-sec fp-acao-sec--alerta"
            onClick={() => onPular(item)}
            aria-label={`Pular ${item.nome}`}
          >
            <SkipForward size={16} /> Pular
          </button>
        </div>
      </div>
    </div>
  );
}

/* CSS do PULAR na fila clássica (2026-08-19) — o modal/chip do Audios (AU_CSS)
   não monta nesta vista, então os estilos vivem aqui com prefixo fp-.
   quick-260822-pzh: classes fp-telmodal / fp-telcard / fp-telseg (fallback de
   ligação tel:) somadas ao bloco abaixo. quick-260822-rr6: card vertical
   (fp-card/fp-card-head/fp-secoes/fp-acoes), botões ≥48px (fp-btn48/fp-ligar/
   fp-ligar-tel/fp-acao-sec) e indicador de refetch (fp-atualizando). */
const FP_CSS = `
.fp-pmodal{ position:fixed; inset:0; z-index:300; background:rgba(0,0,0,.55); display:flex; align-items:flex-end; justify-content:center; padding:0 12px calc(24px + var(--safe-b)); }
.fp-pcard{ width:min(520px, 100%); background:var(--bg-1); border:1px solid var(--line); border-radius:18px; padding:16px; display:flex; flex-direction:column; gap:10px; animation:fpUp .18s ease both; }
@keyframes fpUp{ from{ opacity:0; transform:translateY(10px); } to{ opacity:1; transform:none; } }
.fp-ptit{ display:flex; align-items:center; gap:8px; font-size:15px; font-weight:800; color:var(--alert); }
.fp-pnome{ font-size:14px; font-weight:700; color:var(--ink); }
.fp-phint{ font-size:12.5px; color:var(--dim); line-height:1.5; }
.fp-ptxt{ width:100%; box-sizing:border-box; resize:none; background:var(--bg-2); border:1px solid var(--line); border-radius:12px; padding:10px 12px; color:var(--ink); font-size:14px; line-height:1.5; outline:none; font-family:inherit; }
.fp-ptxt--input{ resize:auto; min-height:48px; }
.fp-ptxt:focus{ border-color:var(--alert); }
.fp-perro{ font-size:12.5px; color:var(--alert); font-weight:700; }
.fp-pacts{ display:flex; gap:8px; justify-content:flex-end; align-items:center; flex-wrap:wrap; }
.fp-pgo{ display:inline-flex; align-items:center; justify-content:center; gap:6px; border:none; border-radius:12px; padding:10px 16px; background:var(--alert); color:#fff; font-weight:800; font-size:13.5px; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.fp-pgo:disabled{ opacity:.55; cursor:default; }
.fp-spin{ width:16px; height:16px; border-radius:50%; flex:none; border:2px solid rgba(255,255,255,.45); border-top-color:#fff; animation:fpSpin .7s linear infinite; }
.fp-spin--dim{ border:2px solid color-mix(in srgb, var(--dim) 45%, transparent); border-top-color:var(--dim); }
@keyframes fpSpin{ to{ transform:rotate(360deg); } }
@media (prefers-reduced-motion:reduce){ .fp-spin,.fp-pcard{ animation:none!important; } }

/* Alvo de toque mínimo ≥48px (R2/D-02) — modificador aplicado junto de
   classes já existentes (.seg/.fp-telchoice/.fp-telsegbtn/.fp-pgo) sem mexer
   no estilo global dessas classes fora deste arquivo. */
.fp-btn48{ min-height:48px; display:inline-flex; align-items:center; justify-content:center; gap:8px; }

/* Indicador discreto de refetch (R1/D-01) — o card do lead NUNCA some; só
   este texto aparece/some na barra de progresso. */
.fp-atualizando{ display:flex; align-items:center; gap:6px; margin-top:8px; font-size:11.5px; font-weight:700; color:var(--dim); }

.fp-teleravi{ font-size:11px; color:var(--alert); font-weight:700; margin-top:6px; }

/* Card vertical (R2/R7, rr6): avatar+nome no topo, seções recolhíveis no
   meio, ações grandes embaixo — substitui o layout horizontal antigo
   (avatar | info | coluna de botões pequenos). */
.fp-card{ flex-direction:column; align-items:stretch; }
.fp-card-head{ display:flex; align-items:center; gap:clamp(11px, 3cqi, 16px); }

/* Seções recolhíveis "Roteiro"/"Dossiê" (R7/D-07). */
.fp-secoes{ display:flex; flex-direction:column; gap:8px; margin-top:12px; }
.fp-secao{ border:1px solid var(--line); border-radius:12px; overflow:hidden; background:var(--bg-2); }
.fp-secao-head{ width:100%; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:12px 14px; min-height:44px; background:none; border:none; color:var(--ink); font-size:13.5px; font-weight:700; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.fp-chev{ transition:transform 160ms var(--ease-out); color:var(--dim); flex:none; }
.fp-chev--aberto{ transform:rotate(180deg); }
.fp-secao-body{ padding:0 14px 14px; }
.fp-secao-texto{ white-space:pre-wrap; font-size:13px; line-height:1.6; color:var(--dim); max-height:260px; overflow-y:auto; }
.fp-secao-vazio{ font-size:12.5px; color:var(--dim-2); font-style:italic; }

/* Ações do card (R2/D-02): "Ligar" primário grande full-width; "Ligar pelo
   telefone" secundário grande full-width; "Copiar número"/"Pular" numa
   grade de 2 colunas, todos ≥48px com ícone e texto legível. */
.fp-acoes{ display:flex; flex-direction:column; gap:10px; margin-top:14px; }
.fp-ligar{ min-height:52px; width:100%; display:flex; align-items:center; justify-content:center; gap:9px; border:none; border-radius:14px; background:var(--romero, #3d8bff); color:#04122a; font-weight:800; font-size:15px; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.fp-ligar:active{ transform:scale(0.98); }
.fp-ligar-tel{ min-height:48px; width:100%; display:flex; align-items:center; justify-content:center; gap:8px; border:1px solid var(--line); border-radius:14px; background:var(--bg-2); color:var(--ink); font-weight:700; font-size:14px; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.fp-ligar-tel:active{ background:rgba(255,255,255,.06); }
.fp-acoes-row{ display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.fp-acao-sec{ min-height:48px; display:flex; align-items:center; justify-content:center; gap:6px; border:1px solid var(--line); border-radius:12px; background:transparent; color:var(--dim); font-weight:700; font-size:12.5px; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.fp-acao-sec:active{ background:rgba(255,255,255,.06); }
.fp-acao-sec--alerta{ border-color:color-mix(in srgb, var(--alert) 45%, transparent); color:var(--alert); }

/* Tela de retorno (D-04) — mesmo molde visual do modalPular. */
.fp-telmodal{ position:fixed; inset:0; z-index:310; background:rgba(0,0,0,.55); display:flex; align-items:flex-end; justify-content:center; padding:0 12px calc(24px + var(--safe-b)); }
.fp-telcard{ width:min(520px, 100%); max-height:min(720px, 88vh); overflow-y:auto; background:var(--bg-1); border:1px solid var(--line); border-radius:18px; padding:16px; display:flex; flex-direction:column; gap:12px; animation:fpUp .18s ease both; }
.fp-telesc{ display:flex; flex-direction:column; gap:8px; }
.fp-telchoice{ border:1px solid var(--line); background:var(--bg-2); color:var(--ink); border-radius:12px; padding:12px; font-size:14px; font-weight:700; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.fp-telchoice--ok{ border-color:color-mix(in srgb, var(--ok, #2ecc71) 45%, var(--line)); }
.fp-telchoice--tel{ border-color:color-mix(in srgb, var(--romero, #3d8bff) 45%, var(--line)); color:var(--romero, #3d8bff); }
.fp-telform{ display:flex; flex-direction:column; gap:10px; }
.fp-telq{ display:flex; flex-direction:column; gap:6px; }
.fp-tellbl{ font-size:12px; font-weight:800; color:var(--dim); text-transform:uppercase; letter-spacing:.03em; }
.fp-telseg{ display:flex; gap:6px; flex-wrap:wrap; }
.fp-telsegbtn{ border:1px solid var(--line); background:var(--bg-2); color:var(--ink); border-radius:999px; padding:6px 14px; font-size:12.5px; font-weight:700; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.fp-telsegbtn.active{ background:var(--accent); border-color:var(--accent); color:#fff; }
.fp-telsegbtn:disabled{ opacity:.55; cursor:default; }

/* R9 (quick-260822-rr6): toggle grande "⭐ Super fã" — mesmo padrão visual dos
   botões novos (≥48px, ícone, texto legível), disponível nos dois caminhos
   do retorno tel:. */
.fp-superfa{ width:100%; display:flex; align-items:center; justify-content:center; gap:8px; border:1px solid var(--line); background:var(--bg-2); color:var(--dim); border-radius:12px; font-size:14px; font-weight:700; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.fp-superfa.active{ border-color:color-mix(in srgb, #f5c43d 55%, var(--line)); background:color-mix(in srgb, #f5c43d 16%, transparent); color:#f5c43d; }
.fp-superfa:disabled{ opacity:.55; cursor:default; }
`;
