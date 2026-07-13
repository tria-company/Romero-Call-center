// Modulo PURO — parse do formulario de 14 perguntas (webhook do GHL Workflow
// disparado no submit do form pelo aluno USI). SEM imports de mastra/ghl:
// deterministico, testavel por smoke sem chamada de rede/LLM. Consumido por
// bant.ts (Filtro 1/2/3) e pelo qualificadorAgent (via decidirRoteamento).
//
// As 14 perguntas do form: as 3 "ancoras de leitura" do playbook (Sec.5) sao
// Q08 (aplicou Metodo ADS), Q12 (modulo da pos que ficou/interrompido) e Q14
// (maior dificuldade hoje — dor declarada). As demais 11 cobrem ICP
// (formacao/registro/tempo de atuacao), operacao (area/modelo/volume/ticket)
// e intencao (canal/indicacao/congresso/motivo de interesse).
//
// Formato exato dos nomes de campo do form GHL e Claude's Discretion
// (01-CONTEXT.md, secao "Claude's Discretion": "detalhes de parsing do form
// 14q"). Normalizado aqui pra {q01..q14} + campos derivados.

export interface FormularioBruto {
  q01_profissao?: string;
  q02_registro_ativo?: string; // 'sim' | 'nao'
  q03_tempo_atuacao_anos?: string | number;
  q04_area_foco?: string;
  q05_modelo_atendimento?: string; // ex: 'autonomo', 'clinica', 'hospital'
  q06_pacientes_semana?: string | number;
  q07_ticket_medio?: string | number;
  q08_aplicou_ads?: string; // 'sim' | 'nao' [ANCORA 08]
  q09_canal_captacao?: string;
  q10_indicou_curso?: string; // 'sim' | 'nao'
  q11_motivo_interesse?: string; // texto livre — pode conter "so explorando"
  q12_modulo_interrompido?: string; // texto livre [ANCORA 12]
  q13_congresso_sp?: string; // 'sim' | 'nao'
  q14_maior_dificuldade?: string; // texto livre — dor declarada [ANCORA 14]
  [chave: string]: unknown;
}

export interface FormularioParseado {
  // Respostas normalizadas 1:1 com o payload (uso de debug/auditoria)
  q01: string;
  q02: string;
  q03: string;
  q04: string;
  q05: string;
  q06: string;
  q07: string;
  q08: string;
  q09: string;
  q10: string;
  q11: string;
  q12: string;
  q13: string;
  q14: string;
  // Campos derivados — consumidos por bant.ts
  profissao: string;
  registro: boolean;
  tempoAtuacaoAnos: number;
  modeloAtendimento: string;
  ticket: number;
  aplicouAds: boolean;
  indicouCurso: boolean;
  congressoSp: boolean;
  moduloInterrompido: boolean;
  dorDeclarada: string;
  motivoInteresse: string;
  lexicoTexto: string;
}

function paraTexto(valor: unknown): string {
  if (valor === undefined || valor === null) return '';
  return String(valor).trim();
}

function paraBooleanoSimNao(valor: unknown): boolean {
  const texto = paraTexto(valor).toLowerCase();
  return texto === 'sim' || texto === 'yes' || texto === 'true' || texto === '1';
}

// paraNumero: converte string do form (com simbolos/moeda) em numero,
// tratando separador de milhar/decimal no formato pt-BR. Regra
// deterministica (CR-03 do 01-REVIEW.md):
// 1) remove tudo que nao for digito, ponto ou virgula;
// 2) SE houver virgula, ela e o separador decimal -> remove TODOS os pontos
//    (milhar) e troca a virgula por ponto (ex: '1.500,00' -> '1500.00');
// 3) SENAO, SE o ponto esta no padrao de milhar pt-BR (grupos de 3 digitos
//    apos o ponto, ex: '1.500' ou '12.345.678'), remove todos os pontos
//    (ex: '1.500' -> '1500');
// 4) senao, mantem o ponto como decimal (ex: '2.5' -> 2.5, '400' -> 400).
const REGEX_PONTO_MILHAR = /^\d{1,3}(\.\d{3})+$/;

function paraNumero(valor: unknown): number {
  if (valor === undefined || valor === null) return 0;
  let texto = paraTexto(valor).replace(/[^\d.,]/g, '');
  if (texto.includes(',')) {
    texto = texto.replace(/\./g, '').replace(',', '.');
  } else if (REGEX_PONTO_MILHAR.test(texto)) {
    texto = texto.replace(/\./g, '');
  }
  const numero = parseFloat(texto);
  return Number.isFinite(numero) ? numero : 0;
}

const SEM_MODULO_INTERROMPIDO = ['', 'nenhum', 'nao', 'não', 'n/a', 'na', 'completo', 'concluido', 'concluído'];

// parseFormulario: payload do webhook (submit do form, 14 perguntas) ->
// objeto estruturado {q01..q14} + campos derivados. Puro — sem side-effect,
// sem chamada de rede.
export function parseFormulario(payload: FormularioBruto): FormularioParseado {
  const q01 = paraTexto(payload.q01_profissao);
  const q02 = paraTexto(payload.q02_registro_ativo);
  const q03 = paraTexto(payload.q03_tempo_atuacao_anos);
  const q04 = paraTexto(payload.q04_area_foco);
  const q05 = paraTexto(payload.q05_modelo_atendimento);
  const q06 = paraTexto(payload.q06_pacientes_semana);
  const q07 = paraTexto(payload.q07_ticket_medio);
  const q08 = paraTexto(payload.q08_aplicou_ads);
  const q09 = paraTexto(payload.q09_canal_captacao);
  const q10 = paraTexto(payload.q10_indicou_curso);
  const q11 = paraTexto(payload.q11_motivo_interesse);
  const q12 = paraTexto(payload.q12_modulo_interrompido);
  const q13 = paraTexto(payload.q13_congresso_sp);
  const q14 = paraTexto(payload.q14_maior_dificuldade);

  const moduloInterrompido = !SEM_MODULO_INTERROMPIDO.includes(q12.toLowerCase());

  return {
    q01, q02, q03, q04, q05, q06, q07, q08, q09, q10, q11, q12, q13, q14,
    profissao: q01,
    registro: paraBooleanoSimNao(q02),
    tempoAtuacaoAnos: paraNumero(q03),
    modeloAtendimento: q05.toLowerCase(),
    ticket: paraNumero(q07),
    aplicouAds: paraBooleanoSimNao(q08),
    indicouCurso: paraBooleanoSimNao(q10),
    congressoSp: paraBooleanoSimNao(q13),
    moduloInterrompido,
    dorDeclarada: q14,
    motivoInteresse: q11,
    lexicoTexto: [q11, q12, q14].filter(Boolean).join(' '),
  };
}
