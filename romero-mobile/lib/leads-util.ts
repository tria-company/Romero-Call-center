/* ══════════════════════════════════════════════════════════════════════════
   LEADS-UTIL — helpers puros de lead, sem store nem localStorage.

   Único sobrevivente do antigo `lib/db/schema.ts`: a derivação `iniciais`,
   usada pelo avatar em Base, Fila e Ficha. Função pura — nada de estado,
   nada de PII em log.
   ══════════════════════════════════════════════════════════════════════════ */

/** Iniciais do nome para o avatar: "Maria Silva" → "MS", "Ana" → "AN". */
export function iniciais(nome: string): string {
  const p = nome.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return "?";
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}
