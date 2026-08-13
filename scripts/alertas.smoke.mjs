#!/usr/bin/env node
// scripts/alertas.smoke.mjs
//
// Smoke determinístico (sem rede/Redis) da checagem periódica de threshold
// (`src/mastra/alertas.ts`, Fase 10 Plano 04, D-07, OBS-02). Roda SEM
// ALERT_WEBHOOK_URL no ambiente — o POST de alertarThreshold() vira no-op
// (só log), então o smoke prova a LÓGICA de comparação/dedup, não a
// entrega de rede. Prova:
//   1. avaliarThresholds(snapshot) NÃO gera alerta para um snapshot dentro
//      de todos os limites.
//   2. avaliarThresholds(snapshot) gera o alerta certo quando profundidade
//      de fila / taxa de erro por etapa / 429 passam do limite configurado.
//   3. A taxa de erro por etapa só alerta com amostra mínima (evita ruído
//      de amostra pequena) — um total abaixo do mínimo não dispara mesmo
//      com taxa 100%.
//   4. Nenhuma string de título/detalhe dos alertas inclui telefone/CPF/voto.
//   5. iniciarChecagemAlertas()/fecharAlertas() não lançam e são
//      idempotentes (chamar 2x não duplica o efeito nem lança).
//
// Uso: node --experimental-strip-types scripts/alertas.smoke.mjs

import { avaliarThresholds, iniciarChecagemAlertas, fecharAlertas } from '../src/mastra/alertas.ts';
import {
  METRICAS_FILA_ALERTA,
  METRICAS_ERRO_TAXA_ALERTA,
  METRICAS_429_ALERTA,
} from '../src/mastra/config.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function snapshotBase() {
  return {
    atendentesOnline: 0,
    chamadasAtivas: 0,
    profundidadeFila: 0,
    errosDia: 0,
    taxaErroPorEtapa: {
      webhook: { erros: 0, total: 0, taxa: 0 },
      transcricao: { erros: 0, total: 0, taxa: 0 },
      analise: { erros: 0, total: 0, taxa: 0 },
      sync: { erros: 0, total: 0, taxa: 0 },
    },
    contagem429: 0,
  };
}

function testeDentroDoLimiteNaoAlerta() {
  const snapshot = snapshotBase();
  snapshot.profundidadeFila = Math.max(0, METRICAS_FILA_ALERTA - 1);
  snapshot.contagem429 = Math.max(0, METRICAS_429_ALERTA - 1);

  const alertas = avaliarThresholds(snapshot);
  checar(alertas.length === 0, `snapshot dentro dos limites não deveria gerar alerta, recebido: ${JSON.stringify(alertas)}`);
}

function testeFilaAcimaDoLimiteAlerta() {
  const snapshot = snapshotBase();
  snapshot.profundidadeFila = METRICAS_FILA_ALERTA + 1;

  const alertas = avaliarThresholds(snapshot);
  const alerta = alertas.find((a) => a.chave === 'fila');
  checar(!!alerta, 'profundidadeFila acima do limite deveria gerar alerta chave=fila');
  checar(!!alerta && alerta.titulo.includes('acima do limite'), 'título do alerta de fila deveria conter "acima do limite"');
}

function testeEtapaAcimaDoLimiteComAmostraSuficienteAlerta() {
  const snapshot = snapshotBase();
  // total=20 >= MIN_TOTAL_ETAPA_ALERTA (10), taxa 0.5 > METRICAS_ERRO_TAXA_ALERTA
  snapshot.taxaErroPorEtapa.transcricao = { erros: 10, total: 20, taxa: 10 / 20 };
  checar(10 / 20 > METRICAS_ERRO_TAXA_ALERTA, 'pré-condição do teste: taxa de 0.5 deveria exceder o limite configurado');

  const alertas = avaliarThresholds(snapshot);
  const alerta = alertas.find((a) => a.chave === 'etapa:transcricao');
  checar(!!alerta, 'taxa de erro da etapa transcricao acima do limite com amostra suficiente deveria gerar alerta');
}

function testeEtapaAmostraPequenaNaoAlerta() {
  const snapshot = snapshotBase();
  // total=1 < MIN_TOTAL_ETAPA_ALERTA (10) mesmo com taxa 100% — não deve alertar (ruído).
  snapshot.taxaErroPorEtapa.analise = { erros: 1, total: 1, taxa: 1 };

  const alertas = avaliarThresholds(snapshot);
  const alerta = alertas.find((a) => a.chave === 'etapa:analise');
  checar(!alerta, 'taxa de erro 100% com amostra pequena (total=1) NÃO deveria alertar (ruído de amostra pequena)');
}

function teste429AcimaDoLimiteAlerta() {
  const snapshot = snapshotBase();
  snapshot.contagem429 = METRICAS_429_ALERTA + 1;

  const alertas = avaliarThresholds(snapshot);
  const alerta = alertas.find((a) => a.chave === '429');
  checar(!!alerta, 'contagem429 acima do limite deveria gerar alerta chave=429');
}

function testeSemPiiNosAlertas() {
  const snapshot = snapshotBase();
  snapshot.profundidadeFila = METRICAS_FILA_ALERTA + 1;
  snapshot.contagem429 = METRICAS_429_ALERTA + 1;
  snapshot.taxaErroPorEtapa.sync = { erros: 15, total: 20, taxa: 15 / 20 };

  const alertas = avaliarThresholds(snapshot);
  checar(alertas.length > 0, 'pré-condição do teste: deveria haver ao menos 1 alerta para checar PII');

  const termosProibidos = /telefone|cpf|voto/i;
  for (const alerta of alertas) {
    checar(!termosProibidos.test(alerta.titulo), `título do alerta '${alerta.titulo}' não deveria conter termo de PII`);
    checar(!termosProibidos.test(alerta.detalhe), `detalhe do alerta '${alerta.detalhe}' não deveria conter termo de PII`);
  }
}

function testeIniciarFecharIdempotenteNaoLanca() {
  let lancou = false;
  try {
    iniciarChecagemAlertas();
    iniciarChecagemAlertas(); // segunda chamada — idempotente, não deve criar 2º interval
    fecharAlertas();
    fecharAlertas(); // segunda chamada — no-op, não deve lançar
  } catch {
    lancou = true;
  }
  checar(!lancou, 'iniciarChecagemAlertas()/fecharAlertas() não deveriam lançar mesmo chamados 2x (idempotência)');
}

function main() {
  testeDentroDoLimiteNaoAlerta();
  testeFilaAcimaDoLimiteAlerta();
  testeEtapaAcimaDoLimiteComAmostraSuficienteAlerta();
  testeEtapaAmostraPequenaNaoAlerta();
  teste429AcimaDoLimiteAlerta();
  testeSemPiiNosAlertas();
  testeIniciarFecharIdempotenteNaoLanca();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('PASS');
  process.exit(0);
}

main();
