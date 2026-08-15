/**
 * Marca do app: uma patinha desenhada à mão (4 dedos + coxim).
 *
 * SVG próprio em vez do ícone do lucide porque a marca aparece de 16px a 160px
 * e precisa aguentar os dois extremos. A geometria tem uma regra: os dedos
 * externos NÃO podem encostar no coxim — quando encostavam, em 30px tudo se
 * fundia num borrão que parecia uma cara de urso.
 */
export function Patinha({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      {/* dedos externos — menores, inclinados e acima da linha do coxim */}
      <ellipse cx="8.8" cy="17.4" rx="4.3" ry="5.4" transform="rotate(-24 8.8 17.4)" />
      <ellipse cx="39.2" cy="17.4" rx="4.3" ry="5.4" transform="rotate(24 39.2 17.4)" />
      {/* dedos internos — maiores e mais altos */}
      <ellipse cx="18.6" cy="10.6" rx="4.6" ry="6" transform="rotate(-8 18.6 10.6)" />
      <ellipse cx="29.4" cy="10.6" rx="4.6" ry="6" transform="rotate(8 29.4 10.6)" />
      {/* coxim */}
      <path d="M24 24.6c7.1 0 12.9 5.3 12.9 11.2 0 4.2-3.4 6.8-7.6 6.8-2 0-3.5-.6-5.3-.6s-3.3.6-5.3.6c-4.2 0-7.6-2.6-7.6-6.8C11.1 29.9 16.9 24.6 24 24.6Z" />
    </svg>
  );
}

/** Bloco de marca: patinha sobre o gradiente + nome. */
export function Marca({
  size = 40,
  showName = true,
  subtitle,
}: {
  size?: number;
  showName?: boolean;
  subtitle?: string;
}) {
  return (
    <div className="row" style={{ gap: 11 }}>
      <span
        style={{
          width: size,
          height: size,
          flex: "none",
          borderRadius: size >= 44 ? "var(--r)" : "var(--r-sm)",
          background: "linear-gradient(150deg,#3d8bff,#1b4fa0)",
          color: "#04122a",
          display: "grid",
          placeItems: "center",
          boxShadow: "0 6px 22px -8px rgba(61,139,255,.45)",
        }}
      >
        <Patinha size={size * 0.62} />
      </span>
      {showName && (
        <span style={{ minWidth: 0 }}>
          <span
            className="trunc"
            style={{
              display: "block",
              fontSize: size * 0.4,
              fontWeight: 600,
              letterSpacing: "-.022em",
              lineHeight: 1.15,
            }}
          >
            Central Animal
          </span>
          {subtitle && (
            <span className="dim2 trunc" style={{ display: "block" }}>
              {subtitle}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
