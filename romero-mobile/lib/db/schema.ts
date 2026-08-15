/* ══════════════════════════════════════════════════════════════════════════
   MODELO DE DADOS — Central Animal

   O ciclo do sistema, na ordem em que as telas o percorrem:

     candidato → fila do dia → lead (pet, atendimentos) → linha do tempo
        → solicitação → equipe → retorno, que volta para a fila.

   Duas regras de domínio moram aqui e valem para o app inteiro:
     1. a FILA é ordenada por motivo (retorno vence aniversário, que vence
        primeiro contato, que vence reaquecimento);
     2. todo contato entra na LINHA DO TEMPO — é ela que sustenta o bloqueio
        de repetição, o único mecanismo que impede o mesmo apoiador de receber
        dois envios no mesmo dia.
   ══════════════════════════════════════════════════════════════════════════ */

/* ── Candidatos ────────────────────────────────────────────────────────── */

export type CandidatoId = "romero" | "andreza";

export type Candidato = {
  id: CandidatoId;
  nome: string;
  cargo: string;
  numero: string;
  emoji: string;
  instagram: string;
  seguidores: number;
  seguidoresHoje: number;
  /** apoio confirmado × meta — é o que enche o foguete */
  apoio: number;
  meta: number;
  apoioHoje: number;
};

/* ── Leads ─────────────────────────────────────────────────────────────── */

export type Especie = "cao" | "gato";

export type Pet = {
  id: string;
  nome: string;
  especie: Especie;
  raca: string;
  idadeAnos: number;
  vivo: boolean;
};

export const TAGS = ["multiplicadora", "romero", "andreza", "indicacoes", "novo"] as const;
export type TagLead = (typeof TAGS)[number];

export type Lead = {
  id: string;
  nome: string;
  idade: number;
  bairro: string;
  cidade: string;
  whatsapp: string;
  /** MM-DD — usado pelo motor da fila para o motivo "aniversário" */
  aniversario: string;
  indicacoes: number;
  confirmou: CandidatoId[];
  multiplicadora: boolean;
  pets: Pet[];
  anotacao?: { texto: string; em: string };
  criadoEm: string;
  ultimoContatoEm?: string;
};

/* ── Atendimentos (o que já foi entregue ao lead) ──────────────────────── */

export const SERVICOS = [
  "castracao",
  "consulta",
  "exame",
  "cirurgia",
  "racao",
  "resgate",
  "denuncia",
  "medicacao",
  "outro",
] as const;
export type Servico = (typeof SERVICOS)[number];

export const SERVICO_LABEL: Record<Servico, string> = {
  castracao: "Castração",
  consulta: "Consulta",
  exame: "Exame",
  cirurgia: "Cirurgia",
  racao: "Ração",
  resgate: "Resgate",
  denuncia: "Denúncia",
  medicacao: "Medicação",
  outro: "Outro",
};

export type Atendimento = {
  id: string;
  leadId: string;
  servico: Servico;
  detalhe?: string;
  em: string;
};

/* ── Fila do dia ───────────────────────────────────────────────────────── */

export const MOTIVOS = ["retorno", "aniversario", "primeiro-contato", "reaquecimento"] as const;
export type Motivo = (typeof MOTIVOS)[number];

export const MOTIVO_LABEL: Record<Motivo, string> = {
  retorno: "Retorno de entrega",
  aniversario: "Aniversário",
  "primeiro-contato": "Primeiro contato",
  reaquecimento: "Reaquecimento",
};

/** Classe do selo no mockup (.why.ret / .ani / .pri / .rea). */
export const MOTIVO_CLASSE: Record<Motivo, string> = {
  retorno: "ret",
  aniversario: "ani",
  "primeiro-contato": "pri",
  reaquecimento: "rea",
};

/** Ordem do motor: quem entregou algo ontem vem antes de todo o resto. */
export const MOTIVO_PESO: Record<Motivo, number> = {
  retorno: 0,
  aniversario: 1,
  "primeiro-contato": 2,
  reaquecimento: 3,
};

export type ItemFila = {
  id: string;
  leadId: string;
  motivo: Motivo;
  detalhe: string;
  feito: boolean;
  feitoEm?: string;
  /** dia da fila (YYYY-MM-DD local) */
  dia: string;
};

/* ── Linha do tempo ────────────────────────────────────────────────────── */

export type TipoInteracao =
  | "ligacao"
  | "video"
  | "audio"
  | "mensagem"
  | "atendimento"
  | "nota";

export type AutorInteracao = "voce" | "romero" | "andreza" | "equipe";

export type StatusEnvio = "visto-respondeu" | "visto-sem-resposta" | "nao-visto";

export type Interacao = {
  id: string;
  leadId: string;
  tipo: TipoInteracao;
  autor: AutorInteracao;
  titulo: string;
  subtitulo?: string;
  em: string;
  status?: StatusEnvio;
  /** minutos até a resposta, quando houve */
  respostaMin?: number;
  /** selo extra: "Gerou tarefa de retorno", "Virou solicitação #4471"… */
  selo?: string;
};

/* ── Solicitações ──────────────────────────────────────────────────────── */

export type TipoSolicitacao = "veterinaria" | "financeira" | "outros";

export const TIPO_SOLICITACAO_LABEL: Record<TipoSolicitacao, string> = {
  veterinaria: "Veterinária",
  financeira: "Financeira",
  outros: "Outros",
};

/** Opções de "Qual" por tipo — o formulário é todo em botões. */
export const QUAIS_POR_TIPO: Record<TipoSolicitacao, Servico[]> = {
  veterinaria: ["consulta", "castracao", "exame", "cirurgia"],
  financeira: ["racao", "medicacao", "outro"],
  outros: ["resgate", "denuncia", "outro"],
};

export type Prioridade = 1 | 2 | 3;

/** Prazo de cada prioridade, em horas. */
export const PRAZO_HORAS: Record<Prioridade, number> = { 1: 24, 2: 72, 3: 168 };
export const PRIORIDADE_LABEL: Record<Prioridade, string> = {
  1: "1 · 24h",
  2: "2 · 72h",
  3: "3 · 7 dias",
};

export type StatusSolicitacao = "aberta" | "assumida" | "resolvida";

export type Solicitacao = {
  id: string;
  /** número curto e legível, o que a equipe fala em voz alta */
  codigo: number;
  leadId: string;
  tipo: TipoSolicitacao;
  qual: Servico;
  observacao: string;
  prioridade: Prioridade;
  status: StatusSolicitacao;
  responsavel?: string;
  criadaEm: string;
  prazo: string;
  assumidaEm?: string;
  resolvidaEm?: string;
  /** true quando a resolução já devolveu a tarefa de retorno para a fila */
  retornoGerado?: boolean;
};

/* ── Painel (números que vêm do CRM, não da base local) ────────────────── */

export type Painel = {
  cadastros: number;
  apoiadoresAtivos: number;
  apoiadoresHoje: number;
  /** membros do grupo de operação que recebe as solicitações */
  equipeTamanho: number;
  equipeOnline: number;
};

/* ── Banco ─────────────────────────────────────────────────────────────── */

/* A Central de Campanha NÃO mora aqui. Os números dela nunca mudam, então são
   uma constante em `lib/campanha.ts` — fora do banco, fora do localStorage e
   fora da hidratação. Ver o comentário lá. */

export type Banco = {
  versao: number;
  painel: Painel;
  candidatos: Candidato[];
  leads: Lead[];
  atendimentos: Atendimento[];
  fila: ItemFila[];
  interacoes: Interacao[];
  solicitacoes: Solicitacao[];
  /** último código emitido, para o próximo #NNNN */
  ultimoCodigo: number;
};

/* ── Derivações ────────────────────────────────────────────────────────── */

export function iniciais(nome: string): string {
  const p = nome.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return "?";
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

/**
 * "34 anos · Boa Viagem, Recife" — a linha de baixo do nome.
 *
 * Omite o que faltar em vez de imprimir "0 anos · , ": a base real do ClickUp
 * não tem idade, e nem toda ficha tem bairro.
 */
export function resumoLead(l: Pick<Lead, "idade" | "bairro" | "cidade">): string {
  const partes: string[] = [];
  if (l.idade > 0) partes.push(`${l.idade} anos`);
  const lugar = [l.bairro, l.cidade].filter(Boolean).join(", ");
  if (lugar) partes.push(lugar);
  return partes.join(" · ") || "Sem endereço na base";
}

export function solicitacaoAberta(s: Solicitacao): boolean {
  return s.status === "aberta" || s.status === "assumida";
}

export function atrasada(s: Solicitacao, agora: Date = new Date()): boolean {
  return solicitacaoAberta(s) && new Date(s.prazo).getTime() < agora.getTime();
}

/** Horas que faltam para o prazo. Negativo = já venceu. */
export function horasAtePrazo(s: Solicitacao, agora: Date = new Date()): number {
  return (new Date(s.prazo).getTime() - agora.getTime()) / 3_600_000;
}
