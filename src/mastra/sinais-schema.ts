// Schema JSON estrito dos 6 sinais extraidos da transcricao de call/ligacao
// (SDR AUTON, GRAV-02) + parse seguro.
//
// Molde EXATO de camila-schema.ts (SaidaCamilaSchema/parseSaidaCamila/
// extrairBlocoJson) — mesmo contrato fail-safe: parseSinais NUNCA retorna
// `ok:true` com dado invalido (T-03-07). Falha de parse ou de schema sempre
// vira `ok:false, erro`; quem chama (extracao-sinais.ts) decide o fallback
// seguro (NAO persiste nada nos custom fields do contato).
//
// Os 6 sinais (playbook + 03-02-PLAN.md, sem enum oficial documentado —
// Claude's Discretion): objecoes, dor_real (dor EFETIVA vs a declarada no
// form), lexico (termos/frases-eco literais), sinais_compra (nivel +
// evidencia), sinais_desistencia (presente + evidencia) e ajuste_bant
// (ADVISORY — string curta, NUNCA numero; NUNCA sobrescreve os campos do
// score BANT, que sao geridos por outro processo/agente — ver guarda de
// tools/update-contact-field.ts).

import { z } from 'zod';

export const ObjecaoSchema = z.object({
  categoria: z.string().min(1).max(60).describe('categoria curta da objecao (ex: preco, tempo, confianca, ceticismo do metodo)'),
  trecho: z.string().min(1).describe('trecho/evidencia da transcricao que sustenta a objecao'),
});
export type Objecao = z.infer<typeof ObjecaoSchema>;

export const NIVEIS_SINAL_COMPRA = ['baixo', 'medio', 'alto'] as const;
export const NivelSinalCompraSchema = z.enum(NIVEIS_SINAL_COMPRA);
export type NivelSinalCompra = z.infer<typeof NivelSinalCompraSchema>;

export const SinaisCompraSchema = z.object({
  nivel: NivelSinalCompraSchema,
  // CR-02: evidencia VAZIA e valida — o prompt do extrator instrui
  // explicitamente '"evidencia": ""' quando nao ha evidencia na transcricao
  // (caso comum em call SDR inicial) e manda NUNCA inventar evidencia.
  // Exigir min(1) aqui contradizia o prompt: toda call sem sinal de compra
  // derrubava o parse inteiro (e com ele o gatilho de resgate de 48h da
  // desistencia). Mesmo padrao .default('') de SinaisDesistenciaSchema.
  evidencia: z.string().default('').describe('trecho da transcricao que sustenta o nivel; vazio se nao houver evidencia'),
});
export type SinaisCompra = z.infer<typeof SinaisCompraSchema>;

export const SinaisDesistenciaSchema = z.object({
  presente: z.boolean(),
  evidencia: z.string().default('').describe('trecho da transcricao; vazio se presente=false'),
});
export type SinaisDesistencia = z.infer<typeof SinaisDesistenciaSchema>;

export const SaidaSinaisSchema = z.object({
  objecoes: z.array(ObjecaoSchema).default([]),
  dor_real: z.string().default('').describe('dor EFETIVA relatada na call — pode divergir da dor declarada no formulario'),
  lexico: z.array(z.string().min(1)).default([]).describe('termos/frases-eco LITERAIS do lead'),
  sinais_compra: SinaisCompraSchema,
  sinais_desistencia: SinaisDesistenciaSchema,
  // ADVISORY (design decision 3, 03-02-PLAN.md): string curta, NUNCA um
  // numero pra sobrescrever o score do BANT — vai so pra
  // resumo_ultima_ligacao/nota, nunca pros campos protegidos do score.
  ajuste_bant: z.string().default('').describe('leitura ADVISORY de ajuste do score de qualificacao com base na call — texto curto, nunca numero, nunca grava direto no CRM'),
});
export type SaidaSinais = z.infer<typeof SaidaSinaisSchema>;

export type ParseSinaisResultado =
  | { ok: true; data: SaidaSinais }
  | { ok: false; erro: string };

/**
 * Extrai o parse seguro do JSON estrito dos 6 sinais a partir do texto bruto
 * devolvido pelo LLM extrator (resposta.text). NUNCA retorna `ok:true` com
 * dado invalido (T-03-07) — falha de extracao, JSON malformado ou schema
 * invalido sempre vira `ok:false, erro`. Quem chama decide o fallback seguro
 * (extracao-sinais.ts: nao persiste nada nos custom fields, so loga).
 */
export function parseSinais(raw: string): ParseSinaisResultado {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, erro: 'saida vazia ou nao-string' };
  }

  const blocoJson = extrairBlocoJson(raw);
  if (!blocoJson) {
    return { ok: false, erro: 'nenhum bloco JSON encontrado na saida' };
  }

  let candidato: unknown;
  try {
    candidato = JSON.parse(blocoJson);
  } catch (e) {
    return { ok: false, erro: `JSON invalido: ${(e as Error).message}` };
  }

  const resultado = SaidaSinaisSchema.safeParse(candidato);
  if (!resultado.success) {
    const detalhe = resultado.error.issues
      .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('; ');
    return { ok: false, erro: `schema invalido: ${detalhe}` };
  }

  return { ok: true, data: resultado.data };
}

// Extrai o primeiro bloco {...} balanceado do texto. Modelos as vezes
// envolvem o JSON em cercas ```json ... ``` ou adicionam texto antes/depois
// apesar da instrucao de saida estrita — o parse e tolerante a isso, mas o
// zod continua validando o CONTEUDO com rigor total (nada de invalido passa
// como ok). Copia DELIBERADA (nao import) da funcao homonima privada de
// camila-schema.ts — mantem sinais-schema.ts sem dependencia cruzada de um
// schema de dominio diferente (Camila x extracao de sinais).
function extrairBlocoJson(raw: string): string | null {
  const semCercas = raw.replace(/```json/gi, '```').trim();
  const inicioCerca = semCercas.indexOf('```');
  let texto = semCercas;
  if (inicioCerca !== -1) {
    const fimCerca = semCercas.indexOf('```', inicioCerca + 3);
    if (fimCerca !== -1) {
      texto = semCercas.slice(inicioCerca + 3, fimCerca).trim();
    }
  }

  const primeiraChave = texto.indexOf('{');
  if (primeiraChave === -1) return null;

  let profundidade = 0;
  for (let i = primeiraChave; i < texto.length; i++) {
    const char = texto[i];
    if (char === '{') profundidade++;
    else if (char === '}') {
      profundidade--;
      if (profundidade === 0) {
        return texto.slice(primeiraChave, i + 1);
      }
    }
  }
  return null;
}
