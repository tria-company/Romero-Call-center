import type { Metadata } from "next";
import { Inicio } from "@/components/telas/Inicio";
import { SecaoCampanha } from "@/components/telas/Campanha";

export const metadata: Metadata = { title: "Início" };

/**
 * O par Início + Central de Campanha é montado AQUI, e não dentro do `Inicio`.
 *
 * `Inicio` é componente de cliente (lê o banco no localStorage); `SecaoCampanha`
 * é de servidor (números fixos, nada a hidratar). Cliente não pode IMPORTAR
 * servidor — mas pode RECEBÊ-LO como `children`, que é o que esta página faz.
 * O resultado é a campanha chegando desenhada no HTML mesmo enquanto o resto da
 * tela ainda espera a base local.
 */
export default function Page() {
  return (
    <Inicio>
      <SecaoCampanha />
    </Inicio>
  );
}
