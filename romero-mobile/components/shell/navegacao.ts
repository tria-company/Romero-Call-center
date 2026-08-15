import type { LucideIcon } from "lucide-react";
import { House, Target, Users, UserRound } from "lucide-react";

/**
 * As abas fixas, na ordem e com os rótulos do mockup.
 * O mockup usa emoji; aqui viram ícones de traço, que é o que a barra
 * herdada do sistema anterior sabe desenhar (e escala melhor).
 *
 * Duas abas do mockup já saíram, as duas a pedido:
 * · "Campanha" (sexta, portada do 2º mockup) virou SEÇÃO do Início;
 * · "Equipe" foi REMOVIDA junto com a tela — ver o AGENTS.md, porque ela era
 *   o fecho do ciclo e o app perdeu o passo que devolvia o retorno para a fila.
 */
export type Destino = {
  href: string;
  label: string;
  labelLongo: string;
  icon: LucideIcon;
  /** true = ativo só na rota exata (a raiz casaria com tudo) */
  exato?: boolean;
};

export const DESTINOS: readonly Destino[] = [
  { href: "/", label: "Início", labelLongo: "Início", icon: House, exato: true },
  { href: "/fila", label: "Fila", labelLongo: "Fila de hoje", icon: Target },
  { href: "/base", label: "Base", labelLongo: "Base", icon: Users },
  { href: "/perfil", label: "Perfil", labelLongo: "Perfil", icon: UserRound },
];

export function rotaAtiva(pathname: string, d: Destino): boolean {
  return d.exato ? pathname === d.href : pathname === d.href || pathname.startsWith(`${d.href}/`);
}

export function tituloDaRota(pathname: string): string {
  return DESTINOS.find((x) => rotaAtiva(pathname, x))?.labelLongo ?? "Central Animal";
}
