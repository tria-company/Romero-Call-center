/* ══════════════════════════════════════════════════════════════════════════
   SEMENTE — base de exemplo determinística.

   Os números de tela do mockup são reproduzidos EXATAMENTE: 84.312 e 61.847
   seguidores, 150.000 cadastros, 18.427 apoiadores ativos, fila de 47 com 12
   feitas, 12 solicitações abertas com 3 vencendo hoje, Romero 14.208/21.500 e
   Andreza 13.940/21.500. Os cinco leads nomeados da tela 02 e a linha do tempo
   da Maria das Graças também vêm palavra por palavra de lá.

   O resto da base é gerado por um PRNG semeado, para a mesma semente produzir
   sempre a mesma base. As DATAS, porém, são relativas ao primeiro boot — é o
   que faz existir aniversário hoje, solicitação vencendo hoje e retorno de
   ontem.

   NOMES E TELEFONES SÃO FICTÍCIOS.
   ══════════════════════════════════════════════════════════════════════════ */

import type {
  Atendimento,
  AutorInteracao,
  Banco,
  Candidato,
  Especie,
  Interacao,
  ItemFila,
  Lead,
  Motivo,
  Pet,
  Prioridade,
  Servico,
  Solicitacao,
  TipoSolicitacao,
} from "./schema";
import { PRAZO_HORAS } from "./schema";

/**
 * Subir este número descarta a base local e re-semeia (ver `store.ler`).
 *
 * REGRA: mexeu em QUALQUER COISA que este arquivo gera, suba o número na mesma
 * edição. Quem já abriu o app fica com a base antiga para sempre — o `store`
 * só re-semeia quando a versão gravada difere desta. Foi assim que uma base
 * v2 sem linha do tempo sobreviveu à criação da linha do tempo: o número já
 * tinha sido subido antes, e a mudança seguinte entrou de graça.
 *
 * Aba anônima e teste automatizado NÃO pegam esse caso: eles sempre começam
 * com localStorage vazio, então a semente nova roda e tudo parece certo.
 *
 * v3 — linha do tempo para toda a base
 * v4 — cada entrega narrada uma vez só: janela de 3 dias contra o duplo
 *      registro (mão × gerado) e um serviço por ficha contra o título repetido
 *
 * A v5 existiu por algumas horas (bloco `campanha` no banco) e foi RETIRADA:
 * aqueles números nunca mudam, então viraram constante em `lib/campanha.ts` e
 * o banco voltou a ter exatamente a forma da v4. Voltar o número para 4 é de
 * propósito — é o que descarta os bancos gravados como v5, inclusive os que
 * pegaram a versão nova ANTES do campo existir e travavam a tela num esqueleto
 * eterno. O aviso acima não é teórico: aconteceu de novo, do mesmo jeito.
 *
 * v6 — entrou a BASE REAL do ClickUp (`lib/db/reais.json`, ver `reais.ts`).
 *      O formato do `Banco` não mudou; o CONTEÚDO sim, e quem já abriu o app
 *      tem uma base fictícia v4 gravada que nunca sairia sozinha do caminho.
 *      Pulamos o 5 de propósito: aquele número já foi usado pelo bloco
 *      `campanha` que existiu por algumas horas, e algum navegador pode ter
 *      ficado com um blob marcado v5. Ir para 6 descarta os dois.
 */
export const VERSAO_BANCO = 6;

const DIA = 86_400_000;
const HORA = 3_600_000;

/* ── PRNG ──────────────────────────────────────────────────────────────── */

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rnd = () => number;
const inteiro = (r: Rnd, min: number, max: number) => min + Math.floor(r() * (max - min + 1));
const escolher = <T,>(r: Rnd, a: readonly T[]): T => a[Math.floor(r() * a.length)];

/** Sorteio ponderado: `[valor, peso]`. */
function ponderado<T>(r: Rnd, pares: readonly (readonly [T, number])[]): T {
  const total = pares.reduce((s, p) => s + p[1], 0);
  let x = r() * total;
  for (const [v, p] of pares) {
    x -= p;
    if (x <= 0) return v;
  }
  return pares[pares.length - 1][0];
}

let seq = 0;
const uid = (p: string) => `${p}_${(++seq).toString(36)}`;

/* ── Vocabulário ───────────────────────────────────────────────────────── */

const NOMES_F = [
  "Maria das Graças Silva", "Adrienne Martins Vianna", "Luzia Siqueira Santos",
  "Márcia de Oliveira", "Josefa Bezerra Lima", "Rosângela Ferreira",
  "Cláudia Vasconcelos", "Edna Farias Ramos", "Severina Gomes",
  "Gilvanete Alves Coelho", "Rejane Monteiro", "Marluce Tavares",
  "Simone Correia Melo", "Patrícia Amorim", "Vanessa Leite Souza",
  "Cristiane Nascimento", "Elaine Barbosa", "Jaqueline Marinho",
  "Sandra Rodrigues", "Aline Cavalcanti", "Débora Siqueira Araújo",
  "Michele Andrade", "Renata Pereira", "Tatiane Farias",
];
const NOMES_M = [
  "José Bezerra da Mata", "Severino Ramos Filho", "Cícero Alves Barbosa",
  "Ednaldo Monteiro", "Jailson da Silva Melo", "Robson Coelho Lima",
  "Anderson Tavares", "Wellington Souza Amorim", "Gilberto Nascimento",
  "Francisco das Chagas Leite",
];

const BAIRROS: readonly (readonly [string, string])[] = [
  ["Ibura", "Recife"], ["Nova Descoberta", "Recife"], ["Vasco da Gama", "Recife"],
  ["Casa Amarela", "Recife"], ["Cordeiro", "Recife"], ["Afogados", "Recife"],
  ["Imbiribeira", "Recife"], ["Água Fria", "Recife"], ["Dois Unidos", "Recife"],
  ["Janga", "Paulista"], ["Maranguape II", "Paulista"],
  ["Piedade", "Jaboatão"], ["Candeias", "Jaboatão"],
  ["Rio Doce", "Olinda"], ["Peixinhos", "Olinda"],
  ["Salgado", "Caruaru"], ["Timbi", "Camaragibe"],
];

const NOMES_PET = [
  "Thor", "Mel", "Bidu", "Nina", "Frajola", "Pretinha", "Luna", "Bob",
  "Amora", "Simba", "Cacau", "Chico", "Malu", "Pipoca", "Toby", "Jujuba",
  "Rex", "Mimi", "Bento", "Maya", "Bolinha", "Nala",
];
const RACAS_CAO = ["SRD", "Pinscher", "Poodle", "Shih Tzu", "Yorkshire", "Pitbull"];
const RACAS_GATO = ["SRD", "Siamês", "Persa", "Angorá"];

const EQUIPE = ["Carla", "Andreza", "Raíssa", "Léo", "Beto"];

const ORIGENS = [
  "Landing page",
  "Guru",
  "Central Animal",
  "WhatsApp da Andreza",
  "Redes sociais",
  "Indicação de apoiador",
  "Mutirão de castração",
];

const CLINICAS = [
  "Clínica São Francisco",
  "Upinha Vet",
  "Centro de Zoonoses",
  "Clínica Amigo Fiel",
];

/** Assunto dos envios, por canal. Frases curtas: a linha do tempo é escaneada. */
const ASSUNTOS: Record<string, string[]> = {
  mensagem: [
    "Confirmação de data e endereço",
    "Lembrete do jejum antes do procedimento",
    "Retorno sobre a fila de castração",
    "Aviso do mutirão no bairro",
  ],
  audio: [
    "Explicação sobre o pós-operatório",
    "Resposta à dúvida sobre vacina",
    "Recado sobre a documentação",
  ],
  video: [
    "Convite para o mutirão",
    "Recado sobre a campanha de castração",
    "Agradecimento pelo apoio",
  ],
  ligacao: [
    "3 minutos · confirmou presença",
    "6 minutos · pediu ajuda para a vizinha",
    "2 minutos · não atendeu, deixou recado",
    "8 minutos · atualizou o cadastro",
  ],
};

/* ── Helpers ───────────────────────────────────────────────────────────── */

const chaveDia = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const mmdd = (d: Date) =>
  `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function comHora(base: Date, h: number, m = 0): Date {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * `dias` atrás, em hora de expediente sorteada.
 * Sem isso todo registro herda a hora do boot e a linha do tempo inteira sai
 * marcada com o mesmo horário — o que denuncia dado gerado.
 */
function emDiaAleatorio(r: Rnd, agora: Date, dias: number): Date {
  const d = new Date(agora.getTime() - dias * DIA);
  d.setHours(inteiro(r, 8, 18), escolher(r, [0, 10, 15, 20, 30, 40, 45, 50]), 0, 0);
  return d;
}

function telefone(r: Rnd): string {
  return `81${inteiro(r, 90000000, 99999999)}`;
}

/** `n` nomes de pet sem repetição dentro da mesma casa. */
function nomesDistintos(r: Rnd, n: number): string[] {
  const out: string[] = [];
  let tentativas = 0;
  while (out.length < n && tentativas++ < 30) {
    const nome = escolher(r, NOMES_PET);
    if (!out.includes(nome)) out.push(nome);
  }
  return out;
}

function pet(r: Rnd, nome?: string, especie?: Especie, vivo = true): Pet {
  const esp: Especie = especie ?? (r() < 0.55 ? "gato" : "cao");
  return {
    id: uid("pet"),
    nome: nome ?? escolher(r, NOMES_PET),
    especie: esp,
    raca: escolher(r, esp === "cao" ? RACAS_CAO : RACAS_GATO),
    idadeAnos: inteiro(r, 1, 12),
    vivo,
  };
}

/* ── Candidatos ────────────────────────────────────────────────────────── */

function candidatos(): Candidato[] {
  return [
    {
      id: "romero",
      nome: "Romero",
      cargo: "Deputado Estadual",
      numero: "40000",
      emoji: "🐶",
      instagram: "@romeroalbuquerque40000",
      seguidores: 84312,
      seguidoresHoje: 218,
      apoio: 14208,
      meta: 21500,
      apoioHoje: 184,
    },
    {
      id: "andreza",
      nome: "Andreza",
      cargo: "Deputada Federal",
      numero: "4020",
      emoji: "🐱",
      instagram: "@andrezaromero",
      seguidores: 61847,
      seguidoresHoje: 174,
      apoio: 13940,
      meta: 21500,
      apoioHoje: 176,
    },
  ];
}

/* ── Base ──────────────────────────────────────────────────────────────── */

/** Os cinco leads da tela 02, com nome, pet e motivo idênticos ao mockup. */
type Semeado = {
  nome: string;
  idade: number;
  bairro: [string, string];
  pets: { nome: string; especie: Especie; raca?: string; idade?: number; vivo?: boolean }[];
  motivo: Motivo;
  detalhe: string;
  multiplicadora?: boolean;
  indicacoes?: number;
  confirmou?: ("romero" | "andreza")[];
  anotacao?: string;
  aniversarioHoje?: boolean;
  diasSemContato?: number;
};

const DESTAQUES: Semeado[] = [
  {
    nome: "Maria das Graças Silva",
    idade: 62,
    bairro: ["Ibura", "Recife"],
    pets: [{ nome: "Thor", especie: "cao", raca: "SRD", idade: 7 }],
    motivo: "retorno",
    detalhe: "Thor · castração entregue ontem",
    multiplicadora: true,
    indicacoes: 6,
    confirmou: ["romero"],
    anotacao:
      "Perguntou pela recuperação do Thor. Falou que a vizinha também precisa castrar a gata.",
  },
  {
    nome: "José Bezerra da Mata",
    idade: 62,
    bairro: ["Cordeiro", "Recife"],
    pets: [
      { nome: "Mel", especie: "cao", raca: "SRD", idade: 5 },
      { nome: "Bidu", especie: "cao", raca: "Pinscher", idade: 9 },
    ],
    motivo: "aniversario",
    detalhe: "Faz 62 anos hoje · Mel e Bidu",
    aniversarioHoje: true,
    confirmou: ["romero", "andreza"],
    indicacoes: 2,
  },
  {
    nome: "Adrienne Martins Vianna",
    idade: 41,
    bairro: ["Nova Descoberta", "Recife"],
    pets: [{ nome: "Luna", especie: "gato", raca: "SRD", idade: 3 }],
    motivo: "primeiro-contato",
    detalhe: "Trouxe 6 vizinhas para o mutirão",
    multiplicadora: true,
    indicacoes: 6,
  },
  {
    nome: "Luzia Siqueira Santos",
    idade: 57,
    bairro: ["Água Fria", "Recife"],
    pets: [{ nome: "Pretinha", especie: "cao", raca: "SRD", idade: 11 }],
    motivo: "reaquecimento",
    detalhe: "Sem contato há 74 dias",
    diasSemContato: 74,
    confirmou: ["andreza"],
  },
  {
    nome: "Márcia de Oliveira",
    idade: 48,
    bairro: ["Imbiribeira", "Recife"],
    pets: [{ nome: "Frajola", especie: "gato", raca: "SRD", idade: 6 }],
    motivo: "retorno",
    detalhe: "Exame do Frajola concluído",
    confirmou: ["romero"],
    indicacoes: 1,
  },
];

/* ── Geração ───────────────────────────────────────────────────────────── */

const TOTAL_FILA = 47;
const FILA_FEITAS = 12;
const TOTAL_LEADS = 96;

export function criarBancoSemente(): Banco {
  const r = mulberry32(20260806);
  const agora = new Date();
  const hoje = chaveDia(agora);

  const leads: Lead[] = [];
  const atendimentos: Atendimento[] = [];
  const interacoes: Interacao[] = [];
  const fila: ItemFila[] = [];
  const solicitacoes: Solicitacao[] = [];

  /* destaques — os cinco nomeados no mockup */
  const idsDestaque: string[] = [];
  for (const d of DESTAQUES) {
    const lead: Lead = {
      id: uid("ld"),
      nome: d.nome,
      idade: d.idade,
      bairro: d.bairro[0],
      cidade: d.bairro[1],
      whatsapp: telefone(r),
      aniversario: d.aniversarioHoje
        ? mmdd(agora)
        : mmdd(new Date(agora.getTime() + inteiro(r, 20, 300) * DIA)),
      indicacoes: d.indicacoes ?? 0,
      confirmou: d.confirmou ?? [],
      multiplicadora: !!d.multiplicadora,
      pets: d.pets.map((p) =>
        pet(r, p.nome, p.especie, p.vivo ?? true),
      ).map((p, i) => ({
        ...p,
        raca: d.pets[i].raca ?? p.raca,
        idadeAnos: d.pets[i].idade ?? p.idadeAnos,
      })),
      anotacao: d.anotacao
        ? { texto: d.anotacao, em: new Date(agora.getTime() - 115 * DIA).toISOString() }
        : undefined,
      criadoEm: new Date(agora.getTime() - inteiro(r, 200, 500) * DIA).toISOString(),
      ultimoContatoEm:
        d.diasSemContato != null
          ? new Date(agora.getTime() - d.diasSemContato * DIA).toISOString()
          : new Date(agora.getTime() - inteiro(r, 1, 14) * DIA).toISOString(),
    };
    leads.push(lead);
    idsDestaque.push(lead.id);
  }

  const maria = leads[0];
  const jose = leads[1];
  const marcia = leads[4];

  /* atendimentos da Maria — os três da tela 03 */
  atendimentos.push(
    {
      id: uid("at"),
      leadId: maria.id,
      servico: "castracao",
      detalhe: "Thor",
      em: new Date(agora.getTime() - 1 * DIA).toISOString(),
    },
    {
      id: uid("at"),
      leadId: maria.id,
      servico: "consulta",
      detalhe: "Thor",
      em: new Date(agora.getTime() - 32 * DIA).toISOString(),
    },
    {
      id: uid("at"),
      leadId: maria.id,
      servico: "exame",
      detalhe: "Exame de sangue",
      em: new Date(agora.getTime() - 146 * DIA).toISOString(),
    },
  );
  atendimentos.push({
    id: uid("at"),
    leadId: marcia.id,
    servico: "exame",
    detalhe: "Frajola",
    em: new Date(agora.getTime() - 1 * DIA).toISOString(),
  });

  /* linha do tempo da Maria — os cinco registros da tela 04 */
  interacoes.push(
    {
      id: uid("it"),
      leadId: maria.id,
      tipo: "atendimento",
      autor: "equipe",
      titulo: "Castração do Thor concluída",
      subtitulo: "Clínica São Francisco · agendado por Carla",
      em: comHora(agora, 8, 12).toISOString(),
      selo: "Gerou tarefa de retorno",
      status: "visto-respondeu",
    },
    {
      id: uid("it"),
      leadId: maria.id,
      tipo: "video",
      autor: "andreza",
      titulo: "Andreza enviou vídeo",
      subtitulo: "Convite para o mutirão do Ibura",
      em: comHora(new Date(agora.getTime() - 3 * DIA), 19, 40).toISOString(),
      status: "visto-respondeu",
      respostaMin: 12,
    },
    {
      id: uid("it"),
      leadId: maria.id,
      tipo: "ligacao",
      autor: "voce",
      titulo: "Você ligou",
      subtitulo: "6 minutos · pediu castração para a gata da vizinha",
      em: comHora(new Date(agora.getTime() - 8 * DIA), 14, 5).toISOString(),
      selo: "Virou solicitação #4471",
    },
    {
      id: uid("it"),
      leadId: maria.id,
      tipo: "audio",
      autor: "voce",
      titulo: "Você enviou áudio",
      subtitulo: "Pergunta sobre a recuperação do Thor",
      em: comHora(new Date(agora.getTime() - 16 * DIA), 9, 30).toISOString(),
      status: "visto-sem-resposta",
    },
    {
      id: uid("it"),
      leadId: maria.id,
      tipo: "video",
      autor: "voce",
      titulo: "Você enviou vídeo",
      subtitulo: "Primeiro contato após a consulta",
      em: comHora(new Date(agora.getTime() - 115 * DIA), 16, 22).toISOString(),
      status: "visto-respondeu",
    },
  );

  /* resto da base */
  const usados = new Set(leads.map((l) => l.nome));
  while (leads.length < TOTAL_LEADS) {
    const feminino = r() < 0.72;
    const pool = feminino ? NOMES_F : NOMES_M;
    let nome = escolher(r, pool);
    if (usados.has(nome)) {
      nome = `${nome.split(" ")[0]} ${escolher(r, ["Souza", "Lima", "Ramos", "Alves", "Barbosa", "Gomes"])}`;
      if (usados.has(nome)) continue;
    }
    usados.add(nome);

    const [bairro, cidade] = escolher(r, BAIRROS);
    const diasDesdeCadastro = inteiro(r, 10, 620);
    const criadoEm = emDiaAleatorio(r, agora, diasDesdeCadastro);
    const nPets = r() < 0.25 ? 2 : 1;
    const idadeLead = inteiro(r, 22, 74);
    // 4 aniversariantes hoje, o resto espalhado no ano
    const fazAniversarioHoje = leads.length >= TOTAL_LEADS - 4;

    leads.push({
      id: uid("ld"),
      nome,
      idade: idadeLead,
      bairro,
      cidade,
      whatsapp: telefone(r),
      aniversario: fazAniversarioHoje
        ? mmdd(agora)
        : mmdd(new Date(agora.getTime() + inteiro(r, 5, 350) * DIA)),
      indicacoes: r() < 0.3 ? inteiro(r, 1, 8) : 0,
      confirmou: [
        ...(r() < 0.55 ? (["romero"] as const) : []),
        ...(r() < 0.48 ? (["andreza"] as const) : []),
      ],
      multiplicadora: r() < 0.16,
      // nomes distintos: dois pets homônimos na mesma casa ("Nina e Nina")
      // parecem erro de cadastro, não coincidência
      pets: nomesDistintos(r, nPets).map((n) => pet(r, n, undefined, r() > 0.06)),
      criadoEm: criadoEm.toISOString(),
      // o contato nunca pode ser anterior ao cadastro
      ultimoContatoEm:
        r() < 0.82
          ? emDiaAleatorio(r, agora, inteiro(r, 1, Math.max(1, diasDesdeCadastro - 1))).toISOString()
          : undefined,
    });
  }

  /* atendimentos espalhados */
  for (const l of leads.slice(5)) {
    // Nada pode ser datado antes de a pessoa existir na base: um exame
    // anterior ao cadastro aparece fora de ordem na linha do tempo e lê como
    // bug, não como histórico.
    const idadeDias = Math.max(
      2,
      Math.floor((agora.getTime() - new Date(l.criadoEm).getTime()) / DIA),
    );
    const n = inteiro(r, 0, 3);
    const unicos = new Set<Servico>();
    for (let i = 0; i < n; i++) {
      // Um serviço por ficha. Duas consultas em datas diferentes existem na
      // vida real, mas na tela viram duas linhas com o MESMO título — e título
      // repetido lê como erro de cadastro, não como histórico. Variedade de
      // serviço conta a história melhor do que repetição do mesmo.
      const disponiveis = (["castracao", "consulta", "exame", "racao", "medicacao"] as const).filter(
        (s) => !unicos.has(s),
      );
      if (disponiveis.length === 0) break;
      const servico: Servico = escolher(r, disponiveis);
      unicos.add(servico);
      atendimentos.push({
        id: uid("at"),
        leadId: l.id,
        servico,
        detalhe: l.pets[0]?.nome,
        em: emDiaAleatorio(r, agora, inteiro(r, 1, idadeDias - 1)).toISOString(),
      });
    }
  }

  /* ── fila do dia: 47 itens, 12 já feitos ─────────────────────────────── */
  const naFila = new Set<string>();
  const empurrar = (leadId: string, motivo: Motivo, detalhe: string) => {
    if (naFila.has(leadId)) return;
    naFila.add(leadId);
    fila.push({ id: uid("fl"), leadId, motivo, detalhe, feito: false, dia: hoje });
  };

  DESTAQUES.forEach((d, i) => empurrar(idsDestaque[i], d.motivo, d.detalhe));

  // aniversariantes de hoje
  for (const l of leads) {
    if (fila.length >= TOTAL_FILA) break;
    if (l.aniversario === mmdd(agora) && !naFila.has(l.id)) {
      const pets = l.pets.map((p) => p.nome).join(" e ");
      empurrar(l.id, "aniversario", `Faz ${l.idade} anos hoje${pets ? ` · ${pets}` : ""}`);
    }
  }
  // quem nunca foi contatado
  for (const l of leads) {
    if (fila.length >= TOTAL_FILA) break;
    if (!l.ultimoContatoEm && !naFila.has(l.id)) {
      empurrar(l.id, "primeiro-contato", "Entrou pelo cadastro e nunca foi contatado");
    }
  }
  // reaquecimento: contato mais antigo primeiro
  const frios = leads
    .filter((l) => l.ultimoContatoEm && !naFila.has(l.id))
    .sort((a, b) => (a.ultimoContatoEm ?? "").localeCompare(b.ultimoContatoEm ?? ""));
  for (const l of frios) {
    if (fila.length >= TOTAL_FILA) break;
    const dias = Math.round((agora.getTime() - new Date(l.ultimoContatoEm!).getTime()) / DIA);
    empurrar(l.id, "reaquecimento", `Sem contato há ${dias} dias`);
  }

  ordenarFila(fila);
  // as 12 primeiras já foram feitas hoje — menos as dos destaques, que
  // precisam continuar abertas para a tela 02 ficar igual ao mockup
  let feitas = 0;
  for (let i = fila.length - 1; i >= 0 && feitas < FILA_FEITAS; i--) {
    if (idsDestaque.includes(fila[i].leadId)) continue;
    fila[i].feito = true;
    fila[i].feitoEm = new Date(agora.getTime() - inteiro(r, 1, 5) * HORA).toISOString();
    feitas++;
  }

  /* ── solicitações: 12 abertas, 3 vencendo hoje ───────────────────────── */
  let codigo = 4460;
  const abrir = (
    leadId: string,
    tipo: TipoSolicitacao,
    qual: Servico,
    prioridade: Prioridade,
    observacao: string,
    horasRestantes: number,
    responsavel?: string,
  ) => {
    const prazo = new Date(agora.getTime() + horasRestantes * HORA);
    const criadaEm = new Date(prazo.getTime() - PRAZO_HORAS[prioridade] * HORA);
    solicitacoes.push({
      id: uid("sl"),
      codigo: ++codigo,
      leadId,
      tipo,
      qual,
      observacao,
      prioridade,
      status: responsavel ? "assumida" : "aberta",
      responsavel,
      criadaEm: criadaEm.toISOString(),
      prazo: prazo.toISOString(),
      assumidaEm: responsavel
        ? new Date(agora.getTime() - 14 * 60_000).toISOString()
        : undefined,
    });
  };

  // as três da tela 06, com os prazos do mockup (4h, 7h, 11h)
  abrir(maria.id, "veterinaria", "castracao", 1, "Gata da vizinha, ninhada recente", 4, "Carla");
  abrir(leads[7].id, "outros", "resgate", 1, "Animal na Av. Recife, próximo ao viaduto", 7);
  abrir(jose.id, "veterinaria", "cirurgia", 1, "Bidu · nódulo na pata", 11);
  abrir(marcia.id, "veterinaria", "exame", 2, "Frajola · repetir hemograma", 48);
  abrir(leads[9].id, "veterinaria", "consulta", 2, "Nina · tosse persistente", 52);
  abrir(leads[11].id, "veterinaria", "castracao", 3, "Pretinha · fila do mutirão", 144);
  abrir(leads[13].id, "outros", "denuncia", 3, "Cordeiro · cão preso em corrente curta", 150);
  abrir(leads[15].id, "financeira", "racao", 3, "Protetora com 6 animais", 158);
  abrir(leads[17].id, "veterinaria", "consulta", 2, "Retorno pós-castração", 60);
  abrir(leads[19].id, "financeira", "medicacao", 3, "Uso contínuo, cão idoso", 162);
  abrir(leads[21].id, "outros", "resgate", 2, "Filhotes em terreno baldio", 64);
  abrir(leads[23].id, "veterinaria", "exame", 3, "Ultrassom · suspeita de gestação", 166);

  // histórico resolvido, que alimenta os 94% dentro do prazo
  for (let i = 0; i < 34; i++) {
    const lead = escolher(r, leads);
    const prioridade = escolher(r, [1, 2, 3] as const) as Prioridade;
    const criadaEm = new Date(agora.getTime() - inteiro(r, 2, 30) * DIA);
    const prazo = new Date(criadaEm.getTime() + PRAZO_HORAS[prioridade] * HORA);
    // 2 em 34 estouram o prazo → 94%
    const noPrazo = i >= 2;
    solicitacoes.push({
      id: uid("sl"),
      codigo: ++codigo,
      leadId: lead.id,
      tipo: "veterinaria",
      qual: escolher(r, ["consulta", "castracao", "exame"] as const),
      observacao: "",
      prioridade,
      status: "resolvida",
      responsavel: escolher(r, EQUIPE),
      criadaEm: criadaEm.toISOString(),
      prazo: prazo.toISOString(),
      assumidaEm: new Date(criadaEm.getTime() + 2 * HORA).toISOString(),
      resolvidaEm: new Date(
        prazo.getTime() + (noPrazo ? -inteiro(r, 2, 20) * HORA : inteiro(r, 4, 20) * HORA),
      ).toISOString(),
      retornoGerado: true,
    });
  }

  // A linha do tempo é a ÚLTIMA coisa a nascer: ela deriva de tudo o que já
  // existe (entrada na base, atendimentos, solicitações, último contato).
  interacoes.push(
    ...gerarLinhaDoTempo(r, leads, atendimentos, solicitacoes, interacoes),
  );
  interacoes.sort((a, b) => b.em.localeCompare(a.em));

  return {
    versao: VERSAO_BANCO,
    painel: {
      cadastros: 150000,
      apoiadoresAtivos: 18427,
      apoiadoresHoje: 312,
      equipeTamanho: 12,
      equipeOnline: 12,
    },
    candidatos: candidatos(),
    leads,
    atendimentos,
    fila,
    interacoes,
    solicitacoes,
    ultimoCodigo: codigo,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   LINHA DO TEMPO DE TODA A BASE

   Nenhum perfil pode abrir com "0 registros": uma ficha sem histórico não diz
   se a pessoa é nova ou se o gabinete a esqueceu — que é justamente a decisão
   que a tela existe para apoiar.

   O histórico não é inventado do nada: ele é DERIVADO do que o lead já tem —
   quando entrou na base, os atendimentos que recebeu, as solicitações que
   abriu e a data do último contato. Assim a linha do tempo bate com o resto da
   ficha em vez de contar outra história.
   ══════════════════════════════════════════════════════════════════════════ */
function gerarLinhaDoTempo(
  r: Rnd,
  leads: Lead[],
  atendimentos: Atendimento[],
  solicitacoes: Solicitacao[],
  jaEscritas: Interacao[],
): Interacao[] {
  const out: Interacao[] = [];

  // O que já foi escrito à mão (a linha da Maria) não pode ser duplicado.
  const narrado = new Set(
    jaEscritas.map((i) => `${i.leadId}|${i.tipo}|${i.em.slice(0, 10)}`),
  );

  const porLead = new Map<string, Atendimento[]>();
  for (const a of atendimentos) {
    const lista = porLead.get(a.leadId);
    if (lista) lista.push(a);
    else porLead.set(a.leadId, [a]);
  }

  const solPorLead = new Map<string, Solicitacao[]>();
  for (const s of solicitacoes) {
    const lista = solPorLead.get(s.leadId);
    if (lista) lista.push(s);
    else solPorLead.set(s.leadId, [s]);
  }

  const empurrar = (i: Omit<Interacao, "id">) => {
    const chave = `${i.leadId}|${i.tipo}|${i.em.slice(0, 10)}`;
    if (narrado.has(chave)) return;
    narrado.add(chave);
    out.push({ ...i, id: uid("it") });
  };

  for (const l of leads) {
    /* 1 · a entrada na base — o registro que todo mundo tem */
    empurrar({
      leadId: l.id,
      tipo: "nota",
      autor: "equipe",
      titulo: "Entrou na base",
      subtitulo: `Cadastro via ${escolher(r, ORIGENS)}`,
      em: l.criadoEm,
    });

    /* 2 · cada atendimento entregue.
       A janela de 3 dias evita narrar DUAS VEZES a mesma entrega: a linha
       escrita à mão registra a castração do Thor hoje, e o `atendimento`
       correspondente está datado de ontem. Chaves por dia não pegavam isso —
       são datas diferentes contando o mesmo fato. */
    const narradoAMao = jaEscritas.filter(
      (i) => i.leadId === l.id && i.tipo === "atendimento",
    );
    for (const a of porLead.get(l.id) ?? []) {
      const jaContado = narradoAMao.some(
        (i) => Math.abs(new Date(i.em).getTime() - new Date(a.em).getTime()) < 3 * DIA,
      );
      if (jaContado) continue;
      const rotulo = SERVICO_ROTULO[a.servico] ?? "Atendimento";
      empurrar({
        leadId: l.id,
        tipo: "atendimento",
        autor: "equipe",
        titulo: `${rotulo} ${a.detalhe ? `d${/a$/i.test(a.detalhe) ? "a" : "o"} ${a.detalhe} ` : ""}concluíd${rotulo.endsWith("e") || rotulo.endsWith("m") ? "o" : "a"}`,
        subtitulo: `${escolher(r, CLINICAS)} · agendado por ${escolher(r, EQUIPE)}`,
        em: a.em,
        selo: "Gerou tarefa de retorno",
      });
    }

    /* 3 · cada solicitação aberta veio de uma conversa */
    for (const s of solPorLead.get(l.id) ?? []) {
      empurrar({
        leadId: l.id,
        tipo: "ligacao",
        autor: "voce",
        titulo: "Você ligou",
        subtitulo: s.observacao || "Registrou um pedido",
        em: s.criadaEm,
        selo: `Virou solicitação #${s.codigo}`,
      });
    }

    /* 4 · os envios, terminando exatamente no último contato do cadastro —
           é o que faz o "último há X dias" da ficha bater com a linha */
    if (!l.ultimoContatoEm) continue;
    const fim = new Date(l.ultimoContatoEm).getTime();
    const inicio = new Date(l.criadoEm).getTime();
    const quantos = inteiro(r, 1, 3);

    for (let k = 0; k < quantos; k++) {
      const em = k === 0 ? fim : inicio + ((fim - inicio) * (quantos - k)) / (quantos + 1);
      if (em < inicio) continue;

      const tipo = ponderado(r, [
        ["mensagem", 5],
        ["video", 3],
        ["ligacao", 3],
        ["audio", 2],
      ] as const);

      // vídeo às vezes sai em nome do candidato — é o que dá peso ao selo
      // dourado da Andreza na linha do tempo
      const autor: AutorInteracao =
        tipo === "video" && r() < 0.45 ? (r() < 0.5 ? "andreza" : "romero") : "voce";

      const titulo =
        autor === "voce"
          ? tipo === "ligacao"
            ? "Você ligou"
            : `Você enviou ${tipo === "mensagem" ? "mensagem" : tipo === "audio" ? "áudio" : "vídeo"}`
          : `${autor === "andreza" ? "Andreza" : "Romero"} enviou vídeo`;

      const status = ponderado(r, [
        ["visto-respondeu", 45],
        ["visto-sem-resposta", 32],
        ["nao-visto", 23],
      ] as const);

      empurrar({
        leadId: l.id,
        tipo,
        autor,
        titulo,
        subtitulo: escolher(r, ASSUNTOS[tipo] ?? ASSUNTOS.mensagem),
        em: new Date(em).toISOString(),
        status,
        respostaMin: status === "visto-respondeu" ? inteiro(r, 2, 180) : undefined,
      });
    }
  }

  return out;
}

/** Rótulo por serviço — o mesmo de `SERVICO_LABEL`, sem importar a tela. */
const SERVICO_ROTULO: Record<string, string> = {
  castracao: "Castração",
  consulta: "Consulta",
  exame: "Exame",
  cirurgia: "Cirurgia",
  racao: "Entrega de ração",
  resgate: "Resgate",
  denuncia: "Denúncia",
  medicacao: "Entrega de medicação",
  outro: "Atendimento",
};

/** Ordem do motor da fila: motivo primeiro, feitas por último. */
export function ordenarFila(fila: ItemFila[]): ItemFila[] {
  const peso: Record<Motivo, number> = {
    retorno: 0,
    aniversario: 1,
    "primeiro-contato": 2,
    reaquecimento: 3,
  };
  fila.sort((a, b) => {
    if (a.feito !== b.feito) return a.feito ? 1 : -1;
    return peso[a.motivo] - peso[b.motivo];
  });
  return fila;
}
