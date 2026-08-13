#!/usr/bin/env node
// scripts/mascarar.smoke.mjs
//
// Smoke determinístico (sem rede) do módulo canônico de mascaramento de PII
// (Fase 10, OBS-03, D-09/D-10): mascararTelefone + mascararCpf, fonte única
// consumida pelos 6 call sites (2 in-app TS + 4 scripts).
//
// Uso: node --experimental-strip-types scripts/mascarar.smoke.mjs

import { mascararTelefone, mascararCpf } from '../src/mastra/mascarar.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function testeMascararTelefone() {
  checar(
    mascararTelefone('') === '(sem telefone)',
    "mascararTelefone('') deveria retornar '(sem telefone)'",
  );
  checar(
    mascararTelefone('12') === '****12',
    "mascararTelefone('12') deveria retornar '****12'",
  );
  const telefoneLongo = mascararTelefone('+55 11 98765-4321');
  checar(
    telefoneLongo.endsWith('4321'),
    `mascararTelefone('+55 11 98765-4321') deveria terminar em '4321', recebido: '${telefoneLongo}'`,
  );
  checar(
    !telefoneLongo.includes('8765'),
    `mascararTelefone('+55 11 98765-4321') NÃO deveria conter '8765', recebido: '${telefoneLongo}'`,
  );
}

function testeMascararCpf() {
  checar(mascararCpf('') === '(sem cpf)', "mascararCpf('') deveria retornar '(sem cpf)'");
  const cpfMascarado = mascararCpf('123.456.789-09');
  checar(
    cpfMascarado === '123.***.***-09',
    `mascararCpf('123.456.789-09') deveria retornar '123.***.***-09', recebido: '${cpfMascarado}'`,
  );
  checar(
    !cpfMascarado.includes('456'),
    `mascararCpf('123.456.789-09') NÃO deveria conter '456', recebido: '${cpfMascarado}'`,
  );
  checar(
    !cpfMascarado.includes('789'),
    `mascararCpf('123.456.789-09') NÃO deveria conter '789', recebido: '${cpfMascarado}'`,
  );
  // Regressão: com exatamente 5 dígitos, prefixo(3)+sufixo(2) cobre o input inteiro —
  // o formato pontilhado não pode ser usado aqui, senão revela 100% disfarçado de mascarado.
  const cpfCurto = mascararCpf('12345');
  checar(
    cpfCurto === '*****',
    `mascararCpf('12345') deveria retornar '*****' (totalmente mascarado), recebido: '${cpfCurto}'`,
  );
  checar(
    !cpfCurto.includes('12345'),
    `mascararCpf('12345') NÃO deveria conter o CPF completo, recebido: '${cpfCurto}'`,
  );
}

function main() {
  testeMascararTelefone();
  testeMascararCpf();

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE PASS');
  process.exit(0);
}

main();
