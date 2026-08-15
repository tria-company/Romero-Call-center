import type { Metadata } from "next";
import { Perfil } from "@/components/telas/Perfil";

export const metadata: Metadata = { title: "Perfil" };

export default function Page() {
  return <Perfil />;
}
