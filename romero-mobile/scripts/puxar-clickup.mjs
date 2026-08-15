/* ══════════════════════════════════════════════════════════════════════════
   EXTRATOR — ClickUp (Gabinete 509) → base local do app

   Lê o folder "Telemarketing 2.0" (space RELATÓRIOS DIÁRIOS) e escreve
   `lib/db/reais.json`, que a semente consome no lugar da base fictícia.

     Leads    1000320000002833   → Lead[]  (+ estatísticas do total)
     Ligações 1000320000002834   → Interacao[]

   As ESTATÍSTICAS varrem a lista inteira; só os primeiros --leads=N entram
   no arquivo, porque o banco do app é um blob único em localStorage e não
   cabem 38 mil pessoas ali.

   O QUE NÃO TEM FONTE no ClickUp e fica vazio de propósito, em vez de
   inventado: pets, aniversário, idade, indicações e atendimentos.

   Uso:  node scripts/puxar-clickup.mjs [--leads=600] [--max-paginas=N]

   O arquivo gerado tem dados pessoais reais (nome, telefone, CPF) e está no
   .gitignore. Não comitar.
   ══════════════════════════════════════════════════════════════════════════ */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");

const LISTA_LEADS = "1000320000002833";
const LISTA_LIGACOES = "1000320000002834";
const API = "https://api.clickup.com/api/v2";

/* ── argumentos ────────────────────────────────────────────────────────── */

const arg = (nome, padrao) => {
  const m = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return m ? Number(m.split("=")[1]) : padrao;
};
const LIMITE_LEADS = arg("leads", 600);
const MAX_PAGINAS = arg("max-paginas", Infinity);

/* ── token ─────────────────────────────────────────────────────────────── */

function lerToken() {
  if (process.env.CLICKUP_TOKEN) return process.env.CLICKUP_TOKEN;
  const env = readFileSync(join(RAIZ, ".env.local"), "utf8");
  const linha = env.split(/\r?\n/).find((l) => l.startsWith("CLICKUP_TOKEN="));
  if (!linha) throw new Error("CLICKUP_TOKEN não encontrado em .env.local");
  return linha.slice("CLICKUP_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
}
const TOKEN = lerToken();

/* ── HTTP com repique em 429/5xx ───────────────────────────────────────── */

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function buscar(url, tentativa = 0) {
  const r = await fetch(url, { headers: { Authorization: TOKEN } });
  if (r.status === 429 || r.status >= 500) {
    if (tentativa >= 5) throw new Error(`${r.status} em ${url} após 6 tentativas`);
    const espera = Number(r.headers.get("retry-after")) * 1000 || 2 ** tentativa * 1500;
    process.stdout.write(` [${r.status}, esperando ${Math.round(espera / 1000)}s]`);
    await dormir(espera);
    return buscar(url, tentativa + 1);
  }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} em ${url}`);
  return r.json();
}

async function puxarLista(listaId, rotulo) {
  const out = [];
  for (let pag = 0; pag < MAX_PAGINAS; pag++) {
    const d = await buscar(
      `${API}/list/${listaId}/task?page=${pag}&include_closed=true&subtasks=false`,
    );
    const tarefas = d.tasks ?? [];
    out.push(...tarefas);
    process.stdout.write(`\r  ${rotulo}: ${out.length} tarefas (página ${pag + 1})   `);
    if (d.last_page || tarefas.length === 0) break;
    await dormir(120);
  }
  process.stdout.write("\n");
  return out;
}

/* ── leitura de custom fields ──────────────────────────────────────────── */

const campos = (t) => Object.fromEntries((t.custom_fields ?? []).map((f) => [f.name, f]));

function txt(cs, nome) {
  const v = cs[nome]?.value;
  return v === null || v === undefined ? "" : String(v).trim();
}

function num(cs, nome) {
  const v = Number(cs[nome]?.value);
  return Number.isFinite(v) ? v : 0;
}

/** Data de campo `date` do ClickUp (ms em string) → ISO, ou undefined. */
function data(cs, nome) {
  const v = cs[nome]?.value;
  const ms = Number(v);
  if (!v || !Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

/** Dropdown: o `value` vem como índice (orderindex) ou como id da opção. */
function opcao(cs, nome) {
  const f = cs[nome];
  if (!f) return "";
  const v = f.value;
  if (v === null || v === undefined || v === "") return "";
  const opts = f.type_config?.options ?? [];
  if (typeof v === "number") return opts[v]?.name ?? "";
  const achada = opts.find((o) => o.id === v);
  return achada?.name ?? "";
}

const simNao = (cs, nome) => opcao(cs, nome).toLowerCase() === "sim";

/** +5581999998888 → 81999998888 (o app usa o número nu no link do WhatsApp) */
function telefone(bruto) {
  const so = String(bruto || "").replace(/\D/g, "");
  return so.startsWith("55") ? so.slice(2) : so;
}

const iso = (ms) => new Date(Number(ms)).toISOString();

/* ── mapeamento: tarefa do ClickUp → Lead do app ───────────────────────── */

function paraLead(t) {
  const cs = campos(t);
  const confirmou = [];
  if (opcao(cs, "Confirmou voto no Romero") === "Sim") confirmou.push("romero");
  // O ClickUp escreve "Andressa"; o app usa o id "andreza". A tradução é aqui.
  if (opcao(cs, "Confirmou voto na Andressa") === "Sim") confirmou.push("andreza");

  const obs = txt(cs, "Observação consolidada");
  const ultimo = data(cs, "Último contato");

  return {
    id: t.id,
    nome: txt(cs, "Nome") || t.name,
    idade: 0, // sem fonte no ClickUp — a tela omite quando é 0
    bairro: txt(cs, "Bairro"),
    cidade: txt(cs, "Cidade"),
    whatsapp: telefone(txt(cs, "Telefone")),
    aniversario: "", // sem fonte
    indicacoes: 0, // sem fonte
    confirmou,
    multiplicadora: simNao(cs, "Militante?"),
    pets: [], // sem fonte
    ...(obs ? { anotacao: { texto: obs, em: ultimo ?? iso(t.date_created) } } : {}),
    criadoEm: iso(t.date_created),
    ...(ultimo ? { ultimoContatoEm: ultimo } : {}),
    /* usados só para derivar a fila; removidos antes de gravar */
    _proximo: data(cs, "Próximo contato"),
    _tentativas: num(cs, "Quantidade de tentativas"),
    _resultado: txt(cs, "Último resultado"),
  };
}

/* ── fila do dia: derivada de "Próximo contato" ────────────────────────── */

const DIA_MS = 86_400_000;

function derivarFila(leads, agora) {
  const hoje = new Date(agora);
  hoje.setHours(23, 59, 59, 999);
  const diaLocal = new Date(agora.getTime() - agora.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);

  const itens = [];
  for (const l of leads) {
    if (!l._proximo) continue;
    if (new Date(l._proximo).getTime() > hoje.getTime()) continue;

    let motivo;
    if (l._tentativas === 0) motivo = "primeiro-contato";
    else if (l._resultado.toLowerCase() === "atendeu") motivo = "retorno";
    else if (l.ultimoContatoEm && agora.getTime() - new Date(l.ultimoContatoEm).getTime() > 45 * DIA_MS)
      motivo = "reaquecimento";
    else motivo = "retorno";

    // já contatado hoje = tarefa cumprida
    const feito = !!l.ultimoContatoEm && l.ultimoContatoEm.slice(0, 10) === diaLocal;

    itens.push({
      id: `fl_${l.id}`,
      leadId: l.id,
      motivo,
      detalhe: l._resultado
        ? `Última tentativa: ${l._resultado}`
        : "Sem tentativa registrada",
      feito,
      ...(feito ? { feitoEm: l.ultimoContatoEm } : {}),
      dia: diaLocal,
    });
  }
  return itens;
}

/* ── linha do tempo ────────────────────────────────────────────────────── */

function ligacaoParaInteracao(t, idsValidos) {
  const cs = campos(t);
  const leadId = cs["Lead"]?.value?.[0]?.id || txt(cs, "ID do Lead");
  if (!leadId || !idsValidos.has(leadId)) return null;

  const atendeu = opcao(cs, "Atendeu?") === "Sim";
  const em = data(cs, "Início da ligação") ?? iso(t.date_created);
  const sub = txt(cs, "Observações extraídas") || txt(cs, "Análise da IA");
  const aderencia = num(cs, "Aderência ao script");

  return {
    id: t.id,
    leadId,
    tipo: "ligacao",
    autor: "voce",
    titulo: atendeu ? "Ligação atendida" : "Ligação não atendida",
    ...(sub ? { subtitulo: sub.slice(0, 220) } : {}),
    em,
    status: atendeu ? "visto-respondeu" : "nao-visto",
    ...(txt(cs, "Operador") ? { selo: `Operador: ${txt(cs, "Operador")}` } : {}),
    ...(aderencia ? { respostaMin: aderencia } : {}),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   CENTRAL DE CAMPANHA — métricas derivadas das Ligações e dos Leads.

   Tudo aqui é CONTADO, nunca estimado. O que a fonte não sabe responder sai
   como lista vazia ou zero, e a tela mostra "sem dados ainda" em vez de um
   número bonito que ninguém pode auditar.

   O que a fonte NÃO tem, e por isso não é calculado aqui:
     · votos acumulados por dia — o ClickUp guarda a confirmação de voto como
       estado atual do lead, sem data. Não há série histórica para reconstruir.
     · comparativo semanal e tendências — exigem semanas de histórico.
     · metas, calendário eleitoral e tamanho da equipe — decisão de campanha,
       não é telemetria. Ficam em `lib/campanha-config.ts`.
   ══════════════════════════════════════════════════════════════════════════ */

const diaLocalDe = (iso) => (iso ? iso.slice(0, 10) : null);

/**
 * Duração da ligação, em segundos.
 *
 * A fonte preferida é o campo `Duração da ligação`, que vem em texto
 * ("1min 32s", "45s", "1h 02min"). Os timestamps NÃO são confiáveis: em parte
 * dos registros o `Fim da ligação` é anterior ao `Início` — provavelmente
 * gravados por etapas diferentes do fluxo. Quando a diferença dá negativa,
 * ela é descartada em vez de virar um número.
 */
function duracaoSegundos(textoDuracao, ini, fim) {
  const t = String(textoDuracao || "");
  if (t) {
    const h = /(\d+)\s*h/.exec(t);
    const m = /(\d+)\s*min/.exec(t);
    const s = /(\d+)\s*s(?!\w)/.exec(t);
    const total =
      (h ? Number(h[1]) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0) + (s ? Number(s[1]) : 0);
    if (total > 0) return total;
  }
  if (!ini || !fim) return null;
  const seg = (new Date(fim).getTime() - new Date(ini).getTime()) / 1000;
  return seg > 0 && seg < 4 * 3600 ? Math.round(seg) : null;
}

function mediana(nums) {
  if (!nums.length) return 0;
  const o = [...nums].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : Math.round((o[m - 1] + o[m]) / 2);
}

function calcularCampanha(brutosLigacoes, todosLeads, agora) {
  const ligs = brutosLigacoes.map((t) => {
    const cs = campos(t);
    const ini = data(cs, "Início da ligação") ?? iso(t.date_created);
    const fim = data(cs, "Fim da ligação");
    return {
      operador: txt(cs, "Operador") || "(sem operador)",
      atendeu: opcao(cs, "Atendeu?") === "Sim",
      ini,
      dur: duracaoSegundos(txt(cs, "Duração da ligação"), ini, fim),
      ader: num(cs, "Aderência ao script"),
      falha: txt(cs, "Motivo da falha"),
      retorno: opcao(cs, "Retorno necessário?") === "Sim",
      dataRetorno: data(cs, "Data do retorno"),
      leadId: cs["Lead"]?.value?.[0]?.id || txt(cs, "ID do Lead"),
    };
  });

  /* ── produção diária: uma barra por dia com ligação registrada ────────── */
  const porDia = new Map();
  for (const l of ligs) {
    const d = diaLocalDe(l.ini);
    if (!d) continue;
    const e = porDia.get(d) ?? { dia: d, ligacoes: 0, contatos: 0 };
    e.ligacoes += 1;
    if (l.atendeu) e.contatos += 1;
    porDia.set(d, e);
  }
  const serie = [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia));

  /* ── tempo de ligação ─────────────────────────────────────────────────── */
  const duracoes = ligs.map((l) => l.dur).filter((d) => d !== null);
  const tempoMedio = duracoes.length
    ? {
        atual: Math.round(duracoes.reduce((a, b) => a + b, 0) / duracoes.length),
        min: Math.min(...duracoes),
        mediana: mediana(duracoes),
        max: Math.max(...duracoes),
        amostra: duracoes.length,
      }
    : { atual: 0, min: 0, mediana: 0, max: 0, amostra: 0 };

  /* ── ranking de telefonistas ──────────────────────────────────────────── */
  const porOp = new Map();
  for (const l of ligs) {
    const e = porOp.get(l.operador) ?? {
      nome: l.operador,
      lig: 0,
      cont: 0,
      aders: [],
      durs: [],
      leads: new Set(),
    };
    e.lig += 1;
    if (l.atendeu) {
      e.cont += 1;
      if (l.leadId) e.leads.add(l.leadId);
    }
    if (l.ader > 0) e.aders.push(l.ader);
    if (l.dur !== null) e.durs.push(l.dur);
    porOp.set(l.operador, e);
  }

  // votos creditados ao operador: lead que ele atendeu E que confirmou voto
  const confirmados = new Set(
    todosLeads.filter((l) => l.confirmou.length > 0).map((l) => l.id),
  );

  const telefonistas = [...porOp.values()]
    .map((e, i) => ({
      id: i,
      nome: e.nome,
      turno: "", // sem fonte no ClickUp
      lig: e.lig,
      cont: e.cont,
      conv: e.lig ? Math.round((e.cont / e.lig) * 100) : 0,
      ader: e.aders.length
        ? Math.round(e.aders.reduce((a, b) => a + b, 0) / e.aders.length)
        : 0,
      tsec: e.durs.length ? Math.round(e.durs.reduce((a, b) => a + b, 0) / e.durs.length) : 0,
      votos: [...e.leads].filter((id) => confirmados.has(id)).length,
      ligh: 0, // sem jornada registrada, ligações/hora não é calculável
    }))
    .sort((a, b) => b.lig - a.lig);

  /* ── motivos de não-contato ───────────────────────────────────────────── */
  const naoAtendeu = ligs.filter((l) => !l.atendeu);
  const porFalha = new Map();
  for (const l of naoAtendeu) {
    const k = l.falha || "Não atendeu";
    porFalha.set(k, (porFalha.get(k) ?? 0) + 1);
  }
  const motivos = [...porFalha.entries()]
    .map(([rotulo, n]) => ({ rotulo, n, pctTotal: Math.round((n / (naoAtendeu.length || 1)) * 100) }))
    .sort((a, b) => b.n - a.n);

  /* ── SLA de retornos ──────────────────────────────────────────────────── */
  const agendados = ligs.filter((l) => l.retorno);
  const vencidos = agendados.filter(
    (l) => l.dataRetorno && new Date(l.dataRetorno).getTime() < agora.getTime(),
  ).length;
  const sla = {
    agendados: agendados.length,
    vencidos,
    cumpridos: agendados.length - vencidos,
    pct: agendados.length ? Math.round(((agendados.length - vencidos) / agendados.length) * 100) : 0,
  };

  /* ── votos por cidade e intenção de voto (base inteira) ───────────────── */
  const porCidade = new Map();
  for (const l of todosLeads) {
    if (!l.confirmou.includes("romero")) continue;
    const c = l.cidade || "(sem cidade)";
    porCidade.set(c, (porCidade.get(c) ?? 0) + 1);
  }
  const votosPorCidade = [...porCidade.entries()]
    .map(([rotulo, n]) => ({ rotulo, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 6);

  const intencaoDe = (quem) => {
    const sim = todosLeads.filter((l) => l.confirmou.includes(quem)).length;
    return { rotulo: quem === "romero" ? "Romero" : "Andreza", sim, base: todosLeads.length };
  };

  return {
    serie,
    tempoMedio,
    telefonistas,
    motivosNaoContato: motivos,
    sla,
    votosPorCidade,
    intencao: [intencaoDe("romero"), intencaoDe("andreza")],
    cobertura: {
      feita: todosLeads.filter((l) => l.ultimoContatoEm).length,
      total: todosLeads.length,
    },
    totalLigacoes: ligs.length,
    totalContatos: ligs.filter((l) => l.atendeu).length,
    aderenciaMedia: (() => {
      const a = ligs.map((l) => l.ader).filter((n) => n > 0);
      return a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
    })(),
  };
}

/* ── execução ──────────────────────────────────────────────────────────── */

console.log("Puxando do ClickUp — Gabinete 509 / Telemarketing 2.0\n");

/* `--so-campanha` reprocessa apenas as Ligações e recalcula o painel, mantendo
   os leads já gravados. Varrer 42 mil leads leva ~14 min e 420 requisições no
   MESMO token que o discador usa para escrever — não vale repetir isso só para
   recalcular métrica. */
const SO_CAMPANHA = process.argv.includes("--so-campanha");

const anterior = SO_CAMPANHA
  ? JSON.parse(readFileSync(join(RAIZ, "lib", "db", "reais.json"), "utf8"))
  : null;

if (SO_CAMPANHA) {
  console.log(`  (modo --so-campanha: reaproveitando ${anterior.leads.length} leads já extraídos)\n`);
}

const brutosLeads = SO_CAMPANHA ? [] : await puxarLista(LISTA_LEADS, "Leads");
const brutosLigacoes = await puxarLista(LISTA_LIGACOES, "Ligações");

const agora = new Date();
const todos = SO_CAMPANHA ? [] : brutosLeads.map(paraLead);

/* estatísticas sobre a lista INTEIRA, antes de cortar */
const totais = SO_CAMPANHA ? anterior.totais : {
  cadastros: todos.length,
  confirmadosRomero: todos.filter((l) => l.confirmou.includes("romero")).length,
  confirmadosAndreza: todos.filter((l) => l.confirmou.includes("andreza")).length,
  militantes: todos.filter((l) => l.multiplicadora).length,
  comContato: todos.filter((l) => l.ultimoContatoEm).length,
  semContato: todos.filter((l) => !l.ultimoContatoEm).length,
  contatadosHoje: todos.filter(
    (l) => l.ultimoContatoEm && l.ultimoContatoEm.slice(0, 10) === agora.toISOString().slice(0, 10),
  ).length,
  ligacoes: brutosLigacoes.length,
};

/* Quem tem mais história vem primeiro: a base carregada no aparelho fica útil
   em vez de virar 600 fichas vazias. */
const ordenados = [...todos].sort((a, b) => {
  const peso = (l) => (l._proximo ? 2 : 0) + (l.ultimoContatoEm ? 1 : 0) + l._tentativas / 100;
  return peso(b) - peso(a);
});
const escolhidos = SO_CAMPANHA ? [] : ordenados.slice(0, LIMITE_LEADS);

const fila = derivarFila(escolhidos, agora);

const ids = new Set(escolhidos.map((l) => l.id));
const interacoes = brutosLigacoes
  .map((t) => ligacaoParaInteracao(t, ids))
  .filter(Boolean);

/* toda ficha abre com pelo menos um registro — a entrada na base */
for (const l of escolhidos) {
  interacoes.push({
    id: `it_base_${l.id}`,
    leadId: l.id,
    tipo: "nota",
    autor: "equipe",
    titulo: "Entrou na base",
    subtitulo: "Importado do ClickUp · Telemarketing 2.0",
    em: l.criadoEm,
  });
}
interacoes.sort((a, b) => b.em.localeCompare(a.em));

/* campos auxiliares saem antes de gravar */
const leads = escolhidos.map(({ _proximo, _tentativas, _resultado, ...l }) => l);

const campanha = calcularCampanha(brutosLigacoes, SO_CAMPANHA ? anterior.leads : todos, agora);

/* Cobertura e base da intenção falam da LISTA INTEIRA, não da amostra
   embarcada. `totais` sempre reflete os 42 mil — inclusive no modo parcial,
   em que `calcularCampanha` só enxergou os 600 gravados. */
campanha.cobertura = { feita: totais.comContato, total: totais.cadastros };
campanha.intencao = [
  { rotulo: "Romero", sim: totais.confirmadosRomero, base: totais.cadastros },
  { rotulo: "Andreza", sim: totais.confirmadosAndreza, base: totais.cadastros },
];

const saida = SO_CAMPANHA
  ? { ...anterior, geradoEm: agora.toISOString(), campanha }
  : {
  geradoEm: agora.toISOString(),
  origem: {
    workspace: "9014971829 · Gabinete 509",
    space: "90144242499 · RELATÓRIOS DIÁRIOS",
    folder: "1000320000002685 · Telemarketing 2.0",
  },
  totais,
  campanha,
  leads,
  fila,
  interacoes,
};

const leadsGravados = SO_CAMPANHA ? anterior.leads.length : leads.length;
const filaGravada = SO_CAMPANHA ? anterior.fila.length : fila.length;

mkdirSync(join(RAIZ, "lib", "db"), { recursive: true });
writeFileSync(join(RAIZ, "lib", "db", "reais.json"), JSON.stringify(saida, null, 1), "utf8");

console.log("\n── totais da lista inteira ──");
for (const [k, v] of Object.entries(totais)) console.log(`  ${k}: ${v.toLocaleString("pt-BR")}`);
console.log(`\n── gravado em lib/db/reais.json ──`);
console.log(`  leads embarcados: ${leadsGravados}`);
console.log(`  fila do dia:      ${filaGravada}`);
console.log(`  interações:       ${SO_CAMPANHA ? anterior.interacoes.length : interacoes.length}`);
console.log("\n── Central de Campanha (calculado, nunca estimado) ──");
console.log(`  ligações:      ${campanha.totalLigacoes} (${campanha.totalContatos} atenderam)`);
console.log(`  dias com dado: ${campanha.serie.length}`);
console.log(`  telefonistas:  ${campanha.telefonistas.length}`);
console.log(
  `  tempo médio:   ${campanha.tempoMedio.atual}s (amostra de ${campanha.tempoMedio.amostra})`,
);
console.log(`  aderência:     ${campanha.aderenciaMedia}%`);
console.log(`  cobertura:     ${campanha.cobertura.feita}/${campanha.cobertura.total}`);
