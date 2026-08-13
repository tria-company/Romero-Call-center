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

import Redis from 'ioredis';
import { WAVOIP_DEVICES, WAVOIP_USER_DEVICES, WAVOIP_DEVICE_TOKEN, REDIS_URL, DEVICE_LEASE_TTL_MS } from './config.ts';

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

// ===== Pool com lease/release (DEVICE-02, Fase 07 Plano 02) =====
//
// Quando ha menos devices que atendentes, o atendente sem device dedicado
// (resolverConfigDoUsuario acima -> modo:'pool') aloca um device LIVRE do
// pool no inicio da chamada (lease) e devolve no fim (release). Espelha
// estado-webhook.ts (DD-07-04): backend Redis-ou-memoria decidido UMA vez no
// boot por REDIS_URL, cliente ioredis lazy singleton, SET ... 'PX' ttl 'NX'
// atomico pro lease, NUNCA lanca pro chamador (Redis fora do ar degrada:
// lease falha-fechado = "sem device livre", release = no-op best-effort).

export interface DeviceAlocado {
  deviceId: string;
  wavoipToken: string;
  leaseTtlMs: number;
}

const MODO_POOL: 'redis' | 'memoria' = REDIS_URL ? 'redis' : 'memoria';

const PREFIXO_LEASE = 'wv:lease:';

/** deviceIds do inventario que NAO estao dedicados a nenhum usuario (DD-07-06). */
function deviceIdsDePool(): string[] {
  const dedicadosSet = new Set(DEDICADOS.values());
  const ids: string[] = [];
  for (const deviceId of INVENTARIO.keys()) {
    if (!dedicadosSet.has(deviceId)) ids.push(deviceId);
  }
  return ids;
}

// ----- Backend MEMORIA — Map<deviceId, {usuario, ts}> + poda preguicosa por TTL -----

const leaseMem = new Map<string, { usuario: string; ts: number }>();

function leaseVivoMem(deviceId: string): boolean {
  const entrada = leaseMem.get(deviceId);
  if (!entrada) return false;
  if (Date.now() - entrada.ts > DEVICE_LEASE_TTL_MS) {
    leaseMem.delete(deviceId); // poda preguicosa — TTL expirado, device volta sozinho ao pool
    return false;
  }
  return true;
}

function alocarDeviceMem(usuario: string): DeviceAlocado | null {
  for (const deviceId of deviceIdsDePool()) {
    if (leaseVivoMem(deviceId)) continue;
    const token = tokenDoDevice(deviceId);
    if (!token) continue;
    leaseMem.set(deviceId, { usuario, ts: Date.now() });
    return { deviceId, wavoipToken: token, leaseTtlMs: DEVICE_LEASE_TTL_MS };
  }
  return null;
}

function liberarDeviceMem(deviceId: string, usuario?: string): void {
  const entrada = leaseMem.get(deviceId);
  if (!entrada) return;
  if (usuario && entrada.usuario !== usuario) return; // T-07-05: nao libera lease de outro
  leaseMem.delete(deviceId);
}

// ----- Backend REDIS — cliente lazy, TTL nativo, SET NX atomico (espelha estado-webhook.ts) -----

let clientePool: Redis | null = null;

function garantirClientePool(): Redis {
  if (!clientePool) {
    clientePool = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectTimeout: 5000,
    });
    // So para nao derrubar o processo com unhandled error — mensagem curta,
    // NUNCA a REDIS_URL (pode embutir credencial).
    clientePool.on('error', (e) => {
      console.error('[dispositivos] erro de conexao Redis do pool (degradando):', e instanceof Error ? e.message : String(e));
    });
  }
  return clientePool;
}

async function alocarDeviceRedis(usuario: string): Promise<DeviceAlocado | null> {
  try {
    const cliente = garantirClientePool();
    for (const deviceId of deviceIdsDePool()) {
      const token = tokenDoDevice(deviceId);
      if (!token) continue;
      const resultado = await cliente.set(PREFIXO_LEASE + deviceId, usuario, 'PX', DEVICE_LEASE_TTL_MS, 'NX');
      if (resultado === 'OK') {
        return { deviceId, wavoipToken: token, leaseTtlMs: DEVICE_LEASE_TTL_MS };
      }
    }
    return null; // nenhum device livre — esgotamento (DD-07-09), NAO e erro
  } catch (e) {
    // Fail-fechado (diferente de estado-webhook.ts): melhor "tente de novo"
    // do que entregar um device que talvez ja esteja leased por outro.
    console.error('[dispositivos] falha ao alocar device do pool (degradando p/ sem-device-livre):', e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function liberarDeviceRedis(deviceId: string, usuario?: string): Promise<void> {
  try {
    const cliente = garantirClientePool();
    if (usuario) {
      try {
        const dono = await cliente.get(PREFIXO_LEASE + deviceId);
        if (dono !== null && dono !== usuario) return; // T-07-05: nao libera lease de outro
      } catch (e) {
        // GET falhou — segue com o del best-effort (nao trava o release por
        // causa de uma falha transiente na checagem de dono).
        console.error('[dispositivos] falha ao checar dono do lease (seguindo com del best-effort):', e instanceof Error ? e.message : String(e));
      }
    }
    await cliente.del(PREFIXO_LEASE + deviceId);
  } catch (e) {
    console.error('[dispositivos] falha ao liberar device do pool (degradando p/ no-op):', e instanceof Error ? e.message : String(e));
  }
}

// ----- Superficie publica — despacha para o backend escolhido no boot -----

/**
 * Aloca um device LIVRE do pool para `usuario` (lease). Retorna `null`
 * quando o pool esta esgotado (o endpoint traduz em 503 — DD-07-09) OU em
 * falha do Redis (fail-fechado — DD-07-04). Nunca lanca.
 */
export async function alocarDevice(usuario: string): Promise<DeviceAlocado | null> {
  return MODO_POOL === 'redis' ? alocarDeviceRedis(usuario) : Promise.resolve(alocarDeviceMem(usuario));
}

/**
 * Devolve `deviceId` ao pool. Se `usuario` for informado, so libera quando
 * `usuario` e o dono do lease (T-07-05) — idempotente e best-effort, nunca
 * lanca (release repetido/de device sem lease ativa e no-op).
 */
export async function liberarDevice(deviceId: string, usuario?: string): Promise<void> {
  if (!deviceId) return;
  return MODO_POOL === 'redis' ? liberarDeviceRedis(deviceId, usuario) : Promise.resolve(liberarDeviceMem(deviceId, usuario));
}

/** 'redis' ou 'memoria' — usado pelo smoke e pelo log de boot. */
export function modoDevicePool(): 'redis' | 'memoria' {
  return MODO_POOL;
}

/** Fecha o cliente Redis do pool (graceful shutdown) — no-op em modo memoria. */
export async function fecharDevicePool(): Promise<void> {
  if (clientePool) {
    await clientePool.quit();
    clientePool = null;
  }
}

if (deviceIdsDePool().length > 0) {
  console.log(
    MODO_POOL === 'redis'
      ? '[dispositivos] pool de devices em Redis (compartilhado)'
      : '[dispositivos] pool de devices em memoria (1 instancia)',
  );
}
