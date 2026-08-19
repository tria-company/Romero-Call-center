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

  // 1) 1º evento 'open' de device novo — NÃO dispara (sem transição: nunca
  //    esteve caído antes).
  let d = decidirAlertaQuedaDevice(estado, true, T0, COOLDOWN);
  checar(d.disparar === false, `1º open de device novo deveria NÃO disparar, recebido: ${JSON.stringify(d)}`);
  checar(d.tipo === null, `1º open: tipo deveria ser null, recebido: '${d.tipo}'`);
  checar(d.novoEstado.caido === false, `1º open: novoEstado.caido deveria ser false, recebido: ${JSON.stringify(d.novoEstado)}`);
  estado = d.novoEstado;

  // 2) heartbeat 'open' repetido, já conectado — NÃO dispara.
  d = decidirAlertaQuedaDevice(estado, true, T0 + 1000, COOLDOWN);
  checar(d.disparar === false, `heartbeat 'open' repetido deveria NÃO disparar, recebido: ${JSON.stringify(d)}`);
  estado = d.novoEstado;

  // 3) open -> hibernating (transição pra caído), fora de qualquer cooldown
  //    anterior (ultimoAlertaTs=0) — DISPARA 'queda' exatamente 1x.
  const tQueda = T0 + 2000;
  d = decidirAlertaQuedaDevice(estado, false, tQueda, COOLDOWN);
  checar(d.disparar === true && d.tipo === 'queda', `open->hibernating deveria disparar 'queda', recebido: ${JSON.stringify(d)}`);
  checar(d.novoEstado.caido === true, `após queda, novoEstado.caido deveria ser true, recebido: ${JSON.stringify(d.novoEstado)}`);
  checar(d.novoEstado.ultimoAlertaTs === tQueda, `após queda, ultimoAlertaTs deveria ser o 'agora' do disparo (${tQueda}), recebido: ${d.novoEstado.ultimoAlertaTs}`);
  estado = d.novoEstado;

  // 4) 3 heartbeats 'hibernating' seguidos (dentro do cooldown) — NÃO
  //    re-disparam.
  for (let i = 1; i <= 3; i++) {
    const tHeartbeat = tQueda + i * 60_000; // +1min, +2min, +3min — bem dentro dos 15min de cooldown
    d = decidirAlertaQuedaDevice(estado, false, tHeartbeat, COOLDOWN);
    checar(d.disparar === false, `heartbeat 'hibernating' #${i} (dentro do cooldown) deveria NÃO re-disparar, recebido: ${JSON.stringify(d)}`);
    checar(d.novoEstado.caido === true, `heartbeat 'hibernating' #${i}: continua caido=true, recebido: ${JSON.stringify(d.novoEstado)}`);
    checar(d.novoEstado.ultimoAlertaTs === tQueda, `heartbeat 'hibernating' #${i}: ultimoAlertaTs NÃO deveria mudar (sem novo disparo), recebido: ${d.novoEstado.ultimoAlertaTs}`);
    estado = d.novoEstado;
  }

  // 5) hibernating -> open (reconexão) — DISPARA 'volta' e reseta caido.
  const tVolta = tQueda + 5 * 60_000;
  d = decidirAlertaQuedaDevice(estado, true, tVolta, COOLDOWN);
  checar(d.disparar === true && d.tipo === 'volta', `hibernating->open deveria disparar 'volta', recebido: ${JSON.stringify(d)}`);
  checar(d.novoEstado.caido === false, `após volta, novoEstado.caido deveria ser false (reset), recebido: ${JSON.stringify(d.novoEstado)}`);
  checar(d.novoEstado.ultimoAlertaTs === tVolta, `após volta, ultimoAlertaTs deveria ser o 'agora' do disparo (${tVolta}), recebido: ${d.novoEstado.ultimoAlertaTs}`);
  estado = d.novoEstado;

  // 6) caso de cooldown EXPIRADO: uma nova queda logo após a 'volta' (passo 5)
  //    ainda está DENTRO do cooldown (ultimoAlertaTs foi atualizado pela
  //    própria 'volta') — NÃO deve re-disparar (CASO 2b). Só uma queda cujo
  //    'agora' já passou cooldownMs desde esse último alerta volta a disparar.
  const tQuedaCedoDemais = tVolta + 1000; // bem dentro do cooldown desde a 'volta'
  d = decidirAlertaQuedaDevice(estado, false, tQuedaCedoDemais, COOLDOWN);
  checar(d.disparar === false, `queda logo após a 'volta' (ainda dentro do cooldown) deveria NÃO disparar, recebido: ${JSON.stringify(d)}`);
  checar(d.novoEstado.caido === true, `queda cedo demais: novoEstado.caido deveria ser true mesmo sem disparar, recebido: ${JSON.stringify(d.novoEstado)}`);
  estado = d.novoEstado;

  // Heartbeat 'hibernating' repetido, mesma queda em aberto — nunca dispara,
  // mesmo que o tempo avance muito além do cooldown (CASO 3: independe do
  // cooldown enquanto não houver reconexão).
  const tMuitoDepois = tQuedaCedoDemais + COOLDOWN + 60_000;
  d = decidirAlertaQuedaDevice(estado, false, tMuitoDepois, COOLDOWN);
  checar(d.disparar === false, `heartbeat 'hibernating' muito depois (mesma queda em aberto) deveria continuar NÃO disparando, recebido: ${JSON.stringify(d)}`);
  estado = d.novoEstado;

  // Reconecta — dispara 'volta' e reseta ultimoAlertaTs pro momento da reconexão.
  const tVolta2 = tMuitoDepois + 1000;
  d = decidirAlertaQuedaDevice(estado, true, tVolta2, COOLDOWN);
  checar(d.disparar === true && d.tipo === 'volta', `reconexão após heartbeats prolongados deveria disparar 'volta', recebido: ${JSON.stringify(d)}`);
  estado = d.novoEstado;

  // Uma queda que só chega DEPOIS de cooldownMs desde essa 'volta' (que
  // atualizou ultimoAlertaTs) volta a disparar 'queda' normalmente.
  const tQueda3 = tVolta2 + COOLDOWN + 1000;
  d = decidirAlertaQuedaDevice(estado, false, tQueda3, COOLDOWN);
  checar(d.disparar === true && d.tipo === 'queda', `queda após o cooldown expirar (desde a última 'volta') deveria disparar 'queda', recebido: ${JSON.stringify(d)}`);

  if (falhas.length > 0) {
    console.error('=== SMOKE FAIL ===');
    for (const f of falhas) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main();
