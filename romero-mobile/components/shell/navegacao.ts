import type { LucideIcon } from "lucide-react";
import { House, Mic, Target, Users, UserRound } from "lucide-react";

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
  /** true = aba visível só para o gestor (atendente não a vê) */
  soGestor?: boolean;
  /** true = aba visível só pro usuário romero (ENVIO-07) — ausência total pra
   *  qualquer outro usuário, nunca um estado desabilitado/cinza. */
  soRomero?: boolean;
};

export const DESTINOS: readonly Destino[] = [
  { href: "/", label: "Início", labelLongo: "Início", icon: House, exato: true, soGestor: true },
  { href: "/fila", label: "Fila", labelLongo: "Fila de hoje", icon: Target },
  { href: "/base", label: "Base", labelLongo: "Base", icon: Users, soGestor: true },
  { href: "/audios", label: "Áudios", labelLongo: "Lista de Áudios", icon: Mic, soRomero: true },
  { href: "/perfil", label: "Perfil", labelLongo: "Perfil", icon: UserRound },
];

/**
 * Abas que o usuário enxerga.
 *
 * Gestor/admin (ENVIO-08): barra ENXUTA — Início · Ações · Perfil. A Fila
 * absorve a lista de Áudios e passa a se chamar "Ações"; a aba Áudios e a aba
 * Base saem do menu. A lista de áudios agora vive DENTRO de Ações (sem dropdown);
 * `/base` continua existindo por rota direta, só não aparece no menu. A seção de
 * áudios dentro de Ações segue romero-only — o gate real é o backend
 * (`exigirRomero`), aqui é só apresentação.
 *
 * Atendente: inalterado — Fila e Perfil (nunca teve Base/Áudios).
 */
export function destinosVisiveis(papel: "gestor" | "atendente", _usuario?: string): Destino[] {
  const por = (href: string) => DESTINOS.find((d) => d.href === href)!;
  if (papel === "gestor") {
    return [por("/"), { ...por("/fila"), label: "Ações", labelLongo: "Ações de hoje" }, por("/perfil")];
  }
  return [por("/fila"), por("/perfil")];
}

export function rotaAtiva(pathname: string, d: Destino): boolean {
  return d.exato ? pathname === d.href : pathname === d.href || pathname.startsWith(`${d.href}/`);
}

export function tituloDaRota(pathname: string): string {
  return DESTINOS.find((x) => rotaAtiva(pathname, x))?.labelLongo ?? "Central Animal";
}
