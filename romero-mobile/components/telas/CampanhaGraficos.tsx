import type { DiaCampanha, Tendencia, TomCampanha } from "@/lib/campanha";

/* ══════════════════════════════════════════════════════════════════════════
   GRÁFICOS DA CENTRAL DE CAMPANHA

   Traduções diretas dos SVG de `ROMERO/central-campanha-romero.html`: mesmo
   viewBox, mesma escala, mesmas cotas. A diferença é que ali os pontos estão
   escritos à mão na marcação e aqui saem da série — o desenho é o mesmo, e
   mudar um número da semente move a linha em vez de mentir.

   Uma adaptação: o mockup usa `font-size:9` no eixo. Dentro do aparelho de
   400px daquele arquivo, 9 unidades do viewBox de 640 viram 4,6px de tela —
   ilegível. Aqui o eixo vale 14 unidades (~7px no celular, ~13px no rail), na
   mesma linha do "DIFERENÇA DELIBERADA" que o design system já assume: o
   mockup desenha uma tela, o app precisa de uma que escale.
   ══════════════════════════════════════════════════════════════════════════ */

export const COR: Record<TomCampanha, string> = {
  accent: "var(--accent)",
  accent2: "var(--accent2)",
  good: "var(--good)",
  warn: "var(--warn)",
  crit: "var(--crit)",
};

/* ── Votos acumulados vs meta · toda a campanha ────────────────────────── */

const L = 40; // margem esquerda: onde começa a grade
const R = 620; // margem direita
const TOPO = 20; // y da meta cheia
const BASE = 190; // y do zero

export function GraficoAcumulado({
  serie,
  meta,
  totalDias,
  diaProjecao,
}: {
  serie: DiaCampanha[];
  meta: number;
  totalDias: number;
  diaProjecao: number;
}) {
  const dia = serie.length; // hoje é o último dia com número
  // Sem dia nenhum não há o que desenhar — e `serie[dia - 1]` abaixo seria
  // `serie[-1]`, que estoura. Quem chama já mostra "sem dados"; isto é cinto.
  if (dia === 0) return null;

  const x = (d: number) => L + ((d - 1) * (R - L)) / (totalDias - 1);
  const y = (v: number) => BASE - (v / meta) * (BASE - TOPO);

  const pontos = serie.map((d, i) => `${x(i + 1)},${y(d.acumulado)}`).join(" ");
  const hoje = { cx: x(dia), cy: y(serie[dia - 1].acumulado) };
  const rotuloMeta = `${Math.round(meta / 1000)}k`;
  /** dia sob o qual a etiqueta da meta se apoia */
  const rotulo = Math.round(totalDias * 0.8);

  return (
    <svg
      className="chart"
      viewBox="0 0 640 232"
      role="img"
      aria-label={`Votos acumulados contra a meta de ${meta.toLocaleString("pt-BR")}`}
    >
        {/* grade e escala */}
        <line className="glin" x1={L} y1={TOPO} x2={R} y2={TOPO} />
        <line className="glin" x1={L} y1={(TOPO + BASE) / 2} x2={R} y2={(TOPO + BASE) / 2} />
        <line className="glin" x1={L} y1={BASE} x2={R} y2={BASE} />
        <text className="axis" x="4" y={TOPO + 3}>
          {rotuloMeta}
        </text>
        <text className="axis" x="4" y={(TOPO + BASE) / 2 + 3}>
          {Math.round(meta / 2000)}k
        </text>
        <text className="axis" x="4" y={BASE + 3}>
          0
        </text>

        {/* ritmo ideal: sair de meta/totalDias no d1 e chegar cheio no último */}
        <line
          x1={x(1)}
          y1={y(meta / totalDias)}
          x2={x(totalDias)}
          y2={y(meta)}
          stroke="var(--faint)"
          strokeWidth="1.5"
          strokeDasharray="5 4"
        />
        {/* a etiqueta acompanha a linha por BAIXO. No canto de cima, onde o
            mockup a deixa, ela cai no vão entre a linha ideal e a projeção e
            as três se encavalam. Aqui ela senta a 80% do percurso, onde só
            existe a própria linha. */}
        <text
          className="axis"
          x={x(rotulo)}
          y={y((meta * rotulo) / totalDias) + 22}
          textAnchor="middle"
          style={{ fill: "var(--faint)" }}
        >
          meta {rotuloMeta}
        </text>

        {/* projeção: do ponto de hoje até cruzar a meta, e daí reta */}
        <polyline
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.6"
          strokeDasharray="3 3"
          points={`${hoje.cx},${hoje.cy} ${x(diaProjecao)},${y(meta)} ${x(totalDias)},${y(meta)}`}
        />

        {/* realizado */}
        <polygon
          fill="var(--accent)"
          opacity=".10"
          points={`${pontos} ${hoje.cx},${BASE} ${x(1)},${BASE}`}
        />
        <polyline
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.6"
          strokeLinejoin="round"
          points={pontos}
        />
        <circle cx={hoje.cx} cy={hoje.cy} r="4" fill="var(--accent)" />

        {/* eixo do tempo */}
        <text className="axis" x={x(1) - 4} y="206">
          d1
        </text>
        <text className="axis" x={hoje.cx} y="206" textAnchor="middle">
          hoje
        </text>
        <text className="axis" x={x(diaProjecao)} y="206" textAnchor="middle">
          d{diaProjecao}
        </text>
        <text className="axis" x={x(totalDias)} y="206" textAnchor="end">
          d{totalDias}
        </text>
    </svg>
  );
}

/* ── Produção diária · ligações e contatos ─────────────────────────────── */

export function GraficoProducao({ serie }: { serie: DiaCampanha[] }) {
  // `Math.max()` de lista vazia é -Infinity, e daí toda a escala vira NaN.
  if (serie.length === 0) return null;
  const teto = Math.ceil(Math.max(...serie.map((d) => d.ligacoes))) || 1;
  const piso = 168; // linha de base
  const alturaMax = 150;
  const passo = 48;
  const largura = 38;
  const altura = (v: number) => (v / teto) * alturaMax;

  return (
    <svg
      className="chart"
      viewBox="0 0 640 190"
      role="img"
      aria-label="Ligações e contatos por dia da campanha"
    >
      {serie.map((d, i) => {
        const x = L + i * passo;
        return (
          <g key={i}>
            <rect
              x={x}
              y={piso - altura(d.ligacoes)}
              width={largura}
              height={altura(d.ligacoes)}
              rx="3"
              fill="var(--accent)"
              opacity=".28"
            />
            <rect
              x={x}
              y={piso - altura(d.contatos)}
              width={largura}
              height={altura(d.contatos)}
              rx="3"
              fill="var(--good)"
            />
            <text className="axis" x={x + largura / 2} y="184" textAnchor="middle">
              d{i + 1}
            </text>
          </g>
        );
      })}
      <line className="glin" x1="34" y1={piso} x2={R} y2={piso} />
    </svg>
  );
}

/* ── Tendências (semanal) ──────────────────────────────────────────────── */

export function Tendencias({ itens }: { itens: Tendencia[] }) {
  return (
    <>
      {itens.map((t) => (
        <div key={t.rotulo} className="trend">
          <div className="trend-h">
            <span className="lab">{t.rotulo}</span>
            <strong className="tabnum">{t.valor}</strong>
          </div>
          <svg viewBox="0 0 100 34" preserveAspectRatio="none" className="spark" aria-hidden>
            <polyline
              fill="none"
              stroke={COR[t.tom]}
              strokeWidth="2.5"
              points={t.pontos.map(([x, y]) => `${x},${y}`).join(" ")}
            />
          </svg>
        </div>
      ))}
    </>
  );
}

/* ── Retrato do telefonista ────────────────────────────────────────────── */

const PELE = ["#f3caa4", "#e3ad83", "#cd9163", "#b07845", "#8d5a34", "#f7d9ba"];
const CABELO = ["#241a12", "#4a3423", "#6d4c2c", "#0e0e10", "#8a7660", "#a9662f"];
const FUNDO = ["#d7e6fb", "#e7ddfb", "#d8f2e8", "#fbe2ec", "#fbecd6", "#dfeafb"];
const ROUPA = ["#3b6fd6", "#7c4ddb", "#12855a", "#c0653b", "#2b8f9a", "#5b6675"];

/**
 * Retrato desenhado a partir do índice — o mesmo gerador do mockup.
 * São 150 pessoas na operação e nenhuma foto: um monograma repetiria letras,
 * e um avatar cinza igual para todos apagaria a linha do ranking. Aqui a
 * combinação (pele × cabelo × fundo × roupa) já dá 1.296 rostos distintos.
 */
export function Retrato({ id }: { id: number }) {
  // id do próprio telefonista, e não `useId()`: o recorte precisa de um nome
  // estável entre servidor e cliente, e a lista já garante que ele é único.
  const clip = `retrato-${id}`;
  const pele = PELE[id % 6];
  const cabelo = CABELO[(id * 4 + 1) % 6];
  const fundo = FUNDO[(id * 5) % 6];
  const roupa = ROUPA[(id * 2 + 1) % 6];

  const cortes = [
    <path key="0" d="M11 17 Q20 3 29 17 Q29 9 20 8 Q11 9 11 17 Z" fill={cabelo} />,
    <path key="1" d="M11 18 Q11 6 20 6 Q29 6 29 18 L26 15 Q20 10 14 15 Z" fill={cabelo} />,
    <g key="2">
      <circle cx="20" cy="7.5" r="3.2" fill={cabelo} />
      <path d="M12 17 Q20 6 28 17 Q28 11 20 10 Q12 11 12 17Z" fill={cabelo} />
    </g>,
    <path
      key="3"
      d="M10 21 Q10 6 20 6 Q30 6 30 21 L30 25 L27 25 L27 16 Q20 10 13 16 L13 25 L10 25 Z"
      fill={cabelo}
    />,
  ];

  return (
    <svg viewBox="0 0 40 40" className="avph" aria-hidden>
      <defs>
        <clipPath id={clip}>
          <circle cx="20" cy="20" r="20" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect width="40" height="40" fill={fundo} />
        <ellipse cx="20" cy="42" rx="13" ry="10" fill={roupa} />
        <circle cx="20" cy="19" r="8" fill={pele} />
        {cortes[id % 4]}
      </g>
    </svg>
  );
}
