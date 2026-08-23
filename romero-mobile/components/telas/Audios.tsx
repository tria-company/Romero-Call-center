"use client";

import * as React from "react";
import { ArrowLeft, CheckCheck, Clock, FolderOpen, Mic, Pause, Phone, Play, RotateCcw, Search, Send, SkipForward, X } from "lucide-react";
import { iniciais } from "@/lib/leads-util";
import { fmtTelefone, urlCallCenter, vibrar } from "@/lib/contato";
import { iniciarLigacaoReal, preaquecerDossieLead, useLeadReal } from "@/lib/leads-real";
import { buscarConversaLead, buscarMidiaMensagem, buscarNovidades, enviarAudioParaLead, enviarTextoParaLead, pularContato, useAudiosReais } from "@/lib/audios-real";
import type { LeadAudioReal, MensagemConversa } from "@/lib/audios-real";
import { listarConteudos, enviarConteudoParaLead } from "@/lib/conteudos-real";
import type { ConteudoReal } from "@/lib/conteudos-real";
import { BibliotecaConteudos } from "./BibliotecaConteudos";
import { Autobox, Vhead } from "./blocos";
// 2026-08-19: tocar no NOME da conversa abre a ficha (dossiê + histórico) como
// overlay — mesma PerfilLead da Base, em modo embutido (sem navegar, o chat
// continua aberto por trás).
import { PerfilLead } from "./PerfilLead";
import { DossieMarkdown } from "@/components/DossieMarkdown";

/* TELA · ÁUDIOS — estilo WhatsApp, CONVERSA por lead. Toca no lead → abre a
   conversa dele; grava (segurar o microfone) e o áudio vira uma mensagem de voz
   enviada. O áudio gravado fica PRONTO e serve pros próximos leads (grava uma
   vez, manda pra vários — D-03).
   Fonte: `useAudiosReais` via `/api/mobile/audios*` (romero-only, 12-04).

   Renderiza de dois jeitos (ENVIO-08):
   · `embutido` → vista "Áudios" do DROPDOWN de "Ações" (a Fila), sem cabeçalho
     próprio — o título é o dropdown da tela-mãe;
   · padrão    → tela própria em /audios (rota direta de rollback).
   A CONVERSA é overlay `position:fixed` — cobre a tela dos dois jeitos.
   LGPD: telefone sempre mascarado; nunca logar telefone/leadId/base64. */

function fmtMMSS(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const AV_CORES = ["#e17076", "#7bc862", "#65aadd", "#a695e7", "#ee7aae", "#6ec9cb", "#f2749a", "#5db075", "#e59f4a"];
function corAvatar(nome: string): string {
  let h = 0;
  for (let i = 0; i < nome.length; i++) h = (h * 31 + nome.charCodeAt(i)) >>> 0;
  return AV_CORES[h % AV_CORES.length];
}
const ONDAS = Array.from({ length: 20 }, (_, i) => 5 + Math.round(Math.abs(Math.sin(i * 1.35)) * 14));

type EstadoGravacao = "vazio" | "gravando" | "preview";
/** Uma mensagem de áudio numa conversa: sobe OTIMISTA ("enviando", relógio)
 *  e confirma ("ok", ✓✓) — como no WhatsApp. Falha remove a bolha e vira
 *  mensagem de sistema no fio. `src` é o que o ▶ toca: data-URI (bolha da
 *  sessão) ou URL do anexo no ClickUp (bolha vinda do histórico/Lista 03);
 *  sem src, a bolha aparece sem player. `durMs` só existe pra bolha da sessão. */
type Bolha = {
  hora: string;
  durMs?: number;
  status: "enviando" | "ok";
  src?: string | null;
  /** 'texto' = mensagem digitada (Fase 13 fatia 2); default áudio. */
  tipo?: "audio" | "texto";
  texto?: string;
};

/** Hora da bolha: HH:MM se for de hoje; senão dd/MM HH:MM (histórico). */
function fmtQuandoBolha(em: number): string {
  if (!em) return "—";
  const d = new Date(em);
  const hoje = new Date();
  const mesmaData = d.toDateString() === hoje.toDateString();
  const hhmm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return mesmaData ? hhmm : `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${hhmm}`;
}
/** Situação do último envio numa conversa (pra mostrar aviso no fio). */
type SituacaoLead = "sem-whatsapp" | "desconectado" | "erro" | null;

/** Selo por status (modelo de 4 estados, 2026-08-19) — rótulo + classe de cor.
 *  enviar_audio = nada enviado/aguardando; indefinido = respondeu neutro (Romero
 *  decide); ligar/nao_ligar = desfecho claro. */
/* ── Contador de áudios DO DIA (modo fast, 2026-08-20): persistido por
   aparelho em localStorage e zerado quando vira o dia. Soma envios do modo
   fast E da conversa — é o "quanto enviei hoje" da tela final do jogo. ── */
function lerAudiosDia(): number {
  try {
    const o = JSON.parse(localStorage.getItem("audiosEnviadosDia") ?? "null") as { data?: string; total?: number } | null;
    const hoje = new Date().toISOString().slice(0, 10);
    return o?.data === hoje ? Number(o.total) || 0 : 0;
  } catch {
    return 0;
  }
}
function somarAudiosDia(n: number): number {
  const hoje = new Date().toISOString().slice(0, 10);
  // aceita n negativo (estorno do envio otimista que falhou) — nunca abaixo de 0
  const total = Math.max(0, lerAudiosDia() + n);
  try {
    localStorage.setItem("audiosEnviadosDia", JSON.stringify({ data: hoje, total }));
  } catch {
    /* storage cheio/privado: o contador degrada, o envio não */
  }
  return total;
}
/** mm:ss para o placar/cronômetro do modo fast. */
function fmtRelogio(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const SELO_UI: Record<"ligar" | "nao_ligar" | "indefinido" | "aguardando" | "enviar_audio", { rotulo: string; cls: string }> = {
  enviar_audio: { rotulo: "Enviar áudio", cls: "envaudio" },
  aguardando: { rotulo: "Aguardando", cls: "aguard" },
  indefinido: { rotulo: "Indefinido", cls: "indef" },
  ligar: { rotulo: "Ligar", cls: "ligar" },
  nao_ligar: { rotulo: "Não ligar", cls: "nao" },
};

export function Audios({ embutido = false }: { embutido?: boolean } = {}) {
  const { leads, carregando, erro, semMapeamento, recarregar, recarregarSilencioso, conectado } = useAudiosReais();
  /* Filtro pelo selo (2026-08-19) — o backend já manda a lista ordenada por
     última mensagem (quem falou por último no topo, estilo WhatsApp). */
  const [filtroSelo, setFiltroSelo] = React.useState<"todos" | "enviar_audio" | "aguardando" | "indefinido" | "ligar" | "nao_ligar">("todos");
  /* Busca (2026-08-19) por nome OU telefone — filtra o LOTE já carregado (os
     nunca-ligados de hoje), não a base inteira. Telefone casa por dígitos
     (ignora +, espaços, parênteses). Compõe com o filtro de selo. */
  const [busca, setBusca] = React.useState("");

  /* Pular contato (2026-08-19): quando o funil marca "Não ligar", o Romero
     tira a Ligação da fila explicando o MOTIVO (vira comentário na task e a
     Ligação FECHA no ClickUp). `pulados` esconde a linha na hora (otimista);
     o auto-refresh de 30s reconcilia com o backend. */
  const [pularAlvo, setPularAlvo] = React.useState<LeadAudioReal | null>(null);
  const [pularMotivo, setPularMotivo] = React.useState("");
  const [pulando, setPulando] = React.useState(false);
  const [pularErro, setPularErro] = React.useState(false);
  const [pulados, setPulados] = React.useState<Set<string>>(() => new Set());

  const leadsFiltrados = React.useMemo(() => {
    const vivos = pulados.size === 0 ? leads : leads.filter((l) => !(l.ligacaoTaskId && pulados.has(l.ligacaoTaskId)));
    const porSelo = filtroSelo === "todos" ? vivos : vivos.filter((l) => (l.conversa?.status ?? "enviar_audio") === filtroSelo);
    const q = busca.trim().toLowerCase();
    const qDigitos = q.replace(/\D/g, "");
    const base = !q
      ? porSelo
      : porSelo.filter((l) => {
          const nomeBate = l.nome.toLowerCase().includes(q);
          const telBate = qDigitos.length > 0 && l.telefone.replace(/\D/g, "").includes(qDigitos);
          return nomeBate || telBate;
        });
    // Lead vinculado primeiro (2026-08-21): as linhas com leadTaskId — as que o
    // modo fast consegue pegar — sobem; avulsas (só-ligação) descem. Sort ESTÁVEL
    // do V8 preserva a ordem por última mensagem dentro de cada grupo.
    return [...base].sort((a, b) => (b.leadTaskId ? 1 : 0) - (a.leadTaskId ? 1 : 0));
  }, [leads, filtroSelo, busca, pulados]);

  /* Confirma o pular: fecha a Ligação no backend com o motivo; sucesso tira a
     linha da lista na hora. Falha mantém o modal aberto com o aviso. */
  async function confirmarPular() {
    if (!pularAlvo?.ligacaoTaskId || pulando) return;
    const motivo = pularMotivo.trim();
    if (!motivo) return;
    setPulando(true);
    setPularErro(false);
    const ok = await pularContato(pularAlvo.ligacaoTaskId, motivo);
    setPulando(false);
    if (!ok) {
      setPularErro(true);
      return;
    }
    const id = pularAlvo.ligacaoTaskId;
    setPulados((p) => {
      const n = new Set(p);
      n.add(id);
      return n;
    });
    setPularAlvo(null);
    setPularMotivo("");
  }

  /* Biblioteca de conteúdos (Fase 2 do roadmap): mensagens/links prontos que o
     Felipe deixa cadastrados; o Romero abre a "pasta" na conversa, escolhe e o
     conteúdo entra no campo de texto pra revisar e enviar. Carrega sob demanda
     ao abrir — nunca bloqueia a conversa; falha vira lista vazia. */
  const [conteudosAberto, setConteudosAberto] = React.useState(false);
  const [conteudos, setConteudos] = React.useState<ConteudoReal[]>([]);
  const [conteudosCarregando, setConteudosCarregando] = React.useState(false);
  const [conteudosCarregou, setConteudosCarregou] = React.useState(false);
  // aba ativa do painel: "enviar" (escolher pra mandar) ou "gerenciar" (CRUD),
  // tudo DENTRO do mesmo painel deslizante — sem tela cheia separada.
  const [modoConteudos, setModoConteudos] = React.useState<"enviar" | "gerenciar">("enviar");
  // preview de mídia ANTES de enviar (pedido do gestor): o operador vê a imagem/
  // vídeo/áudio e confirma; só então manda.
  const [previewConteudo, setPreviewConteudo] = React.useState<ConteudoReal | null>(null);
  const [enviandoConteudo, setEnviandoConteudo] = React.useState(false);

  async function recarregarConteudos() {
    setConteudosCarregando(true);
    const lista = await listarConteudos();
    setConteudos(lista);
    setConteudosCarregando(false);
    setConteudosCarregou(true);
  }
  async function abrirConteudos() {
    setModoConteudos("enviar");
    setConteudosAberto(true);
    if (conteudosCarregou || conteudosCarregando) return;
    await recarregarConteudos();
  }

  /* Escolher um conteúdo:
     - TEXTO/LINK → INSERE no campo (o operador revisa e toca enviar).
     - IMAGEM/VÍDEO/ÁUDIO → abre PREVIEW (o operador vê a mídia e confirma); só
       então envia via /conteudos/:id/enviar. */
  function escolherConteudo(cnt: ConteudoReal) {
    if (cnt.tipo === "imagem" || cnt.tipo === "video" || cnt.tipo === "audio") {
      setPreviewConteudo(cnt);
      return;
    }
    const trecho = cnt.tipo === "link" ? (cnt.url ?? "") : (cnt.texto ?? "");
    if (trecho) setTextoDigitado((t) => (t.trim() ? t + "\n" : "") + trecho);
    setConteudosAberto(false);
  }

  /* Confirma o envio da mídia pré-visualizada (imagem/vídeo/áudio). */
  async function confirmarEnvioConteudo() {
    if (!previewConteudo || !leadAberto || enviandoConteudo) return;
    const alvo = leadAberto.leadTaskId;
    const id = previewConteudo.id;
    setEnviandoConteudo(true);
    const ok = await enviarConteudoParaLead(id, alvo);
    setEnviandoConteudo(false);
    setPreviewConteudo(null);
    setConteudosAberto(false);
    if (ok) window.setTimeout(() => void atualizarConversa(alvo, true), 1200);
  }

  // agrupa por categoria pra render (categoria vazia vira "Geral").
  const conteudosPorCategoria = React.useMemo(() => {
    const grupos = new Map<string, ConteudoReal[]>();
    for (const c of conteudos) {
      const cat = (c.categoria ?? "").trim() || "Geral";
      const arr = grupos.get(cat) ?? [];
      arr.push(c);
      grupos.set(cat, arr);
    }
    return [...grupos.entries()];
  }, [conteudos]);

  // "Apareça 10 e vá carregando" — por ROLAGEM (2026-08-19): o sentinela no fim
  // da lista (`au-more`) revela +10 ao entrar na viewport, no lugar do timer de
  // 2,5s — quem rola vê mais na hora; quem não rola não empilha linha à toa.
  const [visiveis, setVisiveis] = React.useState(10);
  React.useEffect(() => {
    setVisiveis(10);
  }, [filtroSelo, busca]);
  const sentinelaRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (visiveis >= leadsFiltrados.length) return;
    const el = sentinelaRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entradas) => {
        if (entradas.some((e) => e.isIntersecting)) setVisiveis((v) => v + 10);
      },
      { rootMargin: "360px 0px" }, // começa a revelar ~1 tela antes do fim
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visiveis, leadsFiltrados.length]);
  const leadsVisiveis = leadsFiltrados.slice(0, visiveis);

  /* ── Ligação Wavoip de dentro da conversa (2026-08-19) — mesmo circuito do
     PerfilLead: token buscado ao MONTAR (pop-up blocker exige `window.open`
     síncrono no gesto), `iniciarLigacaoReal` cria a Ligação avulsa e a aba já
     aberta navega pro discador com deep-link da task. Obs.: com a Ligação
     criada, o lead SAI da lista de nunca-ligados no próximo refresh — é o
     funil desenhado (áudio → respondeu → ligou → vira Ligação). ── */
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
  const [ligando, setLigando] = React.useState(false);
  /* Ligação SEM SAIR DA TELA (2026-08-19, estilo WhatsApp): o discador abre
     EMBUTIDO num overlay por cima da conversa/lista, já discando (auto=1) —
     nada de navegar nem abrir aba. O fluxo operacional inteiro (chamada,
     desfecho, voto) roda dentro do frame; o X fecha e devolve pra cá. */
  const [chamadaUrl, setChamadaUrl] = React.useState<string | null>(null);
  function ligarParaLead(lead: LeadAudioReal) {
    if (ligando) return;
    vibrar();
    // Fonte "fila": a linha JÁ é uma Ligação — o overlay abre essa task direto.
    if (lead.ligacaoTaskId) {
      setChamadaUrl(urlCallCenter(tokenCC, lead.ligacaoTaskId) + "&auto=1");
      return;
    }
    // Fonte nunca-ligados (sem Ligação ainda): cria a avulsa e então abre o
    // overlay — sem window.open, pop-up blocker deixou de ser problema.
    setLigando(true);
    iniciarLigacaoReal(lead.leadTaskId).then((taskId) => {
      if (!montadoRef.current) return;
      setLigando(false);
      if (taskId) setChamadaUrl(urlCallCenter(tokenCC, taskId) + "&auto=1");
    });
  }

  /* Fecho AUTOMÁTICO (2026-08-19): quando o fluxo da task encerra no discador
     (desfecho/voto feitos ou "voltar"), o frame posta
     `{tipo:'discador:fluxo-encerrado'}` — fecha o overlay e recarrega a lista
     (a Ligação com desfecho sai da fila na hora). Origem conferida contra a
     própria URL do frame. */
  React.useEffect(() => {
    if (!chamadaUrl) return;
    function aoMensagem(e: MessageEvent) {
      if ((e.data as { tipo?: string } | null)?.tipo !== "discador:fluxo-encerrado") return;
      try {
        if (e.origin !== new URL(chamadaUrl!, window.location.href).origin) return;
      } catch {
        return;
      }
      setChamadaUrl(null);
      recarregar();
    }
    window.addEventListener("message", aoMensagem);
    return () => window.removeEventListener("message", aoMensagem);
  }, [chamadaUrl, recarregar]);

  /* Overlay da CHAMADA — renderizado tanto na conversa quanto na lista (a
     conversa retorna cedo, então o markup entra nos dois returns). `allow`
     delega microfone/autoplay pro frame do discador (WebRTC Wavoip). */
  const overlayChamada = chamadaUrl && (
    <div className="au-call" role="dialog" aria-label="Ligação em andamento">
      <div className="au-call-top">
        <span className="au-call-tit">Ligação pelo discador — encerre a chamada antes de fechar</span>
        <button type="button" className="au-call-x" onClick={() => setChamadaUrl(null)} aria-label="Fechar a ligação">
          <X size={20} />
        </button>
      </div>
      {/* eslint-disable-next-line react/iframe-missing-sandbox */}
      {/* screen-wake-lock: sem essa permissão o navegador NEGA o wake lock que o
          discador pede dentro do iframe → a tela do celular bloqueia no meio da
          chamada → a página é suspensa → Wavoip derruba com client:ping-timeout
          (as 2 quedas do Tercio em 19/08). */}
      <iframe src={chamadaUrl} className="au-call-frame" allow="microphone; autoplay; screen-wake-lock" title="Discador" />
    </div>
  );

  /* ── Gravação (D-01/D-02/D-03) — grava uma vez, serve pra vários leads. ── */
  const [estadoGravacao, setEstadoGravacao] = React.useState<EstadoGravacao>("vazio");
  const [erroMic, setErroMic] = React.useState<string | null>(null);
  /* Aviso "segure para gravar" (2026-08-20): um CLIQUE rápido no microfone
     (soltou em <600ms) não grava nada — antes isso era silencioso e o operador
     achava que o botão não funcionava. Agora acende uma dica transitória. */
  const [dicaSegurar, setDicaSegurar] = React.useState(false);
  const dicaSegurarRef = React.useRef<number | null>(null);
  const flashDicaSegurar = React.useCallback(() => {
    setDicaSegurar(true);
    if (dicaSegurarRef.current != null) window.clearTimeout(dicaSegurarRef.current);
    dicaSegurarRef.current = window.setTimeout(() => setDicaSegurar(false), 2600);
  }, []);
  const [duracaoMs, setDuracaoMs] = React.useState(0);
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
  const soltarPendenteRef = React.useRef(false);
  const montadoRef = React.useRef(true);

  const pararCronometro = React.useCallback(() => {
    if (cronometroRef.current != null) {
      window.clearInterval(cronometroRef.current);
      cronometroRef.current = null;
    }
  }, []);

  const montarPreview = React.useCallback((blob: Blob, decorridoMs: number) => {
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
      const r = reader.result;
      if (typeof r === "string") setAudioBase64(r.split(",")[1] ?? "");
    };
    reader.readAsDataURL(blob);
    setEstadoGravacao("preview");
  }, []);

  // Gravação por TOQUE (modo fast): true quando a gravação começou por um
  // clique (toggle) em vez de segurar — muda só o descarte do clique curto.
  const porToqueRef = React.useRef(false);
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
          stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          if (decorridoMs < 600) {
            // clique rápido: reseta. No modo TOQUE (fast) não existe "segurar" —
            // reseta em silêncio; no modo SEGURAR (conversa), avisa que precisa segurar.
            if (montadoRef.current) {
              setEstadoGravacao("vazio");
              if (!porToqueRef.current) flashDicaSegurar();
            }
            return;
          }
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || mimeAlvo });
          montarPreview(blob, decorridoMs);
        };
        rec.start();
        inicioGravacaoRef.current = Date.now();
        setDuracaoMs(0);
        setEstadoGravacao("gravando");
        pararCronometro();
        cronometroRef.current = window.setInterval(() => setDuracaoMs(Date.now() - inicioGravacaoRef.current), 200);
        if (soltarPendenteRef.current) {
          soltarPendenteRef.current = false;
          pararGravacao();
        }
      })
      .catch(() => setErroMic("Não conseguimos acessar o microfone. Verifique a permissão do navegador."));
  }
  function pararGravacao() {
    pararCronometro();
    recorderRef.current?.stop();
  }
  /* Gravar por TOQUE (toggle) — 1º toque começa, 2º toque para. Usado pelos
     dois botões de microfone (modo fast e conversa). */
  function alternarGravacao() {
    if (estadoGravacao === "gravando") pararGravacao();
    else if (estadoGravacao === "vazio" || estadoGravacao === "preview") {
      // "preview" entra aqui quando o áudio já foi enviado a ESTE lead
      // (Audios.tsx:1215 esconde o ramo "regravar" nesse caso e mostra o
      // microfone) — sem este ramo o toque virava no-op e o microfone
      // ficava morto para o mesmo lead. iniciarGravacao() sobrescreve
      // audioBase64/audioUrl quando a gravação termina, então o novo áudio
      // não bate mais com audioEnviadoPorLead[lead] e a barra reabre o
      // envio — o áudio ANTIGO continua ofertável aos PRÓXIMOS leads (D-03),
      // pois a marca é por lead.
      porToqueRef.current = true;
      iniciarGravacao();
    }
  }
  function regravar() {
    setAudioUrl((a) => {
      if (a) URL.revokeObjectURL(a);
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

  React.useEffect(() => {
    // REARMAR o guard no body é obrigatório: no StrictMode (dev) o React roda
    // mount → cleanup → mount de novo; sem esta linha o cleanup deixava
    // montadoRef=false pra sempre e montarPreview desistia em silêncio — a
    // gravação congelava em "solte para parar".
    montadoRef.current = true;
    return () => {
      montadoRef.current = false;
      pararCronometro();
      try {
        recorderRef.current?.stop();
      } catch {
        /* ignora */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (dicaSegurarRef.current != null) window.clearTimeout(dicaSegurarRef.current);
      setAudioUrl((a) => {
        if (a) URL.revokeObjectURL(a);
        return a;
      });
    };
  }, [pararCronometro]);

  const audioPronto = estadoGravacao === "preview" && !!audioBase64;

  /* ── Conversa por lead + dropdown ─────────────────────────────────────── */
  const [leadAberto, setLeadAberto] = React.useState<LeadAudioReal | null>(null);
  /* Bolinha de não-lida: o backend marca lido_em ao abrir a conversa, mas a
     LISTA só refletia no poll de 30s — o operador voltava e via a bolinha
     ainda acesa ("não marcou"). `lidosLocais` apaga OTIMISTA no toque; o
     refresh seguinte confirma com o dado real. */
  const [lidosLocais, setLidosLocais] = React.useState<Set<string>>(() => new Set());
  /* Ficha (dossiê + histórico) como overlay da conversa (2026-08-19) — abre no
     toque do NOME, fecha no voltar; trocar/fechar a conversa fecha junto. */
  const [fichaAberta, setFichaAberta] = React.useState(false);
  /* Card recolhível do DOSSIÊ (2026-08-19) — faixa fixa entre .au-chead e
     .au-thread, mesmo dado da ficha (useLeadReal) sem duplicar fetch aqui:
     o hook é ocioso (sem fetch) enquanto não há conversa aberta. */
  const [dossieAberto, setDossieAberto] = React.useState(false);
  React.useEffect(() => {
    setFichaAberta(false);
    setDossieAberto(false);
  }, [leadAberto]);
  // leve:true (2026-08-20): o card só mostra o DOSSIÊ — a variante sem
  // timeline carrega em ~1-2s frio (e ms no cache) em vez dos 10s+ da ficha
  // completa. A ficha completa (com timeline) fica pro overlay do PerfilLead.
  const { ficha: fichaDossie, carregando: dossieCarregando } = useLeadReal(leadAberto?.leadTaskId ?? null, { leve: true });
  const dossieTexto = typeof fichaDossie?.dossie === "string" ? fichaDossie.dossie : "";
  const [bolhasPorLead, setBolhasPorLead] = React.useState<Record<string, Bolha[]>>({});
  /* Qual ÁUDIO (identidade = prefixo do base64) já foi enviado pra cada lead
     NESTA sessão — decide a barra da conversa: o MESMO áudio não se reenvia
     (barra esvazia, vira microfone), mas um áudio NOVO reabre o envio. Não dá
     pra usar só "tem bolha?": com o histórico persistente toda conversa antiga
     tem bolha, e a barra nunca mais ofereceria o Enviar. */
  const [audioEnviadoPorLead, setAudioEnviadoPorLead] = React.useState<Record<string, string>>({});
  const [situacaoPorLead, setSituacaoPorLead] = React.useState<Record<string, SituacaoLead>>({});
  const [enviandoLead, setEnviandoLead] = React.useState<string | null>(null);
  const [avisoSemAudio, setAvisoSemAudio] = React.useState(false);
  const avisoRef = React.useRef<number | null>(null);
  const threadRef = React.useRef<HTMLDivElement | null>(null);

  /* ── Conversa REAL (Fase 13, fatia 1): ao abrir, o painel busca as mensagens
        do WhatsApp com o lead (DOIS lados, com transcrição dos áudios) e faz
        poll de 10s enquanto a conversa está aberta. Quando a conversa chega,
        as bolhas de sessão já CONFIRMADAS saem (a mensagem real substitui);
        as "enviando" ficam até o desfecho. ── */
  const [conversaPorLead, setConversaPorLead] = React.useState<Record<string, MensagemConversa[]>>({});
  const [conversaCarregando, setConversaCarregando] = React.useState(false);
  const atualizarConversa = React.useCallback(async (leadTaskId: string, silencioso: boolean) => {
    if (!silencioso) setConversaCarregando(true);
    const msgs = await buscarConversaLead(leadTaskId);
    if (msgs) {
      setConversaPorLead((p) => ({ ...p, [leadTaskId]: msgs }));
      setBolhasPorLead((p) => ({ ...p, [leadTaskId]: (p[leadTaskId] ?? []).filter((b) => b.status === "enviando") }));
    }
    setConversaCarregando(false);
  }, []);
  const jaTemConversaRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const lead = leadAberto;
    if (!lead) return;
    const id = lead.leadTaskId;
    void atualizarConversa(id, jaTemConversaRef.current.has(id));
    jaTemConversaRef.current.add(id);
    const timer = window.setInterval(() => void atualizarConversa(id, true), 10_000);
    return () => window.clearInterval(timer);
  }, [leadAberto, atualizarConversa]);

  /* ── NOVIDADE EM ~4s (2026-08-19, "tenho que dar F5 pra aparecer"): sonda o
        ts da última mensagem persistida; mudou → recarrega a LISTA silenciosa
        e a CONVERSA aberta NA HORA. Voltar o foco/aba também dispara uma
        checagem. Os polls de 30s/10s continuam como rede de segurança. ── */
  const ultimoTsRef = React.useRef(0);
  const leadAbertoRef = React.useRef<LeadAudioReal | null>(null);
  leadAbertoRef.current = leadAberto;
  React.useEffect(() => {
    let vivo = true;
    let checando = false;
    const checar = async () => {
      if (checando) return;
      checando = true;
      try {
        const ts = await buscarNovidades();
        if (!vivo || !ts) return;
        if (ultimoTsRef.current === 0) {
          ultimoTsRef.current = ts; // baseline: a carga inicial já trouxe tudo
          return;
        }
        if (ts <= ultimoTsRef.current) return;
        ultimoTsRef.current = ts;
        recarregarSilencioso();
        // segunda passada: mensagem de DESCONHECIDO dispara a criação da
        // Ligação no backend (inbound→fila, leva ~5-8s) — sem isto a linha
        // nova só entraria no poll de 30s.
        window.setTimeout(() => {
          if (vivo) recarregarSilencioso();
        }, 8_000);
        const aberto = leadAbertoRef.current;
        if (aberto?.leadTaskId) void atualizarConversa(aberto.leadTaskId, true);
      } finally {
        checando = false;
      }
    };
    const id = window.setInterval(() => void checar(), 4_000);
    const aoVoltar = () => void checar();
    window.addEventListener("focus", aoVoltar);
    document.addEventListener("visibilitychange", aoVoltar);
    void checar();
    return () => {
      vivo = false;
      window.clearInterval(id);
      window.removeEventListener("focus", aoVoltar);
      document.removeEventListener("visibilitychange", aoVoltar);
    };
  }, [recarregarSilencioso, atualizarConversa]);

  /* ── Player das bolhas: UM <audio> compartilhado; ▶ toca o src da bolha
        (data-URI da sessão ou mídia baixada da conversa), toque de novo pausa.
        Chave string: mensagens usam o id da Evolution, sessão usa "s<i>". ── */
  const [bolhaTocando, setBolhaTocando] = React.useState<string | null>(null);
  const [midiaCarregando, setMidiaCarregando] = React.useState<string | null>(null);
  const bolhaAudioRef = React.useRef<HTMLAudioElement | null>(null);
  const midiaCacheRef = React.useRef<Map<string, string>>(new Map());
  function alternarBolha(chave: string, src: string) {
    const el = bolhaAudioRef.current;
    if (!el) return;
    if (bolhaTocando === chave) {
      el.pause();
      return;
    }
    el.src = src;
    el.play()
      .then(() => setBolhaTocando(chave))
      .catch(() => setBolhaTocando(null));
  }
  async function tocarMensagem(m: MensagemConversa) {
    if (bolhaTocando === m.id) {
      bolhaAudioRef.current?.pause();
      return;
    }
    let src = midiaCacheRef.current.get(m.id) ?? null;
    if (!src) {
      setMidiaCarregando(m.id);
      src = await buscarMidiaMensagem(m.id);
      setMidiaCarregando(null);
      if (!src) return; // mídia expirada/indisponível: o toque simplesmente não toca
      midiaCacheRef.current.set(m.id, src);
    }
    alternarBolha(m.id, src);
  }
  React.useEffect(() => {
    // trocou/fechou a conversa: para o que estiver tocando
    bolhaAudioRef.current?.pause();
    setBolhaTocando(null);
  }, [leadAberto]);

  // rola pro fim quando chega bolha/mensagem/situação nova
  React.useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [leadAberto, bolhasPorLead, situacaoPorLead, conversaPorLead]);

  async function enviarNaConversa(lead: LeadAudioReal) {
    if (enviandoLead) return;
    if (!audioPronto || !conectado) {
      setAvisoSemAudio(true);
      if (avisoRef.current != null) window.clearTimeout(avisoRef.current);
      avisoRef.current = window.setTimeout(() => setAvisoSemAudio(false), 2200);
      return;
    }
    const id = lead.leadTaskId;
    const hora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    // OTIMISTA (pedido do gestor): a bolha SOBE NA HORA em estado "enviando"
    // (relógio) e o compose volta pro microfone — nada de áudio "travado" na
    // barra. Confirmou → ✓✓. Falhou → a bolha desce e o fio mostra o motivo.
    setEnviandoLead(id);
    setAudioEnviadoPorLead((p) => ({ ...p, [id]: audioBase64!.slice(0, 32) }));
    setSituacaoPorLead((p) => ({ ...p, [id]: null }));
    setBolhasPorLead((p) => ({
      ...p,
      [id]: [
        ...(p[id] ?? []),
        // src = data-URI do próprio áudio: o ▶ da bolha TOCA (independe do blob
        // da barra, que pode ser regravado/limpo depois).
        { hora, durMs: duracaoPreviewMs, status: "enviando", src: `data:${audioMime};base64,${audioBase64}` },
      ],
    }));
    const r = await enviarAudioParaLead(id, audioBase64!, audioMime);
    setEnviandoLead(null);
    if (r.tipo === "sucesso") {
      somarAudiosDia(1); // entra no "🔥 Hoje" da tela final do modo fast
      setBolhasPorLead((p) => ({
        ...p,
        [id]: (p[id] ?? []).map((b, i, arr) => (i === arr.length - 1 && b.status === "enviando" ? { ...b, status: "ok" } : b)),
      }));
      // em ~1,5s a conversa real traz a mensagem enviada (e substitui a bolha)
      window.setTimeout(() => void atualizarConversa(id, true), 1500);
    } else {
      setBolhasPorLead((p) => ({ ...p, [id]: (p[id] ?? []).filter((b) => b.status !== "enviando") }));
      // falhou: libera o reenvio DESTE áudio pra este lead (a barra volta pronta)
      setAudioEnviadoPorLead((p) => {
        const { [id]: _descartado, ...resto } = p;
        return resto;
      });
      setSituacaoPorLead((p) => ({
        ...p,
        [id]: r.tipo === "sem_whatsapp" ? "sem-whatsapp" : r.tipo === "desconectado" ? "desconectado" : "erro",
      }));
    }
  }

  /* Envio de TEXTO (Fase 13 fatia 2) — mesmo padrão otimista do áudio. */
  const [textoDigitado, setTextoDigitado] = React.useState("");
  async function enviarTextoNaConversa(lead: LeadAudioReal) {
    const texto = textoDigitado.trim();
    if (!texto || enviandoLead) return;
    if (!conectado) {
      setAvisoSemAudio(true);
      if (avisoRef.current != null) window.clearTimeout(avisoRef.current);
      avisoRef.current = window.setTimeout(() => setAvisoSemAudio(false), 2200);
      return;
    }
    const id = lead.leadTaskId;
    const hora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    setEnviandoLead(id);
    setTextoDigitado("");
    setSituacaoPorLead((p) => ({ ...p, [id]: null }));
    setBolhasPorLead((p) => ({ ...p, [id]: [...(p[id] ?? []), { hora, status: "enviando", tipo: "texto", texto }] }));
    const r = await enviarTextoParaLead(id, texto);
    setEnviandoLead(null);
    if (r.tipo === "sucesso") {
      setBolhasPorLead((p) => ({
        ...p,
        [id]: (p[id] ?? []).map((b, i, arr) => (i === arr.length - 1 && b.status === "enviando" ? { ...b, status: "ok" } : b)),
      }));
      window.setTimeout(() => void atualizarConversa(id, true), 1500);
    } else {
      setBolhasPorLead((p) => ({ ...p, [id]: (p[id] ?? []).filter((b) => b.status !== "enviando") }));
      setTextoDigitado(texto); // devolve o texto pra barra — dá pra corrigir/tentar de novo
      setSituacaoPorLead((p) => ({
        ...p,
        [id]: r.tipo === "sem_whatsapp" ? "sem-whatsapp" : r.tipo === "desconectado" ? "desconectado" : "erro",
      }));
    }
  }

  /* Linha de baixo de cada conversa: o NÚMERO do lead (pedido explícito — o
     operador confere o telefone sem abrir a conversa). Estados sobrepõem:
     sem-whatsapp esconde o número (lead pulado, não é mais discável por áudio);
     enviado mantém o número junto do selo. Exibir ≠ logar (LGPD ok). */
  function statusLista(lead: LeadAudioReal): { txt: string; cls: string } {
    if (situacaoPorLead[lead.leadTaskId] === "sem-whatsapp") return { txt: "🚫 sem WhatsApp — pulado", cls: "semwa" };
    // "enviado" pelo rastro do envio desta sessão (audioEnviadoPorLead) — a
    // bolha confirmada é substituída pela conversa real, então não serve de marca.
    if (audioEnviadoPorLead[lead.leadTaskId]) return { txt: `🎤 enviado · ${fmtTelefone(lead.telefone) || "sem telefone"}`, cls: "sent" };
    // fmtTelefone('') devolve '' (não "—"): sem o fallback a linha ficaria em branco.
    return { txt: fmtTelefone(lead.telefone) || "sem telefone", cls: "" };
  }

  /* Próximo lead ainda SEM áudio enviado (2026-08-20): dentro da conversa, o
     fluxo do Romero é gravar → próximo → gravar, sem voltar pra lista. Anda a
     lista COMPLETA na ordem do backend (ignora filtro/busca ativos), começa
     DEPOIS do lead aberto e dá a volta; pula quem já saiu (pulados), quem não
     tem lead vinculado (linha só-ligação) e número sem WhatsApp (o áudio não
     entregaria). null = ninguém pendente → o botão nem aparece. */
  const proximoSemAudio = React.useMemo(() => {
    if (!leadAberto) return null;
    const vivos = leads.filter(
      (l) => l.leadTaskId && !(l.ligacaoTaskId && pulados.has(l.ligacaoTaskId)),
    );
    const pendente = (l: LeadAudioReal) =>
      l.leadTaskId !== leadAberto.leadTaskId &&
      (l.conversa?.status ?? "enviar_audio") === "enviar_audio" &&
      situacaoPorLead[l.leadTaskId] !== "sem-whatsapp";
    const i = vivos.findIndex((l) => l.leadTaskId === leadAberto.leadTaskId);
    const giro = [...vivos.slice(i + 1), ...vivos.slice(0, Math.max(i, 0))];
    return giro.find(pendente) ?? null;
  }, [leads, pulados, situacaoPorLead, leadAberto]);

  const irParaProximoSemAudio = () => {
    if (!proximoSemAudio) return;
    // mesmo par de efeitos do toque na linha da lista: bolinha apaga na hora
    // e a conversa troca de lead (dossiê/thread recarregam pelos efeitos).
    setLidosLocais((p) => {
      const n = new Set(p);
      n.add(proximoSemAudio.leadTaskId);
      return n;
    });
    setLeadAberto(proximoSemAudio);
  };

  /* ═══════════════ MODO FAST (2026-08-20) ═══════════════
     A visão: mandar o MÁXIMO de áudios em pouco tempo, com contexto. Tela
     cheia com só o lead + dossiê + microfone; gravou → confere → enviou →
     JÁ CAI NO PRÓXIMO. Placar (⚡ sessão) + cronômetro em cima, "Encerrar"
     embaixo, e no fim uma tela de celebração estilo Duolingo com os tiles
     (sessão / hoje / tempo). */
  const [modoFast, setModoFast] = React.useState(false);
  const [fastLead, setFastLead] = React.useState<LeadAudioReal | null>(null);
  const [fastFim, setFastFim] = React.useState(false);
  const [fastSessao, setFastSessao] = React.useState(0);
  const [fastEnviadosIds, setFastEnviadosIds] = React.useState<Set<string>>(() => new Set());
  const [fastAviso, setFastAviso] = React.useState<string | null>(null);
  const [fastAgora, setFastAgora] = React.useState(0);
  const [fastTempoFim, setFastTempoFim] = React.useState(0);
  const [fastEmVoo, setFastEmVoo] = React.useState(0); // envios otimistas ainda confirmando
  const [fastPulados, setFastPulados] = React.useState(0); // quantos ele decidiu NÃO mandar áudio
  const [fastPuladosSet, setFastPuladosSet] = React.useState<Set<string>>(() => new Set());
  const fastInicioRef = React.useRef(0);

  /* Fila do fast = mesma régua do ⏭ da conversa: pendente de áudio, com lead,
     não pulado, não sem-whatsapp — MENOS quem já recebeu nesta sessão (o selo
     do backend só vira "aguardando" no próximo refetch). Parte de
     `leadsFiltrados` (respeita BUSCA e filtro de selo ativos): buscar "TESTE"
     e entrar no ⚡ treina só nos leads de teste; sem filtro, é a lista toda. */
  const pendentesFast = React.useMemo(
    () =>
      leadsFiltrados.filter(
        (l) =>
          l.leadTaskId &&
          !(l.ligacaoTaskId && pulados.has(l.ligacaoTaskId)) &&
          (l.conversa?.status ?? "enviar_audio") === "enviar_audio" &&
          situacaoPorLead[l.leadTaskId] !== "sem-whatsapp" &&
          !fastEnviadosIds.has(l.leadTaskId) &&
          !fastPuladosSet.has(l.leadTaskId) &&
          !audioEnviadoPorLead[l.leadTaskId],
      ),
    [leadsFiltrados, pulados, situacaoPorLead, fastEnviadosIds, fastPuladosSet, audioEnviadoPorLead],
  );

  /* Dossiê do lead em foco no fast — hook próprio (ocioso fora do modo),
     variante LEVE (sem timeline: só o dossiê importa aqui). */
  const { ficha: fichaFast, carregando: fastDossieCarregando } = useLeadReal(
    modoFast ? (fastLead?.leadTaskId ?? null) : null,
    { leve: true },
  );
  const dossieFastTexto = typeof fichaFast?.dossie === "string" ? fichaFast.dossie : "";

  /* PRÉ-AQUECIMENTO (a estratégia dos "milésimos"): enquanto o Romero grava
     pro lead atual, os dossiês dos 2 PRÓXIMOS da esteira já são buscados —
     o avanço encontra tudo em cache. Re-dispara no preview (audioPronto):
     envio vem em segundos, garante frescor. Dedup/cache do lib fazem as
     repetições custarem zero. */
  React.useEffect(() => {
    if (!modoFast || fastFim) return;
    for (const l of pendentesFast.filter((x) => x.leadTaskId !== fastLead?.leadTaskId).slice(0, 2)) {
      preaquecerDossieLead(l.leadTaskId);
    }
  }, [modoFast, fastFim, fastLead, audioPronto, pendentesFast]);

  // cronômetro do placar (1s) — só enquanto o modo está vivo
  React.useEffect(() => {
    if (!modoFast || fastFim) return;
    const t = window.setInterval(() => setFastAgora(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [modoFast, fastFim]);

  function entrarModoFast() {
    vibrar();
    regravar();
    setFastSessao(0);
    setFastPulados(0);
    setFastPuladosSet(new Set());
    setFastAviso(null);
    setFastFim(pendentesFast.length === 0);
    setFastLead(pendentesFast[0] ?? null);
    fastInicioRef.current = Date.now();
    setFastAgora(Date.now());
    setModoFast(true);
  }
  function encerrarModoFast() {
    setFastTempoFim(Date.now() - fastInicioRef.current);
    setFastFim(true);
  }
  function sairModoFast() {
    setModoFast(false);
    setFastFim(false);
    setFastLead(null);
    setFastAviso(null);
    regravar();
  }
  function avancarFast(aposId: string) {
    const prox = pendentesFast.find((l) => l.leadTaskId !== aposId) ?? null;
    if (prox) setFastLead(prox);
    else encerrarModoFast();
  }
  /* PULAR pessoa (2026-08-20): o Romero decide NÃO mandar áudio pra esta —
     conta como pulado e cai no próximo, sem enviar nada. Não volta nesta
     sessão (fastPuladosSet). O total aparece na tela final. */
  function pularNoFast() {
    const lead = fastLead;
    if (!lead) return;
    const id = lead.leadTaskId;
    vibrar();
    setFastAviso(null);
    setFastPulados((n) => n + 1);
    setFastPuladosSet((p) => new Set(p).add(id));
    regravar(); // descarta qualquer áudio em preview
    avancarFast(id);
  }
  /* OTIMISTA (2026-08-20, feedback: "demora demais pra passar pro próximo"):
     o toque AVANÇA NA HORA — placar +1, próximo lead, microfone limpo — e o
     envio real corre em segundo plano (Evolution leva 3-10s), igual à bolha
     otimista da conversa. Falhou → placar/da­dia voltam, o lead RETORNA pra
     fila e o aviso conta pra quem falhou. `fastEmVoo` mostra o que ainda está
     confirmando (inclusive na tela final, que atualiza ao vivo). */
  function enviarNoFast() {
    const lead = fastLead;
    if (!lead || !audioPronto || !conectado) return;
    const id = lead.leadTaskId;
    const nome = lead.nome;
    const b64 = audioBase64!;
    const mime = audioMime;
    vibrar();
    setFastAviso(null);
    setFastEnviadosIds((p) => new Set(p).add(id));
    setFastSessao((n) => n + 1);
    somarAudiosDia(1);
    setAudioEnviadoPorLead((p) => ({ ...p, [id]: b64.slice(0, 32) })); // selo vira "Aguardando" na hora
    setFastEmVoo((n) => n + 1);
    regravar(); // áudio é personalizado por lead — o próximo grava o dele
    avancarFast(id);
    void (async () => {
      const r = await enviarAudioParaLead(id, b64, mime);
      setFastEmVoo((n) => Math.max(0, n - 1));
      if (r.tipo === "sucesso") {
        setSituacaoPorLead((p) => ({ ...p, [id]: null }));
        return;
      }
      // não confirmou: desfaz o placar/dia e o selo otimista
      setFastSessao((n) => Math.max(0, n - 1));
      somarAudiosDia(-1);
      setAudioEnviadoPorLead((p) => {
        const { [id]: _descartado, ...resto } = p;
        return resto;
      });
      if (r.tipo === "sem_whatsapp") {
        setSituacaoPorLead((p) => ({ ...p, [id]: "sem-whatsapp" }));
        setFastAviso(`${nome}: número sem WhatsApp — ficou de fora.`);
      } else {
        // volta pra fila (sai dos enviados) pra tentar de novo depois
        setFastEnviadosIds((p) => {
          const n = new Set(p);
          n.delete(id);
          return n;
        });
        setFastAviso(`⚠️ Falha ao enviar pra ${nome} — voltou pra fila.`);
      }
    })();
  }

  if (modoFast) {
    const tempoMs = fastFim ? fastTempoFim : (fastAgora || Date.now()) - fastInicioRef.current;
    return (
      <div className="au-fast">
        <style>{AU_CSS}</style>
        {fastFim ? (
          <div className="au-fast-fim">
            <div className="au-fast-emoji">{fastSessao > 0 ? "🎉" : fastPulados > 0 ? "👋" : "😴"}</div>
            <div className="au-fast-tit">
              {fastSessao > 0 ? "Mandou bem!" : fastPulados > 0 ? "Sessão encerrada" : "Nada pendente"}
            </div>
            <div className="au-fast-sub">
              {fastSessao > 0
                ? `${fastSessao} áudio${fastSessao === 1 ? "" : "s"} nesta sessão — todo mundo com contexto do dossiê.`
                : fastPulados > 0
                  ? "Nenhum áudio enviado nesta sessão."
                  : "Todo mundo da lista já recebeu áudio hoje."}
            </div>
            <div className="au-fast-tiles">
              <div className="au-fast-tile am">
                <span className="au-fast-tile-rot">⚡ Sessão</span>
                <span className="au-fast-tile-val">{fastSessao}</span>
              </div>
              <div className="au-fast-tile vd">
                <span className="au-fast-tile-rot">🔥 Hoje</span>
                <span className="au-fast-tile-val">{lerAudiosDia()}</span>
              </div>
              <div className="au-fast-tile az">
                <span className="au-fast-tile-rot">⏱ Tempo</span>
                <span className="au-fast-tile-val">{fmtRelogio(tempoMs)}</span>
              </div>
            </div>
            {fastPulados > 0 && (
              <div className="au-fast-sub">⏭️ Você pulou {fastPulados} {fastPulados === 1 ? "pessoa" : "pessoas"} nesta sessão.</div>
            )}
            {fastEmVoo > 0 && (
              <div className="au-fast-sub">✈️ {fastEmVoo} envio{fastEmVoo === 1 ? "" : "s"} confirmando em segundo plano…</div>
            )}
            <button type="button" className="au-fast-claim" onClick={sairModoFast}>
              Voltar pra lista
            </button>
          </div>
        ) : (
          <>
            <div className="au-fast-top">
              <span className="au-fast-score">⚡ {fastSessao}</span>
              <span className="au-fast-relogio">{fmtRelogio(tempoMs)}</span>
              <span className="au-fast-resta">
                {pendentesFast.length} na fila{fastEmVoo > 0 ? ` · ✈️ ${fastEmVoo}` : ""}
              </span>
            </div>
            <div className="au-fast-lead">
              <div className="au-fast-nome">{fastLead?.nome}</div>
              <div className="au-fast-tel">{fmtTelefone(fastLead?.telefone ?? "")}</div>
            </div>
            <div className="au-fast-dossie">
              {fastDossieCarregando && !dossieFastTexto ? (
                <div className="au-fast-dossie-vazio">📋 carregando o dossiê…</div>
              ) : dossieFastTexto ? (
                <DossieMarkdown texto={dossieFastTexto} />
              ) : (
                <div className="au-fast-dossie-vazio">Sem dossiê deste lead — vale usar o nome e a cidade.</div>
              )}
            </div>
            {(fastAviso || erroMic) && <div className="au-fast-aviso">{fastAviso ?? erroMic}</div>}
            <div className="au-fast-acao">
              {audioPronto && audioUrl ? (
                <>
                  <div className="au-fast-preview">
                    <button
                      type="button"
                      className="au-fast-play"
                      onClick={alternarReproducao}
                      aria-label={tocando ? "Pausar o áudio" : "Ouvir o áudio"}
                    >
                      {tocando ? <Pause size={20} /> : <Play size={20} />}
                    </button>
                    <span className="au-fast-dur">{fmtRelogio(duracaoPreviewMs)}</span>
                    <button type="button" className="au-fast-regravar" onClick={regravar} aria-label="Regravar o áudio">
                      <RotateCcw size={16} /> regravar
                    </button>
                    <audio
                      ref={audioElRef}
                      src={audioUrl}
                      onPlay={() => setTocando(true)}
                      onPause={() => setTocando(false)}
                      onEnded={() => setTocando(false)}
                    />
                  </div>
                  <button type="button" className="au-fast-send" onClick={enviarNoFast}>
                    Enviar e próximo
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={"au-fast-mic" + (estadoGravacao === "gravando" ? " gravando" : "")}
                  onClick={alternarGravacao}
                  aria-label={estadoGravacao === "gravando" ? "Tocar para parar de gravar" : "Tocar para gravar o áudio"}
                >
                  <Mic size={30} />
                </button>
              )}
              <div className={"au-fast-hint" + (dicaSegurar ? " dica" : "")}>
                {estadoGravacao === "gravando"
                  ? `🔴 Gravando… ${fmtRelogio(duracaoMs)} — toque para parar`
                  : audioPronto
                    ? "Confere o áudio e envia — já caio no próximo."
                    : "👆 Toque no microfone e grave usando o dossiê aí de cima."}
              </div>
              {/* PULAR pessoa (2026-08-20): não quer mandar áudio pra esta →
                  cai no próximo sem enviar. Neutro (a ação verde é enviar). */}
              <button type="button" className="au-fast-pular" onClick={pularNoFast}>
                <SkipForward size={16} /> Pular esta pessoa
              </button>
              <button type="button" className="au-fast-end" onClick={encerrarModoFast}>
                Encerrar modo fast
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  /* ═══════════════ CONVERSA (por lead) ═══════════════ */
  if (leadAberto) {
    const bolhas = bolhasPorLead[leadAberto.leadTaskId] ?? [];
    const conversa = conversaPorLead[leadAberto.leadTaskId] ?? [];
    const situ = situacaoPorLead[leadAberto.leadTaskId] ?? null;
    const enviando = enviandoLead === leadAberto.leadTaskId;
    const gravando = estadoGravacao === "gravando";
    return (
      <div className="au-conv">
        <style>{AU_CSS}</style>
        <div className="au-chead">
          <button type="button" className="au-back" onClick={() => setLeadAberto(null)} aria-label="Voltar">
            <ArrowLeft size={24} />
          </button>
          {/* nome/avatar TOCÁVEIS (2026-08-19, estilo WhatsApp): abrem a ficha
              do lead (dossiê + histórico) por cima da conversa. */}
          <span className="au-av sm" style={{ background: corAvatar(leadAberto.nome) }} onClick={() => setFichaAberta(true)}>
            {iniciais(leadAberto.nome)}
          </span>
          <div
            className="au-ct au-ct-btn"
            role="button"
            tabIndex={0}
            onClick={() => setFichaAberta(true)}
            onKeyDown={(e) => (e.key === "Enter" ? setFichaAberta(true) : null)}
            aria-label={`Ver dossiê e histórico de ${leadAberto.nome}`}
          >
            <div className="au-cnm">{leadAberto.nome}</div>
            <div className="au-cst">{fmtTelefone(leadAberto.telefone)} · toque p/ ficha</div>
          </div>
          <button
            type="button"
            className="au-callbtn"
            onClick={() => ligarParaLead(leadAberto)}
            disabled={ligando}
            aria-label="Ligar para o lead (call center)"
            title="Ligar (call center)"
          >
            {ligando ? <span className="au-spin" /> : <Phone size={19} />}
          </button>
          {proximoSemAudio && (
            <button
              type="button"
              className="au-nextbtn"
              onClick={irParaProximoSemAudio}
              aria-label={`Próximo lead sem áudio: ${proximoSemAudio.nome}`}
              title={`Próximo sem áudio: ${proximoSemAudio.nome}`}
            >
              <SkipForward size={18} />
            </button>
          )}
        </div>

        {/* ── card recolhível do DOSSIÊ (2026-08-19): faixa fixa (não rola com
              o thread), some sozinha quando o lead não tem dossiê (erro/vazio
              já carregado degradam em silêncio — a conversa segue normal). ── */}
        {(dossieCarregando || dossieTexto) && (
          <div className="au-dossie">
            <button
              type="button"
              className="au-dossie-strip"
              onClick={() => setDossieAberto((v) => !v)}
              disabled={dossieCarregando && !dossieTexto}
              aria-expanded={dossieAberto}
            >
              <span>📋 Dossiê{dossieCarregando && !dossieTexto ? " — carregando…" : ""}</span>
              {!!dossieTexto && <span className="au-dossie-chev">{dossieAberto ? "▴ ocultar" : "▾"}</span>}
            </button>
            {dossieAberto && dossieTexto && (
              <div className="au-dossie-body">
                <DossieMarkdown texto={dossieTexto} />
              </div>
            )}
          </div>
        )}

        <div className="au-thread" ref={threadRef}>
          {/* com mensagens de outros dias na conversa, "HOJE" mentiria */}
          <div className="au-day">
            {conversa.some((m) => fmtQuandoBolha(m.ts).includes("/")) ? "CONVERSA" : "HOJE"}
          </div>
          {conversa.length === 0 && bolhas.length === 0 && situ !== "sem-whatsapp" && (
            <div className="au-hintbig">
              {conversaCarregando ? (
                <>Carregando a conversa…</>
              ) : (
                <>
                  Nenhuma mensagem ainda.
                  <br />
                  {audioPronto
                    ? "Toque em Enviar para mandar o áudio."
                    : "Toque no microfone para gravar o áudio."}
                </>
              )}
            </div>
          )}

          {/* ── a conversa REAL (dois lados), vinda do WhatsApp ── */}
          {conversa.map((m) =>
            m.tipo === "outro" ? null : (
              <div key={m.id} className={"au-bubble" + (m.deNos ? "" : " in")}>
                {m.tipo === "audio" ? (
                  <>
                    <div className="au-voice">
                      <button
                        type="button"
                        className="au-vplay"
                        onClick={() => void tocarMensagem(m)}
                        aria-label={bolhaTocando === m.id ? "Pausar áudio" : "Ouvir áudio"}
                      >
                        {midiaCarregando === m.id ? (
                          <span className="au-spin" />
                        ) : bolhaTocando === m.id ? (
                          <Pause size={16} />
                        ) : (
                          <Play size={16} />
                        )}
                      </button>
                      <span className={"au-vwave" + (bolhaTocando === m.id ? " play" : "")}>
                        {ONDAS.map((h, j) => (
                          <i key={j} style={{ height: h }} />
                        ))}
                      </span>
                    </div>
                    {m.transcricao && <div className="au-trans">“{m.transcricao.replace(/Falante \d+:\s*/g, "").trim()}”</div>}
                  </>
                ) : (
                  <div className="au-btxt">{m.texto}</div>
                )}
                <div className="au-meta">
                  {fmtQuandoBolha(m.ts)} {m.deNos && <CheckCheck size={14} className="au-mck" />}
                </div>
              </div>
            ),
          )}

          {/* ── bolhas da SESSÃO (envio em andamento / recém-confirmado — a
                 conversa real substitui no próximo refresh) ── */}
          {bolhas.map((b, i) => (
            <div key={`s${i}`} className="au-bubble">
              {b.tipo === "texto" ? (
                <div className="au-btxt">{b.texto}</div>
              ) : (
                <div className="au-voice">
                  {b.src ? (
                    <button
                      type="button"
                      className="au-vplay"
                      onClick={() => alternarBolha(`s${i}`, b.src!)}
                      aria-label={bolhaTocando === `s${i}` ? "Pausar áudio" : "Ouvir áudio"}
                    >
                      {bolhaTocando === `s${i}` ? <Pause size={16} /> : <Play size={16} />}
                    </button>
                  ) : (
                    <span className="au-vplay off">
                      <Mic size={15} />
                    </span>
                  )}
                  <span className={"au-vwave" + (bolhaTocando === `s${i}` ? " play" : "")}>
                    {ONDAS.map((h, j) => (
                      <i key={j} style={{ height: h }} />
                    ))}
                  </span>
                  {typeof b.durMs === "number" && b.durMs > 0 && <span className="au-vdur">{fmtMMSS(b.durMs)}</span>}
                </div>
              )}
              <div className="au-meta">
                {b.hora}{" "}
                {b.status === "enviando" ? (
                  /* subiu otimista: relógio até o backend confirmar (WhatsApp-like) */
                  <Clock size={13} className="au-mwait" />
                ) : (
                  <CheckCheck size={14} className="au-mck" />
                )}
              </div>
            </div>
          ))}
          {/* player compartilhado das bolhas (som apenas; sem UI própria) */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio
            ref={bolhaAudioRef}
            onPause={() => setBolhaTocando(null)}
            onEnded={() => setBolhaTocando(null)}
            style={{ display: "none" }}
          />
          {situ === "sem-whatsapp" && <div className="au-sysmsg semwa">🚫 Este número não tem WhatsApp — pulado.</div>}
          {situ === "desconectado" && <div className="au-sysmsg semwa">Não enviou — número desconectado.</div>}
          {situ === "erro" && <div className="au-sysmsg semwa">O envio falhou. Toque em Enviar para tentar de novo.</div>}
          {avisoSemAudio && <div className="au-sysmsg">{conectado === false ? "Sessão desconectada." : "Grave um áudio primeiro."}</div>}
        </div>

        {/* compose: áudio pronto E ESTE áudio ainda não foi mandado pra ESTE
            lead → play + Enviar; senão → segurar mic. Depois do envio a barra
            ESVAZIA (a bolha já subiu no fio) — o mesmo áudio segue pronto pros
            PRÓXIMOS leads (D-03), e um áudio NOVO reabre o envio aqui. */}
        <div className="au-compose">
          {/* aviso "segure para gravar" (2026-08-20): flutua acima da barra ao
              clicar rápido no microfone — some sozinho em ~2,6s. */}
          {dicaSegurar && <div className="au-dica-segurar">✋ Segure o microfone para gravar — não solte enquanto fala.</div>}
          {audioPronto && audioBase64 && audioEnviadoPorLead[leadAberto.leadTaskId] !== audioBase64.slice(0, 32) ? (
            <>
              <div className="au-field ready">
                <button type="button" className="au-play" onClick={alternarReproducao} aria-label={tocando ? "Pausar" : "Reproduzir"}>
                  {tocando ? <Pause size={17} /> : <Play size={17} />}
                </button>
                <span className={"au-wave" + (tocando ? " play" : "")} aria-hidden="true">
                  {ONDAS.map((h, i) => (
                    <i key={i} style={{ height: h }} />
                  ))}
                </span>
                <span className="au-dur">{fmtMMSS(duracaoPreviewMs)}</span>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio
                  ref={audioElRef}
                  src={audioUrl ?? undefined}
                  onPlay={() => setTocando(true)}
                  onPause={() => setTocando(false)}
                  onEnded={() => setTocando(false)}
                  style={{ display: "none" }}
                />
                <button type="button" className="au-trashmini" onClick={regravar} aria-label="Regravar">
                  <RotateCcw size={17} />
                </button>
              </div>
              <button
                type="button"
                className="au-mic send"
                disabled={enviando}
                onClick={() => void enviarNaConversa(leadAberto)}
                aria-label="Enviar áudio"
              >
                {enviando ? <span className="au-spin lg" /> : <Send size={22} />}
              </button>
            </>
          ) : (
            <>
              {/* biblioteca de conteúdos prontos (Fase 2): abre o bottom-sheet;
                  escolher insere texto/link no campo pra revisar e enviar. */}
              {!gravando && (
                <button
                  type="button"
                  className="au-lib"
                  onClick={() => void abrirConteudos()}
                  aria-label="Biblioteca de conteúdos prontos"
                >
                  <FolderOpen size={20} />
                </button>
              )}
              <div className={"au-field" + (gravando ? " rec" : "")}>
                {gravando ? (
                  <>
                    <span className="au-recdot" />
                    <span className="au-rectime">{fmtMMSS(duracaoMs)}</span>
                    <span className="au-slide">toque para parar</span>
                  </>
                ) : (
                  /* chat de verdade (Fase 13 fatia 2): digita = manda TEXTO;
                     vazio = toque no microfone e manda ÁUDIO (WhatsApp-like) */
                  <input
                    className="au-txtin"
                    type="text"
                    value={textoDigitado}
                    onChange={(e) => setTextoDigitado(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void enviarTextoNaConversa(leadAberto);
                      }
                    }}
                    placeholder={erroMic ?? "Mensagem…"}
                    enterKeyHint="send"
                    maxLength={4096}
                  />
                )}
              </div>
              {textoDigitado.trim() && !gravando ? (
                <button
                  type="button"
                  className="au-mic send"
                  disabled={!!enviandoLead}
                  onClick={() => void enviarTextoNaConversa(leadAberto)}
                  aria-label="Enviar mensagem"
                >
                  {enviandoLead ? <span className="au-spin lg" /> : <Send size={22} />}
                </button>
              ) : (
                <button
                  type="button"
                  className={"au-mic" + (gravando ? " recording" : "")}
                  onClick={alternarGravacao}
                  onContextMenu={(e) => e.preventDefault()}
                  aria-label={gravando ? "Parar de gravar" : "Gravar áudio (toque)"}
                >
                  <Mic size={23} />
                </button>
              )}
            </>
          )}
        </div>

        {/* chamada embutida (estilo WhatsApp) — por cima de tudo */}
        {overlayChamada}

        {/* ── FICHA do lead (2026-08-19): dossiê + histórico como OVERLAY —
              a conversa fica viva por trás; voltar fecha só a ficha. ── */}
        {fichaAberta && (
          <div className="au-ficha">
            <div className="au-chead">
              <button type="button" className="au-back" onClick={() => setFichaAberta(false)} aria-label="Voltar pra conversa">
                <ArrowLeft size={24} />
              </button>
              <div className="au-ct">
                <div className="au-cnm">{leadAberto.nome}</div>
                <div className="au-cst">dossiê e histórico</div>
              </div>
            </div>
            <div className="au-fbody">
              {/* Suspense: PerfilLead usa useSearchParams (exigência do Next). */}
              <React.Suspense fallback={null}>
                <PerfilLead id={leadAberto.leadTaskId} embutido />
              </React.Suspense>
            </div>
          </div>
        )}

        {/* PAINEL da biblioteca — renderizado DENTRO da conversa (correção
            2026-08-23): abre SOBRE a conversa, não na lista. */}
        {conteudosAberto && (
          <div
            className="au-libsheet-wrap"
            role="dialog"
            aria-modal="true"
            aria-label="Biblioteca de conteúdos"
            onClick={() => setConteudosAberto(false)}
          >
            <div className="au-libsheet" onClick={(e) => e.stopPropagation()}>
              <div className="au-libgrab" aria-hidden="true" />
              <div className="au-libtop">
                <div className="au-libtabs">
                  <button type="button" className={"au-libtab" + (modoConteudos === "enviar" ? " on" : "")} onClick={() => setModoConteudos("enviar")}>
                    Enviar
                  </button>
                  <button type="button" className={"au-libtab" + (modoConteudos === "gerenciar" ? " on" : "")} onClick={() => setModoConteudos("gerenciar")}>
                    Gerenciar
                  </button>
                </div>
                <button type="button" className="au-libx" onClick={() => setConteudosAberto(false)} aria-label="Fechar">
                  <X size={20} />
                </button>
              </div>
              <div className="au-libbody">
                {modoConteudos === "enviar" ? (
                  <>
                    <div className="au-libhint">
                      Toque num conteúdo: texto e link entram no campo pra você revisar; imagem, vídeo e áudio vão direto.
                    </div>
                    {conteudosCarregando ? (
                      <div className="au-libvazio">Carregando…</div>
                    ) : conteudos.length === 0 ? (
                      <div className="au-libvazio">
                        Nada cadastrado ainda. Toque em <b>Gerenciar</b> pra adicionar.
                      </div>
                    ) : (
                      conteudosPorCategoria.map(([cat, itens]) => (
                        <div key={cat} className="au-libgrupo">
                          <div className="au-libcat">{cat}</div>
                          {itens.map((cnt) => (
                            <button key={cnt.id} type="button" className="au-libitem" onClick={() => void escolherConteudo(cnt)}>
                              <span className="au-libtag">{cnt.tipo}</span>
                              <span className="au-libtxt">
                                <span className="au-libnome">{cnt.titulo}</span>
                                <span className="au-libsub">{cnt.tipo === "texto" ? (cnt.texto ?? "") : (cnt.url ?? "")}</span>
                              </span>
                            </button>
                          ))}
                        </div>
                      ))
                    )}
                  </>
                ) : (
                  <BibliotecaConteudos onChange={() => void recarregarConteudos()} />
                )}
              </div>
            </div>
          </div>
        )}

        {/* PREVIEW da mídia ANTES de enviar (imagem/vídeo/áudio): o operador vê
            e confirma; só então manda. */}
        {previewConteudo && (
          <div
            className="au-libsheet-wrap"
            role="dialog"
            aria-modal="true"
            aria-label="Pré-visualizar conteúdo"
            onClick={() => {
              if (!enviandoConteudo) setPreviewConteudo(null);
            }}
          >
            <div className="au-libsheet au-libprev" onClick={(e) => e.stopPropagation()}>
              <div className="au-libgrab" aria-hidden="true" />
              <div className="au-libtop">
                <div className="au-libprevtit">Enviar este conteúdo?</div>
                <button type="button" className="au-libx" onClick={() => setPreviewConteudo(null)} disabled={enviandoConteudo} aria-label="Fechar">
                  <X size={20} />
                </button>
              </div>
              <div className="au-libprevbody">
                {previewConteudo.tipo === "imagem" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="au-libprevmedia" src={previewConteudo.url ?? ""} alt={previewConteudo.titulo} />
                ) : previewConteudo.tipo === "video" ? (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <video className="au-libprevmedia" src={previewConteudo.url ?? ""} controls />
                ) : (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <audio className="au-libprevaudio" src={previewConteudo.url ?? ""} controls />
                )}
                <div className="au-libprevnome">{previewConteudo.titulo}</div>
              </div>
              <div className="au-libprevacts">
                <button type="button" className="seg" onClick={() => setPreviewConteudo(null)} disabled={enviandoConteudo}>
                  Cancelar
                </button>
                <button type="button" className="au-libprevgo" onClick={() => void confirmarEnvioConteudo()} disabled={enviandoConteudo}>
                  {enviandoConteudo ? "Enviando…" : "Enviar"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ═══════════════ LISTA (nunca-ligados) ═══════════════ */
  const conteudo = (
    <>
      {/* Banner de conexão SÓ quando há problema (pedido 2026-08-19): conectado
          é silêncio; o aviso aparece apenas com a sessão comprovadamente fora. */}
      {conectado === false && (
        <Autobox tom="warn" titulo="Número desconectado">
          Reconecte o WhatsApp dedicado — nenhum áudio sai enquanto a sessão estiver fora.
        </Autobox>
      )}

      {/* Busca por nome ou telefone (pedido 2026-08-19) — filtra o lote de hoje. */}
      <div className="au-search">
        <Search size={18} className="au-search-ic" aria-hidden />
        <input
          type="search"
          inputMode="search"
          className="au-search-in"
          placeholder="Buscar por nome ou telefone…"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          aria-label="Buscar lead por nome ou telefone"
        />
        {busca && (
          <button type="button" className="au-search-x" onClick={() => setBusca("")} aria-label="Limpar busca">
            <X size={16} />
          </button>
        )}
      </div>

      {/* Filtro pelo SELO da conversa (pedido 2026-08-19) — substitui os chips
          de origem (ENVIO-04): o operador filtra por "posso ligar?", não por
          onde o lead entrou. QUEBRA DE LINHA (2026-08-20): antes era scroll-x e
          os últimos chips vazavam pra fora da tela. */}
      <div className="au-filtros">
        {(
          [
            ["todos", "Todos"],
            ["enviar_audio", "Enviar áudio"],
            ["aguardando", "Aguardando"],
            ["indefinido", "Indefinido"],
            ["ligar", "Ligar"],
            ["nao_ligar", "Não ligar"],
          ] as const
        ).map(([valor, rotulo]) => (
          <button
            key={valor}
            type="button"
            className={filtroSelo === valor ? "seg on" : "seg"}
            onClick={() => setFiltroSelo(valor)}
          >
            {rotulo}
          </button>
        ))}
      </div>

      {carregando ? (
        <div className="au-list">
          <div className="au-more">
            <span className="au-spin" /> carregando…
          </div>
        </div>
      ) : erro ? (
        <div className="empty">
          <b>Não deu para carregar a lista</b>
          <button type="button" className="seg" style={{ marginTop: 10 }} onClick={recarregar}>
            tentar de novo
          </button>
        </div>
      ) : semMapeamento ? (
        <Autobox tom="warn" titulo="Fila não configurada">
          Configure o mapeamento do operador no discador (painel /admin do call center).
        </Autobox>
      ) : leadsFiltrados.length === 0 ? (
        <div className="empty">
          {busca.trim() ? (
            <>
              <b>Nada encontrado</b>
              Nenhum lead de hoje bate com “{busca.trim()}”.
            </>
          ) : (
            <>
              <b>Nenhuma ligação pra você aqui</b>
              Quando criarem uma Ligação pra você, o lead aparece nesta lista.
            </>
          )}
        </div>
      ) : (
        <div className="au-list" role="list">
          {leadsVisiveis.map((lead) => {
            const st = statusLista(lead);
            // Selo "posso ligar?" (Fase 13 fatia 2): sem-whatsapp da sessão
            // sobrepõe; senão, ENVIO desta sessão (fast/conversa) vira
            // "Aguardando" NA HORA (2026-08-20 — o backend só reflete no
            // próximo refetch, e a linha parecia continuar "Enviar áudio");
            // por último vale a avaliação do backend (LLM/heurística).
            const selo =
              situacaoPorLead[lead.leadTaskId] === "sem-whatsapp"
                ? { status: "nao_ligar" as const, motivo: "Número sem WhatsApp" }
                : audioEnviadoPorLead[lead.leadTaskId] && (lead.conversa?.status ?? "enviar_audio") === "enviar_audio"
                  ? { status: "aguardando" as const, motivo: "Áudio enviado — aguardando resposta" }
                  : lead.conversa;
            // Linha SEM lead vinculado (Ligação avulsa/manual sem LEAD_REL):
            // não há conversa possível. O toque NÃO liga mais (2026-08-20 —
            // pedido: "não quero tocar e já ligar"); ligar é só pelo botão 📞
            // explícito no canto da linha.
            const abrir = () => {
              if (!lead.leadTaskId) {
                return;
              }
              // bolinha apaga NA HORA (o backend marca lido_em em paralelo)
              setLidosLocais((p) => {
                const n = new Set(p);
                n.add(lead.leadTaskId);
                return n;
              });
              setLeadAberto(lead);
            };
            return (
              <div key={lead.leadTaskId || lead.ligacaoTaskId} className="au-row" role="listitem" tabIndex={0} onClick={abrir} onKeyDown={(e) => (e.key === "Enter" ? abrir() : null)}>
                <span className="au-av" style={{ background: corAvatar(lead.nome) }}>
                  {iniciais(lead.nome)}
                  {/* bolinha: mensagem do LEAD ainda NÃO LIDA — abrir a
                      conversa marca como lida (banco) e apaga na hora
                      (lidosLocais, otimista) */}
                  {lead.ultima && !lead.ultima.deNos && !lead.ultima.lida && !lidosLocais.has(lead.leadTaskId) && (
                    <span className="au-dot" aria-label="Mensagem nova do lead" />
                  )}
                </span>
                <span className="au-rc">
                  <span className="au-name">{lead.nome}</span>
                  <span className={"au-sub " + st.cls}>{st.txt}</span>
                  {lead.ultima && !lead.ultima.deNos && !lead.ultima.lida && !lidosLocais.has(lead.leadTaskId) && lead.ultima.preview && (
                    <span className="au-prev">{lead.ultima.preview}</span>
                  )}
                </span>
                {selo && (
                  <span className="au-lado">
                    <span className={"au-selo " + SELO_UI[selo.status].cls}>{SELO_UI[selo.status].rotulo}</span>
                    {selo.motivo && <span className="au-balao">{selo.motivo}</span>}
                    {/* PULAR (2026-08-19): só quando o funil diz que NÃO deu
                        certo e a linha tem Ligação pra fechar — abre o modal
                        de motivo (stopPropagation: não abre a conversa). */}
                    {selo.status === "nao_ligar" && lead.ligacaoTaskId && (
                      <button
                        type="button"
                        className="au-pular"
                        onClick={(e) => {
                          e.stopPropagation();
                          vibrar();
                          setPularAlvo(lead);
                          setPularMotivo("");
                          setPularErro(false);
                        }}
                        aria-label={`Pular ${lead.nome}`}
                      >
                        <SkipForward size={12} /> Pular
                      </button>
                    )}
                    {/* linha sem lead: NÃO liga daqui (decisão 2026-08-20 — o
                        Romero encostava sem querer e caía numa chamada). A
                        linha é só informativa; ligação é pela fila/conversa. */}
                  </span>
                )}
              </div>
            );
          })}
          {leadsVisiveis.length < leadsFiltrados.length && (
            <div className="au-more" ref={sentinelaRef}>
              <span className="au-spin" /> carregando mais…
            </div>
          )}
        </div>
      )}

      {/* chamada embutida (estilo WhatsApp) — também disponível na LISTA
          (linhas call-only sem vínculo ligam direto daqui). */}
      {overlayChamada}

      {/* ⚡ MODO FAST (2026-08-20): entra na esteira de envio de áudio — some
          quando não há ninguém pendente. */}
      {pendentesFast.length > 0 && (
        <button type="button" className="au-fastfab" onClick={entrarModoFast}>
          ⚡ Modo fast <span className="au-fastfab-n">{pendentesFast.length}</span>
        </button>
      )}

      {/* ── modal do PULAR (2026-08-19): motivo OBRIGATÓRIO — vira comentário
            na Ligação (⏭️ Contato pulado) e a task fecha, saindo da fila. ── */}
      {pularAlvo && (
        <div
          className="au-pmodal"
          role="dialog"
          aria-modal="true"
          aria-label="Pular contato"
          onClick={() => {
            if (!pulando) setPularAlvo(null);
          }}
        >
          <div className="au-pcard" onClick={(e) => e.stopPropagation()}>
            <div className="au-ptit">
              <SkipForward size={17} /> Pular contato
            </div>
            <div className="au-pnome">{pularAlvo.nome}</div>
            <div className="au-phint">A Ligação sai da sua fila e o motivo fica registrado na task do ClickUp.</div>
            <textarea
              className="au-ptxt"
              value={pularMotivo}
              onChange={(e) => setPularMotivo(e.target.value)}
              placeholder="Explique o motivo (obrigatório)…"
              rows={3}
              maxLength={500}
              autoFocus
            />
            {pularErro && <div className="au-perro">Não deu para pular — tente de novo.</div>}
            <div className="au-pacts">
              <button type="button" className="seg" onClick={() => setPularAlvo(null)} disabled={pulando}>
                Cancelar
              </button>
              <button type="button" className="au-pgo" onClick={() => void confirmarPular()} disabled={pulando || !pularMotivo.trim()}>
                {pulando ? <span className="au-spin" /> : <SkipForward size={15} />} Pular contato
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  );

  // Embutido (vista "Áudios" do dropdown de Ações): só o conteúdo — o título
  // já é o próprio dropdown da tela-mãe; sem wrapper `.view` (o pai já é a tela).
  if (embutido) {
    return (
      <>
        <style>{AU_CSS}</style>
        {conteudo}
      </>
    );
  }

  // Tela própria (/audios) — rota direta de rollback, sem dropdown.
  return (
    <div className="view au-view">
      <style>{AU_CSS}</style>
      <Vhead titulo="Áudios" sub="sua fila — mensagem, áudio e ligação" live={conectado ? "conectado" : undefined} />
      {conteudo}
    </div>
  );
}

const AU_CSS = `
.au-view{ position:relative; }
.au-search{ position:relative; display:flex; align-items:center; margin:2px 0 10px; }
.au-search-ic{ position:absolute; left:12px; color:var(--dim); pointer-events:none; }
.au-search-in{ width:100%; box-sizing:border-box; padding:11px 38px 11px 38px; border-radius:12px; border:1px solid var(--line); background:var(--card); color:var(--ink); font-size:15px; outline:none; -webkit-appearance:none; }
.au-search-in::placeholder{ color:var(--dim); }
/* Filtros de selo: EMBRULHAM em vez de correr num scroll horizontal (2026-08-20,
   "os filtros estão vazando na tela"). Todos os 6 ficam visíveis — ~2 linhas no
   celular, 1 no tablet/rail. Chips um pouco mais compactos pra empacotar bem;
   escopado a esta tela (não altera .seg/.scroll-x usados em outros lugares). */
.au-filtros{ display:flex; flex-wrap:wrap; gap:7px; margin:2px 0 4px; }
.au-filtros .seg{ padding:8px 13px; font-size:13px; font-weight:700; line-height:1; flex:0 1 auto; }
.au-search-in:focus{ border-color:var(--go); }
.au-search-in::-webkit-search-cancel-button{ display:none; }
.au-search-x{ position:absolute; right:8px; width:26px; height:26px; border:none; border-radius:50%; background:transparent; color:var(--dim); display:grid; place-items:center; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.au-search-x:active{ background:var(--line); }
.au-list{ display:flex; flex-direction:column; gap:0; }
.au-row{ display:flex; align-items:center; gap:12px; padding:11px 4px; cursor:pointer; position:relative; border-radius:12px; transition:background .12s; -webkit-tap-highlight-color:transparent; }
.au-row:active{ background:var(--card); }
.au-row:focus-visible{ outline:2px solid var(--go); outline-offset:2px; }
.au-row + .au-row::before{ content:""; position:absolute; left:60px; right:6px; top:0; height:1px; background:var(--line); }
.au-av{ width:47px; height:47px; border-radius:50%; flex:none; display:grid; place-items:center; color:#0b141a; font-weight:800; font-size:15px; position:relative; }
.au-dot{ position:absolute; top:-1px; right:-1px; width:13px; height:13px; border-radius:50%; background:var(--go); border:2.5px solid var(--bg-0); }
.au-prev{ font-size:12.5px; font-weight:700; color:var(--go); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.au-av.sm{ width:38px; height:38px; font-size:13px; }
.au-rc{ flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.au-name{ font-size:15px; font-weight:700; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.au-sub{ font-size:13px; color:var(--dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:flex; align-items:center; gap:5px; }
.au-sub.sent{ color:var(--go); }
.au-sub.semwa{ color:var(--alert); }
.au-trail{ flex:none; width:26px; display:grid; place-items:center; color:var(--go); }
.au-ck{ color:var(--go); }
/* selo "posso ligar?" + balão do motivo, no canto direito da linha */
.au-lado{ flex:none; display:flex; flex-direction:column; align-items:flex-end; gap:4px; max-width:172px; }
.au-selo{ font-size:10px; font-weight:800; letter-spacing:.03em; text-transform:uppercase; padding:3px 8px; border-radius:999px; white-space:nowrap; }
.au-selo.ligar{ background:color-mix(in srgb, var(--go) 18%, transparent); color:var(--go); }
.au-selo.nao{ background:color-mix(in srgb, var(--alert) 16%, transparent); color:var(--alert); }
.au-selo.indef{ background:color-mix(in srgb, #f5a623 20%, transparent); color:#f5a623; }
.au-selo.envaudio{ background:color-mix(in srgb, var(--accent, #4a90e2) 18%, transparent); color:var(--accent, #4a90e2); }
.au-selo.aguard{ background:var(--card-2); color:var(--dim); }
/* motivo INTEIRO, sem cortar (pedido do gestor): o balão cresce em altura,
   quebra linha e a linha da lista acompanha — legibilidade > compacidade. */
.au-balao{ max-width:100%; font-size:10.5px; line-height:1.4; color:var(--dim); background:var(--card-2); border-radius:10px 10px 3px 10px; padding:5px 9px; white-space:normal; overflow-wrap:break-word; text-align:right; }
/* pular contato (2026-08-19): chip na linha + modal de motivo */
.au-pular{ display:inline-flex; align-items:center; gap:4px; font-size:10px; font-weight:800; letter-spacing:.03em; text-transform:uppercase; padding:4px 9px; border-radius:999px; border:1px solid color-mix(in srgb, var(--alert) 45%, transparent); background:transparent; color:var(--alert); cursor:pointer; -webkit-tap-highlight-color:transparent; }
.au-pular:active{ background:color-mix(in srgb, var(--alert) 14%, transparent); }
.au-pmodal{ position:fixed; inset:0; z-index:300; background:rgba(0,0,0,.55); display:flex; align-items:flex-end; justify-content:center; padding:0 12px calc(24px + var(--safe-b)); }
.au-pcard{ width:min(520px, 100%); background:var(--bg-1); border:1px solid var(--line); border-radius:18px; padding:16px; display:flex; flex-direction:column; gap:10px; animation:auB .18s ease both; }
.au-ptit{ display:flex; align-items:center; gap:8px; font-size:15px; font-weight:800; color:var(--alert); }
.au-pnome{ font-size:14px; font-weight:700; color:var(--ink); }
.au-phint{ font-size:12.5px; color:var(--dim); line-height:1.5; }
.au-ptxt{ width:100%; box-sizing:border-box; resize:none; background:var(--bg-2); border:1px solid var(--line); border-radius:12px; padding:10px 12px; color:var(--ink); font-size:14px; line-height:1.5; outline:none; font-family:inherit; }
.au-ptxt:focus{ border-color:var(--alert); }
.au-perro{ font-size:12.5px; color:var(--alert); font-weight:700; }
.au-pacts{ display:flex; gap:8px; justify-content:flex-end; align-items:center; }
.au-pgo{ display:inline-flex; align-items:center; gap:6px; border:none; border-radius:12px; padding:10px 14px; background:var(--alert); color:#fff; font-weight:800; font-size:13px; cursor:pointer; -webkit-tap-highlight-color:transparent; }
/* ── Biblioteca de conteúdos (redesenho: painel DENTRO da conversa) ── */
/* botão de acesso ÓBVIO na barra de digitar: cor de destaque pra saltar aos olhos. */
.au-lib{ width:46px; height:46px; border-radius:50%; flex:none; cursor:pointer; border:1px solid color-mix(in srgb, var(--go) 55%, transparent); background:color-mix(in srgb, var(--go) 16%, var(--bg-1)); color:var(--go); display:grid; place-items:center; transition:transform .1s, background .2s; -webkit-tap-highlight-color:transparent; }
.au-lib:active{ transform:scale(.92); }
.au-lib:hover{ background:color-mix(in srgb, var(--go) 26%, var(--bg-1)); }
/* painel deslizante: cola no rodapé, largura total no celular, centrado no desktop */
.au-libsheet-wrap{ position:fixed; inset:0; z-index:320; background:rgba(0,0,0,.5); display:flex; align-items:flex-end; justify-content:center; }
.au-libsheet{ width:100%; max-width:620px; max-height:88vh; display:flex; flex-direction:column; background:var(--bg-1); border:1px solid var(--line); border-bottom:none; border-radius:20px 20px 0 0; padding:8px 14px calc(14px + var(--safe-b)); animation:auB .2s ease both; box-shadow:0 -10px 40px rgba(0,0,0,.35); }
.au-libgrab{ width:40px; height:4px; border-radius:99px; background:var(--line); margin:2px auto 8px; flex:none; }
.au-libtop{ display:flex; align-items:center; justify-content:space-between; gap:10px; flex:none; margin-bottom:8px; }
.au-libtabs{ display:flex; gap:4px; background:var(--bg-0); border:1px solid var(--line); border-radius:12px; padding:3px; }
.au-libtab{ appearance:none; border:none; background:none; color:var(--dim); font-size:14px; font-weight:800; padding:9px 18px; border-radius:9px; cursor:pointer; min-height:40px; -webkit-tap-highlight-color:transparent; }
.au-libtab.on{ background:var(--go); color:#062015; }
.au-libx{ width:40px; height:40px; flex:none; border-radius:50%; border:1px solid var(--line); background:var(--bg-0); color:var(--dim); display:grid; place-items:center; cursor:pointer; }
.au-libbody{ flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch; display:flex; flex-direction:column; gap:12px; padding:2px 0 4px; }
.au-libhint{ font-size:12.5px; color:var(--dim); line-height:1.45; }
.au-libvazio{ padding:26px 8px; text-align:center; color:var(--dim); font-size:13.5px; line-height:1.5; }
.au-libgrupo{ display:flex; flex-direction:column; gap:7px; }
.au-libcat{ font-size:11px; font-weight:800; letter-spacing:.04em; text-transform:uppercase; color:var(--dim); padding:0 2px; }
.au-libitem{ display:flex; align-items:flex-start; gap:10px; text-align:left; width:100%; border:1px solid var(--line); background:var(--bg-0); border-radius:13px; padding:12px 13px; cursor:pointer; color:var(--ink); min-height:52px; -webkit-tap-highlight-color:transparent; transition:border-color .15s, background .15s; }
.au-libitem:active{ transform:scale(.99); background:color-mix(in srgb, var(--go) 8%, var(--bg-0)); }
.au-libtag{ flex:none; margin-top:1px; font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.03em; color:var(--go); border:1px solid color-mix(in srgb, var(--go) 45%, transparent); border-radius:6px; padding:2px 6px; }
.au-libtxt{ display:flex; flex-direction:column; gap:2px; min-width:0; }
.au-libnome{ font-size:14.5px; font-weight:700; color:var(--ink); }
.au-libsub{ font-size:12px; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
/* preview da mídia antes de enviar */
.au-libprev{ max-height:92vh; }
.au-libprevtit{ font-size:15px; font-weight:800; color:var(--ink); }
.au-libprevbody{ flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch; display:flex; flex-direction:column; align-items:center; gap:12px; padding:8px 0; }
.au-libprevmedia{ max-width:100%; max-height:58vh; border-radius:14px; object-fit:contain; background:var(--bg-0); }
.au-libprevaudio{ width:100%; margin:24px 0; }
.au-libprevnome{ font-size:14px; font-weight:700; color:var(--ink); text-align:center; }
.au-libprevacts{ flex:none; display:flex; gap:10px; justify-content:flex-end; padding-top:12px; }
.au-libprevgo{ display:inline-flex; align-items:center; justify-content:center; border:none; border-radius:12px; padding:12px 24px; background:var(--go); color:#062015; font-weight:800; font-size:15px; cursor:pointer; min-height:48px; -webkit-tap-highlight-color:transparent; }
.au-libprevgo:disabled{ opacity:.6; cursor:default; }
.au-pgo:disabled{ opacity:.55; cursor:default; }
.au-spin{ width:16px; height:16px; border-radius:50%; flex:none; border:2px solid color-mix(in srgb, var(--dim) 45%, transparent); border-top-color:var(--go); animation:auSpin .7s linear infinite; }
.au-spin.lg{ width:20px; height:20px; border-color:rgba(6,32,21,.35); border-top-color:#062015; }
@keyframes auSpin{ to{ transform:rotate(360deg); } }
.au-more{ display:flex; align-items:center; justify-content:center; gap:8px; padding:14px; color:var(--dim-2); font-size:12.5px; }


/* ── conversa ── */
.au-conv{ position:fixed; inset:0; z-index:200; display:flex; flex-direction:column; background:var(--bg-0); }
.au-chead{ flex:none; display:flex; align-items:center; gap:8px; padding:calc(var(--safe-t) + 8px) 10px 10px 2px; background:var(--bg-1); border-bottom:1px solid var(--line); }
.au-back{ background:none; border:none; color:var(--ink); cursor:pointer; padding:6px; display:grid; place-items:center; }
.au-callbtn{ margin-left:auto; flex:none; width:38px; height:38px; border-radius:50%; border:none; background:var(--go); color:#fff; display:grid; place-items:center; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.au-callbtn:active{ filter:brightness(.9); }
.au-callbtn:disabled{ opacity:.6; cursor:default; }
/* "próximo sem áudio" na conversa: mesmo tamanho do 📞, mas neutro — a ação
   verde continua sendo ligar; este é o avanço da esteira de áudios. */
.au-nextbtn{ flex:none; width:38px; height:38px; border-radius:50%; border:1px solid var(--line); background:var(--card-2); color:var(--ink); display:grid; place-items:center; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.au-nextbtn:active{ filter:brightness(1.25); }
.au-ct{ min-width:0; }
.au-cnm{ font-size:16px; font-weight:700; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.au-cst{ font-size:12px; color:var(--dim); }
/* chamada embutida (2026-08-19): o discador num frame, por cima de tudo */
.au-call{ position:fixed; inset:0; z-index:320; background:var(--bg-0); display:flex; flex-direction:column; }
.au-call-top{ flex:none; display:flex; align-items:center; gap:10px; padding:calc(var(--safe-t) + 8px) 12px 8px; background:var(--bg-1); border-bottom:1px solid var(--line); }
.au-call-tit{ flex:1; min-width:0; font-size:12.5px; color:var(--dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.au-call-x{ flex:none; width:34px; height:34px; border:none; border-radius:50%; background:var(--card-2); color:var(--ink); display:grid; place-items:center; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.au-call-x:active{ filter:brightness(1.2); }
.au-call-frame{ flex:1; width:100%; border:0; background:#0b141a; }
/* nome tocável → ficha (2026-08-19) */
.au-ct-btn{ flex:1; cursor:pointer; border-radius:10px; padding:3px 8px; margin:-3px 0 -3px -4px; -webkit-tap-highlight-color:transparent; }
.au-ct-btn:active{ background:var(--card-2); }
.au-ficha{ position:fixed; inset:0; z-index:240; background:var(--bg-0); display:flex; flex-direction:column; }
.au-fbody{ flex:1; overflow-y:auto; padding:4px 14px calc(24px + var(--safe-b)); }
.au-fbody .view{ min-height:0; }
/* card recolhível do dossiê (2026-08-19) — fixo entre chead e thread, não rola */
.au-dossie{ flex:none; border-bottom:1px solid var(--line); background:var(--bg-1); }
.au-dossie-strip{ width:100%; box-sizing:border-box; display:flex; align-items:center; justify-content:space-between; gap:8px; background:none; border:none; padding:10px 14px; color:var(--ink); font-size:12.5px; font-weight:700; text-align:left; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.au-dossie-strip:disabled{ opacity:.6; cursor:default; }
.au-dossie-chev{ font-size:11.5px; font-weight:700; color:var(--dim); flex:none; }
.au-dossie-body{ padding:2px 14px 12px; max-height:40vh; overflow-y:auto; }
.au-thread{ flex:1; overflow-y:auto; padding:16px 12px; display:flex; flex-direction:column; gap:8px; }
.au-day{ align-self:center; background:var(--card-2); color:var(--dim); font-size:11px; padding:5px 12px; border-radius:8px; margin-bottom:4px; }
.au-hintbig{ align-self:center; color:var(--dim); font-size:13.5px; text-align:center; margin:auto 24px; line-height:1.7; }
/* dica "segure para gravar": destaque âmbar no hint do fast + pill flutuante na
   conversa. Some sozinho; pulsa uma vez pra chamar atenção sem irritar. */
.au-fast-hint.dica{ color:#f5a623; font-weight:700; }
.au-dica-segurar{ position:absolute; left:12px; right:12px; bottom:calc(100% + 8px); background:color-mix(in srgb, #f5a623 18%, var(--card-2)); color:#f5a623; border:1px solid color-mix(in srgb, #f5a623 40%, transparent); border-radius:12px; padding:9px 13px; font-size:13px; font-weight:600; text-align:center; box-shadow:0 6px 18px rgba(0,0,0,.28); animation:audica .22s ease-out; }
@keyframes audica{ from{ transform:translateY(6px); opacity:0; } to{ transform:translateY(0); opacity:1; } }
@media (prefers-reduced-motion:reduce){ .au-dica-segurar{ animation:none; } }
.au-bubble{ align-self:flex-end; max-width:80%; background:color-mix(in srgb, var(--go) 24%, var(--bg-1)); border-radius:12px 12px 4px 12px; padding:8px 10px 6px; animation:auB .2s ease both; }
.au-bubble.in{ align-self:flex-start; background:var(--card-2); border-radius:12px 12px 12px 4px; }
.au-btxt{ font-size:14px; color:var(--ink); line-height:1.45; word-break:break-word; white-space:pre-wrap; }
.au-trans{ margin-top:6px; padding-top:5px; border-top:1px solid color-mix(in srgb, var(--ink) 12%, transparent); font-size:12px; font-style:italic; color:var(--dim); line-height:1.5; }
@keyframes auB{ from{ opacity:0; transform:translateY(6px); } to{ opacity:1; transform:none; } }
.au-voice{ display:flex; align-items:center; gap:9px; min-width:196px; }
.au-vplay{ width:34px; height:34px; border-radius:50%; flex:none; display:grid; place-items:center; background:rgba(255,255,255,.14); color:var(--ink); border:none; cursor:pointer; padding:0; -webkit-tap-highlight-color:transparent; }
.au-vplay:active{ transform:scale(.92); }
.au-vplay.off{ opacity:.55; cursor:default; }
.au-vwave{ flex:1; display:flex; align-items:center; gap:2.5px; height:24px; }
.au-vwave i{ width:3px; border-radius:3px; background:var(--ink); opacity:.7; display:block; }
.au-vwave.play i{ animation:auEq .9s ease-in-out infinite; }
.au-vdur{ font-size:11px; color:var(--dim); flex:none; }
.au-meta{ display:flex; align-items:center; gap:4px; justify-content:flex-end; margin-top:3px; font-size:10.5px; color:var(--dim); }
.au-mck{ color:var(--go); }
.au-mwait{ color:var(--dim); opacity:.85; }
.au-sysmsg{ align-self:center; background:var(--card-2); color:var(--dim); font-size:12.5px; padding:7px 14px; border-radius:10px; text-align:center; max-width:86%; }
.au-sysmsg.semwa{ color:var(--alert); }

/* compose (conversa) */
.au-compose{ position:relative; flex:none; display:flex; align-items:center; gap:9px; padding:10px 10px calc(10px + var(--safe-b)); background:var(--bg-1); border-top:1px solid var(--line); }
.au-view .au-compose{ position:fixed; left:50%; transform:translateX(-50%); bottom:calc(var(--tabbar-h) + var(--tabbar-gap) * 2 + var(--safe-b) + 10px); width:min(620px, calc(100% - var(--pad-x) * 2)); background:transparent; border:none; padding:0; z-index:30; }
.au-field{ flex:1; min-height:50px; background:var(--bg-2); border:1px solid var(--line); border-radius:26px; display:flex; align-items:center; gap:10px; padding:0 10px 0 16px; overflow:hidden; color:var(--dim); font-size:14px; box-shadow:0 4px 14px rgba(0,0,0,.25); }
.au-field .au-hint{ flex:1; }
.au-txtin{ flex:1; min-width:0; height:100%; background:none; border:none; outline:none; color:var(--ink); font-size:14.5px; }
.au-txtin::placeholder{ color:var(--dim); }
.au-field.rec{ color:var(--ink); }
.au-recdot{ width:11px; height:11px; border-radius:50%; background:var(--alert); flex:none; animation:auBlink 1s steps(2,start) infinite; }
@keyframes auBlink{ 50%{ opacity:.25; } }
.au-rectime{ font-weight:700; color:var(--ink); font-variant-numeric:tabular-nums; }
.au-slide{ margin-left:auto; color:var(--dim-2); font-size:12.5px; padding-right:6px; }
.au-field.ready{ color:var(--ink); }
.au-play{ width:32px; height:32px; border-radius:50%; flex:none; border:none; cursor:pointer; display:grid; place-items:center; background:color-mix(in srgb, var(--go) 18%, transparent); color:var(--go); }
.au-wave{ flex:1; display:flex; align-items:center; gap:3px; height:26px; overflow:hidden; }
.au-wave i{ width:3px; border-radius:3px; background:var(--go); opacity:.6; display:block; }
.au-wave.play i{ animation:auEq .9s ease-in-out infinite; }
@keyframes auEq{ 50%{ transform:scaleY(.4); } }
.au-dur{ font-size:12.5px; color:var(--dim); font-variant-numeric:tabular-nums; flex:none; }
.au-trashmini{ flex:none; background:none; border:none; color:var(--dim-2); padding:0 2px; cursor:pointer; display:grid; place-items:center; }
.au-mic{ width:54px; height:54px; border-radius:50%; flex:none; border:none; cursor:pointer; background:var(--go); color:#062015; display:grid; place-items:center; box-shadow:0 4px 14px color-mix(in srgb, var(--go) 45%, transparent); transition:transform .1s, background .2s; touch-action:none; user-select:none; }
.au-mic:active{ transform:scale(.94); }
.au-mic.recording{ background:var(--alert); color:#fff; transform:scale(1.14); box-shadow:0 0 0 8px color-mix(in srgb, var(--alert) 16%, transparent); }
.au-mic.send{ background:var(--go-strong, var(--go)); }
.au-mic:disabled{ opacity:.7; }
/* ── ⚡ MODO FAST ─────────────────────────────────────────────────────── */
.au-fastfab{ position:fixed; right:14px; bottom:calc(var(--safe-b, 0px) + 86px); z-index:210; display:inline-flex; align-items:center; gap:7px; border:none; border-radius:999px; padding:12px 18px; background:linear-gradient(135deg,#f5a623,#f7c948); color:#1a1408; font-size:14px; font-weight:900; letter-spacing:.01em; box-shadow:0 6px 18px rgba(245,166,35,.35); cursor:pointer; -webkit-tap-highlight-color:transparent; }
.au-fastfab:active{ transform:scale(.97); }
.au-fastfab-n{ background:#1a1408; color:#f7c948; border-radius:999px; padding:1px 8px; font-size:12px; }

.au-fast{ position:fixed; inset:0; z-index:300; background:var(--bg-0); display:flex; flex-direction:column; padding:calc(var(--safe-t, 0px) + 10px) 14px calc(var(--safe-b, 0px) + 12px); gap:10px; }
.au-fast-top{ flex:none; display:flex; align-items:center; gap:10px; }
.au-fast-score{ font-size:20px; font-weight:900; color:#f7c948; font-variant-numeric:tabular-nums; }
.au-fast-relogio{ flex:1; text-align:center; font-size:14px; color:var(--dim); font-variant-numeric:tabular-nums; }
.au-fast-resta{ font-size:12px; color:var(--dim-2); }
.au-fast-lead{ flex:none; }
.au-fast-nome{ font-size:21px; font-weight:900; color:var(--ink); line-height:1.15; text-wrap:balance; }
.au-fast-tel{ font-size:13px; color:var(--dim); margin-top:2px; }
.au-fast-dossie{ flex:1; min-height:0; overflow-y:auto; background:var(--card-2); border:1px solid var(--line); border-radius:14px; padding:12px; }
.au-fast-dossie-vazio{ color:var(--dim-2); font-size:13.5px; text-align:center; padding:26px 8px; }
.au-fast-aviso{ flex:none; background:color-mix(in srgb, #f5a623 16%, transparent); color:#f5a623; border-radius:10px; padding:8px 12px; font-size:13px; text-align:center; }
.au-fast-acao{ flex:none; display:flex; flex-direction:column; align-items:center; gap:10px; padding-top:2px; }
.au-fast-mic{ width:84px; height:84px; border-radius:50%; border:none; background:var(--go); color:#fff; display:grid; place-items:center; cursor:pointer; -webkit-tap-highlight-color:transparent; touch-action:none; box-shadow:0 8px 22px rgba(0,168,132,.35); }
.au-fast-mic.gravando{ background:#e53935; animation:aufastpulso 1s infinite; }
@keyframes aufastpulso{ 0%,100%{ transform:scale(1); } 50%{ transform:scale(1.08); } }
.au-fast-hint{ font-size:12.5px; color:var(--dim); text-align:center; max-width:300px; }
.au-fast-preview{ display:flex; align-items:center; gap:12px; background:var(--card-2); border:1px solid var(--line); border-radius:999px; padding:8px 14px; }
.au-fast-play{ width:42px; height:42px; border-radius:50%; border:none; background:var(--accent, #4a90e2); color:#fff; display:grid; place-items:center; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.au-fast-dur{ font-size:14px; color:var(--ink); font-variant-numeric:tabular-nums; }
.au-fast-regravar{ display:inline-flex; align-items:center; gap:5px; border:none; background:none; color:var(--dim); font-size:12.5px; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.au-fast-send{ width:100%; max-width:340px; border:none; border-radius:14px; padding:15px; background:var(--go); color:#fff; font-size:16px; font-weight:900; display:inline-flex; align-items:center; justify-content:center; gap:8px; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.au-fast-send:disabled{ opacity:.65; }
.au-fast-pular{ display:inline-flex; align-items:center; justify-content:center; gap:7px; width:100%; max-width:340px; border:1px solid var(--line); border-radius:12px; padding:11px; background:var(--card-2); color:var(--ink); font-size:14px; font-weight:700; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.au-fast-pular:active{ filter:brightness(1.2); }
.au-fast-end{ border:none; background:none; color:var(--dim-2); font-size:13px; padding:8px 14px; cursor:pointer; text-decoration:underline; text-underline-offset:3px; -webkit-tap-highlight-color:transparent; }

/* tela final — celebração estilo Duolingo: emoji grande, frase, 3 tiles, CTA */
.au-fast-fim{ flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; text-align:center; padding:18px; }
.au-fast-emoji{ font-size:64px; line-height:1; }
.au-fast-tit{ font-size:26px; font-weight:900; color:var(--ink); }
.au-fast-sub{ font-size:14.5px; color:var(--dim); max-width:300px; }
.au-fast-tiles{ display:flex; gap:10px; margin-top:10px; width:100%; max-width:360px; }
.au-fast-tile{ flex:1; border-radius:14px; padding:2px; display:flex; flex-direction:column; overflow:hidden; }
.au-fast-tile.am{ background:#f7c948; }
.au-fast-tile.vd{ background:#58cc02; }
.au-fast-tile.az{ background:#1cb0f6; }
.au-fast-tile-rot{ font-size:10.5px; font-weight:900; letter-spacing:.05em; text-transform:uppercase; color:#14110a; padding:5px 4px 4px; }
.au-fast-tile-val{ background:var(--card-2); color:var(--ink); border-radius:0 0 12px 12px; font-size:22px; font-weight:900; padding:10px 4px; font-variant-numeric:tabular-nums; }
.au-fast-claim{ margin-top:14px; width:100%; max-width:340px; border:none; border-radius:14px; padding:15px; background:var(--accent, #4a90e2); color:#fff; font-size:15.5px; font-weight:900; cursor:pointer; -webkit-tap-highlight-color:transparent; }
@media (prefers-reduced-motion:reduce){ .au-spin,.au-recdot,.au-wave i,.au-mic,.au-bubble,.au-fast-mic{ animation:none!important; transition:none!important; } }
`;
