"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * Folha inferior. Faz o que um modal em celular precisa fazer: trava o scroll
 * do fundo, prende o foco, devolve o foco ao fechar, fecha no Escape e
 * **arrasta para baixo para dispensar**.
 *
 * A saída é animada de verdade — `saindo` existe para a folha tocar a
 * animação antes de desmontar, em vez de sumir de um quadro para o outro.
 */

const DUR_IN = 300;
const DUR_OUT = 200;

export function Folha({
  aberto,
  onFechar,
  titulo,
  sub,
  children,
  rodape,
}: {
  aberto: boolean;
  onFechar: () => void;
  titulo?: React.ReactNode;
  sub?: React.ReactNode;
  children: React.ReactNode;
  rodape?: React.ReactNode;
}) {
  const [montado, setMontado] = React.useState(false);
  const [visivel, setVisivel] = React.useState(false);
  const [saindo, setSaindo] = React.useState(false);
  const painelRef = React.useRef<HTMLDivElement>(null);
  const corpoRef = React.useRef<HTMLDivElement>(null);
  const focoAnterior = React.useRef<HTMLElement | null>(null);
  const tituloId = React.useId();

  React.useEffect(() => setMontado(true), []);

  React.useEffect(() => {
    if (aberto) {
      focoAnterior.current = document.activeElement as HTMLElement | null;
      setVisivel(true);
      setSaindo(false);
    } else if (visivel) {
      setSaindo(true);
      const t = setTimeout(() => {
        setVisivel(false);
        setSaindo(false);
        focoAnterior.current?.focus?.();
      }, DUR_OUT);
      return () => clearTimeout(t);
    }
  }, [aberto, visivel]);

  // trava o scroll do fundo enquanto aberta
  React.useEffect(() => {
    if (!visivel) return;
    const anterior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = anterior;
    };
  }, [visivel]);

  // Escape + foco preso
  React.useEffect(() => {
    if (!visivel || saindo) return;
    const painel = painelRef.current;
    const focaveis = () =>
      Array.from(
        painel?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);

    const t = setTimeout(() => {
      // foca o painel, não o primeiro botão: focar o "X" acende um anel
      // enorme sobre o fechar toda vez que a folha abre
      (painel?.querySelector<HTMLElement>("[data-autofocus]") ?? painel)?.focus({
        preventScroll: true,
      });
    }, DUR_IN * 0.6);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onFechar();
        return;
      }
      if (e.key !== "Tab") return;
      const lista = focaveis();
      if (!lista.length) return;
      const [primeiro] = lista;
      const ultimo = lista[lista.length - 1];
      if (e.shiftKey && document.activeElement === primeiro) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault();
        primeiro.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [visivel, saindo, onFechar]);

  /* arrastar para dispensar */
  const arrasto = React.useRef({ ativo: false, y0: 0, t0: 0, dy: 0, id: -1 });
  const podeArrastar = () => (corpoRef.current?.scrollTop ?? 0) <= 0;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" || !podeArrastar()) return;
    arrasto.current = { ativo: true, y0: e.clientY, t0: performance.now(), dy: 0, id: e.pointerId };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const a = arrasto.current;
    if (!a.ativo || e.pointerId !== a.id) return;
    const dy = e.clientY - a.y0;
    a.dy = dy < 0 ? dy / 6 : dy; // resistência ao puxar para cima
    const el = painelRef.current;
    if (!el) return;
    el.style.transition = "none";
    el.style.transform = `translate3d(0, ${a.dy}px, 0)`;
  };
  const finalizar = (e: React.PointerEvent) => {
    const a = arrasto.current;
    if (!a.ativo || e.pointerId !== a.id) return;
    a.ativo = false;
    const el = painelRef.current;
    const velocidade = a.dy / Math.max(1, performance.now() - a.t0);
    if (el) {
      el.style.transition = "";
      el.style.transform = "";
    }
    if (a.dy > 110 || (velocidade > 0.55 && a.dy > 40)) onFechar();
  };

  if (!montado || !visivel) return null;

  return createPortal(
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <div
        onClick={onFechar}
        style={{
          position: "absolute",
          inset: 0,
          background: "var(--overlay)",
          WebkitBackdropFilter: "blur(8px)",
          backdropFilter: "blur(8px)",
          animation: saindo
            ? `fade-in ${DUR_OUT}ms var(--ease-out) reverse forwards`
            : `fade-in ${DUR_IN}ms var(--ease-out) both`,
        }}
      />

      <div
        ref={painelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titulo ? tituloId : undefined}
        tabIndex={-1}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 560,
          maxHeight: "88dvh",
          display: "flex",
          flexDirection: "column",
          background: "linear-gradient(178deg, #0d2b52 0%, #0a2141 100%)",
          borderTop: "1px solid var(--line-2)",
          borderRadius: "var(--r-xl) var(--r-xl) 0 0",
          boxShadow: "var(--shadow-lg)",
          overflow: "hidden",
          outline: "none",
          touchAction: "pan-y",
          animation: saindo
            ? `sheet-down ${DUR_OUT}ms var(--ease) forwards`
            : `sheet-up ${DUR_IN}ms var(--ease-spring)`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finalizar}
        onPointerCancel={finalizar}
      >
        <div style={{ padding: "10px 0 2px", display: "grid", placeItems: "center", flex: "none" }}>
          <span style={{ width: 38, height: 4, borderRadius: 999, background: "var(--line-2)" }} />
        </div>

        {titulo != null && (
          <div className="row" style={{ padding: "6px 16px 12px", alignItems: "flex-start" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <h2 id={tituloId} style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-.02em" }}>
                {titulo}
              </h2>
              {sub && (
                <div className="dim2 trunc" style={{ fontSize: 11.5, marginTop: 2 }}>
                  {sub}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onFechar}
              aria-label="Fechar"
              style={{
                flex: "none",
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: "rgba(255,255,255,.08)",
                display: "grid",
                placeItems: "center",
                color: "var(--dim)",
              }}
            >
              <X size={15} />
            </button>
          </div>
        )}

        <div
          ref={corpoRef}
          className="stack"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            overscrollBehavior: "contain",
            padding: "0 16px 16px",
            // A folha vive num portal, fora do `.view`: sem declarar o próprio
            // container, os tamanhos em `cqi` cairiam para a janela e o texto
            // aqui dentro não acompanharia o resto do app.
            containerType: "inline-size",
          }}
        >
          {children}
        </div>

        {rodape && (
          <div
            style={{
              flex: "none",
              padding: "12px 16px calc(12px + var(--safe-b))",
              borderTop: "1px solid var(--line)",
            }}
          >
            {rodape}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
