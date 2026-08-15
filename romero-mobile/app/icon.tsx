import { ImageResponse } from "next/og";
import { Patinha } from "@/components/brand/marcaOg";

/** Favicon da aba. Os ícones do PWA (192/512) vivem em app/icones/[size]. */
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 32,
          height: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #3d8bff 0%, #1b4fa0 100%)",
          borderRadius: 7,
        }}
      >
        <Patinha size={21} cor="#04122a" />
      </div>
    ),
    size,
  );
}
