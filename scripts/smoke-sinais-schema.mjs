// Smoke de GRAV-02: prova o parse seguro do JSON estrito dos 6 sinais em
// sinais-schema.ts. Modulo puro (so importa 'zod', sem imports relativos
// extensionless), entao importamos direto via node --experimental-strip-types
// (mesmo padrao de scripts/smoke-camila-schema.mjs/smoke-bant.mjs).

import { parseSinais, SaidaSinaisSchema } from '../src/mastra/sinais-schema.ts';

const falhas = [];

function checar(descricao, condicao) {
  if (!condicao) falhas.push(descricao);
}

// ---- Caso 1: JSON valido completo com os 6 sinais -> ok:true + campos corretos ----
{
  const raw = JSON.stringify({
    objecoes: [{ categoria: 'preco', trecho: 'achei salgado pro momento' }],
    dor_real: 'nao consegue aplicar o Metodo ADS na rotina, mais do que o form deixou claro',
    lexico: ['trava na hora de decidir', 'preciso pensar melhor'],
    sinais_compra: { nivel: 'alto', evidencia: 'perguntou como funciona o pagamento' },
    sinais_desistencia: { presente: false, evidencia: '' },
    ajuste_bant: 'demonstrou mais urgencia do que o form sugeria',
  });

  const resultado = parseSinais(raw);
  checar('caso1: ok=true', resultado.ok === true);
  if (resultado.ok) {
    checar('caso1: objecoes[0].categoria=preco', resultado.data.objecoes[0]?.categoria === 'preco');
    checar('caso1: dor_real preenchida', resultado.data.dor_real.length > 0);
    checar('caso1: lexico.length=2', resultado.data.lexico.length === 2);
    checar('caso1: sinais_compra.nivel=alto', resultado.data.sinais_compra.nivel === 'alto');
    checar('caso1: sinais_desistencia.presente=false', resultado.data.sinais_desistencia.presente === false);
    checar('caso1: ajuste_bant preenchido (advisory)', resultado.data.ajuste_bant.length > 0);
  }
}

// ---- Caso 2: JSON SEM sinais_desistencia -> ok:false ----
{
  const raw = JSON.stringify({
    objecoes: [],
    dor_real: 'dor generica',
    lexico: [],
    sinais_compra: { nivel: 'baixo', evidencia: '' },
    ajuste_bant: '',
  });

  const resultado = parseSinais(raw);
  checar('caso2: ok=false (sinais_desistencia ausente)', resultado.ok === false);
}

// ---- Caso 3: sinais_compra.nivel com tipo/valor errado (fora do enum) -> ok:false ----
{
  const raw = JSON.stringify({
    objecoes: [],
    dor_real: 'dor generica',
    lexico: [],
    sinais_compra: { nivel: 'super_alto', evidencia: 'x' },
    sinais_desistencia: { presente: false, evidencia: '' },
    ajuste_bant: '',
  });

  const resultado = parseSinais(raw);
  checar('caso3: ok=false (sinais_compra.nivel fora do enum baixo|medio|alto)', resultado.ok === false);
}

// ---- Caso 4: sinais_desistencia.presente com tipo errado (string em vez de boolean) -> ok:false ----
{
  const raw = JSON.stringify({
    objecoes: [],
    dor_real: 'dor generica',
    lexico: [],
    sinais_compra: { nivel: 'medio', evidencia: 'x' },
    sinais_desistencia: { presente: 'sim', evidencia: '' },
    ajuste_bant: '',
  });

  const resultado = parseSinais(raw);
  checar('caso4: ok=false (sinais_desistencia.presente nao-boolean)', resultado.ok === false);
}

// ---- Caso 5: texto sem bloco JSON -> ok:false ----
{
  const raw = 'nao consegui processar a transcricao agora, tente novamente mais tarde.';
  const resultado = parseSinais(raw);
  checar('caso5: ok=false (texto puro sem bloco JSON)', resultado.ok === false);
}

// ---- Caso 6: saida vazia/nao-string -> ok:false ----
{
  checar('caso6a: ok=false (string vazia)', parseSinais('').ok === false);
  checar('caso6b: ok=false (null)', parseSinais(null).ok === false);
}

// ---- Caso 7: bloco JSON dentro de cercas ```json ... ``` com texto ao redor -> extraido corretamente ----
{
  const jsonValido = JSON.stringify({
    objecoes: [{ categoria: 'tempo', trecho: 'nao tenho tempo agora' }],
    dor_real: 'sobrecarga de agenda',
    lexico: ['sem tempo'],
    sinais_compra: { nivel: 'medio', evidencia: 'perguntou sobre prazo' },
    sinais_desistencia: { presente: true, evidencia: 'disse que vai pensar e sumiu' },
    ajuste_bant: 'timing pode estar mais apertado do que o form sugeriu',
  });
  const raw = `Aqui esta a analise:\n\`\`\`json\n${jsonValido}\n\`\`\`\nFim da analise.`;

  const resultado = parseSinais(raw);
  checar('caso7: ok=true (bloco JSON em cercas ```json extraido corretamente)', resultado.ok === true);
  if (resultado.ok) {
    checar('caso7: sinais_desistencia.presente=true', resultado.data.sinais_desistencia.presente === true);
    checar('caso7: sinais_desistencia.evidencia preenchida', resultado.data.sinais_desistencia.evidencia.length > 0);
  }
}

// ---- Caso 9 (CR-02): sinais_compra SEM evidencia (evidencia: '') -> ok:true ----
// O prompt do extrator instrui explicitamente '"evidencia": ""' quando nao ha
// evidencia (NUNCA inventar) — o schema NAO pode rejeitar esse caso, senao
// toda call sem sinal de compra derruba os 6 sinais (inclusive o gatilho de
// resgate de 48h da desistencia).
{
  const raw = JSON.stringify({
    objecoes: [],
    dor_real: '',
    lexico: [],
    sinais_compra: { nivel: 'baixo', evidencia: '' },
    sinais_desistencia: { presente: true, evidencia: 'falou que vai desistir' },
    ajuste_bant: '',
  });

  const resultado = parseSinais(raw);
  checar('caso9: ok=true (sinais_compra.evidencia vazia e VALIDA — caso comum sem evidencia, CR-02)', resultado.ok === true);
  if (resultado.ok) {
    checar('caso9: sinais_compra.evidencia === "" preservada', resultado.data.sinais_compra.evidencia === '');
    checar('caso9: sinais_desistencia.presente=true sobrevive ao parse (gatilho do resgate de 48h)', resultado.data.sinais_desistencia.presente === true);
  }
}

// ---- Caso 10 (CR-02): sinais_compra sem a CHAVE evidencia -> ok:true via default('') ----
{
  const raw = JSON.stringify({
    objecoes: [],
    dor_real: '',
    lexico: [],
    sinais_compra: { nivel: 'baixo' },
    sinais_desistencia: { presente: false, evidencia: '' },
    ajuste_bant: '',
  });

  const resultado = parseSinais(raw);
  checar('caso10: ok=true (evidencia ausente cai no default(""))', resultado.ok === true);
  if (resultado.ok) {
    checar('caso10: sinais_compra.evidencia defaulta pra ""', resultado.data.sinais_compra.evidencia === '');
  }
}

// ---- Caso 8 (bonus): schema exportado tem o formato esperado ----
checar('caso8: SaidaSinaisSchema exportado', typeof SaidaSinaisSchema?.safeParse === 'function');

if (falhas.length > 0) {
  console.error('[smoke-sinais-schema] GRAV-02 FALHOU:');
  for (const f of falhas) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('[smoke-sinais-schema] GRAV-02 OK');
