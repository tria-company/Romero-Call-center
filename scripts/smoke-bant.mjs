// Smoke de QUAL-01/02/03: prova o parse do form 14q + scoring BANT + Filtro
// 1 (descarte)/Filtro 2 (>=5 Qualificado / <5 Perdido) em bant.ts +
// formulario.ts. Ambos os modulos sao puros (sem imports de mastra/ghl),
// entao importamos direto via node --experimental-strip-types — sem
// necessidade do hack de extracao por regex usado em smokes anteriores
// (create-task.ts/update-contact-field.ts importam ghl.ts, que tem imports
// extensionless incompativel com o loader nativo; bant.ts/formulario.ts nao
// importam nada alem um do outro).

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

if (falhas.length > 0) {
  console.error('[smoke-bant] QUAL-01/02/03 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-bant] QUAL-01/02/03 OK');
