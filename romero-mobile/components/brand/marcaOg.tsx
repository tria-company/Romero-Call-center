/**
 * Versão da patinha desenhada só com DIVs, para o satori (ImageResponse).
 * O componente da interface (`Marca.tsx`) é SVG de verdade; este existe
 * exclusivamente para gerar os ícones do PWA em build — o satori não suporta
 * `transform` em `<ellipse>`.
 *
 * A geometria acompanha a do SVG: dedos externos acima da linha do coxim.
 */
export function Patinha({ size, cor }: { size: number; cor: string }) {
  const u = size / 48; // mesma grade do SVG original (viewBox 48)

  const dedo = (cx: number, cy: number, rx: number, ry: number, rot: number) => (
    <div
      style={{
        position: "absolute",
        left: (cx - rx) * u,
        top: (cy - ry) * u,
        width: rx * 2 * u,
        height: ry * 2 * u,
        borderRadius: "50%",
        background: cor,
        transform: `rotate(${rot}deg)`,
      }}
    />
  );

  return (
    <div style={{ position: "relative", width: size, height: size, display: "flex" }}>
      {dedo(8.8, 17.4, 4.3, 5.4, -24)}
      {dedo(39.2, 17.4, 4.3, 5.4, 24)}
      {dedo(18.6, 10.6, 4.6, 6, -8)}
      {dedo(29.4, 10.6, 4.6, 6, 8)}
      {/* coxim: topo em meia-circunferência (raio = metade da largura) e base
          um pouco mais reta — é o que aproxima a forma de feijão do SVG */}
      <div
        style={{
          position: "absolute",
          left: 12.2 * u,
          top: 24.6 * u,
          width: 23.6 * u,
          height: 18.2 * u,
          background: cor,
          borderRadius: `${11.8 * u}px ${11.8 * u}px ${10 * u}px ${10 * u}px`,
        }}
      />
    </div>
  );
}
