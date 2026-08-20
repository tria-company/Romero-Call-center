#!/usr/bin/env node
// scripts/alerta-queda-device.smoke.mjs
//
// Smoke determinístico (sem rede) do edge-trigger de alerta de queda do
// device Wavoip de um ATENDENTE (Quick 260819-p1r —
// src/mastra/alerta-queda-device.ts): simula uma sequência de eventos DEVICE
// mantendo `let estado` local e reaplicando decidirAlertaQuedaDevice a cada
// evento, provando que só a TRANSIÇÃO conectado<->caído dispara alerta,
// respeitando o cooldown por-device.
//
// Regra-chave (fix p1r): a VOLTA (🟢 reconectou) só é anunciada se a QUEDA
// daquele episódio foi efetivamente anunciada. Uma queda suprimida pelo
// cooldown (CASO 2b) NÃO gera "🟢 reconectou" órfão na reconexão.
//
// Sem rede: enviarAlertaGrupo NÃO é chamada aqui — este smoke testa só a
// decisão pura, no mesmo estilo de scripts/dispositivos.smoke.mjs (helper
// checar()+lista de falhas, import() dinâmico).
//
// Uso: node --experimental-strip-types scripts/alerta-queda-device.smoke.mjs

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

async function main() {
  const { decidirAlertaQuedaDevice } = await import('../src/mastra/alerta-queda-device.ts');

  const COOLDOWN = 15 * 60 * 1000; // mesmo default de ALERTA_QUEDA_COOLDOWN_MS (config.ts)
  const T0 = 1_000_000_000_000; // epoch ms arbitrário, fixo (sem Date.now())

  let estado; // undefined = device nunca visto (caller usa Map.get, que devolve undefined)

  // A) 1º evento 'open' de device novo — NÃO dispara (sem transição).
  let d = decidirAlertaQuedaDevice(estado, true, T0, COOLDOWN);
  checar(d.disparar === false && d.tipo === null, `A) 1º open de device novo deveria NÃO disparar, recebido: ${JSON.stringify(d)}`);
  checar(d.novoEstado.caido === false && d.novoEstado.quedaAnunciada === false, `A) novoEstado deveria ser {caido:false, quedaAnunciada:false}, recebido: ${JSON.stringify(d.novoEstado)}`);
  estado = d.novoEstado;

  // B) heartbeat 'open' repetido, já conectado — NÃO dispara.
  d = decidirAlertaQuedaDevice(estado, true, T0 + 1000, COOLDOWN);
  checar(d.disparar === false, `B) heartbeat 'open' repetido deveria NÃO disparar, recebido: ${JSON.stringify(d)}`);
  estado = d.novoEstado;

  // C) open -> hibernating (transição pra caído), fora de qualquer cooldown
  //    anterior (ultimoAlertaTs=0) — DISPARA 'queda' 1x e marca quedaAnunciada.
  const tQueda = T0 + 2000;
  d = decidirAlertaQuedaDevice(estado, false, tQueda, COOLDOWN);
  checar(d.disparar === true && d.tipo === 'queda', `C) open->hibernating deveria disparar 'queda', recebido: ${JSON.stringify(d)}`);
  checar(d.novoEstado.caido === true, `C) após queda, caido deveria ser true, recebido: ${JSON.stringify(d.novoEstado)}`);
  checar(d.novoEstado.ultimoAlertaTs === tQueda, `C) após queda, ultimoAlertaTs deveria ser ${tQueda}, recebido: ${d.novoEstado.ultimoAlertaTs}`);
  checar(d.novoEstado.quedaAnunciada === true, `C) após queda, quedaAnunciada deveria ser true, recebido: ${d.novoEstado.quedaAnunciada}`);
  estado = d.novoEstado;

  // D) 3 heartbeats 'hibernating' seguidos (dentro do cooldown) — NÃO
  //    re-disparam; preservam ultimoAlertaTs e quedaAnunciada.
  for (let i = 1; i <= 3; i++) {
    const tHeartbeat = tQueda + i * 60_000; // +1min, +2min, +3min — bem dentro dos 15min
    d = decidirAlertaQuedaDevice(estado, false, tHeartbeat, COOLDOWN);
    checar(d.disparar === false, `D) heartbeat 'hibernating' #${i} deveria NÃO re-disparar, recebido: ${JSON.stringify(d)}`);
    checar(d.novoEstado.caido === true, `D) heartbeat #${i}: continua caido=true, recebido: ${JSON.stringify(d.novoEstado)}`);
    checar(d.novoEstado.ultimoAlertaTs === tQueda, `D) heartbeat #${i}: ultimoAlertaTs NÃO deveria mudar, recebido: ${d.novoEstado.ultimoAlertaTs}`);
    checar(d.novoEstado.quedaAnunciada === true, `D) heartbeat #${i}: quedaAnunciada deveria continuar true, recebido: ${d.novoEstado.quedaAnunciada}`);
    estado = d.novoEstado;
  }

  // E) hibernating -> open (reconexão) com a queda JÁ anunciada — DISPARA
  //    'volta', reseta caido e quedaAnunciada; ultimoAlertaTs é PRESERVADO
  //    (a volta não mexe no relógio de cooldown das quedas).
  const tVolta = tQueda + 5 * 60_000;
  d = decidirAlertaQuedaDevice(estado, true, tVolta, COOLDOWN);
  checar(d.disparar === true && d.tipo === 'volta', `E) hibernating->open (queda anunciada) deveria disparar 'volta', recebido: ${JSON.stringify(d)}`);
  checar(d.novoEstado.caido === false, `E) após volta, caido deveria ser false, recebido: ${JSON.stringify(d.novoEstado)}`);
  checar(d.novoEstado.quedaAnunciada === false, `E) após volta, quedaAnunciada deveria ser false, recebido: ${d.novoEstado.quedaAnunciada}`);
  checar(d.novoEstado.ultimoAlertaTs === tQueda, `E) após volta, ultimoAlertaTs deveria ser PRESERVADO (${tQueda}, o da queda), recebido: ${d.novoEstado.ultimoAlertaTs}`);
  estado = d.novoEstado;

  // F) O FIX — queda 2 SUPRIMIDA pelo cooldown, então reconexão NÃO anuncia volta.
  //    F1: cai de novo logo após a volta → dentro do cooldown desde a queda 1
  //        (ultimoAlertaTs=tQueda) → CASO 2b: NÃO dispara, quedaAnunciada=false.
  const tDrop2 = tVolta + 1000; // (5min+1s) desde tQueda < 15min → suprimida
  d = decidirAlertaQuedaDevice(estado, false, tDrop2, COOLDOWN);
  checar(d.disparar === false, `F1) 2ª queda dentro do cooldown deveria ser SUPRIMIDA (não dispara), recebido: ${JSON.stringify(d)}`);
  checar(d.novoEstado.caido === true, `F1) 2ª queda suprimida: caido deveria ser true, recebido: ${JSON.stringify(d.novoEstado)}`);
  checar(d.novoEstado.quedaAnunciada === false, `F1) 2ª queda suprimida: quedaAnunciada deveria ser false, recebido: ${d.novoEstado.quedaAnunciada}`);
  estado = d.novoEstado;

  //    F2: reconecta — como a 2ª queda NÃO foi anunciada, a volta NÃO dispara
  //        (evita "🟢 reconectou" órfão). ESTE é o comportamento do fix.
  const tReconnect2 = tDrop2 + 1000;
  d = decidirAlertaQuedaDevice(estado, true, tReconnect2, COOLDOWN);
  checar(d.disparar === false && d.tipo === null, `F2) [FIX] reconexão após queda NÃO anunciada NÃO deveria disparar 'volta', recebido: ${JSON.stringify(d)}`);
  checar(d.novoEstado.caido === false, `F2) após reconexão silenciosa, caido deveria ser false, recebido: ${JSON.stringify(d.novoEstado)}`);
  estado = d.novoEstado;

  // G) cooldown EXPIRADO: uma queda que chega passado cooldownMs desde a última
  //    queda anunciada volta a disparar normalmente; e a volta dela também.
  const tQueda3 = tQueda + COOLDOWN + 60_000; // 16min desde tQueda (última queda anunciada) → fora do cooldown
  d = decidirAlertaQuedaDevice(estado, false, tQueda3, COOLDOWN);
  checar(d.disparar === true && d.tipo === 'queda', `G) queda após o cooldown expirar deveria disparar 'queda', recebido: ${JSON.stringify(d)}`);
  checar(d.novoEstado.quedaAnunciada === true, `G) queda pós-cooldown: quedaAnunciada deveria ser true, recebido: ${d.novoEstado.quedaAnunciada}`);
  estado = d.novoEstado;

  const tVolta3 = tQueda3 + 60_000;
  d = decidirAlertaQuedaDevice(estado, true, tVolta3, COOLDOWN);
  checar(d.disparar === true && d.tipo === 'volta', `G) reconexão após a queda pós-cooldown (anunciada) deveria disparar 'volta', recebido: ${JSON.stringify(d)}`);

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
