// Smoke de HARD-02: prova os OUTPUT GUARDRAILS deterministicos em
// guardrails/saida.ts — schema (validarSchema), PII scrubber (scrubPII) e
// checagem de fatos-autorizados/anti-alucinacao (checarFatosAutorizados),
// orquestrados por avaliarSaida. Modulo so importa camila-schema.ts e
// anonimizacao.ts (ambos puros) — importado direto via
// node --experimental-strip-types, mesmo padrao de
// scripts/smoke-fallback.mjs / scripts/smoke-guardrail-injecao.mjs.

import {
  validarSchema,
  scrubPII,
  checarFatosAutorizados,
  avaliarSaida,
  CONCORRENTES_CONHECIDOS_STEMS,
} from '../src/mastra/guardrails/saida.ts';

const falhas = [];
function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

function saidaValidaCamila(mensagens = ['oi'], overrides = {}) {
  return JSON.stringify({
    acao: 'responder',
    mensagens,
    proximo_estado: 'S',
    tools_a_executar: [],
    sinal_alerta: null,
    ...overrides,
  });
}

// ============================================================================
// 1) scrubPII — PII estruturado
// ============================================================================
{
  const r = scrubPII('meu cpf e 123.456.789-00, liga (11) 99999-8888');
  checar('scrubPII: CPF redigido -> [CPF] presente', r.texto.includes('[CPF]'));
  checar('scrubPII: CPF redigido -> digitos originais ausentes', !r.texto.includes('123.456.789-00'));
  checar('scrubPII: telefone redigido -> [CONTATO] presente', r.texto.includes('[CONTATO]'));
  checar('scrubPII: telefone redigido -> digitos originais ausentes', !r.texto.includes('99999-8888'));
  checar('scrubPII: redacoes >= 2 (CPF + telefone)', r.redacoes >= 2);
  checar('scrubPII: preserva o resto do texto ("liga")', r.texto.includes('liga'));
}

// ============================================================================
// 2) scrubPII — nome de paciente por marcador explicito (WR-02: escopo
// outbound REDUZIDO — so 'paciente <Nome>' redige; o blocklist clinico da
// transcricao NAO se aplica ao canal de saida)
// ============================================================================
{
  const r = scrubPII('o paciente Joao tem diabetes');
  checar('scrubPII (paciente): nome de paciente redigido -> [PACIENTE] presente', r.texto.includes('[PACIENTE]'));
  checar('scrubPII (paciente): nome "Joao" ausente apos redacao', !r.texto.includes('Joao'));
  checar('scrubPII (WR-02): termo clinico "diabetes" NAO e mais garbleado no outbound', r.texto.includes('diabetes') && !r.texto.includes('[CLINICO]'));
  checar('scrubPII (paciente): redacoes >= 1 (nome do paciente)', r.redacoes >= 1);
}

// ============================================================================
// 2b) WR-02 — mensagens legitimas de venda NAO sao corrompidas pelo scrub
// outbound: vocabulario clinico de conversa peer-to-peer e tratamento comum
// ("seu", "Sra.") passam intactos.
// ============================================================================
{
  const t1 = 'muita gente trava nos casos de ansiedade, o Metodo ADS ajuda a olhar a raiz';
  const r1 = scrubPII(t1);
  checar('scrubPII (WR-02): "casos de ansiedade" passa intacto (sem [CLINICO])', r1.texto === t1 && r1.redacoes === 0);

  const t2 = 'te mando o link no seu WhatsApp, pode ser?';
  const r2 = scrubPII(t2);
  checar('scrubPII (WR-02): "no seu WhatsApp" passa intacto (sem [PACIENTE])', r2.texto === t2 && r2.redacoes === 0);

  const t3 = 'pode pedir os exames e a receita normalmente pelo sistema';
  const r3 = scrubPII(t3);
  checar('scrubPII (WR-02): "exames"/"receita" passam intactos no outbound', r3.texto === t3 && r3.redacoes === 0);
}

// ============================================================================
// 3) scrubPII — texto limpo passa intacto (nao redige nada por engano)
// ============================================================================
{
  const texto = 'Combinado, vamos agendar a call comercial pra proxima semana.';
  const r = scrubPII(texto);
  checar('scrubPII (limpo): texto intacto', r.texto === texto);
  checar('scrubPII (limpo): redacoes === 0', r.redacoes === 0);
}

// ============================================================================
// 4) scrubPII — fail-safe (nao-string / vazio nao lanca, nunca esvazia por bug)
// ============================================================================
{
  let lancou = false;
  let r;
  try {
    r = scrubPII(null);
  } catch {
    lancou = true;
  }
  checar('scrubPII(null): nao lanca', lancou === false);
  checar('scrubPII(null): texto vazio, redacoes 0', r.texto === '' && r.redacoes === 0);
}

// ============================================================================
// 5) checarFatosAutorizados — preco + prazo clinico inventados na mesma frase
// ============================================================================
{
  const r = checarFatosAutorizados('nosso plano custa R$ 497 e cura em 30 dias');
  checar('fatos (preco+prazo): seguro=false', r.seguro === false);
  checar('fatos (preco+prazo): violacoes inclui "preco"', r.violacoes.includes('preco'));
  checar('fatos (preco+prazo): violacoes inclui "prazo_clinico"', r.violacoes.includes('prazo_clinico'));
}

// ============================================================================
// 5b) WR-01 — precos AUTORIZADOS pelo prompt (Starter R$ 797 / Pro R$ 1.497)
// NAO sao suprimidos; preco NAO-autorizado continua violacao.
// ============================================================================
{
  const rAutorizado = checarFatosAutorizados('o Starter sai por R$ 797 e o Pro por R$ 1.497, mas o detalhe e conversa pro closer');
  checar('fatos (WR-01, precos autorizados): seguro=true', rAutorizado.seguro === true);
  checar('fatos (WR-01, precos autorizados): sem violacao "preco"', !rAutorizado.violacoes.includes('preco'));

  const rAutorizado2 = checarFatosAutorizados('o plano Pro custa R$ 1497 por mes');
  checar('fatos (WR-01, 1497 sem ponto): seguro=true', rAutorizado2.seguro === true);

  const rInventado = checarFatosAutorizados('consigo fazer por R$ 497 pra voce');
  checar('fatos (WR-01, preco inventado R$ 497): seguro=false', rInventado.seguro === false);
  checar('fatos (WR-01, preco inventado): violacoes inclui "preco"', rInventado.violacoes.includes('preco'));

  const rMisto = checarFatosAutorizados('o Starter e R$ 797, mas te dou por R$ 500');
  checar('fatos (WR-01, autorizado + inventado juntos): seguro=false (o inventado ainda pega)', rMisto.violacoes.includes('preco'));
}

// ============================================================================
// 5c) WR-01 — fatos autorizados de garantia/migracao NAO disparam GRAVE;
// garantia de RESULTADO continua GRAVE.
// ============================================================================
{
  const rMigracao = checarFatosAutorizados('a migracao dos seus dados e garantida pela equipe em 48h');
  checar('fatos (WR-01, migracao garantida 48h — fato autorizado): sem violacao "garantia_bonus"', !rMigracao.violacoes.includes('garantia_bonus'));

  const rGarantia7d = checarFatosAutorizados('tem garantia de 7 dias, se nao curtir voce cancela');
  checar('fatos (WR-01, garantia de 7 dias — fato autorizado): sem violacao "garantia_bonus"', !rGarantia7d.violacoes.includes('garantia_bonus'));

  const rResultado = checarFatosAutorizados('e o resultado e garantido, pode confiar');
  checar('fatos (WR-01, "resultado e garantido" segue violacao GRAVE)', rResultado.violacoes.includes('garantia_bonus'));

  const rGarantiaResultado = checarFatosAutorizados('temos garantia de resultado em qualquer caso');
  checar('fatos (WR-01, "garantia de resultado" segue violacao)', rGarantiaResultado.violacoes.includes('garantia_bonus'));
}

// ============================================================================
// 6) checarFatosAutorizados — estatistica/percentual de marketing
// ============================================================================
{
  const r = checarFatosAutorizados('83% dos nossos clientes recupera 8h/semana');
  checar('fatos (percentual): seguro=false', r.seguro === false);
  checar('fatos (percentual): violacoes inclui "percentual"', r.violacoes.includes('percentual'));
}

// ============================================================================
// 7) checarFatosAutorizados — garantia/bonus inventados
// ============================================================================
{
  const r = checarFatosAutorizados('temos um bonus exclusivo e resultado garantido pra voce');
  checar('fatos (garantia/bonus): seguro=false', r.seguro === false);
  checar('fatos (garantia/bonus): violacoes inclui "garantia_bonus"', r.violacoes.includes('garantia_bonus'));
}

// ============================================================================
// 8) checarFatosAutorizados — concorrente nominal (lista-piso ajustavel)
// ============================================================================
{
  checar('CONCORRENTES_CONHECIDOS_STEMS tem pelo menos 1 item (lista-piso nao-vazia)', CONCORRENTES_CONHECIDOS_STEMS.length >= 1);
  const marca = CONCORRENTES_CONHECIDOS_STEMS[0];
  const r = checarFatosAutorizados(`isso e bem melhor que o ${marca}, viu`);
  checar(`fatos (concorrente "${marca}"): seguro=false`, r.seguro === false);
  checar('fatos (concorrente): violacoes inclui "concorrente_nominal"', r.violacoes.includes('concorrente_nominal'));
}

// ============================================================================
// 9) ANTI FALSO-POSITIVO — mensagem legitima (call/Metodo ADS) passa intacta
// ============================================================================
{
  const texto = 'a call e com o closer, ele te mostra como funciona o Metodo ADS';
  const r = checarFatosAutorizados(texto);
  checar('fatos (legitima, call/Metodo ADS): seguro=true', r.seguro === true);
  checar('fatos (legitima, call/Metodo ADS): violacoes vazio', r.violacoes.length === 0);
}

// ============================================================================
// 10) ANTI FALSO-POSITIVO — horario/duracao NAO sao preco/%/prazo-clinico
// ============================================================================
{
  const texto = 'a call e amanha as 15h e dura uns 45min, o closer explica o resto';
  const r = checarFatosAutorizados(texto);
  checar('fatos (horario/duracao): seguro=true', r.seguro === true);
  checar('fatos (horario/duracao): violacoes vazio', r.violacoes.length === 0);
}

// ============================================================================
// 11) validarSchema — malformado nao envia; valido passa
// ============================================================================
{
  const invalido = validarSchema('isso nao e JSON nenhum');
  checar('validarSchema (malformado): seguro=false', invalido.seguro === false);
  checar('validarSchema (malformado): data ausente', invalido.data === undefined);

  const valido = validarSchema(saidaValidaCamila(['oi, tudo bem?']));
  checar('validarSchema (valido): seguro=true', valido.seguro === true);
  checar('validarSchema (valido): data presente', valido.data !== undefined);
}

// ============================================================================
// 12) avaliarSaida — schema invalido: nao envia (acao suprimir)
// ============================================================================
{
  const r = avaliarSaida('lixo nao-JSON qualquer');
  checar('avaliarSaida (schema invalido): seguro=false', r.seguro === false);
  checar('avaliarSaida (schema invalido): envia=false', r.envia === false);
  checar('avaliarSaida (schema invalido): acao=suprimir', r.acao === 'suprimir');
}

// ============================================================================
// 13) avaliarSaida — mensagem com PII: redige e ENVIA (PII nao bloqueia o envio)
// ============================================================================
{
  const raw = saidaValidaCamila(['meu cpf e 123.456.789-00, te chamo depois']);
  const r = avaliarSaida(raw);
  checar('avaliarSaida (PII): seguro=true (sem violacao de FATO)', r.seguro === true);
  checar('avaliarSaida (PII): envia=true', r.envia === true);
  checar('avaliarSaida (PII): mensagensScrubbed[0] contem [CPF]', r.mensagensScrubbed[0].includes('[CPF]'));
  checar('avaliarSaida (PII): mensagensScrubbed[0] nao contem os digitos originais', !r.mensagensScrubbed[0].includes('123.456.789-00'));
}

// ============================================================================
// 14) avaliarSaida — fato inventado GRAVE (prazo clinico): suprime a mensagem
// e sinaliza acao=escalar; nada crua e enviada.
// ============================================================================
{
  const raw = saidaValidaCamila(['voce cura em 30 dias, garantido']);
  const r = avaliarSaida(raw);
  checar('avaliarSaida (grave): seguro=false', r.seguro === false);
  checar('avaliarSaida (grave): mensagem violante NAO esta em mensagensScrubbed', r.mensagensScrubbed.length === 0);
  checar('avaliarSaida (grave): envia=false (toda mensagem foi suprimida)', r.envia === false);
  checar('avaliarSaida (grave): acao=escalar', r.acao === 'escalar');
  checar('avaliarSaida (grave): violacoes inclui prazo_clinico', r.violacoes.includes('prazo_clinico'));
}

// ============================================================================
// 15) avaliarSaida — fato inventado NAO-grave (preco) + mensagem legitima:
// suprime so a violante, ENVIA a legitima (acao=suprimir, envia=true).
// ============================================================================
{
  const raw = saidaValidaCamila(['nosso plano custa R$ 497', 'mas a call com o closer resolve isso']);
  const r = avaliarSaida(raw);
  checar('avaliarSaida (misto): seguro=false', r.seguro === false);
  checar('avaliarSaida (misto): acao=suprimir (nao grave)', r.acao === 'suprimir');
  checar('avaliarSaida (misto): envia=true (sobrou a mensagem legitima)', r.envia === true);
  checar('avaliarSaida (misto): mensagensScrubbed tem exatamente a legitima', r.mensagensScrubbed.length === 1 && r.mensagensScrubbed[0].includes('closer'));
  checar('avaliarSaida (misto): a mensagem de preco NUNCA aparece em mensagensScrubbed', !r.mensagensScrubbed.some((m) => m.includes('R$ 497')));
}

// ============================================================================
// 16) avaliarSaida — mensagem legitima limpa: seguro/envia/acao=enviar
// ============================================================================
{
  const raw = saidaValidaCamila(['perfeito, vamos agendar a call comercial entao']);
  const r = avaliarSaida(raw);
  checar('avaliarSaida (limpo): seguro=true', r.seguro === true);
  checar('avaliarSaida (limpo): envia=true', r.envia === true);
  checar('avaliarSaida (limpo): acao=enviar', r.acao === 'enviar');
  checar('avaliarSaida (limpo): violacoes vazio', r.violacoes.length === 0);
}

if (falhas.length > 0) {
  console.error('[smoke-guardrail-saida] HARD-02 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-guardrail-saida] HARD-02 OK');
