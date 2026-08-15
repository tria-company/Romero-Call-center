"use client";

import { useEffect } from "react";
import { inicializar } from "@/lib/db";

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
 * Semeia a base na primeira visita. Fica aqui (e não dentro de cada tela)
 * para que o custo da semente aconteça uma vez só, logo após a hidratação.
 */
export function BootDados() {
  useEffect(() => {
    inicializar();
  }, []);
  return null;
}
