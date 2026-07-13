// Smoke de CAM-03: prova o parse seguro do JSON estrito da Camila em
// camila-schema.ts. Modulo puro (so importa 'zod', sem imports relativos
// extensionless), entao importamos direto via node --experimental-strip-types
// (mesmo padrao de scripts/smoke-bant.mjs).

import { parseSaidaCamila, SaidaCamilaSchema } from '../src/mastra/camila-schema.ts';

const falhas = [];

function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// ---- Caso 1: JSON valido completo -> ok ----
{
  const raw = JSON.stringify({
    acao: 'responder',
    mensagens: ['Dr. Tarcisio, oi. Li teu formulario com calma.'],
    delay_ms: [15000],
    proximo_estado: 'S',
    tools_a_executar: [
      { tool: 'update_contact_field', args: { chave: 'spin_stage', valor: 'S' } },
    ],
    sinal_alerta: null,
    log_interno: 'abertura personalizada via ancora do form',
  });

  const resultado = parseSaidaCamila(raw);
  checar('caso1: ok=true', resultado.ok === true);
  if (resultado.ok) {
    checar('caso1: acao=responder', resultado.data.acao === 'responder');
    checar('caso1: mensagens.length=1', resultado.data.mensagens.length === 1);
    checar('caso1: tools_a_executar[0].tool=update_contact_field', resultado.data.tools_a_executar[0]?.tool === 'update_contact_field');
  }
}

// ---- Caso 2: JSON sem mensagens quando acao envia -> erro ----
{
  const raw = JSON.stringify({
    acao: 'responder',
    mensagens: [],
    proximo_estado: 'P',
    tools_a_executar: [],
    sinal_alerta: null,
  });

  const resultado = parseSaidaCamila(raw);
  checar('caso2: ok=false (acao=responder sem mensagens)', resultado.ok === false);
}

// ---- Caso 3: texto sem JSON -> erro ----
{
  const raw = 'desculpa, tive um problema e nao consegui gerar a resposta agora.';
  const resultado = parseSaidaCamila(raw);
  checar('caso3: ok=false (texto puro sem bloco JSON)', resultado.ok === false);
}

// ---- Caso 4 (bonus): tool fora do allowlist -> erro ----
{
  const raw = JSON.stringify({
    acao: 'responder',
    mensagens: ['oi'],
    proximo_estado: 'S',
    tools_a_executar: [{ tool: 'apagar_tudo', args: {} }],
    sinal_alerta: null,
  });

  const resultado = parseSaidaCamila(raw);
  checar('caso4: ok=false (tool fora do allowlist)', resultado.ok === false);
}

// ---- Caso 5 (bonus): acao=escalar sem mensagens -> ok (nao exige envio) ----
{
  const raw = JSON.stringify({
    acao: 'escalar',
    mensagens: [],
    proximo_estado: 'PAUSADO_HUMANO',
    tools_a_executar: [
      { tool: 'escalate_to_human', args: { telefone: '5511999999999', motivo: 'sofrimento_agudo' } },
      { tool: 'update_contact_field', args: { chave: 'spin_stage', valor: 'PAUSADO_HUMANO' } },
      { tool: 'log_note', args: { nota: 'protocolo sofrimento agudo acionado' } },
    ],
    sinal_alerta: 'sofrimento_agudo',
  });

  const resultado = parseSaidaCamila(raw);
  checar('caso5: ok=true (acao=escalar sem mensagens e valido)', resultado.ok === true);
}

// ---- Caso 6 (bonus): schema exportado tem o formato esperado ----
checar('caso6: SaidaCamilaSchema exportado', typeof SaidaCamilaSchema?.safeParse === 'function');

if (falhas.length > 0) {
  console.error('[smoke-camila-schema] CAM-03 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-camila-schema] CAM-03 OK');
