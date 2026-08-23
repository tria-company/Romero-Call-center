#!/usr/bin/env node
// scripts/painel-agregados.smoke.mjs
//
// Smoke determinístico (OFFLINE — sem rede/Supabase/ClickUp real) das duas
// funções que servem campanha/painel-números de agregados SQL (LEITURA-02,
// Fase B, Phase 19 Plano 04 — src/mastra/painel-dados.ts::
// resumoLigacoesSupabase/resumoCampanhaSupabase + sql/escala/
// 19_rpc_painel_agregados.sql).
//
// A chamada de rede (comOutboxRpc → POST /rpc/painel_*_agregado) não é
// exercitada aqui (não há Supabase real neste ambiente) — a prova é
// ESTRUTURAL: as duas funções PURAS de montagem (`montarResumoLigacoes`,
// `montarResumoCampanha`) recebem um jsonb SINTÉTICO (o formato exato que a
// RPC devolveria) e devolvem exatamente as chaves que a UI já espera de
// `resumoLigacoesAoVivo`/`resumoCampanhaAoVivo` — o contrato de shape que
// este plano promete não mudar.
//
// Molde de scripts/drenar-outbox.smoke.mjs (env sintética antes do import,
// checar()/falhas[], exit 1 em falha, 'SMOKE OK').
//
// NUNCA loga a service key sintética nem qualquer payload real — só
// booleans/estrutura de teste.
//
// Uso: node --experimental-strip-types scripts/painel-agregados.smoke.mjs

// Env sintética ANTES do import — SUPABASE_URL/SUPABASE_SERVICE_KEY são lidas
// no IMPORT-TIME por config.ts (module-level `const`), mesmo racional de
// drenar-outbox.smoke.mjs/outbox-rpc.smoke.mjs.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://fake.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'k';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

async function testeModulosCarregam() {
  const mod = await import('../src/mastra/painel-dados.ts');
  for (const nome of [
    'montarResumoLigacoes',
    'resumoLigacoesSupabase',
    'montarResumoCampanha',
    'resumoCampanhaSupabase',
  ]) {
    checar(typeof mod[nome] === 'function', `painel-dados.ts deveria exportar ${nome}`);
  }
  return mod;
}

/** Chaves de ResumoLigacoes (painel-dados.ts) — o contrato que a UI já lê. */
const CHAVES_RESUMO_LIGACOES = [
  'total',
  'hoje',
  'atendidasHoje',
  'naoAtendidasHoje',
  'semDesfechoHoje',
  'atendidasTotal',
  'comGravacao',
  'comTranscricao',
  'comAnaliseIa',
  'ultimaEm',
  'parcial',
];

function testeMontarResumoLigacoes(mod) {
  const agregadoSintetico = {
    total: 167,
    hoje: 141,
    atendidasHoje: 17,
    naoAtendidasHoje: 26,
    semDesfechoHoje: 98,
    atendidasTotal: 43,
    comGravacao: 29,
    comTranscricao: 29,
    comAnaliseIa: 25,
    ultimaEm: '2026-08-21T13:00:00+00:00',
    parcial: false,
  };
  const resumo = mod.montarResumoLigacoes(agregadoSintetico);

  for (const chave of CHAVES_RESUMO_LIGACOES) {
    checar(
      Object.prototype.hasOwnProperty.call(resumo, chave),
      `montarResumoLigacoes deveria produzir a chave '${chave}' (mesmo shape de resumoLigacoesAoVivo)`,
    );
  }
  checar(resumo.total === 167, `resumo.total deveria ser 167, recebido ${resumo.total}`);
  checar(resumo.atendidasHoje === 17, `resumo.atendidasHoje deveria ser 17, recebido ${resumo.atendidasHoje}`);
  checar(
    resumo.ultimaEm === new Date('2026-08-21T13:00:00+00:00').toISOString(),
    'montarResumoLigacoes deveria normalizar ultimaEm para ISO 8601',
  );
  checar(resumo.parcial === false, 'montarResumoLigacoes: parcial deveria ser sempre false (agregado SQL não pagina)');

  // jsonb vazio (RPC ainda não aplicada / tabela vazia) nunca deveria lançar —
  // degrada para zeros, mesmo espírito de "número honesto em vez de crash".
  const vazio = mod.montarResumoLigacoes({});
  checar(vazio.total === 0 && vazio.ultimaEm === null, 'montarResumoLigacoes({}) deveria degradar para zeros/null, nunca lançar');
}

/** Chaves de ResumoCampanha (painel-dados.ts) — o contrato que a UI já lê. */
const CHAVES_RESUMO_CAMPANHA = [
  'serie',
  'telefonistas',
  'motivosNaoContato',
  'falhasTecnicas',
  'totalLigacoes',
  'totalNaFila',
  'totalContatos',
  'semDesfecho',
  'semOperador',
  'desfechoDeApp',
  'tempoMedio',
  'parcial',
];

const CHAVES_TELEFONISTA = ['id', 'nome', 'turno', 'lig', 'fila', 'cont', 'conv', 'ader', 'aderAmostra', 'tsec', 'votos', 'ligh'];

function testeMontarResumoCampanha(mod) {
  const agregadoSintetico = {
    serie: [{ dia: '2026-08-20', ligacoes: 80, contatos: 12 }],
    ranking: [
      {
        operador: 'wenellyhsc@gmail.com',
        opChave: 'wenellyhsc@gmail.com',
        lig: 67,
        fila: 3,
        cont: 5,
        tsec: 83,
        ini: '2026-08-20T10:00:00+00:00',
        fim: '2026-08-20T14:00:00+00:00',
      },
    ],
    motivosBrutos: ['Não atende', 'não atendida', 'Recusada pelo lead', 'Transcrição não obtida após 3 tentativas'],
    votosPorOperador: { 'wenellyhsc@gmail.com': 4 },
    totalLigacoes: 328,
    totalNaFila: 1121,
    totalContatos: 24,
    semDesfecho: 105,
    semOperador: { lig: 23, cont: 21 },
    desfechoDeApp: { comOperador: 144, atendidas: 3, semDesfecho: 104 },
    tempoMedio: { min: 5, mediana: 50, max: 12217, amostra: 328 },
  };
  const resumo = mod.montarResumoCampanha(agregadoSintetico);

  for (const chave of CHAVES_RESUMO_CAMPANHA) {
    checar(
      Object.prototype.hasOwnProperty.call(resumo, chave),
      `montarResumoCampanha deveria produzir a chave '${chave}' (mesmo shape de resumoCampanhaAoVivo)`,
    );
  }

  checar(resumo.telefonistas.length === 1, `esperava 1 telefonista no ranking, recebido ${resumo.telefonistas.length}`);
  const [tel] = resumo.telefonistas;
  for (const chave of CHAVES_TELEFONISTA) {
    checar(
      Object.prototype.hasOwnProperty.call(tel, chave),
      `telefonista do ranking deveria ter a chave '${chave}' (mesmo shape de TelefonistaCampanha)`,
    );
  }
  checar(tel.nome === 'wenellyhsc', `nomeDeOperador deveria reduzir o e-mail ao local-part, recebido '${tel.nome}'`);
  checar(tel.votos === 4, `votos do operador deveriam vir de votosPorOperador (4), recebido ${tel.votos}`);
  checar(tel.conv === Math.round((5 / 67) * 100), `conv deveria ser round(cont/lig*100), recebido ${tel.conv}`);
  checar(tel.id === 1, `id do ranking deveria ser 1-based, recebido ${tel.id}`);

  // agruparMotivos (reusado, não reimplementado) deveria juntar os sinônimos:
  // "Não atende" + "não atendida" -> UM grupo "Não atende" com n=2; a
  // "transcrição não obtida" vira falha TÉCNICA, não motivo do eleitor.
  const naoAtende = resumo.motivosNaoContato.find((m) => m.rotulo === 'Não atende');
  checar(Boolean(naoAtende) && naoAtende.n === 2, 'agruparMotivos deveria juntar "Não atende"/"não atendida" num grupo só (n=2)');
  checar(resumo.falhasTecnicas.length === 1, 'motivo de transcrição deveria virar falha técnica, não motivo de não-contato');

  checar(resumo.tempoMedio.atual === 50 && resumo.tempoMedio.mediana === 50, 'tempoMedio.atual deveria repetir a mediana (mesmo contrato de resumoCampanhaAoVivo)');
  checar(resumo.parcial === false, 'montarResumoCampanha: parcial deveria ser sempre false (agregado SQL não pagina)');

  // jsonb vazio nunca deveria lançar.
  const vazio = mod.montarResumoCampanha({});
  checar(
    Array.isArray(vazio.serie) && Array.isArray(vazio.telefonistas) && vazio.totalLigacoes === 0,
    'montarResumoCampanha({}) deveria degradar para arrays vazios/zeros, nunca lançar',
  );
}

async function main() {
  const mod = await testeModulosCarregam();
  testeMontarResumoLigacoes(mod);
  testeMontarResumoCampanha(mod);

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
