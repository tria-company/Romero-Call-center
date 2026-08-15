import { ImageResponse } from "next/og";
import { Patinha } from "@/components/brand/marcaOg";

/**
 * Ícones do PWA gerados em build, sem nenhum asset binário no repo: a patinha
 * da marca sobre o gradiente ciano→azul. `/icones/192` e `/icones/512` são os
 * caminhos referenciados no manifest. A pasta se chama `icones` (e não `icon`)
 * porque `app/icon.*` é convenção de arquivo do Next e colidiria com a rota.
 *
 * O desenho usa DIVs (e não <svg>) porque o satori — o renderizador por trás
 * do ImageResponse — só suporta um subconjunto de SVG, e transform em
 * elipse não faz parte dele.
 */

export const dynamic = "force-static";

export function generateStaticParams() {
  return [{ size: "192" }, { size: "512" }];
}

export async function GET(_req: Request, ctx: { params: Promise<{ size: string }> }) {
  const { size: bruto } = await ctx.params;
  const size = bruto === "512" ? 512 : 192;

  return new ImageResponse(
    (
      <div
        style={{
          width: size,
          height: size,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #3d8bff 0%, #1b4fa0 100%)",
        }}
      >
        {/* 0.56 e não mais: o mesmo arquivo serve de ícone `maskable`, e o
            recorte circular do Android come as bordas do quadrado */}
        <Patinha size={size * 0.56} cor="#04122a" />
      </div>
    ),
    { width: size, height: size },
  );
}
