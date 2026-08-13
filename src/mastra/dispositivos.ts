// Multi-device Wavoip (DEVICE-01, Fase 07 Plano 01) — o novo lar de toda a
// logica de device: inventario, resolucao do device de UM usuario logado, e
// (nas fases seguintes) o pool com lease e o mapeamento reverso numero->device.
//
// Ate esta fase, todo atendente ligava pelo mesmo WAVOIP_DEVICE_TOKEN global —
// isso serializa/colide chamadas simultaneas no Wavoip. Este modulo resolve o
// device de CADA atendente a partir do usuario autenticado (nunca de
// param/body do cliente — T-07-01), com fallback gracioso pro token global
// quando nada esta configurado (DD-07-02 item 3, criterio 4 do roadmap).
//
// LGPD/segredo (DD-07-03/T-07-02): nenhuma funcao aqui loga `token` nem
// `numero` — no maximo `deviceId`/`modo`/contagens. O token continua exposto
// client-side por design (o SDK do navegador precisa dele), mas nunca em log
// de servidor.

import { WAVOIP_DEVICES, WAVOIP_USER_DEVICES, WAVOIP_DEVICE_TOKEN } from './config';

export type ModoDevice = 'dedicado' | 'pool' | 'global';

export interface ConfigDevice {
  wavoipToken: string | null;
  deviceId: string | null;
  modo: ModoDevice;
}

interface DeviceInventario {
  token: string;
  numero: string;
}

/**
 * Parser do inventario WAVOIP_DEVICES ("deviceId:token:numero,..."). Cada
 * entrada e splitada nos DOIS primeiros ':' (deviceId, token, numero) — os
 * tokens Wavoip sao alfanumericos e nao contem ':'/','. Entradas sem deviceId
 * ou token sao puladas. `numero` normalizado so-digitos.
 */
function carregarInventario(): Map<string, DeviceInventario> {
  const raw = WAVOIP_DEVICES;
  const m = new Map<string, DeviceInventario>();
  for (const entrada of raw.split(',')) {
    const partes = entrada.split(':');
    if (partes.length < 2) continue;
    const deviceId = (partes[0] || '').trim();
    const token = (partes[1] || '').trim();
    const numero = (partes[2] || '').replace(/[^\d]/g, '');
    if (!deviceId || !token) continue;
    m.set(deviceId, { token, numero });
  }
  return m;
}

/**
 * Parser do mapa dedicado WAVOIP_USER_DEVICES ("usuario:deviceId,...") —
 * identico ao carregarAssignees() de operadores.ts (DISCADOR_ASSIGNEES).
 */
function carregarDedicados(): Map<string, string> {
  const raw = WAVOIP_USER_DEVICES;
  const m = new Map<string, string>();
  for (const par of raw.split(',')) {
    const i = par.indexOf(':');
    if (i === -1) continue;
    const usuario = par.slice(0, i).trim().toLowerCase();
    const deviceId = par.slice(i + 1).trim();
    if (usuario && deviceId) m.set(usuario, deviceId);
  }
  return m;
}

const INVENTARIO = carregarInventario();
const DEDICADOS = carregarDedicados();

if (INVENTARIO.size === 0) {
  console.warn(
    '[dispositivos] WAVOIP_DEVICES vazio: o discador opera em modo GLOBAL (1 device via ' +
      'WAVOIP_DEVICE_TOKEN) para todos os atendentes. Configure WAVOIP_DEVICES/WAVOIP_USER_DEVICES ' +
      'no .env para habilitar device por atendente (DEVICE-01).',
  );
}

/** Retorna o token do inventario para um deviceId, ou null se nao existe. */
export function tokenDoDevice(deviceId: string): string | null {
  const entrada = INVENTARIO.get(deviceId);
  return entrada ? entrada.token : null;
}

/** Mapa reverso numero(so-digitos)->deviceId. null se nenhum device casa. */
export function deviceIdPorNumero(numero: string): string | null {
  const alvo = (numero || '').replace(/[^\d]/g, '');
  if (!alvo) return null;
  for (const [deviceId, entrada] of INVENTARIO) {
    if (entrada.numero && entrada.numero === alvo) return deviceId;
  }
  return null;
}

/** true se algum deviceId do inventario NAO esta dedicado a nenhum usuario (device de pool). */
function existeDeviceDePool(): boolean {
  const dedicadosSet = new Set(DEDICADOS.values());
  for (const deviceId of INVENTARIO.keys()) {
    if (!dedicadosSet.has(deviceId)) return true;
  }
  return false;
}

/**
 * Resolve a config de device do usuario autenticado (DEVICE-01, DD-07-02):
 * 1. usuario tem device dedicado (WAVOIP_USER_DEVICES) -> esse token, modo 'dedicado'.
 * 2. senao, se ha device de pool livre no inventario -> wavoipToken null, modo 'pool'
 *    (o frontend fara lease no inicio da chamada — plano 07-02).
 * 3. senao -> WAVOIP_DEVICE_TOKEN global, modo 'global' (comportamento atual de 1 device,
 *    degradacao graciosa — criterio 4 do roadmap).
 */
export function resolverConfigDoUsuario(usuario: string): ConfigDevice {
  const u = (usuario || '').trim().toLowerCase();
  const deviceIdDedicado = u ? DEDICADOS.get(u) : undefined;
  if (deviceIdDedicado) {
    const token = tokenDoDevice(deviceIdDedicado);
    if (token) {
      return { wavoipToken: token, deviceId: deviceIdDedicado, modo: 'dedicado' };
    }
  }
  if (existeDeviceDePool()) {
    return { wavoipToken: null, deviceId: null, modo: 'pool' };
  }
  return { wavoipToken: WAVOIP_DEVICE_TOKEN, deviceId: null, modo: 'global' };
}
