import type { Metadata } from "next";
import { Fila } from "@/components/telas/Fila";

export const metadata: Metadata = { title: "Fila de hoje" };

export default function Page() {
  return <Fila />;
}
