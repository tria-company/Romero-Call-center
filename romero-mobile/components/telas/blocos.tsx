"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { fmtInt } from "@/lib/format";

/* Blocos compartilhados pelas telas. Cada um é a tradução direta de um pedaço
   do mockup — mesmas classes, mesma marcação. */

/** Cabeçalho `.vhead`: título, subtítulo e indicador ao vivo. */
export function Vhead({
  titulo,
  sub,
  live,
}: {
  titulo: React.ReactNode;
  sub?: React.ReactNode;
  live?: React.ReactNode;
}) {
  return (
    <div className="vhead">
      <div style={{ minWidth: 0 }}>
        <h1>{titulo}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {live && (
        <div className="live">
          <span className="pulse" />
          {live}
        </div>
      )}
    </div>
  );
}

export function Voltar({ href, children = "Voltar" }: { href: string; children?: React.ReactNode }) {
  return (
    <Link href={href} className="back">
      <ChevronLeft size={14} />
      {children}
    </Link>
  );
}

/** Cartão de métrica `.m`. Vira link quando recebe `href`. */
export function Metrica({
  valor,
  label,
  delta,
  alerta,
  href,
  full,
}: {
  valor: React.ReactNode;
  label: string;
  delta?: React.ReactNode;
  alerta?: boolean;
  href?: string;
  full?: boolean;
}) {
  const conteudo = (
    <>
      <div className="mv">{valor}</div>
      <div className="ml">{label}</div>
      {delta != null && <div className={alerta ? "md warn" : "md"}>{delta}</div>}
    </>
  );
  const cls = full ? "m full" : "m";
  return href ? (
    <Link href={href} className={cls}>
      {conteudo}
    </Link>
  ) : (
    <div className={cls}>{conteudo}</div>
  );
}

/** Bloco de lista `.lblk` com cabeçalho `.lttl`. */
export function BlocoLista({
  titulo,
  contador,
  children,
  style,
}: {
  titulo: React.ReactNode;
  contador?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div className="lblk" style={style}>
      <div className="lttl">
        <span>{titulo}</span>
        {contador != null && <span>{contador}</span>}
      </div>
      {children}
    </div>
  );
}

/** Aviso `.autobox` — o quadro que explica o que o sistema faz sozinho. */
export function Autobox({
  titulo,
  children,
  tom = "go",
}: {
  titulo: React.ReactNode;
  children: React.ReactNode;
  tom?: "go" | "info" | "warn";
}) {
  return (
    <div className={tom === "go" ? "autobox" : `autobox ${tom}`}>
      <div className="at">{titulo}</div>
      <div className="ab">{children}</div>
    </div>
  );
}

/** Número que conta até o valor, com ease-out. Respeita reduced-motion. */
export function Contador({
  valor,
  duracao = 900,
  formato = fmtInt,
}: {
  valor: number;
  duracao?: number;
  formato?: (n: number) => string;
}) {
  const [mostrado, setMostrado] = React.useState(valor);
  const deRef = React.useRef(valor);
  const primeiraRef = React.useRef(true);

  React.useEffect(() => {
    const reduzido =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Na primeira montagem sobe de zero; depois anima do valor anterior.
    const de = primeiraRef.current ? 0 : deRef.current;
    primeiraRef.current = false;

    if (reduzido || de === valor) {
      deRef.current = valor;
      setMostrado(valor);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const passo = (agora: number) => {
      const t = Math.min(1, (agora - t0) / duracao);
      const e = 1 - Math.pow(1 - t, 3);
      setMostrado(de + (valor - de) * e);
      if (t < 1) raf = requestAnimationFrame(passo);
      else deRef.current = valor;
    };
    raf = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(raf);
  }, [valor, duracao]);

  return <>{formato(mostrado)}</>;
}

/** Esqueleto enquanto a base hidrata (localStorage é client-only). */
export function Esqueleto({ alturas }: { alturas: number[] }) {
  return (
    <div className="view" aria-busy="true">
      <Skels alturas={alturas} />
    </div>
  );
}

/**
 * As barras do esqueleto SEM a casca `.view`. Serve para a tela que precisa
 * esperar a base só num PEDAÇO — o Início desenha isto no lugar dos cartões
 * locais e, logo abaixo, a seção de campanha, que vem pronta do servidor e não
 * tem por que piscar junto.
 */
export function Skels({ alturas }: { alturas: number[] }) {
  return (
    <>
      {alturas.map((h, i) => (
        <div key={i} className="skel" style={{ height: h, borderRadius: 16 }} />
      ))}
    </>
  );
}
