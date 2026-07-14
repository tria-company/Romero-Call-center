// Smoke de QUAL-01/02/03: prova o parse do form 14q + scoring BANT + Filtro
// 1 (descarte)/Filtro 2 (>=5 Qualificado / <5 Perdido) em bant.ts +
// formulario.ts. Ambos os modulos sao puros (sem imports de mastra/ghl),
// entao importamos direto via node --experimental-strip-types — sem
// necessidade do hack de extracao por regex usado em smokes anteriores
// (create-task.ts/update-contact-field.ts importam ghl.ts, que tem imports
// extensionless incompativel com o loader nativo; bant.ts/formulario.ts nao
// importam nada alem um do outro).
//
// Gap closure 01-13 (2a rodada de regressao, WR-01/WR-02 do 01-REVIEW.md):
// cobre tambem plurais/flexoes do lexico proibido ('curas', 'milagres',
// 'hacks', 'mindsets' — o word-boundary do CR-04 passou a casar so a forma
// exata singular) e respostas de faixa no ticket ('300 a 500', 'entre 1.000
// e 2.000' — paraNumero colava os digitos de numeros distintos).

import { parseFormulario } from '../src/mastra/formulario.ts';
import { filtro1Descarte, scoreBant, decidirRoteamento } from '../src/mastra/bant.ts';

const falhas = [];

function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// Payload base valido: registro ativo, profissao dentro do ICP, ticket >300,
// sem lexico proibido, nao "so explorando". Usado como ponto de partida pra
// cada caso-limite abaixo (cada teste sobrescreve so o campo relevante).
function payloadBase(overrides = {}) {
  return {
    q01_profissao: 'Nutricionista',
    q02_registro_ativo: 'sim',
    q03_tempo_atuacao_anos: '2',
    q04_area_foco: 'nutricao clinica',
    q05_modelo_atendimento: 'consultorio proprio',
    q06_pacientes_semana: '10',
    q07_ticket_medio: '400',
    q08_aplicou_ads: 'nao',
    q09_canal_captacao: 'indicacao',
    q10_indicou_curso: 'nao',
    q11_motivo_interesse: 'quero aplicar o metodo na minha rotina',
    q12_modulo_interrompido: '',
    q13_congresso_sp: 'nao',
    q14_maior_dificuldade: '',
    ...overrides,
  };
}

// ---- Caso 1: descarte por ticket <= R$300 ----
{
  const form = parseFormulario(payloadBase({ q07_ticket_medio: '250' }));
  const resultado = filtro1Descarte(form);
  checar('descarte por ticket<=300: descarta=true', resultado.descarta === true);
  checar('descarte por ticket<=300: motivo=Ticket insuficiente', resultado.motivo === 'Ticket insuficiente');

  const roteamento = decidirRoteamento(form);
  checar('descarte por ticket<=300: roteamento stage=PERDIDO', roteamento.stage === 'PERDIDO');
  checar('descarte por ticket<=300: roteamento enviarMensagem=false', roteamento.stage === 'PERDIDO' && roteamento.enviarMensagem === false);
}

// ---- Caso 2: descarte por lexico proibido no campo aberto ----
{
  const form = parseFormulario(payloadBase({
    q07_ticket_medio: '900',
    q14_maior_dificuldade: 'sinto que preciso de um hack pra aplicar melhor',
  }));
  const resultado = filtro1Descarte(form);
  checar('descarte por lexico: descarta=true', resultado.descarta === true);
  checar('descarte por lexico: motivo=Léxico incompatível', resultado.motivo === 'Léxico incompatível');

  const roteamento = decidirRoteamento(form);
  checar('descarte por lexico: roteamento enviarMensagem=false', roteamento.stage === 'PERDIDO' && roteamento.enviarMensagem === false);
}

// ---- Caso 3: descarte "so explorando" + nao vai Congresso + nao indicou (descarte-sem-mensagem) ----
{
  const form = parseFormulario(payloadBase({
    q07_ticket_medio: '900',
    q11_motivo_interesse: 'so explorando por enquanto',
    q13_congresso_sp: 'nao',
    q10_indicou_curso: 'nao',
  }));
  const resultado = filtro1Descarte(form);
  checar('descarte so explorando: descarta=true', resultado.descarta === true);
  checar('descarte so explorando: motivo=Sem intenção real', resultado.motivo === 'Sem intenção real');

  const roteamento = decidirRoteamento(form);
  checar('descarte so explorando: roteamento stage=PERDIDO', roteamento.stage === 'PERDIDO');
  checar('descarte so explorando: roteamento enviarMensagem=false (Filtro 1 nunca envia mensagem)', roteamento.stage === 'PERDIDO' && roteamento.enviarMensagem === false);
}

// ---- Caso 4: fronteira BANT=5 -> QUALIFICADO ----
{
  const form = parseFormulario(payloadBase({
    q03_tempo_atuacao_anos: '2',      // authority=1 (registro, <5 anos)
    q07_ticket_medio: '400',          // budget=1 (301-600)
    q08_aplicou_ads: 'nao',
    q12_modulo_interrompido: '',       // nao interrompido
    q14_maior_dificuldade: 'dificuldade em aplicar anamnese funcional no dia a dia', // dor declarada -> need=2
    q13_congresso_sp: 'nao',
    q10_indicou_curso: 'nao',          // timing=1
  }));
  const bant = scoreBant(form);
  checar(`fronteira BANT=5: budget=1 (obtido ${bant.budget})`, bant.budget === 1);
  checar(`fronteira BANT=5: authority=1 (obtido ${bant.authority})`, bant.authority === 1);
  checar(`fronteira BANT=5: need=2 (obtido ${bant.need})`, bant.need === 2);
  checar(`fronteira BANT=5: timing=1 (obtido ${bant.timing})`, bant.timing === 1);
  checar(`fronteira BANT=5: total=5 (obtido ${bant.total})`, bant.total === 5);

  const roteamento = decidirRoteamento(form);
  checar('fronteira BANT=5: roteamento stage=QUALIFICADO', roteamento.stage === 'QUALIFICADO');
}

// ---- Caso 5: BANT=4 -> PERDIDO motivo 'BANT insuficiente' ----
{
  const form = parseFormulario(payloadBase({
    q03_tempo_atuacao_anos: '2',      // authority=1
    q07_ticket_medio: '400',          // budget=1
    q08_aplicou_ads: 'nao',
    q12_modulo_interrompido: '',
    q14_maior_dificuldade: '',        // sem dor declarada -> need=1
    q13_congresso_sp: 'nao',
    q10_indicou_curso: 'nao',          // timing=1
  }));
  const bant = scoreBant(form);
  checar(`BANT=4: total=4 (obtido ${bant.total})`, bant.total === 4);

  const roteamento = decidirRoteamento(form);
  checar('BANT=4: roteamento stage=PERDIDO', roteamento.stage === 'PERDIDO');
  checar('BANT=4: roteamento motivo=BANT insuficiente', roteamento.stage === 'PERDIDO' && roteamento.motivo === 'BANT insuficiente');
  checar('BANT=4: roteamento enviarMensagem=false', roteamento.stage === 'PERDIDO' && roteamento.enviarMensagem === false);
}

// ---- Caso 6: ticket pt-BR 'R$ 1.500' vira 1500 (nao 1.5) e NAO descarta por Ticket insuficiente ----
{
  const form = parseFormulario(payloadBase({ q07_ticket_medio: 'R$ 1.500' }));
  checar(`ticket pt-BR 'R$ 1.500': form.ticket=1500 (obtido ${form.ticket})`, form.ticket === 1500);

  const resultado = filtro1Descarte(form);
  checar("ticket pt-BR 'R$ 1.500': NAO descarta por Ticket insuficiente", !(resultado.descarta && resultado.motivo === 'Ticket insuficiente'));

  const bant = scoreBant(form);
  checar(`ticket pt-BR 'R$ 1.500': budget=3 (obtido ${bant.budget})`, bant.budget === 3);
}

// ---- Caso 7: ticket pt-BR com centavos '1.500,00' vira 1500 ----
{
  const form = parseFormulario(payloadBase({ q07_ticket_medio: '1.500,00' }));
  checar(`ticket pt-BR com centavos '1.500,00': form.ticket=1500 (obtido ${form.ticket})`, form.ticket === 1500);
}

// ---- Caso 8: lexico word-boundary — 'procurando' NAO descarta (nao e 'cura' isolada) ----
{
  const form = parseFormulario(payloadBase({
    q07_ticket_medio: '900',
    q14_maior_dificuldade: 'estou procurando uma forma de aplicar o metodo',
  }));
  const resultado = filtro1Descarte(form);
  checar("lexico word-boundary 'procurando': descarta=false", resultado.descarta === false);

  const roteamento = decidirRoteamento(form);
  checar(
    "lexico word-boundary 'procurando': roteamento nao e PERDIDO por lexico",
    !(roteamento.stage === 'PERDIDO' && roteamento.motivo === 'Léxico incompatível'),
  );
}

// ---- Caso 9: regressao — 'cura' isolada continua descartando ----
{
  const form = parseFormulario(payloadBase({
    q07_ticket_medio: '900',
    q14_maior_dificuldade: 'prometo cura para meus pacientes',
  }));
  const resultado = filtro1Descarte(form);
  checar("lexico 'cura' isolada: descarta=true", resultado.descarta === true);
  checar("lexico 'cura' isolada: motivo=Léxico incompatível", resultado.motivo === 'Léxico incompatível');
}

// ---- Caso 10: WR-01 — plural 'curas milagrosas' volta a descartar ----
{
  const form = parseFormulario(payloadBase({
    q07_ticket_medio: '900',
    q14_maior_dificuldade: 'prometo curas milagrosas',
  }));
  const resultado = filtro1Descarte(form);
  checar("WR-01 plural 'curas milagrosas': descarta=true", resultado.descarta === true);
  checar("WR-01 plural 'curas milagrosas': motivo=Léxico incompatível", resultado.motivo === 'Léxico incompatível');
}

// ---- Caso 11: WR-01 — plural 'milagres' volta a descartar ----
{
  const form = parseFormulario(payloadBase({
    q07_ticket_medio: '900',
    q14_maior_dificuldade: 'faço milagres todo dia',
  }));
  const resultado = filtro1Descarte(form);
  checar("WR-01 plural 'milagres': descarta=true", resultado.descarta === true);
  checar("WR-01 plural 'milagres': motivo=Léxico incompatível", resultado.motivo === 'Léxico incompatível');
}

// ---- Caso 12: WR-01 — plural 'hacks'/'mindset' volta a descartar ----
{
  const form = parseFormulario(payloadBase({
    q07_ticket_medio: '900',
    q14_maior_dificuldade: 'uso hacks de mindset',
  }));
  const resultado = filtro1Descarte(form);
  checar("WR-01 plural 'hacks de mindset': descarta=true", resultado.descarta === true);
  checar("WR-01 plural 'hacks de mindset': motivo=Léxico incompatível", resultado.motivo === 'Léxico incompatível');
}

// ---- Caso 13: guarda de regressao — 'estou procurando' continua NAO descartando ----
{
  const form = parseFormulario(payloadBase({
    q07_ticket_medio: '900',
    q14_maior_dificuldade: 'estou procurando uma forma de aplicar o metodo',
  }));
  const resultado = filtro1Descarte(form);
  checar("guarda substring legitima 'estou procurando': descarta=false", resultado.descarta === false);
}

// ---- Caso 14: guarda de regressao — 'busca e procura' continua NAO descartando ----
{
  const form = parseFormulario(payloadBase({
    q07_ticket_medio: '900',
    q14_maior_dificuldade: 'em busca e procura de resultado',
  }));
  const resultado = filtro1Descarte(form);
  checar("guarda substring legitima 'busca e procura': descarta=false", resultado.descarta === false);
}

// ---- Caso 15: WR-02 — faixa '350 a 500' usa o piso (350), sem corromper o roteamento ----
{
  // O piso da faixa fica acima da fronteira de descarte (>300), provando
  // sem ambiguidade que o roteamento nao descarta por 'Ticket insuficiente'
  // quando o piso real da faixa e suficiente (guarda contra o bug antigo de
  // concatenacao, que geraria '350500' — bem acima do piso real).
  const form = parseFormulario(payloadBase({ q07_ticket_medio: '350 a 500' }));
  checar(`WR-02 faixa '350 a 500': form.ticket=350 (obtido ${form.ticket})`, form.ticket === 350);
  const roteamento = decidirRoteamento(form);
  checar(
    "WR-02 faixa '350 a 500': roteamento nao e PERDIDO por 'Ticket insuficiente' via faixa concatenada",
    !(roteamento.stage === 'PERDIDO' && roteamento.motivo === 'Ticket insuficiente'),
  );
}

// ---- Caso 16: WR-02 — faixa '300 a 500' extrai o piso exato 300 (nao corrompido pra '300500') ----
{
  // O piso e exatamente 300, que bate na fronteira legitima do Filtro 1
  // (ticket<=300 descarta — regra pre-existente, fora do escopo do
  // WR-02/IN-01). O que este caso prova e que o VALOR nao e corrompido pela
  // concatenacao do bug antigo — se fosse '300500', o Filtro 1 NAO
  // descartaria (300500>300), mascarando um ticket real insuficiente.
  const form = parseFormulario(payloadBase({ q07_ticket_medio: '300 a 500' }));
  checar(`WR-02 faixa '300 a 500': form.ticket=300 (obtido ${form.ticket})`, form.ticket === 300);
}

// ---- Caso 17: WR-02 — faixa 'entre 1.000 e 2.000' usa o piso pt-BR de milhar (1000) ----
{
  const form = parseFormulario(payloadBase({ q07_ticket_medio: 'entre 1.000 e 2.000' }));
  checar(`WR-02 faixa 'entre 1.000 e 2.000': form.ticket=1000 (obtido ${form.ticket})`, form.ticket === 1000);
  const bant = scoreBant(form);
  checar(`WR-02 faixa 'entre 1.000 e 2.000': budget=3 (obtido ${bant.budget})`, bant.budget === 3);
}

// ---- Caso 18: guarda de regressao — ticket pt-BR 'R$ 1.500' preservado apos o fix de faixa ----
{
  const form = parseFormulario(payloadBase({ q07_ticket_medio: 'R$ 1.500' }));
  checar(`guarda ticket 'R$ 1.500': form.ticket=1500 (obtido ${form.ticket})`, form.ticket === 1500);
}

// ---- Caso 19: guarda de regressao — ticket pt-BR com centavos '1.500,00' preservado ----
{
  const form = parseFormulario(payloadBase({ q07_ticket_medio: '1.500,00' }));
  checar(`guarda ticket '1.500,00': form.ticket=1500 (obtido ${form.ticket})`, form.ticket === 1500);
}

// ---- Caso 20: guarda de regressao — decimal simples '2.5' preservado ----
{
  const form = parseFormulario(payloadBase({ q07_ticket_medio: '2.5' }));
  checar(`guarda ticket '2.5': form.ticket=2.5 (obtido ${form.ticket})`, form.ticket === 2.5);
}

// ---- Caso 21: guarda de regressao — inteiro simples '400' preservado ----
{
  const form = parseFormulario(payloadBase({ q07_ticket_medio: '400' }));
  checar(`guarda ticket '400': form.ticket=400 (obtido ${form.ticket})`, form.ticket === 400);
}

if (falhas.length > 0) {
  console.error('[smoke-bant] QUAL-01/02/03 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-bant] QUAL-01/02/03 OK');
