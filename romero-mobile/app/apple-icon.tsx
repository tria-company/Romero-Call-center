import { ImageResponse } from "next/og";
import { Patinha } from "@/components/brand/marcaOg";

/** Ícone da tela de início do iOS (sem cantos arredondados — o iOS aplica). */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 180,
          height: 180,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #3d8bff 0%, #1b4fa0 100%)",
        }}
      >
        <Patinha size={112} cor="#04122a" />
      </div>
    ),
    size,
  );
}
