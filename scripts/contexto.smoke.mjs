#!/usr/bin/env node
// scripts/contexto.smoke.mjs
//
// Smoke determinístico (sem rede) do Agente Contexto (OPER-05, Fase 03
// Plano 04, D-P3-12/13/14). Prova, via fixtures, que `montarPromptContexto`
// (src/mastra/contexto.ts) monta um prompt válido integrando a observação
// atual + o resultado da nova ligação, que `proximoContato` aplica a regra
// D-P3-14 (DATA_RETORNO sempre vence; senão a regra fixa parametrizável), e
// que `derivarContadores` atualiza os contadores mecânicos do lead de forma
// consistente com ATENDEU.
//
// Uso: node --experimental-strip-types scripts/contexto.smoke.mjs

import { montarPromptContexto, proximoContato, derivarContadores } from '../src/mastra/contexto.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ===== montarPromptContexto =====

function testarMontarPromptContextoAtendido() {
  const { system, prompt } = montarPromptContexto({
    observacaoAtual: 'Lead já foi contatado 2x, sempre pediu retorno.',
    atendeu: true,
    resumoAnalise: 'Lead demonstrou interesse, pediu retorno na próxima semana.',
    aderencia: 8,
    retorno: { necessario: true, data: new Date('2026-08-20T00:00:00Z') },
  });
  checar(typeof system === 'string' && system.length > 0, 'montarPromptContexto deveria retornar system não-vazio');
  checar(prompt.includes('Lead já foi contatado 2x, sempre pediu retorno.'), 'prompt deveria incluir a observação atual');
  checar(prompt.includes('Lead demonstrou interesse, pediu retorno na próxima semana.'), 'prompt deveria incluir o resumo da análise');
  checar(prompt.includes('Aderência ao script: 8/10'), 'prompt deveria incluir a aderência quando presente');
  checar(prompt.includes('2026-08-20'), 'prompt deveria incluir a data do retorno combinado');
  checar(prompt.includes('Atendeu: sim'), 'prompt deveria indicar atendeu=sim');
}

function testarMontarPromptContextoSemObservacaoAnterior() {
  const { prompt } = montarPromptContexto({
    observacaoAtual: '',
    atendeu: false,
    resumoAnalise: '',
    aderencia: null,
    retorno: { necessario: false, data: null },
  });
  checar(prompt.includes('nenhuma observação anterior'), 'prompt deveria sinalizar ausência de observação anterior');
  checar(prompt.includes('Atendeu: não'), 'prompt deveria indicar atendeu=não');
  checar(!prompt.includes('Aderência ao script'), 'prompt NÃO deveria incluir linha de aderência quando null');
  checar(prompt.includes('Retorno combinado: não'), 'prompt deveria indicar retorno combinado=não');
}

// ===== proximoContato =====

const HOJE = new Date('2026-08-10T12:00:00Z');

function testarProximoContatoComDataRetorno() {
  const dataRetorno = new Date('2026-08-25T00:00:00Z');
  const data = proximoContato({ dataRetorno, atendeu: true, hoje: HOJE, diasNaoAtendeu: 1, diasDefault: 2 });
  checar(data.getTime() === dataRetorno.getTime(), 'DATA_RETORNO deveria vencer sobre a regra fixa (D-P3-14)');
}

function testarProximoContatoNaoAtendeu() {
  const data = proximoContato({ dataRetorno: null, atendeu: false, hoje: HOJE, diasNaoAtendeu: 1, diasDefault: 2 });
  const esperado = new Date(HOJE.getTime() + 1 * 24 * 60 * 60 * 1000);
  checar(data.getTime() === esperado.getTime(), `não atendeu deveria ser hoje+1 dia, recebido ${data}`);
}

function testarProximoContatoAtendeuSemRetorno() {
  const data = proximoContato({ dataRetorno: null, atendeu: true, hoje: HOJE, diasNaoAtendeu: 1, diasDefault: 2 });
  const esperado = new Date(HOJE.getTime() + 2 * 24 * 60 * 60 * 1000);
  checar(data.getTime() === esperado.getTime(), `atendeu sem retorno deveria ser hoje+2 dias, recebido ${data}`);
}

// ===== derivarContadores =====

function testarDerivarContadoresAtendeu() {
  const c = derivarContadores({
    atendeu: true,
    tentativasAtuais: 3,
    atendimentosAtuais: 1,
    naoAtendimentosAtuais: 2,
    hoje: HOJE,
  });
  checar(c.tentativas === 4, `tentativas deveria ser 4, recebido ${c.tentativas}`);
  checar(c.atendimentos === 2, `atendimentos deveria incrementar para 2, recebido ${c.atendimentos}`);
  checar(c.naoAtendimentos === 2, `naoAtendimentos NAO deveria mudar, recebido ${c.naoAtendimentos}`);
  checar(c.ultimoContato === HOJE.getTime(), 'ultimoContato deveria ser hoje');
  checar(c.ultimoAtendimento === HOJE.getTime(), 'ultimoAtendimento deveria ser hoje quando atendeu');
}

function testarDerivarContadoresNaoAtendeu() {
  const c = derivarContadores({
    atendeu: false,
    tentativasAtuais: 3,
    atendimentosAtuais: 1,
    naoAtendimentosAtuais: 2,
    hoje: HOJE,
  });
  checar(c.tentativas === 4, `tentativas deveria ser 4 mesmo sem atender, recebido ${c.tentativas}`);
  checar(c.atendimentos === 1, `atendimentos NAO deveria mudar, recebido ${c.atendimentos}`);
  checar(c.naoAtendimentos === 3, `naoAtendimentos deveria incrementar para 3, recebido ${c.naoAtendimentos}`);
  checar(c.ultimoContato === HOJE.getTime(), 'ultimoContato deveria ser hoje mesmo sem atender');
  checar(c.ultimoAtendimento === null, 'ultimoAtendimento deveria ficar null quando NAO atendeu');
}

testarMontarPromptContextoAtendido();
testarMontarPromptContextoSemObservacaoAnterior();
testarProximoContatoComDataRetorno();
testarProximoContatoNaoAtendeu();
testarProximoContatoAtendeuSemRetorno();
testarDerivarContadoresAtendeu();
testarDerivarContadoresNaoAtendeu();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
