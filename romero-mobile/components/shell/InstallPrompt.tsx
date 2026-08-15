"use client";

import * as React from "react";
import { Check, Download, X } from "lucide-react";
import { Folha } from "@/components/telas/Folha";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Plataforma = "ios" | "android" | "desktop";

const OCULTAR = "ca.instalar.oculto";

/**
 * Instalação do PWA.
 *
 * O `beforeinstallprompt` só existe no Chrome/Edge e SÓ dispara quando o
 * navegador considera o app instalável — o que exige service worker, e o
 * service worker só é registrado em produção. Em dev, portanto, o evento
 * nunca chega.
 *
 * Antes isso virava um parágrafo cinza dizendo "aparece quando o navegador
 * permitir", e o usuário procurou um botão que não existia. Agora SEMPRE há
 * botão: com o evento em mãos ele abre o diálogo nativo; sem o evento ele
 * abre as instruções da plataforma, que é o caminho real no iPhone de
 * qualquer jeito (o Safari nunca expôs o evento).
 */
function useInstalacao() {
  const [evento, setEvento] = React.useState<BeforeInstallPromptEvent | null>(null);
  const [instalado, setInstalado] = React.useState(false);
  const [plataforma, setPlataforma] = React.useState<Plataforma>("desktop");
  const [pronto, setPronto] = React.useState(false);

  React.useEffect(() => {
    const nav = navigator as Navigator & { standalone?: boolean };
    setInstalado(
      window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true,
    );

    const ua = navigator.userAgent;
    // iPad com iPadOS 13+ se anuncia como Mac — o toque é o que o denuncia
    const ipad = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    setPlataforma(
      /iPad|iPhone|iPod/.test(ua) || ipad ? "ios" : /Android/.test(ua) ? "android" : "desktop",
    );

    const capturar = (e: Event) => {
      e.preventDefault();
      setEvento(e as BeforeInstallPromptEvent);
    };
    const instalou = () => {
      setInstalado(true);
      setEvento(null);
    };
    window.addEventListener("beforeinstallprompt", capturar);
    window.addEventListener("appinstalled", instalou);
    setPronto(true);
    return () => {
      window.removeEventListener("beforeinstallprompt", capturar);
      window.removeEventListener("appinstalled", instalou);
    };
  }, []);

  const instalar = React.useCallback(async () => {
    if (!evento) return false;
    await evento.prompt();
    const { outcome } = await evento.userChoice;
    setEvento(null);
    if (outcome === "accepted") setInstalado(true);
    return outcome === "accepted";
  }, [evento]);

  return { evento, instalado, plataforma, pronto, instalar };
}

/** Passo a passo por plataforma — o conteúdo da folha de ajuda. */
function ComoInstalar({ plataforma }: { plataforma: Plataforma }) {
  const passos: string[] =
    plataforma === "ios"
      ? [
          "Abra este endereço no Safari (Chrome no iPhone não instala)",
          "Toque em Compartilhar, na barra de baixo",
          "Role e escolha “Adicionar à Tela de Início”",
        ]
      : plataforma === "android"
        ? [
            "Abra o menu ⋮ do Chrome, no canto superior direito",
            "Toque em “Instalar aplicativo” ou “Adicionar à tela inicial”",
            "Confirme — o ícone aparece junto dos outros apps",
          ]
        : [
            "No Chrome ou Edge, procure o ícone de instalar na barra de endereço",
            "Ou abra o menu ⋮ → “Instalar Central Animal…”",
            "O app passa a abrir em janela própria, sem abas",
          ];

  return (
    <>
      <p className="dim" style={{ fontSize: "var(--t-cap)", lineHeight: 1.6 }}>
        {plataforma === "ios"
          ? "O Safari não tem botão automático. São três toques:"
          : "Se o botão automático não apareceu, o caminho manual é este:"}
      </p>
      <div className="lblk">
        {passos.map((p, i) => (
          <div key={i} className="lrow">
            <span className="dot" />
            <span className="nm" style={{ whiteSpace: "normal" }}>
              {p}
            </span>
          </div>
        ))}
      </div>
      <p className="dim2" style={{ fontSize: "var(--t-micro)", lineHeight: 1.5 }}>
        Instalado, o app abre em tela cheia, com ícone próprio, e funciona sem internet — os
        dados ficam neste aparelho.
        {process.env.NODE_ENV !== "production" && (
          <>
            {" "}
            <b>
              Você está no servidor de desenvolvimento: a instalação automática só existe no
              build de produção (npm run build && npm start).
            </b>
          </>
        )}
      </p>
    </>
  );
}

/** Bloco da tela de Perfil: sempre com um botão de verdade. */
export function InstallPrompt() {
  const { evento, instalado, plataforma, pronto, instalar } = useInstalacao();
  const [ajuda, setAjuda] = React.useState(false);

  if (!pronto) return null;

  if (instalado) {
    return (
      <div className="inst">
        <span className="ii">
          <Check size={19} strokeWidth={2.6} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="it">App instalado</div>
          <div className="is">Você já está usando a versão instalada neste aparelho.</div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="inst">
        <span className="ii">
          <Download size={19} strokeWidth={2.4} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="it">Instalar o app</div>
          <div className="is">
            {evento
              ? "Ícone na tela de início e funcionamento sem internet."
              : plataforma === "ios"
                ? "No iPhone é pelo Compartilhar do Safari — mostramos como."
                : "Veja o caminho no seu navegador."}
          </div>
        </div>
        <button
          type="button"
          className="ib"
          onClick={() => {
            if (evento) void instalar();
            else setAjuda(true);
          }}
        >
          {evento ? "Instalar" : "Como fazer"}
        </button>
      </div>

      <Folha aberto={ajuda} onFechar={() => setAjuda(false)} titulo="Instalar o app">
        <ComoInstalar plataforma={plataforma} />
      </Folha>
    </>
  );
}

/**
 * Faixa da tela de Início. Aparece uma vez e some quando dispensada — o lugar
 * definitivo do botão continua sendo o Perfil.
 */
export function InstallBanner() {
  const { evento, instalado, plataforma, pronto, instalar } = useInstalacao();
  const [oculto, setOculto] = React.useState(true);
  const [ajuda, setAjuda] = React.useState(false);

  React.useEffect(() => {
    try {
      setOculto(localStorage.getItem(OCULTAR) === "1");
    } catch {
      setOculto(false);
    }
  }, []);

  function dispensar() {
    setOculto(true);
    try {
      localStorage.setItem(OCULTAR, "1");
    } catch {
      /* armazenamento bloqueado: a faixa volta no próximo acesso */
    }
  }

  // Sem convite nativo e fora do iPhone, uma faixa fixa seria só ruído: quem
  // está no desktop não instala app de celular por impulso.
  const vale = evento != null || plataforma === "ios";
  if (!pronto || instalado || oculto || !vale) return null;

  return (
    <>
      <div className="inst" style={{ animation: "reveal-up 320ms var(--ease-out-soft) both" }}>
        <span className="ii">
          <Download size={19} strokeWidth={2.4} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="it">Instale na tela de início</div>
          <div className="is">Abre em tela cheia e funciona sem internet.</div>
        </div>
        <button
          type="button"
          className="ib"
          onClick={async () => {
            if (evento) {
              if (await instalar()) dispensar();
            } else {
              setAjuda(true);
            }
          }}
        >
          {evento ? "Instalar" : "Ver como"}
        </button>
        <button type="button" className="ix" aria-label="Dispensar" onClick={dispensar}>
          <X size={16} />
        </button>
      </div>

      <Folha aberto={ajuda} onFechar={() => setAjuda(false)} titulo="Instalar o app">
        <ComoInstalar plataforma={plataforma} />
      </Folha>
    </>
  );
}
