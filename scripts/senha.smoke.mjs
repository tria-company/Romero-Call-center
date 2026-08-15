#!/usr/bin/env node
// scripts/senha.smoke.mjs
//
// Smoke determinístico (sem rede) das primitivas de senha (Fase 11, D-08 —
// src/mastra/senha.ts): round-trip scrypt salted, senha errada, salt aleatório por
// chamada, e o caminho de verificação legado sha256 (herdado do seed admin/admin de
// discador-auth.ts) — tudo timing-safe e sem log de segredo (LGPD).
//
// Uso: node --experimental-strip-types scripts/senha.smoke.mjs

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

async function main() {
  const { hashSenhaScrypt, verificarSenhaScrypt, sha256Hex, verificarSenhaLegada } = await import(
    '../src/mastra/senha.ts'
  );

  // Round-trip: hash + verificação da MESMA senha.
  const { hash, salt, algo } = hashSenhaScrypt('segredo');
  checar(algo === 'scrypt', `hashSenhaScrypt('segredo').algo deveria ser 'scrypt', recebido: '${algo}'`);
  checar(typeof hash === 'string' && hash.length > 0, 'hashSenhaScrypt deveria retornar um hash não-vazio');
  checar(typeof salt === 'string' && salt.length > 0, 'hashSenhaScrypt deveria retornar um salt não-vazio');
  checar(
    verificarSenhaScrypt('segredo', hash, salt) === true,
    'verificarSenhaScrypt deveria validar a senha correta contra o hash/salt gerados',
  );

  // Senha errada não verifica.
  checar(
    verificarSenhaScrypt('errado', hash, salt) === false,
    'verificarSenhaScrypt deveria rejeitar uma senha errada',
  );

  // Salt aleatório por usuário: duas chamadas para a MESMA senha geram valores diferentes.
  const outro = hashSenhaScrypt('segredo');
  checar(
    outro.salt !== salt,
    'duas chamadas de hashSenhaScrypt para a mesma senha deveriam gerar salts DIFERENTES (aleatório)',
  );
  checar(
    outro.hash !== hash,
    'duas chamadas de hashSenhaScrypt para a mesma senha deveriam gerar hashes DIFERENTES (salt diferente)',
  );

  // Caminho legado sha256 (sem salt) — verifica admin/admin como no seed de discador-auth.ts.
  const hashLegadoAdmin = sha256Hex('admin');
  checar(
    verificarSenhaLegada('admin', hashLegadoAdmin) === true,
    'verificarSenhaLegada deveria validar a senha correta contra o hash sha256 legado',
  );
  checar(
    verificarSenhaLegada('errado', hashLegadoAdmin) === false,
    'verificarSenhaLegada deveria rejeitar uma senha errada contra o hash sha256 legado',
  );

  // Falha-fechada: entrada inválida nunca lança, sempre retorna false.
  checar(
    verificarSenhaScrypt('qualquer', 'hash-invalido-nao-hex??', salt) === false,
    'verificarSenhaScrypt com hash malformado deveria retornar false, nunca lançar',
  );
  checar(
    verificarSenhaScrypt('qualquer', hash, null) === false,
    'verificarSenhaScrypt com salt null (fora do legado) deveria retornar false',
  );
  checar(
    verificarSenhaLegada('qualquer', 'hash-invalido-nao-hex??') === false,
    'verificarSenhaLegada com hash malformado deveria retornar false, nunca lançar',
  );

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
