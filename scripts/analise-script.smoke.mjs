#!/usr/bin/env node
// scripts/analise-script.smoke.mjs
//
// Smoke determinístico (sem rede) do Agente Análise (OPER-03/04, Fase 03
// Plano 03, D-P3-09/10/11/15). Prova, via fixtures, que
// `parseResultadoAnalise` (src/mastra/analise.ts) extrai o JSON da saída do
// LLM de forma defensiva (JSON puro, JSON cercado por código, texto
// inválido), que `necessitaRevisao` aplica a regra composta (aderência <
// limiar, falha técnica, sinal de alerta/opt-out), e que `extrairRetorno`
// normaliza o retorno combinado na conversa (com data explícita e sem data —
// default +2 dias úteis).
//
// Uso: node --experimental-strip-types scripts/analise-script.smoke.mjs

import { montarPromptAnalise, parseResultadoAnalise, necessitaRevisao, extrairRetorno } from '../src/mastra/analise.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ===== montarPromptAnalise =====

function testarMontarPromptAnalise() {
  const { system, prompt } = montarPromptAnalise({
    script: 'Script de teste com 5 seções.',
    transcricao: 'Alô, aqui é o vendedor da RomeroCall...',
  });
  checar(typeof system === 'string' && system.length > 0, 'montarPromptAnalise deveria retornar system não-vazio');
  checar(typeof prompt === 'string' && prompt.includes('Script de teste com 5 seções.'), 'prompt deveria incluir o script recebido');
  checar(prompt.includes('Alô, aqui é o vendedor da RomeroCall...'), 'prompt deveria incluir a transcrição recebida');
  checar(prompt.includes('Abertura'), 'prompt deveria listar as 5 seções do script (ex.: Abertura)');
}

// ===== parseResultadoAnalise =====

const JSON_VALIDO = JSON.stringify({
  aderencia: 8,
  resumoAnalise: 'Ligação seguiu o script, lead demonstrou interesse.',
  sinaisAlerta: [],
  retorno: { necessario: true, data: '2026-08-15' },
  observacoesExtraidas: 'Lead pediu para ligar depois das 18h.',
});

const JSON_CERCADO = '```json\n' + JSON_VALIDO + '\n```';

const TEXTO_INVALIDO = 'Desculpe, não consigo processar esta solicitação no momento.';

function testarParseJsonValido() {
  const resultado = parseResultadoAnalise(JSON_VALIDO);
  checar(resultado.falhaTecnica === false, 'JSON válido não deveria marcar falhaTecnica');
  checar(resultado.aderencia === 8, `aderencia incorreta: esperado 8, recebido ${resultado.aderencia}`);
  checar(resultado.retorno.necessario === true, 'retorno.necessario deveria ser true');
  checar(resultado.retorno.data === '2026-08-15', `retorno.data incorreta: ${resultado.retorno.data}`);
}

function testarParseJsonCercado() {
  const resultado = parseResultadoAnalise(JSON_CERCADO);
  checar(resultado.falhaTecnica === false, 'JSON cercado por ```json não deveria marcar falhaTecnica');
  checar(resultado.aderencia === 8, `aderencia incorreta (cercado): esperado 8, recebido ${resultado.aderencia}`);
}

function testarParseTextoInvalido() {
  const resultado = parseResultadoAnalise(TEXTO_INVALIDO);
  checar(resultado.falhaTecnica === true, 'texto sem JSON reconhecível deveria marcar falhaTecnica');
}

function testarParseVazio() {
  const resultado = parseResultadoAnalise('');
  checar(resultado.falhaTecnica === true, 'texto vazio deveria marcar falhaTecnica');
}

function testarParseAderenciaForaDaFaixa() {
  const bruto = JSON.stringify({ aderencia: 15, retorno: {} });
  const resultado = parseResultadoAnalise(bruto);
  checar(resultado.aderencia === 10, `aderencia acima de 10 deveria ser clampada em 10, recebido ${resultado.aderencia}`);
}

// ===== necessitaRevisao =====

function testarNecessitaRevisaoAderenciaBaixa() {
  const resultado = necessitaRevisao({ aderencia: 3, limiar: 6, sinaisAlerta: [], falhaTecnica: false });
  checar(resultado === true, 'aderência abaixo do limiar deveria necessitar revisão');
}

function testarNecessitaRevisaoAderenciaOk() {
  const resultado = necessitaRevisao({ aderencia: 8, limiar: 6, sinaisAlerta: [], falhaTecnica: false });
  checar(resultado === false, 'aderência acima do limiar, sem sinais, sem falha técnica NÃO deveria necessitar revisão');
}

function testarNecessitaRevisaoFalhaTecnica() {
  const resultado = necessitaRevisao({ aderencia: 9, limiar: 6, sinaisAlerta: [], falhaTecnica: true });
  checar(resultado === true, 'falha técnica deveria necessitar revisão mesmo com aderência alta (D-P3-08)');
}

function testarNecessitaRevisaoOptOut() {
  const resultado = necessitaRevisao({
    aderencia: 9,
    limiar: 6,
    sinaisAlerta: ['pedido para não ligar mais'],
    falhaTecnica: false,
  });
  checar(resultado === true, 'sinal de alerta (opt-out) deveria necessitar revisão mesmo com aderência alta (D-P3-15)');
}

// ===== extrairRetorno =====

const HOJE = new Date('2026-08-10T12:00:00Z'); // segunda-feira

function testarExtrairRetornoComData() {
  const resultado = { retorno: { necessario: true, data: '2026-08-20' } };
  const { necessario, data } = extrairRetorno(resultado, { hoje: HOJE, defaultDias: 2 });
  checar(necessario === true, 'retorno com data explícita deveria manter necessario=true');
  checar(
    data instanceof Date && data.getTime() === new Date('2026-08-20').getTime(),
    `data deveria ser a explícita (2026-08-20), recebido ${data}`,
  );
}

function testarExtrairRetornoSemData() {
  const resultado = { retorno: { necessario: true, data: null } };
  const { necessario, data } = extrairRetorno(resultado, { hoje: HOJE, defaultDias: 2 });
  checar(necessario === true, 'retorno sem data deveria manter necessario=true');
  // HOJE = segunda 2026-08-10 -> +2 dias úteis = quarta 2026-08-12 (sem fim de semana no meio).
  checar(
    data instanceof Date && data.getTime() === new Date('2026-08-12T12:00:00Z').getTime(),
    `data default incorreta: esperado 2026-08-12, recebido ${data}`,
  );
}

function testarExtrairRetornoSemDataAtravessaFimDeSemana() {
  // Sexta-feira -> +2 dias úteis deveria pular sábado/domingo e cair na terça.
  const sexta = new Date('2026-08-14T12:00:00Z');
  const resultado = { retorno: { necessario: true, data: null } };
  const { data } = extrairRetorno(resultado, { hoje: sexta, defaultDias: 2 });
  checar(
    data instanceof Date && data.getTime() === new Date('2026-08-18T12:00:00Z').getTime(),
    `default deveria pular fim de semana e cair em 2026-08-18 (terça), recebido ${data}`,
  );
}

function testarExtrairRetornoNaoNecessario() {
  const resultado = { retorno: { necessario: false, data: null } };
  const { necessario, data } = extrairRetorno(resultado, { hoje: HOJE, defaultDias: 2 });
  checar(necessario === false, 'retorno não necessário deveria manter necessario=false');
  checar(data === null, `retorno não necessário deveria ter data null, recebido ${data}`);
}

testarMontarPromptAnalise();
testarParseJsonValido();
testarParseJsonCercado();
testarParseTextoInvalido();
testarParseVazio();
testarParseAderenciaForaDaFaixa();
testarNecessitaRevisaoAderenciaBaixa();
testarNecessitaRevisaoAderenciaOk();
testarNecessitaRevisaoFalhaTecnica();
testarNecessitaRevisaoOptOut();
testarExtrairRetornoComData();
testarExtrairRetornoSemData();
testarExtrairRetornoSemDataAtravessaFimDeSemana();
testarExtrairRetornoNaoNecessario();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
