import type { Metadata } from "next";
import { NovaSolicitacao } from "@/components/telas/NovaSolicitacao";

export const metadata: Metadata = { title: "Nova solicitação" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <NovaSolicitacao id={id} />;
}
