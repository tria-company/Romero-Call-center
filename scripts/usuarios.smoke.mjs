#!/usr/bin/env node
// scripts/usuarios.smoke.mjs
//
// Smoke determinístico (sem rede) da migração-seed idempotente env->Postgres (D-02/D-06/
// USER-05 — src/mastra/usuarios.ts): `montarLinhasSeed` é PURA (sem I/O), então este smoke
// cobre só ela — as funções de I/O (buscarUsuario/listarUsuarios/criarUsuario/
// semearUsuariosSeVazio etc.) exigem Supabase configurado e são verificadas E2E fora deste
// smoke (mesmo racional de supabase.smoke.mjs/dispositivos.smoke.mjs).
//
// Uso: node --experimental-strip-types scripts/usuarios.smoke.mjs

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

async function main() {
  const { montarLinhasSeed } = await import('../src/mastra/usuarios.ts');

  // (a) DISCADOR_USERS com admin+joao, DISCADOR_ASSIGNEES/WAVOIP_USER_DEVICES so pra joao.
  const rawUsers = 'admin:8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918,joao:8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918';
  const rawAssignees = 'joao:99';
  const rawDevices = 'joao:dev-2';
  const linhas = montarLinhasSeed(rawUsers, rawAssignees, rawDevices);

  checar(linhas.length === 2, `montarLinhasSeed deveria produzir 2 linhas (admin+joao), recebido: ${linhas.length}`);

  const admin = linhas.find((l) => l.usuario === 'admin');
  checar(!!admin, 'montarLinhasSeed deveria conter a linha "admin"');
  checar(admin?.papel === 'gestor', `admin deveria ter papel 'gestor' (D-06), recebido: '${admin?.papel}'`);
  checar(
    admin?.senha_algo === 'sha256-legado',
    `admin deveria ter senha_algo 'sha256-legado', recebido: '${admin?.senha_algo}'`,
  );
  checar(admin?.senha_salt === null, `admin deveria ter senha_salt null (legado), recebido: ${JSON.stringify(admin?.senha_salt)}`);
  checar(
    admin?.clickup_member_id === null,
    `admin sem entrada em DISCADOR_ASSIGNEES deveria ter clickup_member_id null, recebido: ${JSON.stringify(admin?.clickup_member_id)}`,
  );
  checar(
    admin?.wavoip_device_id === null,
    `admin sem entrada em WAVOIP_USER_DEVICES deveria ter wavoip_device_id null, recebido: ${JSON.stringify(admin?.wavoip_device_id)}`,
  );

  const joao = linhas.find((l) => l.usuario === 'joao');
  checar(!!joao, 'montarLinhasSeed deveria conter a linha "joao"');
  checar(joao?.papel === 'atendente', `joao deveria ter papel 'atendente', recebido: '${joao?.papel}'`);
  checar(
    joao?.clickup_member_id === '99',
    `joao deveria trazer clickup_member_id '99' do join com DISCADOR_ASSIGNEES, recebido: '${joao?.clickup_member_id}'`,
  );
  checar(
    joao?.wavoip_device_id === 'dev-2',
    `joao deveria trazer wavoip_device_id 'dev-2' do join com WAVOIP_USER_DEVICES, recebido: '${joao?.wavoip_device_id}'`,
  );

  // (b) DISCADOR_USERS vazio -> default admin:sha256('admin') preservado (USER-05: nao tranca o admin de producao).
  const linhasDefault = montarLinhasSeed('', '', '');
  checar(
    linhasDefault.length === 1,
    `montarLinhasSeed('', '', '') deveria produzir 1 linha (default admin), recebido: ${linhasDefault.length}`,
  );
  checar(
    linhasDefault[0]?.usuario === 'admin' && linhasDefault[0]?.papel === 'gestor',
    `default sem DISCADOR_USERS deveria ser admin/gestor, recebido: ${JSON.stringify(linhasDefault[0])}`,
  );
  checar(
    linhasDefault[0]?.senha_algo === 'sha256-legado',
    `default admin deveria ter senha_algo 'sha256-legado', recebido: '${linhasDefault[0]?.senha_algo}'`,
  );

  // (c) Nenhuma linha contem a string 'senha' em claro (so hashes hex) — LGPD.
  for (const linha of [...linhas, ...linhasDefault]) {
    const serializado = JSON.stringify(linha);
    checar(
      !/senha\d|"senha"/i.test(serializado) && !serializado.includes('admin:admin'),
      `linha nao deveria conter senha em claro: ${serializado}`,
    );
    checar(
      /^[0-9a-f]+$/i.test(linha.senha_hash),
      `senha_hash deveria ser hex puro (nunca senha em claro), recebido: '${linha.senha_hash}'`,
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

main();
