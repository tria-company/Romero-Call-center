#!/usr/bin/env node
// scripts/usuarios-resolucao.smoke.mjs
//
// Smoke determinístico (sem rede) da resolução de assignee/device pelo
// FALLBACK de degradação (Fase 11 Plano 03, D-02/D-04 — src/mastra/
// operadores.ts + src/mastra/dispositivos.ts): com o snapshot em memória de
// discador_usuarios VAZIO (nenhum `recarregarUsuarios()` chamado nesse
// processo — não há rede/Postgres aqui), `assigneeDoOperador`/
// `resolverConfigDoUsuario` devem cair pros mapas do env
// (DISCADOR_ASSIGNEES/WAVOIP_USER_DEVICES), preservando a semântica de
// operação sem o store aquecido/indisponível.
//
// A cobertura do CAMINHO PRIMÁRIO (snapshot aquecido, fonte = store) exige
// Postgres real (buscarUsuario/recarregarUsuarios fazem fetch) — fora do
// escopo de um smoke sem rede; validada manualmente/E2E (ver SUMMARY do
// plano 11-03).
//
// Também cobre `inventarioPublico()` (dispositivos.ts): nunca expõe `token`.
//
// Uso: node --experimental-strip-types scripts/usuarios-resolucao.smoke.mjs

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

async function main() {
  process.env.DISCADOR_ASSIGNEES = 'joao:88123456';
  process.env.WAVOIP_USER_DEVICES = 'joao:dev1';
  process.env.WAVOIP_DEVICES = 'dev1:tok1:5511999990001';
  process.env.WAVOIP_DEVICE_TOKEN = 'tok_global_nao_deveria_ser_usado';
  // Sem SUPABASE_URL/SUPABASE_SERVICE_KEY: snapshotUsuarios() fica vazio por
  // padrão (nenhum I/O no import de usuarios.ts, nenhuma chamada a
  // recarregarUsuarios() neste smoke) — exercita exatamente o fallback.

  const { assigneeDoOperador, mapaOperadorParaAssignee } = await import('../src/mastra/operadores.ts');
  const { resolverConfigDoUsuario, inventarioPublico } = await import('../src/mastra/dispositivos.ts');

  // (a) assigneeDoOperador cai no fallback DISCADOR_ASSIGNEES com snapshot vazio.
  const assignee = assigneeDoOperador('joao');
  checar(
    assignee === '88123456',
    `assigneeDoOperador('joao') deveria devolver '88123456' (fallback DISCADOR_ASSIGNEES) com snapshot vazio, recebido: ${JSON.stringify(assignee)}`,
  );
  checar(
    assigneeDoOperador('desconhecido') === null,
    `assigneeDoOperador('desconhecido') deveria ser null`,
  );

  const mapa = mapaOperadorParaAssignee();
  checar(
    mapa instanceof Map && mapa.get('joao') === '88123456',
    `mapaOperadorParaAssignee() deveria conter joao->88123456 (fallback), recebido: ${JSON.stringify([...mapa])}`,
  );

  // (b) resolverConfigDoUsuario respeita a cascata dedicado(fallback env)->pool->global.
  const cfg = resolverConfigDoUsuario('joao');
  checar(
    cfg.wavoipToken === 'tok1' && cfg.deviceId === 'dev1' && cfg.modo === 'dedicado',
    `resolverConfigDoUsuario('joao') deveria ser {wavoipToken:'tok1',deviceId:'dev1',modo:'dedicado'} via fallback WAVOIP_USER_DEVICES, recebido: ${JSON.stringify(cfg)}`,
  );

  // (c) inventarioPublico() nunca expõe `token`.
  const inv = inventarioPublico();
  checar(
    Array.isArray(inv) && inv.length === 1,
    `inventarioPublico() deveria ter 1 entrada, recebido: ${JSON.stringify(inv)}`,
  );
  if (Array.isArray(inv) && inv.length === 1) {
    checar(
      inv[0].deviceId === 'dev1' && inv[0].numero === '5511999990001',
      `inventarioPublico()[0] deveria ser {deviceId:'dev1',numero:'5511999990001'}, recebido: ${JSON.stringify(inv[0])}`,
    );
    checar(
      !('token' in inv[0]),
      `inventarioPublico()[0] NUNCA deveria ter a propriedade 'token' (LGPD/segredo), recebido: ${JSON.stringify(inv[0])}`,
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
