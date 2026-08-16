import { FOTO_ROMERO, FOTO_ANDREZA } from "./fotos";

/* ══════════════════════════════════════════════════════════════════════════
   CONFIG DOS CANDIDATOS — dados FIXOS de identidade (nome, número, cargo, foto)
   e os SEGUIDORES do Instagram, que não têm integração automática. Os seguidores
   são REAIS (informados pelo gabinete) e ATUALIZÁVEIS por env — não é mock: é um
   dado seu que você mantém. Quando/se conectar a API do Instagram, isto vira fetch.

   Já os números de operação (cadastros na base, votos confirmados, apoiadores,
   fila) NÃO ficam aqui — esses vêm do ClickUp ao vivo (useNumerosCampanha /
   useFilaReal). Config só guarda o que é identidade + o que você mantém à mão.
   ══════════════════════════════════════════════════════════════════════════ */

export type CandidatoId = "romero" | "andreza";

export interface CandidatoInfo {
  id: CandidatoId;
  cargo: string;
  emoji: string;
  nome: string;
  numero: string;
  instagram: string;
  /** Seguidores do Instagram — real (você informa), atualizável por env. */
  seguidores: number;
  /** Meta de votos da campanha (você define). */
  meta: number;
  foto: string;
}

const num = (v: string | undefined, padrao: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : padrao;
};

export const CANDIDATOS: CandidatoInfo[] = [
  {
    id: "romero",
    cargo: "Deputado Estadual",
    emoji: "🐶",
    nome: "Romero",
    numero: "40000",
    instagram: "@romeroalbuquerque",
    seguidores: num(process.env.NEXT_PUBLIC_SEGUIDORES_ROMERO, 1_000_000),
    meta: num(process.env.NEXT_PUBLIC_META_ROMERO, 21_500),
    foto: FOTO_ROMERO,
  },
  {
    id: "andreza",
    cargo: "Deputada Federal",
    emoji: "🐱",
    nome: "Andreza",
    numero: "4020",
    instagram: "@andrezaromero",
    seguidores: num(process.env.NEXT_PUBLIC_SEGUIDORES_ANDREZA, 78_800),
    meta: num(process.env.NEXT_PUBLIC_META_ANDREZA, 21_500),
    foto: FOTO_ANDREZA,
  },
];
