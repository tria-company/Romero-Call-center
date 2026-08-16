"use client";

/** Nome do operador logado, gravado pelo login. */
export function operadorAtual(): string {
  if (typeof window === "undefined") return "Equipe";
  try {
    return localStorage.getItem("ca.operador") || "Romero";
  } catch {
    return "Romero";
  }
}

/**
 * Antes semeava a base local (store localStorage). Sem store — todo dado vem
 * do backend do discador — não há mais o que inicializar. Fica como no-op para
 * não mexer no ponto de montagem; pode ser removido quando o layout deixar de
 * referenciá-lo.
 */
export function BootDados() {
  return null;
}
