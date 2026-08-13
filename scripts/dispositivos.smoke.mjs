#!/usr/bin/env node
// scripts/dispositivos.smoke.mjs
//
// Smoke determinístico (sem rede) da resolução de device por usuário
// (DEVICE-01, Fase 07 Plano 01 — src/mastra/dispositivos.ts): dedicado ->
// pool -> global (DD-07-02), mapeamento reverso número->device, e o
// fallback gracioso para WAVOIP_DEVICE_TOKEN quando nada está configurado
// (critério 4 do roadmap).
//
// dispositivos.ts lê WAVOIP_DEVICES/WAVOIP_USER_DEVICES/WAVOIP_DEVICE_TOKEN
// UMA VEZ no import do módulo (mesmo padrão de operadores.ts/discador-auth.ts).
// Para testar o cenário de fallback com um conjunto de envs DIFERENTE do
// cenário dedicado/pool, este smoke seta as envs do cenário principal e faz
// `import()` dinâmico; o cenário de fallback roda num SEGUNDO PROCESSO (o
// próprio arquivo, reinvocado com DISPOSITIVOS_SMOKE_CHILD=fallback e outro
// conjunto de envs) — só assim garante um module-load novo com envs
// diferentes, já que reimportar o mesmo specifier no mesmo processo Node
// devolve a instância cacheada (lida na primeira vez).
//
// Uso: node --experimental-strip-types scripts/dispositivos.smoke.mjs

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

// ===== Cenário filho: fallback global (processo separado, envs próprias) =====

async function rodarCenarioFallback() {
  const resultado = { ok: true, erros: [] };
  try {
    const mod = await import('../src/mastra/dispositivos.ts');
    const cfg = mod.resolverConfigDoUsuario('qualquer');
    if (cfg.wavoipToken !== 'tok_global') {
      resultado.ok = false;
      resultado.erros.push(`wavoipToken deveria ser 'tok_global', recebido: '${cfg.wavoipToken}'`);
    }
    if (cfg.modo !== 'global') {
      resultado.ok = false;
      resultado.erros.push(`modo deveria ser 'global', recebido: '${cfg.modo}'`);
    }
    if (cfg.deviceId !== null) {
      resultado.ok = false;
      resultado.erros.push(`deviceId deveria ser null no modo global, recebido: '${cfg.deviceId}'`);
    }
  } catch (e) {
    resultado.ok = false;
    resultado.erros.push(`exceção no cenário fallback: ${e && e.message}`);
  }
  // Marcador delimitado para o processo pai extrair do stdout (que pode
  // conter outros logs do módulo, ex. warn de boot).
  console.log(`__RESULTADO__${JSON.stringify(resultado)}__FIM__`);
  process.exit(resultado.ok ? 0 : 1);
}

// ===== Cenário principal: dedicado / pool / mapeamento reverso =====

function setarEnvsCenarioPrincipal() {
  process.env.WAVOIP_DEVICES = 'dev1:tok1:5511999990001,dev2:tok2:5511999990002';
  process.env.WAVOIP_USER_DEVICES = 'joao:dev1';
  process.env.WAVOIP_DEVICE_TOKEN = 'tok_global_nao_deveria_ser_usado';
}

async function main() {
  setarEnvsCenarioPrincipal();
  const {
    resolverConfigDoUsuario,
    tokenDoDevice,
    deviceIdPorNumero,
  } = await import('../src/mastra/dispositivos.ts');

  // Caso 1: usuário dedicado (joao -> dev1).
  const cfgJoao = resolverConfigDoUsuario('joao');
  checar(
    cfgJoao.wavoipToken === 'tok1' && cfgJoao.deviceId === 'dev1' && cfgJoao.modo === 'dedicado',
    `resolverConfigDoUsuario('joao') deveria ser {wavoipToken:'tok1',deviceId:'dev1',modo:'dedicado'}, recebido: ${JSON.stringify(cfgJoao)}`,
  );

  // Caso 1b: normalização de usuário (case-insensitive / espaços — mesmo padrão de operadores.ts).
  const cfgJoaoMaiusculo = resolverConfigDoUsuario('  JOAO  ');
  checar(
    cfgJoaoMaiusculo.modo === 'dedicado' && cfgJoaoMaiusculo.deviceId === 'dev1',
    `resolverConfigDoUsuario('  JOAO  ') deveria normalizar pra 'joao' e achar dev1, recebido: ${JSON.stringify(cfgJoaoMaiusculo)}`,
  );

  // Caso 2: usuário não mapeado, mas dev2 está livre no pool (não dedicado a ninguém).
  const cfgMaria = resolverConfigDoUsuario('maria');
  checar(
    cfgMaria.wavoipToken === null && cfgMaria.deviceId === null && cfgMaria.modo === 'pool',
    `resolverConfigDoUsuario('maria') deveria ser {wavoipToken:null,deviceId:null,modo:'pool'}, recebido: ${JSON.stringify(cfgMaria)}`,
  );

  // tokenDoDevice: existente vs inexistente.
  checar(tokenDoDevice('dev2') === 'tok2', `tokenDoDevice('dev2') deveria ser 'tok2', recebido: '${tokenDoDevice('dev2')}'`);
  checar(tokenDoDevice('dev-inexistente') === null, `tokenDoDevice('dev-inexistente') deveria ser null`);

  // deviceIdPorNumero: mapeamento reverso número(só-dígitos)->deviceId.
  checar(
    deviceIdPorNumero('5511999990002') === 'dev2',
    `deviceIdPorNumero('5511999990002') deveria ser 'dev2', recebido: '${deviceIdPorNumero('5511999990002')}'`,
  );
  checar(
    deviceIdPorNumero('+55 11 99999-0002') === 'dev2',
    'deviceIdPorNumero deveria normalizar número com formatação (espaços/traço/+) antes de casar',
  );
  checar(deviceIdPorNumero('0000') === null, `deviceIdPorNumero('0000') deveria ser null (nenhum device casa)`);

  // Caso 4 (critério do roadmap): sem WAVOIP_DEVICES, /config volta ao
  // WAVOIP_DEVICE_TOKEN global — testado num processo filho com envs próprias
  // (ver nota no topo do arquivo).
  const filho = spawnSync(
    process.execPath,
    ['--experimental-strip-types', fileURLToPath(import.meta.url)],
    {
      env: {
        ...process.env,
        DISPOSITIVOS_SMOKE_CHILD: 'fallback',
        WAVOIP_DEVICES: '',
        WAVOIP_USER_DEVICES: '',
        WAVOIP_DEVICE_TOKEN: 'tok_global',
      },
      encoding: 'utf8',
    },
  );
  const saida = filho.stdout || '';
  const m = /__RESULTADO__(.*)__FIM__/s.exec(saida);
  if (!m) {
    falhas.push(
      `cenário fallback (processo filho) não produziu o marcador de resultado esperado. ` +
        `exit=${filho.status} stdout=${JSON.stringify(saida)} stderr=${JSON.stringify(filho.stderr || '')}`,
    );
  } else {
    const resultadoFilho = JSON.parse(m[1]);
    checar(
      resultadoFilho.ok === true,
      `cenário fallback (processo filho) falhou: ${JSON.stringify(resultadoFilho.erros)}`,
    );
  }

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

if (process.env.DISPOSITIVOS_SMOKE_CHILD === 'fallback') {
  rodarCenarioFallback();
} else {
  main();
}
