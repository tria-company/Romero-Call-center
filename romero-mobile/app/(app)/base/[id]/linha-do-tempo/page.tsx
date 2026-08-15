import type { Metadata } from "next";
import { LinhaDoTempo } from "@/components/telas/LinhaDoTempo";

export const metadata: Metadata = { title: "Linha do tempo" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LinhaDoTempo id={id} />;
}
