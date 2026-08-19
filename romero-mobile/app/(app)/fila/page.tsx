import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Fila } from "@/components/telas/Fila";
import { COOKIE_SESSAO, lerSessao } from "@/lib/sessao";

export const metadata: Metadata = { title: "Ações de hoje" };

// "Ações" = Fila + Áudios na mesma tela (ENVIO-08). A seção de áudios só monta
// pro romero (gate real = backend `exigirRomero`); por isso a sessão é lida
// aqui e o papel/permissão descem por prop.
export default async function Page() {
  const sessao = await lerSessao((await cookies()).get(COOKIE_SESSAO)?.value);
  const papel = sessao?.papel ?? "atendente";
  const podeAudios = sessao?.usuario === "romero";
  return <Fila papel={papel} podeAudios={podeAudios} />;
}
