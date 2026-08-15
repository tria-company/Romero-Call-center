/* ══════════════════════════════════════════════════════════════════════════
   GARANTE lib/db/reais.json

   `lib/db/reais.json` guarda nome, telefone e endereço de eleitores reais, e
   por isso está no `.gitignore`. Mas `lib/db/reais.ts` e `lib/campanha.ts`
   IMPORTAM esse arquivo — num clone novo ele não existe e o build quebra
   antes de dizer por quê.

   Este script roda em `predev` e `prebuild`: se o arquivo não existir, escreve
   um esqueleto VAZIO. Aí o app sobe com a base fictícia da semente e a Central
   de Campanha diz "sem dados ainda" — que é o comportamento correto para quem
   ainda não rodou `npm run puxar:clickup`.

   Nunca sobrescreve um arquivo existente.
   ══════════════════════════════════════════════════════════════════════════ */

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALVO = join(RAIZ, "lib", "db", "reais.json");

if (existsSync(ALVO)) process.exit(0);

const esqueleto = {
  geradoEm: null,
  origem: null,
  totais: {
    cadastros: 0,
    confirmadosRomero: 0,
    confirmadosAndreza: 0,
    militantes: 0,
    comContato: 0,
    semContato: 0,
    contatadosHoje: 0,
    ligacoes: 0,
  },
  campanha: {
    serie: [],
    tempoMedio: { atual: 0, min: 0, mediana: 0, max: 0, amostra: 0 },
    telefonistas: [],
    motivosNaoContato: [],
    sla: { pct: 0, agendados: 0, cumpridos: 0, vencidos: 0 },
    votosPorCidade: [],
    intencao: [],
    cobertura: { feita: 0, total: 0 },
    totalLigacoes: 0,
    totalContatos: 0,
    aderenciaMedia: 0,
  },
  leads: [],
  fila: [],
  interacoes: [],
};

mkdirSync(dirname(ALVO), { recursive: true });
writeFileSync(ALVO, JSON.stringify(esqueleto, null, 1), "utf8");
console.log("lib/db/reais.json não existia — escrito esqueleto vazio.");
console.log("Rode `npm run puxar:clickup` para trazer a base real do ClickUp.");
