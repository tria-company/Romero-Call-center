#!/usr/bin/env node
// scripts/campo-mapa.smoke.mjs
//
// Smoke determinístico (sem rede/Supabase real) do mapa de field-ids validado
// no boot (17-03, MODELO-06/D-07 — src/mastra/campo-mapa.ts). Prova:
//   1. validarCampoMapa: constantes == ClickUp -> devolve o mapa validado
//      (sem lançar), incluindo opções bidirecionais (porValor/porUuid).
//   2. validarCampoMapa: field_id sumiu no ClickUp -> lança DivergenciaCampoMapa.
//   3. validarCampoMapa: opção NOVA no ClickUp (uuid desconhecido ao código)
//      -> lança DivergenciaCampoMapa (R8 — o gatilho do skip-without-overwrite
//      no caminho reverso futuro).
//   4. carregarEValidarCampoMapa: ClickUp inalcançável (buscarCampos rejeita)
//      -> PULA a validação (pulou=true), NUNCA lança, NUNCA cacheia.
//   5. carregarEValidarCampoMapa: divergência genuína (ClickUp alcançável mas
//      discordante) -> alerta best-effort disparado + RE-LANÇA (falha alto).
//   6. carregarEValidarCampoMapa: tudo bate -> cacheia o mapa e não alerta.
//
// Uso: node scripts/campo-mapa.smoke.mjs

import { validarCampoMapa, carregarEValidarCampoMapa, DivergenciaCampoMapa } from '../src/mastra/campo-mapa.ts';
import { CAMPOS_LEADS, CAMPOS_LIGACOES, CAMPOS_AUDIOS, OPCOES_LEADS, OPCOES_LIGACOES, OPCOES_AUDIOS } from '../src/mastra/clickup.ts';
import { CLICKUP_LIST_LEADS, CLICKUP_LIST_LIGACOES, CLICKUP_LIST_AUDIOS } from '../src/mastra/config.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ===== Fixtures =====

const LISTA_FIXTURE = 'LIGACOES';
const FIELD_ATENDEU = 'field-atendeu-uuid';
const FIELD_OPERADOR = 'field-operador-uuid';
const UUID_SIM = 'opcao-sim-uuid';
const UUID_NAO = 'opcao-nao-uuid';

function constantesFixture() {
  return {
    lista: LISTA_FIXTURE,
    campos: { ATENDEU: FIELD_ATENDEU, OPERADOR: FIELD_OPERADOR },
    opcoes: { [FIELD_ATENDEU]: { sim: UUID_SIM, nao: UUID_NAO } },
  };
}

function camposClickUpFixture(overrides = {}) {
  const base = [
    {
      id: FIELD_ATENDEU,
      name: 'Atendeu',
      type: 'drop_down',
      type_config: { options: [{ id: UUID_SIM, name: 'Sim' }, { id: UUID_NAO, name: 'Não' }] },
    },
    { id: FIELD_OPERADOR, name: 'Operador', type: 'text' },
  ];
  return overrides.campos ?? base;
}

// ===== 1. Caso OK =====

function testeValidarCampoMapaOk() {
  const mapa = validarCampoMapa(constantesFixture(), camposClickUpFixture());
  checar(mapa.length === 2, `esperado 2 entradas validadas, recebido ${mapa.length}`);

  const atendeu = mapa.find((e) => e.campo_logico === 'ATENDEU');
  checar(!!atendeu, 'deveria conter a entrada ATENDEU validada');
  checar(atendeu.field_id === FIELD_ATENDEU, `field_id incorreto: ${atendeu.field_id}`);
  checar(atendeu.tipo === 'drop_down', `tipo incorreto: ${atendeu.tipo}`);
  checar(atendeu.opcoes?.porValor.sim === UUID_SIM, 'opcoes.porValor.sim deveria mapear para o uuid esperado');
  checar(atendeu.opcoes?.porUuid[UUID_SIM] === 'sim', 'opcoes.porUuid deveria ser o inverso de porValor (bidirecional)');
  checar(atendeu.origem.startsWith('clickup_get_custom_fields@'), `origem carimbada incorreta: ${atendeu.origem}`);

  const operador = mapa.find((e) => e.campo_logico === 'OPERADOR');
  checar(!!operador && operador.opcoes === null, 'OPERADOR nao tem OPCOES_* -> opcoes deveria ser null');
}

// ===== 2. field_id ausente =====

function testeValidarCampoMapaFieldIdAusenteLanca() {
  const camposSemAtendeu = camposClickUpFixture().filter((f) => f.id !== FIELD_ATENDEU);
  let lancou = false;
  let ehDivergencia = false;
  try {
    validarCampoMapa(constantesFixture(), camposSemAtendeu);
  } catch (e) {
    lancou = true;
    ehDivergencia = e instanceof DivergenciaCampoMapa;
  }
  checar(lancou, 'field_id ausente no ClickUp deveria lançar');
  checar(ehDivergencia, 'o erro lançado deveria ser DivergenciaCampoMapa');
}

// ===== 3. opção nova no ClickUp =====

function testeValidarCampoMapaOpcaoNovaLanca() {
  const camposComOpcaoNova = camposClickUpFixture().map((f) =>
    f.id === FIELD_ATENDEU
      ? {
          ...f,
          type_config: {
            options: [...f.type_config.options, { id: 'opcao-nova-desconhecida-uuid', name: 'Talvez' }],
          },
        }
      : f,
  );
  let lancou = false;
  let ehDivergencia = false;
  try {
    validarCampoMapa(constantesFixture(), camposComOpcaoNova);
  } catch (e) {
    lancou = true;
    ehDivergencia = e instanceof DivergenciaCampoMapa;
  }
  checar(lancou, 'opção nova/desconhecida no ClickUp deveria lançar (R8)');
  checar(ehDivergencia, 'o erro lançado deveria ser DivergenciaCampoMapa');
}

// ===== 3b. opção removida (uuid esperado sumiu do ClickUp) =====

function testeValidarCampoMapaOpcaoRemovidaLanca() {
  const camposSemOpcaoNao = camposClickUpFixture().map((f) =>
    f.id === FIELD_ATENDEU
      ? { ...f, type_config: { options: f.type_config.options.filter((o) => o.id !== UUID_NAO) } }
      : f,
  );
  let lancou = false;
  try {
    validarCampoMapa(constantesFixture(), camposSemOpcaoNao);
  } catch (e) {
    lancou = e instanceof DivergenciaCampoMapa;
  }
  checar(lancou, 'opção esperada removida do ClickUp deveria lançar DivergenciaCampoMapa');
}

// ===== 4. carregarEValidarCampoMapa — ClickUp inalcançável =====

async function testeCarregarPulaClickUpInalcancavel() {
  let cacheChamado = false;
  let alertaChamado = false;
  const resultado = await carregarEValidarCampoMapa({
    buscarCampos: async () => {
      throw new Error('falha de rede simulada');
    },
    cachear: async () => {
      cacheChamado = true;
      return 0;
    },
    alertar: async () => {
      alertaChamado = true;
    },
  });
  checar(resultado.pulou === true, 'ClickUp inalcancavel deveria resultar em pulou=true');
  checar(resultado.mapa.length === 0, 'ClickUp inalcancavel deveria devolver mapa vazio');
  checar(!cacheChamado, 'ClickUp inalcancavel NAO deveria tentar cachear');
  checar(!alertaChamado, 'ClickUp inalcancavel NAO deveria alertar (nao e divergencia genuina)');
}

// ===== 5. carregarEValidarCampoMapa — divergência genuína falha alto + alerta =====

async function testeCarregarDivergenciaFalhaAltoEAlerta() {
  let alertaChamado = false;
  let cacheChamado = false;
  let lancou = false;
  let ehDivergencia = false;
  try {
    await carregarEValidarCampoMapa({
      // Devolve listas SEM os field-ids reais de CAMPOS_LEADS/LIGACOES/AUDIOS -> toda lista diverge.
      buscarCampos: async () => [],
      cachear: async () => {
        cacheChamado = true;
        return 0;
      },
      alertar: async () => {
        alertaChamado = true;
      },
    });
  } catch (e) {
    lancou = true;
    ehDivergencia = e instanceof DivergenciaCampoMapa;
  }
  checar(lancou, 'divergencia genuina deveria RE-LANCAR (falha alto, MODELO-06)');
  checar(ehDivergencia, 'o erro relançado deveria ser DivergenciaCampoMapa');
  checar(alertaChamado, 'divergencia genuina deveria disparar alerta best-effort ANTES de relançar');
  checar(!cacheChamado, 'divergencia genuina NAO deveria cachear (mapa nunca ficou valido)');
}

// ===== 6. carregarEValidarCampoMapa — sucesso cacheia e nao alerta =====

async function testeCarregarSucessoCacheiaSemAlertar() {
  let alertaChamado = false;
  let linhasCacheadas = null;
  const resultado = await carregarEValidarCampoMapa({
    buscarCampos: async (listId) => {
      // Devolve exatamente os field-ids reais das 3 listas (CAMPOS_LEADS/LIGACOES/AUDIOS + OPCOES_*)
      // — importado indiretamente via módulo real não é necessário aqui: usamos um fixture
      // mínimo que cobre só os campos SEM opções pra não ter que replicar todos os UUIDs reais.
      return fixtureCompletaPorLista(listId);
    },
    cachear: async (linhas) => {
      linhasCacheadas = linhas;
      return linhas.length;
    },
    alertar: async () => {
      alertaChamado = true;
    },
  });
  checar(resultado.pulou === false, 'sucesso nao deveria pular');
  checar(!alertaChamado, 'sucesso NAO deveria alertar');
  checar(Array.isArray(linhasCacheadas) && linhasCacheadas.length === resultado.mapa.length, 'cachear deveria receber o mapa validado completo');
}

// Fixture completa: usa as CONSTANTES REAIS do código (CAMPOS_*/OPCOES_*) pra
// simular uma resposta do ClickUp que bate 100% — exercita o caminho feliz
// fim-a-fim de carregarEValidarCampoMapa sem precisar reimplementar os mapas.
function definicoesDe(campos, opcoesPorFieldId) {
  return Object.values(campos).map((fieldId) => {
    const opcoes = opcoesPorFieldId[fieldId];
    return {
      id: fieldId,
      name: fieldId,
      type: opcoes ? 'drop_down' : 'text',
      type_config: opcoes ? { options: Object.values(opcoes).map((uuid) => ({ id: uuid, name: uuid })) } : undefined,
    };
  });
}

function fixtureCompletaPorLista(listId) {
  if (listId === CLICKUP_LIST_LEADS) return definicoesDe(CAMPOS_LEADS, OPCOES_LEADS);
  if (listId === CLICKUP_LIST_LIGACOES) return definicoesDe(CAMPOS_LIGACOES, OPCOES_LIGACOES);
  if (listId === CLICKUP_LIST_AUDIOS) return definicoesDe(CAMPOS_AUDIOS, OPCOES_AUDIOS);
  return [];
}

async function main() {
  testeValidarCampoMapaOk();
  testeValidarCampoMapaFieldIdAusenteLanca();
  testeValidarCampoMapaOpcaoNovaLanca();
  testeValidarCampoMapaOpcaoRemovidaLanca();
  await testeCarregarPulaClickUpInalcancavel();
  await testeCarregarDivergenciaFalhaAltoEAlerta();
  await testeCarregarSucessoCacheiaSemAlertar();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
