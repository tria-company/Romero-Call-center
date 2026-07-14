// Filtro de anonimizacao LGPD da transcricao de gravacao (GRAV-04).
//
// Por que: a transcricao de uma call/ligacao comercial e a FALA do
// profissional de saude (o lead) — que pode mencionar dado de PACIENTE (nome,
// diagnostico, CPF, telefone, CEP etc), um TERCEIRO cujo dado nao pode ser
// persistido em custom field GHL nem logado em texto bruto (LGPD). Este
// filtro e DETERMINISTICO (regex puro, sem LLM) e FAIL-CLOSED: entrada
// invalida ou qualquer excecao interna retorna { ok: false, textoAnon: '',
// redacoes: 0 }, e o CHAMADOR (index.ts, Task 2) NAO persiste nada nesse
// caso. Um redator aumentado por LLM poderia "falhar aberto" (erro/timeout
// devolvendo o texto original bruto) — o deterministico sempre roda e e
// provavel por smoke sem banco/credenciais/LLM (ver
// scripts/smoke-anonimizacao.mjs). Um redator LLM-aumentado fica como
// candidato de hardening da Fase 5 (HARD-02, scrubber de saida).
//
// IMPORTANTE (LGPD): esta funcao NUNCA loga o `texto` de entrada nem o
// `textoAnon` de saida — so o contador `redacoes`. Callers tambem devem
// seguir essa regra (nunca console.log o texto bruto/anonimizado).

// Tipo em interface SEPARADA (nao inline) — scripts/smoke-anonimizacao.mjs
// extrai o CORPO de anonimizarTranscricao via regex (mesmo padrao de
// DecisaoNoShow em no-show.ts) e a anotacao de retorno precisa ficar limpa
// de chaves `{ }` que colidiriam com o parser.
export interface ResultadoAnonimizacao {
  ok: boolean;
  textoAnon: string;
  redacoes: number;
}

// Blocklist de termos clinicos sensiveis — piso AJUSTAVEL pelo time clinico
// (mesmo espirito do placeholder ICP_PROFISSOES_STEMS da 01-04: lista inicial
// razoavel, nao exaustiva/definitiva). Exportada pra reuso/documentacao — o
// CORPO de anonimizarTranscricao abaixo duplica o MESMO padrao inline (ver
// nota no comentario da funcao) porque o smoke extrai so o corpo via regex e
// roda via `new Function`, que nao tem acesso ao escopo do modulo (mesma
// restricao documentada em no-show.ts#ATRASO_NO_SHOW_MS/lembretes.ts).
export const TERMOS_CLINICOS_REGEX = /\b(diagn[oó]stic\w*|progn[oó]stic\w*|prontu[aá]rio\w*|c[íi]d[- ]?\d{0,3}|exame\w*|laudo\w*|receit[au]\w*|biopsia\w*|tumor\w*|c[âa]ncer\w*|hipertens[ãa]o\w*|diabet\w*|depress[ãa]o\w*|ansiedade\w*|s[íi]ndrome\w*|patologia\w*)\b/gi;

/**
 * GRAV-04 — filtro de anonimizacao LGPD, funcao PURA (sem I/O, sem chamada de
 * LLM). Redige por regex determinístico, substituindo cada match por um
 * marcador estavel: (a) PII estruturado (CPF/CNPJ/RG/telefone/email/CEP);
 * (b) nome de paciente por CONTEXTO (token(s) capitalizado(s) logo apos
 * 'paciente'/'o paciente'/'a paciente'/'Sr.'/'Sra.'/'dona'/'seu' — NAO
 * redige o nome do proprio lead/profissional, so o que vem depois desses
 * marcadores clinicos); (c) blocklist de termos clinicos sensiveis. Conta
 * `redacoes` = total de substituicoes. Fail-closed: texto vazio/nao-string
 * OU qualquer excecao interna devolve { ok: false, textoAnon: '', redacoes: 0
 * } — nunca devolve texto bruto por engano.
 *
 * Prova comportamental em scripts/smoke-anonimizacao.mjs (extrai o CORPO via
 * regex e roda via `new Function`, mesmo padrao de decidirNoShow/no-show.ts).
 *
 * IMPORTANTE: as constantes de regex abaixo sao INLINE (nao referenciam
 * TERMOS_CLINICOS_REGEX do escopo do modulo, nem qualquer import) de
 * proposito — o smoke extrai so o corpo desta funcao, que perde acesso a
 * qualquer const/import de modulo (mesma limitacao/solucao documentada em
 * no-show.ts).
 */
export function anonimizarTranscricao(texto: string): ResultadoAnonimizacao {
  if (!texto || typeof texto !== 'string' || texto.trim().length === 0) {
    return { ok: false, textoAnon: '', redacoes: 0 };
  }

  try {
    let redacoes = 0;
    let out = texto;

    // (a) PII estruturado — ordem importa: formatos mais especificos primeiro
    // (CNPJ tem '/', mais longo) pra nao sobrar digito parcial que o regex
    // seguinte re-case por engano.
    const CNPJ_REGEX = /\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}\b/g;
    out = out.replace(CNPJ_REGEX, function () {
      redacoes++;
      return '[CNPJ]';
    });

    const CPF_REGEX = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
    out = out.replace(CPF_REGEX, function () {
      redacoes++;
      return '[CPF]';
    });

    const EMAIL_REGEX = /\b[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}\b/g;
    out = out.replace(EMAIL_REGEX, function () {
      redacoes++;
      return '[CONTATO]';
    });

    // Telefone/celular BR: DDD opcional entre parenteses + 8 ou 9 digitos
    // (celular comeca com 9), com separadores opcionais (espaco/ponto/hifen).
    const TELEFONE_REGEX = /(?:\+?55\s?)?\(?\d{2}\)?[\s.-]?9\d{3,4}[\s.-]?\d{4}\b/g;
    out = out.replace(TELEFONE_REGEX, function () {
      redacoes++;
      return '[CONTATO]';
    });

    const CEP_REGEX = /\b\d{5}-\d{3}\b/g;
    out = out.replace(CEP_REGEX, function () {
      redacoes++;
      return '[CEP]';
    });

    const RG_REGEX = /\b\d{1,2}\.\d{3}\.\d{3}-[0-9Xx]\b/g;
    out = out.replace(RG_REGEX, function () {
      redacoes++;
      return '[RG]';
    });

    // (b) nome de paciente por CONTEXTO — token(s) capitalizado(s) logo apos
    // marcador clinico. Preserva o marcador (mantem o texto legivel: "o
    // paciente [PACIENTE] relatou"), so redige o nome proprio que vem depois.
    const NOME_PACIENTE_CONTEXTO_REGEX = /\b(o\s+paciente|a\s+paciente|paciente|Sr\.?|Sra\.?|dona|seu)\s+([A-ZÀ-Ý][a-zà-ÿ]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ]+){0,2})/g;
    out = out.replace(NOME_PACIENTE_CONTEXTO_REGEX, function (_m, marcador) {
      redacoes++;
      return marcador + ' [PACIENTE]';
    });

    // (c) blocklist de termos clinicos sensiveis (INLINE — ver nota no
    // comentario da funcao acima sobre a duplicacao com TERMOS_CLINICOS_REGEX).
    const TERMOS_CLINICOS_REGEX_LOCAL = /\b(diagn[oó]stic\w*|progn[oó]stic\w*|prontu[aá]rio\w*|c[íi]d[- ]?\d{0,3}|exame\w*|laudo\w*|receit[au]\w*|biopsia\w*|tumor\w*|c[âa]ncer\w*|hipertens[ãa]o\w*|diabet\w*|depress[ãa]o\w*|ansiedade\w*|s[íi]ndrome\w*|patologia\w*)\b/gi;
    out = out.replace(TERMOS_CLINICOS_REGEX_LOCAL, function () {
      redacoes++;
      return '[CLINICO]';
    });

    return { ok: true, textoAnon: out, redacoes: redacoes };
  } catch (e) {
    // Fail-closed: QUALQUER excecao devolve ok:false — nunca o texto bruto.
    return { ok: false, textoAnon: '', redacoes: 0 };
  }
}

/**
 * HARD-02 (Fase 5, plano 05-05): scrubber de SAIDA — redige PII da mensagem
 * da Camila ANTES do envio ao lead (guardrails/saida.ts:scrubPII).
 *
 * WR-02 (review Fase 5): o escopo do scrub OUTBOUND e DELIBERADAMENTE menor
 * que o da transcricao arquivada (`anonimizarTranscricao`) — sao contextos
 * diferentes. A transcricao persiste fala espontanea que pode conter dado de
 * PACIENTE (terceiro), entao usa o blocklist clinico amplo. A mensagem de
 * SAIDA e uma conversa de venda peer-to-peer com um profissional de saude:
 * vocabulario clinico ("ansiedade", "diabetes", "exames") e NORMAL e
 * legitimo ali — redigi-lo inline mandava texto corrompido ("casos de
 * [CLINICO]") pro WhatsApp do lead, corroendo a persona. O scrub outbound
 * cobre: (a) PII ESTRUTURADO real (CPF/CNPJ/RG/telefone/email/CEP);
 * (b) nome de paciente APENAS com o marcador explicito 'paciente' ("o
 * paciente Joao") — os gatilhos genericos `seu|dona|Sr.|Sra.` foram
 * removidos daqui (corrompiam "no seu WhatsApp" -> "no seu [PACIENTE]").
 * Boundary 7 proibe discutir PACIENTE ESPECIFICO, nao vocabulario clinico
 * em geral (essa defesa segue no prompt + guardrail de fatos).
 *
 * Por que uma funcao SEPARADA em vez de chamar `anonimizarTranscricao`
 * direto: aquela funcao e fail-CLOSED por design (persistencia de
 * transcricao — perder o dado e preferivel a persistir PII bruto) e seu
 * CORPO e extraido via regex por scripts/smoke-anonimizacao.mjs (`new
 * Function`, sem acesso a import/escopo de modulo) — qualquer mudanca de
 * assinatura/corpo quebraria esse smoke da Fase 3.
 *
 * Fail-safe (diferente de `anonimizarTranscricao`): entrada nao-string ou
 * excecao interna devolve o texto ORIGINAL intacto com `redacoes:0` — nao
 * fail-closed. Um scrubber de SAIDA (mensagem indo pro lead) que esvaziasse
 * a mensagem por um bug interno estaria trocando um risco (PII vazado, raro
 * — regex puro sobre string quase nunca lanca) por outro pior (lead
 * legitimo recebendo silencio/mensagem vazia, contra o core value do SDR).
 * NUNCA loga o texto de entrada/saida (mesma regra LGPD do resto do arquivo).
 */
export function redigirPII(texto: string): ResultadoAnonimizacao {
  if (typeof texto !== 'string' || texto.trim().length === 0) {
    return { ok: true, textoAnon: typeof texto === 'string' ? texto : '', redacoes: 0 };
  }

  try {
    let redacoes = 0;
    let out = texto;

    const CNPJ_REGEX = /\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}\b/g;
    out = out.replace(CNPJ_REGEX, function () {
      redacoes++;
      return '[CNPJ]';
    });

    const CPF_REGEX = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
    out = out.replace(CPF_REGEX, function () {
      redacoes++;
      return '[CPF]';
    });

    const EMAIL_REGEX = /\b[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}\b/g;
    out = out.replace(EMAIL_REGEX, function () {
      redacoes++;
      return '[CONTATO]';
    });

    const TELEFONE_REGEX = /(?:\+?55\s?)?\(?\d{2}\)?[\s.-]?9\d{3,4}[\s.-]?\d{4}\b/g;
    out = out.replace(TELEFONE_REGEX, function () {
      redacoes++;
      return '[CONTATO]';
    });

    const CEP_REGEX = /\b\d{5}-\d{3}\b/g;
    out = out.replace(CEP_REGEX, function () {
      redacoes++;
      return '[CEP]';
    });

    const RG_REGEX = /\b\d{1,2}\.\d{3}\.\d{3}-[0-9Xx]\b/g;
    out = out.replace(RG_REGEX, function () {
      redacoes++;
      return '[RG]';
    });

    // WR-02: SO o marcador explicito 'paciente' dispara a redacao de nome no
    // canal outbound — `seu|dona|Sr.|Sra.` sao tratamento comum em conversa
    // de venda ("no seu WhatsApp", "Sra. Fernanda do time") e corrompiam a
    // mensagem legitima. O blocklist clinico amplo (TERMOS_CLINICOS_REGEX)
    // NAO se aplica aqui (ver docstring) — segue valendo so na transcricao
    // arquivada (anonimizarTranscricao).
    const NOME_PACIENTE_CONTEXTO_REGEX = /\b(o\s+paciente|a\s+paciente|paciente)\s+([A-ZÀ-Ý][a-zà-ÿ]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ]+){0,2})/g;
    out = out.replace(NOME_PACIENTE_CONTEXTO_REGEX, function (_m, marcador) {
      redacoes++;
      return marcador + ' [PACIENTE]';
    });

    return { ok: true, textoAnon: out, redacoes: redacoes };
  } catch (e) {
    // Fail-open (ver nota da funcao): devolve o texto ORIGINAL intacto —
    // nunca esvazia a mensagem do lead por um bug interno deste scrubber.
    return { ok: true, textoAnon: texto, redacoes: 0 };
  }
}
