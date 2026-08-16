"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DESTINOS, rotaAtiva } from "./navegacao";
import { Marca } from "@/components/brand/Marca";

/**
 * Navegação principal.
 *
 * Celular  → barra FLUTUANTE no rodapé, com pílula que DESLIZA para a aba ativa.
 * ≥900px   → o mesmo componente vira um rail lateral (só CSS muda de lugar).
 *
 * A pílula é medida do botão ativo (offsetLeft/Width) e reposicionada por
 * transform — assim ela viaja em vez de piscar de um item para o outro.
 *
 * A barra reage à direção da rolagem: descendo ela recolhe (perde os rótulos,
 * encurta e estreita) para devolver tela ao conteúdo; subindo — ou perto do
 * topo — volta inteira. Direção, não posição: quem rola para cima está
 * procurando para onde ir, e é aí que a navegação precisa estar cheia.
 */

/** Recolhe/expande conforme a direção da rolagem. `false` fixo no rail. */
function useBarraRecolhida(ativo: boolean): boolean {
  const [recolhida, setRecolhida] = React.useState(false);

  React.useEffect(() => {
    if (!ativo) {
      setRecolhida(false);
      return;
    }
    let ultimo = window.scrollY;
    let agendado = false;

    const aoRolar = () => {
      if (agendado) return;
      agendado = true;
      // Uma leitura por quadro: `scroll` dispara muito mais que isso, e ler
      // scrollY a cada evento força layout à toa.
      requestAnimationFrame(() => {
        agendado = false;
        const y = window.scrollY;
        const delta = y - ultimo;
        // Limiar contra a inércia do toque: sem ele um tremor de 1px no fim
        // do movimento fica alternando os dois estados.
        if (Math.abs(delta) < 8) return;
        ultimo = y;
        setRecolhida(y > 32 && delta > 0);
      });
    };

    window.addEventListener("scroll", aoRolar, { passive: true });
    return () => window.removeEventListener("scroll", aoRolar);
  }, [ativo]);

  return recolhida;
}

export function TabBar() {
  const pathname = usePathname();
  // Sem selo de contagem na aba Fila: a única fonte ao vivo é o backend do
  // discador (useFilaReal), que não vale um fetch aqui no chrome. A contagem
  // aparece dentro da própria tela de Fila.
  const trilhoRef = React.useRef<HTMLDivElement>(null);
  const [pill, setPill] = React.useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [rail, setRail] = React.useState(false);
  const recolhida = useBarraRecolhida(!rail);

  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 900px)");
    const aplicar = () => setRail(mq.matches);
    aplicar();
    mq.addEventListener("change", aplicar);
    return () => mq.removeEventListener("change", aplicar);
  }, []);

  const medir = React.useCallback(() => {
    const trilho = trilhoRef.current;
    const ativo = trilho?.querySelector<HTMLElement>('[data-ativo="true"]');
    if (!trilho || !ativo) return;
    setPill({
      x: ativo.offsetLeft,
      y: ativo.offsetTop,
      w: ativo.offsetWidth,
      h: ativo.offsetHeight,
    });
  }, []);

  // Medir só interessa ao rail — é o único que ainda desenha o realce.
  React.useLayoutEffect(() => {
    if (rail) medir();
  }, [pathname, rail, medir]);

  React.useEffect(() => {
    const trilho = trilhoRef.current;
    if (!rail || !trilho) return;
    const ro = new ResizeObserver(medir);
    ro.observe(trilho);
    return () => ro.disconnect();
  }, [rail, medir]);

  const tocar = () => {
    // vibração curtíssima: confirma o toque sem virar novidade irritante
    try {
      navigator.vibrate?.(8);
    } catch {}
  };

  return (
    <nav
      aria-label="Navegação principal"
      className="ds-chrome"
      style={
        rail
          ? {
              position: "fixed",
              top: 0,
              bottom: 0,
              left: 0,
              width: "var(--rail-w)",
              zIndex: 90,
              borderRight: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              padding: "18px 12px",
              gap: 18,
            }
          : {
              // Ilha flutuante: descolada das três bordas, arredondada e com
              // sombra própria — a lista passa POR BAIXO dela, e é isso que
              // dá a sensação de camada em vez de rodapé colado.
              position: "fixed",
              left: recolhida ? 46 : "var(--tabbar-gap)",
              right: recolhida ? 46 : "var(--tabbar-gap)",
              bottom: "calc(var(--tabbar-gap) + var(--safe-b))",
              zIndex: 90,
              height: recolhida ? "var(--tabbar-h-min)" : "var(--tabbar-h)",
              borderRadius: "var(--radius-xl)",
              border: "1px solid var(--border)",
              boxShadow: "var(--shadow-lg)",
              transition:
                "height 260ms var(--ease-out), left 340ms var(--ease-out-soft), right 340ms var(--ease-out-soft)",
            }
      }
    >
      {rail && (
        <div style={{ padding: "4px 8px 2px" }}>
          <Marca size={34} subtitle="Gabinete" />
        </div>
      )}

      <div
        ref={trilhoRef}
        style={{
          position: "relative",
          display: "flex",
          flexDirection: rail ? "column" : "row",
          alignItems: "stretch",
          gap: rail ? 4 : 0,
          // 100%: a altura agora vem da barra, que muda ao recolher.
          height: rail ? undefined : "100%",
        }}
      >
        {/* Realce deslizante — só no rail. Na barra flutuante a seleção é a
            COR do ícone e nada mais: ali o realce virava uma moldura dentro de
            outra (a ilha já é uma caixa arredondada), e duas bordas encaixadas
            competem em vez de indicar. */}
        {rail && pill && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: pill.w,
              height: pill.h,
              transform: `translate3d(${pill.x}px, ${pill.y}px, 0)`,
              borderRadius: "var(--radius-pill)",
              background: "var(--accentSoft)",
              border: "1px solid color-mix(in srgb, var(--accent1) 30%, transparent)",
              transition:
                "transform 360ms var(--ease-out-soft), width 360ms var(--ease-out-soft), height 240ms var(--ease-out)",
              pointerEvents: "none",
            }}
          />
        )}

        {DESTINOS.map((d) => {
          const ativo = rotaAtiva(pathname, d);
          const Icone = d.icon;
          return (
            <Link
              key={d.href}
              href={d.href}
              data-ativo={ativo}
              aria-current={ativo ? "page" : undefined}
              onClick={tocar}
              style={{
                position: "relative",
                zIndex: 1,
                flex: rail ? undefined : 1,
                display: "flex",
                flexDirection: rail ? "row" : "column",
                alignItems: "center",
                justifyContent: rail ? "flex-start" : "center",
                gap: rail ? 11 : recolhida ? 0 : 3,
                padding: rail ? "10px 14px" : "8px 2px",
                minWidth: 0,
                borderRadius: "var(--radius-pill)",
                color: ativo ? "var(--accentText)" : "var(--muted)",
                fontSize: rail ? 14 : 10.5,
                fontWeight: ativo ? 600 : 500,
                letterSpacing: rail ? "-.014em" : "-.005em",
                transition: "color var(--dur-fast) linear",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <span
                style={{
                  position: "relative",
                  display: "inline-flex",
                  transform: ativo && !rail ? "translateY(-1px) scale(1.06)" : "none",
                  transition: "transform 320ms var(--ease-bounce)",
                }}
              >
                <Icone size={rail ? 17 : 19} strokeWidth={ativo ? 2.3 : 1.9} />
              </span>
              {/* Recolhida, o rótulo colapsa em altura em vez de sumir de uma
                  vez: some junto com a barra encurtando, num movimento só. */}
              <span
                className="ds-truncate"
                aria-hidden={!rail && recolhida}
                style={
                  rail
                    ? undefined
                    : {
                        height: recolhida ? 0 : 13,
                        opacity: recolhida ? 0 : 1,
                        transition: "height 240ms var(--ease-out), opacity 160ms linear",
                      }
                }
              >
                {rail ? d.labelLongo : d.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
