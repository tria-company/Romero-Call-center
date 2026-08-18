/* ══════════════════════════════════════════════════════════════════════════
   CENTRAL DE CAMPANHA — os números do painel de telemarketing.

   FICA FORA DE `lib/db` DE PROPÓSITO. O resto do app guarda estado que muda
   (leads, fila, solicitações) e por isso passa pelo repositório assíncrono do
   `store`. Isto aqui não muda nunca: é a demonstração desenhada em
   `ROMERO/central-campanha-romero.html`, uma constante.

   Passar por lá custou caro e não comprou nada: a tela virava cliente,
   esperava a hidratação do localStorage e mostrava esqueleto até lá — e quando
   um banco gravado ficou marcado com a versão nova SEM este bloco, o esqueleto
   ficou para sempre. Constante é constante: renderiza no servidor, aparece de
   primeira, não tem como falhar.

   Quando a telemetria for real, isto vira um `fetch` — e AÍ volta a fazer
   sentido morar atrás de um repositório.

   Duas coisas que ficam mais fáceis de conferir se estiverem escritas:

   · a série diária é COERENTE com o topo: 18.240 votos em 12 dias = 1.520/dia,
     e os 158,5 mil de ligações contra 54,4 mil de contatos dão os 34% de taxa
     de contato que a tendência mostra;
   · `ritmoNecessario` da Andreza (1.339) é o número do mockup, e ele NÃO fecha
     com a própria conta dele: faltam 16.100 votos em 18 dias, o que dá 894/dia.
     Foi mantido porque o pedido era reproduzir a tela; para passar a calcular,
     troque por `(meta - votos) / (totalDias - dia)`.

   ─────────────────────────────────────────────────────────────────────────
   HOJE A TELEMETRIA AO VIVO NÃO EXISTE MAIS AQUI. A extração periódica em
   arquivo foi desacoplada: a Central de Campanha exibe apenas o que vem de
   `lib/campanha-config.ts` — meta, calendário e tamanho da equipe — e TODO o
   resto fica VAZIO, com a tela dizendo "sem dados ainda" (via `SemDados`). Os
   números contados voltarão quando existir uma rota de agregação ao vivo; por
   ora, `real` aponta para a constante `VAZIO`.

   Continua sendo montado no SERVIDOR e fora de `lib/db` — pelo mesmo motivo de
   sempre: não passa por localStorage, não espera hidratação, não tem esqueleto
   eterno. Mesmo sem telemetria, o app funciona sem rede.

   O que a fonte NÃO responde fica VAZIO, e a tela diz "sem dados ainda":
     · votos acumulados por dia — o ClickUp guarda confirmação de voto como
       estado do lead, sem data. Não há série a reconstruir.
     · tendências e comparativo semanal — exigem semanas de histórico.
   ══════════════════════════════════════════════════════════════════════════ */

import { CONFIG_CAMPANHA } from "./campanha-config";

export type TomCampanha = "accent" | "accent2" | "good" | "warn" | "crit";

/** Uma urna no painel de metas: onde está, para onde vai, em que ritmo. */
export type MetaVotos = {
  /** o nome como as outras telas o escrevem */
  nome: string;
  /** define a cor da barra: a primeira urna é azul, a segunda é dourada */
  segunda?: boolean;
  /** rótulo da pílula: "adiantado", "no ritmo"… */
  selo: string;
  seloTom: "good" | "acc" | "warn" | "crit";
  votos: number;
  meta: number;
  ritmoAtual: number;
  ritmoNecessario: number;
  projecao: number;
};

/** Um dia da campanha. `ligacoes` e `contatos` em milhares. */
export type DiaCampanha = {
  /** votos confirmados ACUMULADOS até o fim do dia */
  acumulado: number;
  ligacoes: number;
  contatos: number;
};

/** Minigráfico de tendência: pares [x, y] no sistema 100 × 34 do mockup. */
export type Tendencia = {
  rotulo: string;
  valor: string;
  pontos: readonly (readonly [number, number])[];
  tom: TomCampanha;
};

export type LinhaComparativo = {
  rotulo: string;
  valor: string;
  delta: string;
  sentido: "up" | "down";
};

export type BarraCampanha = { rotulo: string; valor: string; pct: number; tom: TomCampanha };

export type IntencaoVoto = {
  rotulo: string;
  base: number;
  /** percentuais que somam 100 */
  sim: number;
  nao: number;
  nd: number;
};

export type Telefonista = {
  id: number;
  nome: string;
  /** "Recife · manhã" */
  turno: string;
  lig: number;
  cont: number;
  /** conversão, aderência e tempo médio (segundos) */
  conv: number;
  ader: number;
  tsec: number;
  votos: number;
  /** ligações por hora */
  ligh: number;
};

/** As seis ordenações do ranking. A chave é o próprio campo do telefonista. */
export const METRICAS_RANKING = ["votos", "conv", "lig", "ader", "tsec", "ligh"] as const;
export type MetricaRanking = (typeof METRICAS_RANKING)[number];

export const METRICA_LABEL: Record<MetricaRanking, string> = {
  votos: "Votos",
  conv: "Conversão",
  lig: "Ligações",
  ader: "Aderência",
  tsec: "Tempo médio",
  ligh: "Lig / hora",
};

/** Unidade que vai embaixo do número grande da linha do ranking. */
export const METRICA_UNIDADE: Record<MetricaRanking, string> = {
  votos: "votos",
  conv: "conv.",
  lig: "lig.",
  ader: "ader.",
  tsec: "médio",
  ligh: "/h",
};

export type Campanha = {
  /* ── SEM CONSUMIDOR HOJE ───────────────────────────────────────────────
     `dia`, `inicio`, `eleicao` e `metas` alimentavam a abertura da tela — o
     alternador, a linha "Dia 12 de 30" e os dois cartões de meta das urnas —,
     que foi retirada a pedido. Os números ficam porque são os do mockup e
     remontar o bloco é mais barato do que redigitá-los. `totalDias`,
     `metaGrafico` e `diaProjecao` CONTINUAM em uso, pelo gráfico acumulado. */
  dia: number;
  totalDias: number;
  /** datas em DD/MM — são rótulo, não cálculo */
  inicio: string;
  eleicao: string;
  /** teto do gráfico acumulado (a meta da urna principal) */
  metaGrafico: number;
  /** dia em que a projeção cruza a meta */
  diaProjecao: number;
  metas: MetaVotos[];
  serie: DiaCampanha[];
  tendencias: Tendencia[];
  comparativo: LinhaComparativo[];
  tempoMedio: {
    /** segundos */
    atual: number;
    min: number;
    mediana: number;
    max: number;
    faixa: readonly [number, number];
    /** posição na barra, como o mockup a desenha */
    pct: number;
  };
  intencao: IntencaoVoto[];
  /** telefonistas na operação inteira (a lista traz só os do ranking) */
  equipeTotal: number;
  telefonistas: Telefonista[];
  votosPorCidade: BarraCampanha[];
  motivosNaoContato: BarraCampanha[];
  sla: { pct: number; agendados: number; cumpridos: number; vencidos: number };
  cobertura: { feita: number; total: number };
};

/** Ordem do ranking: maior primeiro, em qualquer métrica (é o que o mockup faz). */
export function ordenarRanking(lista: readonly Telefonista[], por: MetricaRanking): Telefonista[] {
  return [...lista].sort((a, b) => b[por] - a[por]);
}

/** Semáforo da linha: verde ≥80% de aderência, âmbar 70–79, vermelho abaixo. */
export function tomAderencia(ader: number): "good" | "warn" | "crit" {
  return ader >= 80 ? "good" : ader >= 70 ? "warn" : "crit";
}

/* ── Os números, contados da fonte ─────────────────────────────────────── */

export type CampanhaReal = {
  serie: { dia: string; ligacoes: number; contatos: number }[];
  tempoMedio: { atual: number; min: number; mediana: number; max: number; amostra: number };
  telefonistas: {
    id: number;
    nome: string;
    turno: string;
    lig: number;
    cont: number;
    conv: number;
    ader: number;
    tsec: number;
    votos: number;
    ligh: number;
  }[];
  motivosNaoContato: { rotulo: string; n: number; pctTotal: number }[];
  sla: { pct: number; agendados: number; cumpridos: number; vencidos: number };
  votosPorCidade: { rotulo: string; n: number }[];
  intencao: { rotulo: string; sim: number; nao: number; naoDeclarou: number; base: number }[];
  cobertura: { feita: number; total: number };
  totalLigacoes: number;
  totalContatos: number;
  aderenciaMedia: number;
};

export const CAMPANHA_REAL_VAZIO: CampanhaReal = {
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
};



/** Barra proporcional à MAIOR da lista — é assim que o painel as desenha. */
function barras(
  itens: { rotulo: string; n: number }[],
  tom: TomCampanha,
  sufixo = "",
): BarraCampanha[] {
  const maior = Math.max(...itens.map((i) => i.n), 0);
  return itens.map((i) => ({
    rotulo: i.rotulo,
    valor: `${i.n.toLocaleString("pt-BR")}${sufixo}`,
    pct: maior ? Math.round((i.n / maior) * 100) : 0,
    tom,
  }));
}

/** Faixa-alvo de duração, em segundos. É meta de operação, não medição. */
const FAIXA_ALVO: readonly [number, number] = [60, 180];

/** (meta − votos) ÷ dias restantes. Zero quando não há dias a dividir. */
function ritmoNecessario(votos: number, meta: number, diasRestantes: number): number {
  return diasRestantes ? Math.max(Math.round((meta - votos) / diasRestantes), 0) : 0;
}

/** Monta o painel a partir da telemetria ao vivo (/api/mobile/campanha).
    Era `const real = VAZIO` desde 15/08 (commit 93c0a31, 'sem telemetria ao vivo'):
    a tela nasceu zerada esperando esta fonte. Agora `real` entra por parametro. */
export function montarCampanha(real: CampanhaReal): Campanha {
  const votosRomero = real.intencao.find((i) => i.rotulo === "Romero")?.sim ?? 0;
  const votosAndreza = real.intencao.find((i) => i.rotulo === "Andreza")?.sim ?? 0;
  const diasComDado = real.serie.length;
  const diasRestantes = Math.max(CONFIG_CAMPANHA.calendario.totalDias - diasComDado, 0);

  return {
  dia: diasComDado,
  totalDias: CONFIG_CAMPANHA.calendario.totalDias,
  inicio: CONFIG_CAMPANHA.calendario.inicio,
  eleicao: CONFIG_CAMPANHA.calendario.eleicao,
  metaGrafico: CONFIG_CAMPANHA.metas.romero,
  // sem série histórica de votos não há reta de projeção para cruzar a meta
  diaProjecao: 0,

  metas: [
    {
      nome: "Romero",
      selo: "sem histórico",
      seloTom: "acc",
      votos: votosRomero,
      meta: CONFIG_CAMPANHA.metas.romero,
      ritmoAtual: 0,
      ritmoNecessario: ritmoNecessario(votosRomero, CONFIG_CAMPANHA.metas.romero, diasRestantes),
      projecao: 0,
    },
    {
      nome: "Andreza",
      segunda: true,
      selo: "sem histórico",
      seloTom: "acc",
      votos: votosAndreza,
      meta: CONFIG_CAMPANHA.metas.andreza,
      ritmoAtual: 0,
      ritmoNecessario: ritmoNecessario(votosAndreza, CONFIG_CAMPANHA.metas.andreza, diasRestantes),
      projecao: 0,
    },
  ],

  /* Uma barra por dia com ligação registrada. `acumulado` fica em 0: a
     confirmação de voto no ClickUp não tem data, então não existe série
     histórica — o gráfico de acumulado mostra "sem dados" em vez de uma
     linha rasteira que pareceria queda. */
  serie: real.serie.map((d) => ({
    acumulado: 0,
    ligacoes: d.ligacoes,
    contatos: d.contatos,
  })),

  // exigem semanas de histórico; a extração é uma foto do agora
  tendencias: [],
  comparativo: [],

  tempoMedio: {
    atual: real.tempoMedio.atual,
    min: real.tempoMedio.min,
    mediana: real.tempoMedio.mediana,
    max: real.tempoMedio.max,
    faixa: FAIXA_ALVO,
    pct: real.tempoMedio.atual
      ? Math.min(
          Math.max(
            Math.round(
              ((real.tempoMedio.atual - FAIXA_ALVO[0]) / (FAIXA_ALVO[1] - FAIXA_ALVO[0])) * 100,
            ),
            0,
          ),
          100,
        )
      : 0,
  },

  /* "Não declarou" é o resto da base — e é a verdade: quase ninguém foi
     perguntado ainda. O ClickUp só marca quem confirmou; quem respondeu "não"
     não é contado à parte pela extração, então entra no resto. */
  /* Percentuais sobre `base` = quem RESPONDEU a pergunta (não sobre os cadastros: seria
     sempre 0% e mediria cobertura da pesquisa, não intenção). O rótulo do card mostra
     "base N", então a amostra fica à vista.

     `nao` vinha fixo em 0 e `nd` era o complemento — a faixa vermelha nunca aparecia e
     voto contrário sumia da tela mesmo estando gravado. Agora as três faixas vêm do dado.
     `nd` fecha em 100 para a barra não deixar sobra por arredondamento. */
  intencao: real.intencao.map((i) => {
    const pct = (n: number) => (i.base ? Math.round((n / i.base) * 100) : 0);
    const sim = pct(i.sim);
    const nao = pct(i.nao);
    return { rotulo: i.rotulo, base: i.base, sim, nao, nd: Math.max(0, 100 - sim - nao) };
  }),

  equipeTotal: CONFIG_CAMPANHA.equipeTotal,
  telefonistas: real.telefonistas,

  votosPorCidade: barras(real.votosPorCidade, "good"),
  motivosNaoContato: barras(
    real.motivosNaoContato.map((m) => ({ rotulo: m.rotulo, n: m.n })),
    "warn",
  ),

  sla: real.sla,
  cobertura: real.cobertura,
  };
}

/** Painel vazio — usado no primeiro render, antes da telemetria chegar. */
export const CAMPANHA_VAZIA: Campanha = montarCampanha(CAMPANHA_REAL_VAZIO);

/** Compat: a extração agora é ao vivo; a idade real vem do campo `idadeS` da rota. */
export const CAMPANHA_GERADA_EM: string | null = null;

/** Há telemetria suficiente para o painel dizer alguma coisa? */
export const campanhaTemDados = (real: CampanhaReal): boolean => real.totalLigacoes > 0;
