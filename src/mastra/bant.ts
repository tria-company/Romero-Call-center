// Modulo PURO — Filtro 1 (descarte absoluto), Filtro 2 (scoring BANT 0-3 por
// dimensao) e roteamento do lead logo apos o submit do formulario. SEM
// imports de mastra/ghl: deterministico, testavel por smoke sem LLM.
// Consumido pelo qualificadorAgent (que NAO reimplementa a regra em prosa
// livre) e pela rota /api/webhook/formulario (index.ts).
//
// Fonte: Playbook SDR AUTON Sec.6 (Regras de qualificacao) e Sec.15
// (motivos de perdido) — .planning/notes/playbook-sdr-auton.md.

import type { FormularioParseado } from './formulario';

// ICP: profissoes-alvo da base USI (pos de saude integrativa). Stems (nao
// palavras exatas) pra casar variacoes comuns (ex: "nutricionista" casa com
// "nutri"). Lista PLACEHOLDER — o playbook destilado nao enumera as 8
// profissoes oficiais; ajustar quando o time de produto confirmar a lista
// (Claude's Discretion, registrado no SUMMARY da 01-04).
export const ICP_PROFISSOES_STEMS = [
  'medic',      // medico, medicina
  'nutri',      // nutricionista, nutricao
  'fisioterap', // fisioterapeuta
  'psicolog',   // psicologo, psicologia
  'enferm',     // enfermeiro, enfermagem
  'odont',      // odontologo, odontologia
  'biomedic',   // biomedico
  'farmac',     // farmaceutico
] as const;

// Lexico proibido no campo aberto do form (Filtro 1) — mesma familia do
// lexico banido da Camila (playbook Sec.12), aplicado aqui ao texto livre
// das respostas abertas do lead. Word-boundary (\b) evita falso-positivo
// em substrings legitimas do pt-BR (ex: 'cura' dentro de 'procura'/
// 'procurando'/'procurava' — CR-04 do 01-REVIEW.md). O texto ja passa por
// normalizarTexto (remove acentos), entao \b funciona sobre ASCII puro.
// Cobertura de plural/flexao (WR-01 do 01-REVIEW.md, 2a rodada): a versao
// anterior so casava a forma exata singular ('cura', 'milagre', 'hack',
// 'mindset', 'vibracao'), entao 'curas'/'milagres'/'hacks'/'mindsets'
// escapavam do descarte. `\w*` apos o radical cobre flexao/plural SEM
// reintroduzir o bug de substring do CR-04: o `\b` INICIAL continua exigindo
// inicio de palavra, entao 'procura'/'procurando'/'procurava' (onde 'cura'
// aparece precedida por 'pro', um caractere de palavra) NAO casam — o \b so
// bate quando 'cura'/'curas' comeca a propria palavra. `curas?` cobre
// cura/curas; `milagr\w*` cobre milagre/milagres/milagrosa/milagrosos;
// `hacks?` cobre hack/hacks; `mindset\w*` cobre mindset/mindsets;
// `vibraca\w*`/`vibracion\w*` cobrem vibracao/vibracoes/vibracional/etc
// (apos normalizarTexto remover acentos, 'vibração'->'vibracao').
// SEM flag 'g' — evita estado residual de lastIndex entre chamadas (IN-06).
const LEXICO_PROIBIDO_REGEX = /\b(vibraca\w*|vibracion\w*|mindset\w*|curas?|milagr\w*|hacks?)\b/;

const REGEX_MARCAS_DIACRITICAS = new RegExp('[\\u0300-\\u036f]', 'g');

function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(REGEX_MARCAS_DIACRITICAS, ''); // remove acentos pra comparacao robusta
}

function temViesIntegrativo(profissaoTexto: string): boolean {
  const texto = normalizarTexto(profissaoTexto);
  return /integrativ|holistic|funcional|ortomolecular/.test(texto);
}

export interface ResultadoDescarte {
  descarta: boolean;
  motivo?: string;
}

// Filtro 1 — descarte absoluto (Sec.6). Se descarta, o lead vai pra PERDIDO
// SEM mensagem nenhuma (QUAL-02). Ordem de checagem segue a ordem do
// playbook; a primeira condicao batida define o motivo.
export function filtro1Descarte(form: FormularioParseado): ResultadoDescarte {
  if (!form.registro) {
    return { descarta: true, motivo: 'Fora do ICP' };
  }

  const profissaoNormalizada = normalizarTexto(form.profissao);
  const dentroIcp = (ICP_PROFISSOES_STEMS as readonly string[]).some((stem) => profissaoNormalizada.includes(stem));
  if (!dentroIcp && !temViesIntegrativo(form.profissao)) {
    return { descarta: true, motivo: 'Fora do ICP' };
  }

  if (form.ticket <= 300) {
    return { descarta: true, motivo: 'Ticket insuficiente' };
  }

  const textoAbertoNormalizado = normalizarTexto(form.lexicoTexto);
  if (LEXICO_PROIBIDO_REGEX.test(textoAbertoNormalizado)) {
    return { descarta: true, motivo: 'Léxico incompatível' };
  }

  const soExplorando = normalizarTexto(form.motivoInteresse).includes('so explorando');
  if (soExplorando && !form.congressoSp && !form.indicouCurso) {
    return { descarta: true, motivo: 'Sem intenção real' };
  }

  return { descarta: false };
}

export interface ScoreBant {
  budget: 0 | 1 | 2 | 3;
  authority: 0 | 1 | 2 | 3;
  need: 0 | 1 | 2 | 3;
  timing: 0 | 1 | 2 | 3;
  total: number; // 0-12
}

// Budget: ticket medio (<=300=0 ... 1000+=3).
function scoreBudget(ticket: number): 0 | 1 | 2 | 3 {
  if (ticket >= 1000) return 3;
  if (ticket >= 601) return 2;
  if (ticket >= 301) return 1;
  return 0;
}

// Authority: registro ativo + tempo de atuacao (sem registro=0 ...
// registro + 10 anos+ =3).
function scoreAuthority(form: FormularioParseado): 0 | 1 | 2 | 3 {
  if (!form.registro) return 0;
  if (form.tempoAtuacaoAnos >= 10) return 3;
  if (form.tempoAtuacaoAnos >= 5) return 2;
  return 1;
}

// Need: ja aplica ADS sem dor=0 ... nao aplicou + modulo interrompido + dor
// declarada=3.
function scoreNeed(form: FormularioParseado): 0 | 1 | 2 | 3 {
  const temDorDeclarada = form.dorDeclarada.trim().length > 0;
  if (form.aplicouAds) {
    return temDorDeclarada ? 1 : 0;
  }
  if (form.moduloInterrompido && temDorDeclarada) return 3;
  return temDorDeclarada ? 2 : 1;
}

// Timing: so explorando=0 ... agora (congresso + indicou curso)=3.
function scoreTiming(form: FormularioParseado): 0 | 1 | 2 | 3 {
  const soExplorando = normalizarTexto(form.motivoInteresse).includes('so explorando');
  if (soExplorando) return 0;
  if (form.congressoSp && form.indicouCurso) return 3;
  if (form.congressoSp || form.indicouCurso) return 2;
  return 1;
}

// Filtro 2 — scoring BANT (Sec.6). Cada dimensao 0-3, total 0-12.
export function scoreBant(form: FormularioParseado): ScoreBant {
  const budget = scoreBudget(form.ticket);
  const authority = scoreAuthority(form);
  const need = scoreNeed(form);
  const timing = scoreTiming(form);
  return { budget, authority, need, timing, total: budget + authority + need + timing };
}

export type ResultadoRoteamento =
  | { stage: 'PERDIDO'; enviarMensagem: false; motivo: string; bant?: ScoreBant }
  | { stage: 'QUALIFICADO'; bant: ScoreBant };

// decidirRoteamento: aplica Filtro 1 -> se descarta, PERDIDO sem mensagem
// (QUAL-02). Senao aplica Filtro 2 (scoreBant); total>=5 -> QUALIFICADO
// (QUAL-03); total<5 -> PERDIDO com motivo 'BANT insuficiente'.
export function decidirRoteamento(form: FormularioParseado): ResultadoRoteamento {
  const filtro1 = filtro1Descarte(form);
  if (filtro1.descarta) {
    return { stage: 'PERDIDO', enviarMensagem: false, motivo: filtro1.motivo || 'Fora do ICP' };
  }

  const bant = scoreBant(form);
  if (bant.total >= 5) {
    return { stage: 'QUALIFICADO', bant };
  }

  return { stage: 'PERDIDO', enviarMensagem: false, motivo: 'BANT insuficiente', bant };
}
