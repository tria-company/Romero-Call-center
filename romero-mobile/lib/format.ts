/* ── Formatação pt-BR. Sem dependências: Intl resolve tudo. ─────────────── */

const nf0 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtInt = (n: number) => nf0.format(Math.round(n));
export const fmtDec1 = (n: number) => nf1.format(n);
export const fmtDec2 = (n: number) => nf2.format(n);
export const fmtPct = (n: number, casas = 1) =>
  `${(casas === 0 ? nf0 : nf1).format(n)}%`;

/** 12.400 → "12,4 mil". Para números grandes em espaço apertado. */
export function fmtCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${nf1.format(n / 1_000_000)} mi`;
  if (Math.abs(n) >= 10_000) return `${nf1.format(n / 1000)} mil`;
  return nf0.format(Math.round(n));
}

/* ── Datas ─────────────────────────────────────────────────────────────── */

const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const DIAS_CURTO = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MESES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

export const toDate = (iso: string | Date) => (iso instanceof Date ? iso : new Date(iso));

/** Meia-noite local do dia da data. Base de toda comparação por dia. */
export function inicioDoDia(d: string | Date): Date {
  const x = toDate(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate());
}

export function mesmoDia(a: string | Date, b: string | Date): boolean {
  return inicioDoDia(a).getTime() === inicioDoDia(b).getTime();
}

/** Diferença em dias de calendário (b − a). Hoje→amanhã = 1. */
export function diasEntre(a: string | Date, b: string | Date): number {
  const MS = 86_400_000;
  return Math.round((inicioDoDia(b).getTime() - inicioDoDia(a).getTime()) / MS);
}

export const fmtHora = (d: string | Date) =>
  toDate(d).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

export const fmtData = (d: string | Date) =>
  toDate(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

export const fmtDataCurta = (d: string | Date) =>
  toDate(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });

export const fmtDataHora = (d: string | Date) => `${fmtData(d)} às ${fmtHora(d)}`;

/** "Hoje", "Amanhã", "Ontem", "sexta, 12 de julho" — cabeçalho de grupo. */
export function fmtDiaRelativo(d: string | Date, agora: Date = new Date()): string {
  const delta = diasEntre(agora, d);
  if (delta === 0) return "Hoje";
  if (delta === 1) return "Amanhã";
  if (delta === -1) return "Ontem";
  const x = toDate(d);
  const base = `${DIAS[x.getDay()]}, ${x.getDate()} de ${MESES[x.getMonth()]}`;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export const diaCurto = (d: string | Date) => DIAS_CURTO[toDate(d).getDay()];

/** "há 3 dias", "em 2 h", "agora". */
export function fmtRelativo(d: string | Date, agora: Date = new Date()): string {
  const ms = toDate(d).getTime() - agora.getTime();
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60_000);
  const passado = ms < 0;
  const p = (t: string) => (passado ? `há ${t}` : `em ${t}`);
  if (min < 1) return "agora";
  if (min < 60) return p(`${min} min`);
  const h = Math.round(min / 60);
  if (h < 24) return p(`${h} h`);
  const dias = Math.abs(diasEntre(agora, d));
  if (dias === 1) return passado ? "ontem" : "amanhã";
  if (dias < 30) return p(`${dias} dias`);
  const meses = Math.round(dias / 30);
  return p(meses === 1 ? "1 mês" : `${meses} meses`);
}

/** Sem "há"/"em": só a magnitude. Ex.: "3 dias". */
export function fmtDuracao(dias: number): string {
  if (dias < 1) return "menos de 1 dia";
  if (dias === 1) return "1 dia";
  if (dias < 30) return `${Math.round(dias)} dias`;
  const m = Math.round(dias / 30);
  return m === 1 ? "1 mês" : `${m} meses`;
}

/** Horas com uma casa: 3.4 → "3,4 h"; menos de 1 h vira minutos. */
export function fmtHoras(h: number): string {
  if (!isFinite(h) || h <= 0) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${nf1.format(h)} h`;
  return fmtDuracao(h / 24);
}

/** Chave YYYY-MM-DD local (não UTC — `toISOString` erra o dia no Brasil). */
export function chaveDia(d: string | Date): string {
  const x = toDate(d);
  const mm = String(x.getMonth() + 1).padStart(2, "0");
  const dd = String(x.getDate()).padStart(2, "0");
  return `${x.getFullYear()}-${mm}-${dd}`;
}

/** Valor para <input type="datetime-local"> — precisa ser hora LOCAL. */
export function paraInputDateTime(d: string | Date): string {
  const x = toDate(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
}

export const primeiroNome = (nome: string) => nome.trim().split(/\s+/)[0] ?? "";

/**
 * Prazo curto, do jeito que a tela de Equipe fala: "4h", "2d", "vencida".
 * Abaixo de 48h conta em horas, porque é nessa faixa que a equipe age.
 */
export function fmtPrazoCurto(horas: number): string {
  if (horas <= 0) return "vencida";
  if (horas < 1) return `${Math.max(1, Math.round(horas * 60))}min`;
  if (horas < 48) return `${Math.round(horas)}h`;
  return `${Math.round(horas / 24)}d`;
}

/** "2:38" — duração de ligação, do jeito que a operação lê no relógio. */
export function fmtMinSeg(segundos: number): string {
  const s = Math.max(0, Math.round(segundos));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "2h20" — tempo estimado para terminar a fila. */
export function fmtDuracaoCurta(minutos: number): string {
  if (minutos < 60) return `${Math.round(minutos)}min`;
  const h = Math.floor(minutos / 60);
  const m = Math.round(minutos % 60);
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

/** "Quarta, 5 de agosto" — o subtítulo da tela de Início. */
export function fmtDiaPorExtenso(d: string | Date = new Date()): string {
  const x = toDate(d);
  const dia = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"][x.getDay()];
  const mes = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
  ][x.getMonth()];
  return `${dia}, ${x.getDate()} de ${mes}`;
}

export function saudacao(agora: Date = new Date()): string {
  const h = agora.getHours();
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

/**
 * Nome curto para subtítulo. Conta apenas palavras CHEIAS, então preposições
 * não gastam a cota — "Maria das Graças Silva" vira "Maria das Graças", e não
 * "Maria das", que era como o corte ingênuo terminava.
 */
export function nomeCurto(nome: string, palavras = 2): string {
  const stop = new Set(["da", "das", "de", "do", "dos", "e"]);
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cheias = 0;
  for (const w of partes) {
    out.push(w);
    if (!stop.has(w.toLowerCase())) cheias++;
    if (cheias >= palavras) break;
  }
  return out.join(" ");
}
