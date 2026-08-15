import { Suspense } from "react";
import type { Metadata } from "next";
import { PerfilLead } from "@/components/telas/PerfilLead";

export const metadata: Metadata = { title: "Perfil" };

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ de?: string }>;
}) {
  const { id } = await params;
  const { de } = await searchParams;
  return (
    <Suspense fallback={null}>
      <PerfilLead id={id} de={de} />
    </Suspense>
  );
}
