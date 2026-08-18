import type { Metadata } from "next";
import { Audios } from "@/components/telas/Audios";

export const metadata: Metadata = { title: "Áudios" };

export default function Page() {
  return <Audios />;
}
