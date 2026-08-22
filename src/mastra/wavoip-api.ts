// Cliente da API de GERENCIA da Wavoip (api.wavoip.com/v2): login de CONTA
// (JWT cacheado) + listagem de dispositivos + leitura/gravacao do webhook por
// dispositivo. Isso e o que alimenta a secao "Conexoes Wavoip" do painel de
// admin (auto-descoberta + auto-webhook).
//
// Diferente do WAVOIP_DEVICE_TOKEN (por-device, exposto no navegador): aqui o
// segredo e o login da CONTA (email+senha -> JWT), server-side only.
//
// LGPD/segredo: NUNCA logar JWT, token de device nem numero completo. As
// funcoes de rede LANCAM em falha (o caller decide) — nunca mascaram erro.

import {
  WAVOIP_API_EMAIL,
  WAVOIP_API_PASSWORD,
  WAVOIP_API_BASE,
  WAVOIP_WEBHOOK_URL,
  WAVOIP_WEBHOOK_TOKEN,
  REDIS_URL,
} from './config.ts';
import { fetchTimeout } from './http.ts';
// A4 (Pacote A / incidente 2026-08-22): espelho Redis do invCache, molde de
// estado-webhook.ts — sobrevive a restart do processo web. NUNCA lança pro
// chamador (mesma convenção): Redis fora do ar degrada pro cache em memória.
import Redis from 'ioredis';

/** Dispositivo Wavoip normalizado para a UI (sem token — o token nao vai ao painel). */
export interface DispositivoWavoip {
  id: number;
  nome: string;
  numero: string;
  status: string; // 'open' | 'connecting' | 'hibernating' | 'closed' | ...
  conectado: boolean; // status === 'open'
  webhookOk: boolean | null; // true/false após checagem; null = não checado
}

/** Configuração do webhook de um device (GET/PUT /devices/:id/webhook/settings). */
export interface WebhookDispositivo {
  url: string;
  active: boolean;
  call_event: boolean;
  record_event: boolean;
  device_event: boolean;
}

/** Há credenciais de conta para falar com a API de gerência? */
export function wavoipApiConfigurada(): boolean {
  return Boolean(WAVOIP_API_EMAIL && WAVOIP_API_PASSWORD);
}

let jwtCache: { token: string; exp: number } | null = null;

/** Login de conta -> JWT cacheado (dura ~7 dias; renova com folga). Lança em falha. */
async function obterJwt(forcar = false): Promise<string> {
  if (!wavoipApiConfigurada()) {
    throw new Error('[wavoip-api] WAVOIP_API_EMAIL/PASSWORD ausentes — sem acesso a API de gerencia');
  }
  const agora = Date.now();
  if (!forcar && jwtCache && jwtCache.exp > agora + 60_000) return jwtCache.token;
  let res: Response;
  try {
    res = await fetchTimeout(`${WAVOIP_API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: WAVOIP_API_EMAIL, password: WAVOIP_API_PASSWORD }),
    });
  } catch (e) {
    throw new Error(`[wavoip-api] falha de rede no login: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`[wavoip-api] login falhou (${res.status})`);
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const data = j.data as Record<string, unknown> | undefined;
  const token = (j.token || j.access_token || data?.token) as string | undefined;
  if (!token) throw new Error('[wavoip-api] login sem token no corpo');
  // Cacheia por 6 dias (JWT dura ~7) — renova com folga antes de expirar.
  jwtCache = { token, exp: agora + 6 * 24 * 3600 * 1000 };
  return token;
}

/** fetch autenticado que re-loga UMA vez em 401 (JWT expirou). */
async function apiFetch(caminho: string, init?: RequestInit): Promise<Response> {
  let token = await obterJwt();
  const chamar = (t: string) =>
    fetchTimeout(`${WAVOIP_API_BASE}${caminho}`, {
      ...init,
      headers: { ...(init?.headers || {}), Authorization: `Bearer ${t}` },
    });
  let res = await chamar(token);
  if (res.status === 401) {
    token = await obterJwt(true);
    res = await chamar(token);
  }
  return res;
}

/** Busca CRUA dos devices (inclui `token` — uso INTERNO só). Lança em falha. */
async function buscarDevicesBrutos(): Promise<Array<Record<string, unknown>>> {
  const res = await apiFetch('/devices');
  if (!res.ok) throw new Error(`[wavoip-api] GET /devices falhou (${res.status})`);
  const j = (await res.json().catch(() => null)) as { data?: unknown; devices?: unknown } | unknown[] | null;
  return (Array.isArray(j) ? j : ((j as { data?: unknown })?.data ?? (j as { devices?: unknown })?.devices ?? [])) as Array<
    Record<string, unknown>
  >;
}

/** Lista todos os dispositivos da conta (normalizado, SEM token). Lança em falha. */
export async function listarDispositivosWavoip(): Promise<DispositivoWavoip[]> {
  const arr = await buscarDevicesBrutos();
  return arr.map((d) => {
    const status = String(d.status ?? '');
    return {
      id: Number(d.id),
      nome: String(d.name ?? ''),
      numero: String(d.phone ?? ''),
      status,
      conectado: status === 'open',
      webhookOk: null,
    };
  });
}

// ===== Inventário vivo (deviceId -> token/numero/...) para o call-routing =====
//
// O painel associa um operador a um device da Wavoip (guarda o id do device em
// `wavoip_device_id`). Na hora da ligação, resolverConfigDoUsuario precisa do
// TOKEN daquele device — que a API devolve. Mantemos um snapshot em cache com
// TTL curto pra não bater na API a cada /config. LGPD/segredo: este token vive
// SÓ aqui no servidor — nunca vai ao painel/navegador (o normalizado da UI já
// o remove) nem a log.

interface InvWavoip {
  token: string;
  numero: string;
  nome: string;
  status: string;
  conectado: boolean;
  callsMade: number; // `calls_made` da Wavoip — total acumulado de chamadas do device
}

/** Device do inventário SEM token, para o painel (chamadas por número). */
export interface DeviceWavoipPublico {
  id: string;
  nome: string;
  numero: string;
  status: string;
  conectado: boolean;
  callsMade: number;
}

let invCache: { at: number; mapa: Map<string, InvWavoip> } = { at: 0, mapa: new Map() };

// ===== A4 (Pacote A / incidente 2026-08-22) — espelho Redis do invCache =====
//
// Casca Redis-ou-memoria, molde de estado-webhook.ts (garantirCliente):
// backend escolhido UMA vez no boot por REDIS_URL. Sem Redis, o invCache
// continua só em memória (comportamento de sempre — cold start após restart
// espera o próximo refresh de rede). Com Redis, o inventário (que CONTÉM
// tokens de device) sobrevive a restart: o valor vive só server-side, NUNCA
// vai a log (T-mfp-02).
const MODO_INV: 'redis' | 'memoria' = REDIS_URL ? 'redis' : 'memoria';

let clienteInv: Redis | null = null;

function garantirClienteInv(): Redis {
  if (!clienteInv) {
    clienteInv = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectTimeout: 5000,
    });
    // So para nao derrubar o processo com unhandled error — mensagem curta,
    // NUNCA a REDIS_URL (pode embutir credencial) nem o valor do inventario.
    clienteInv.on('error', (e) => {
      console.error('[wavoip-api] erro de conexao Redis do inventario (degradando):', e instanceof Error ? e.message : String(e));
    });
  }
  return clienteInv;
}

const CHAVE_INV = 'wv:inv';
const INV_TTL_MS = 24 * 60 * 60 * 1000;

/** Espelha o inventário vivo no Redis (best-effort, NUNCA lança). O valor contém tokens — nunca logado. */
async function salvarInventarioRedis(mapa: Map<string, InvWavoip>): Promise<void> {
  if (MODO_INV !== 'redis') return;
  try {
    await garantirClienteInv().set(CHAVE_INV, JSON.stringify(Array.from(mapa.entries())), 'PX', INV_TTL_MS);
  } catch (e) {
    console.error('[wavoip-api] falha ao espelhar inventario no Redis (degradando p/ so-memoria):', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Re-hidrata o invCache a partir do espelho Redis num miss frio (invCache
 * vazio — ex. logo após restart do processo). Best-effort, NUNCA lança: em
 * qualquer erro/miss, no-op silencioso (o refresh de rede seguinte cobre).
 * `invCache.at` NÃO é tocado — fica 0, pra não bloquear o próximo refresh.
 */
async function hidratarInventarioDoRedis(): Promise<void> {
  if (MODO_INV !== 'redis') return;
  try {
    const bruto = await garantirClienteInv().get(CHAVE_INV);
    if (!bruto) return;
    const entradas = JSON.parse(bruto) as Array<[string, InvWavoip]>;
    if (Array.isArray(entradas) && entradas.length > 0 && invCache.mapa.size === 0) {
      invCache = { at: invCache.at, mapa: new Map(entradas) };
    }
  } catch (e) {
    console.error('[wavoip-api] falha ao hidratar inventario do Redis (degradando p/ cache vazio):', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Atualiza o inventário vivo respeitando um TTL (default 60s). NUNCA lança: em
 * falha de rede/API, mantém o snapshot anterior (degradação graciosa — o
 * call-routing cai pro device global, o comportamento de sempre).
 *
 * A4: num miss frio (cache vazio, ex. logo após restart), tenta re-hidratar
 * do espelho Redis ANTES de bater na rede — barato (~ms) e deixa tokens
 * disponíveis mesmo se a API Wavoip estiver lenta/fora nesse instante.
 */
export async function garantirInventarioWavoip(maxIdadeMs = 60_000): Promise<void> {
  if (!wavoipApiConfigurada()) return;
  const agora = Date.now();
  if (invCache.at && agora - invCache.at < maxIdadeMs) return;
  if (MODO_INV === 'redis' && invCache.mapa.size === 0) {
    await hidratarInventarioDoRedis();
  }
  try {
    const brutos = await buscarDevicesBrutos();
    const mapa = new Map<string, InvWavoip>();
    for (const d of brutos) {
      const id = String(d.id ?? '');
      const token = String((d as { token?: unknown }).token ?? '');
      if (!id || !token) continue;
      const status = String(d.status ?? '');
      mapa.set(id, {
        token,
        numero: String(d.phone ?? ''),
        nome: String(d.name ?? ''),
        status,
        conectado: status === 'open',
        callsMade: Number((d as { calls_made?: unknown }).calls_made ?? 0) || 0,
      });
    }
    invCache = { at: agora, mapa };
    void salvarInventarioRedis(mapa);
  } catch (e) {
    // Mantém o snapshot anterior (que pode ser o hidratado do Redis acima);
    // marca `at` pra não martelar a API em loop.
    invCache = { at: agora, mapa: invCache.mapa };
    console.error('[wavoip-api] falha ao atualizar inventario (mantendo cache):', e instanceof Error ? e.message : String(e));
  }
}

/**
 * A5 (Pacote A / incidente 2026-08-22, T-mfp-04): tira o refresh do inventário
 * do caminho crítico da discagem (/config, /dispositivo/lease). `Promise.race`
 * entre o refresh real (que segue em BACKGROUND populando invCache+Redis pra
 * próxima chamada mesmo se perder a corrida) e um teto de tempo — NUNCA lança,
 * NUNCA espera além do teto. Sem isso, uma API Wavoip em timeout travava toda
 * discagem atrás dela (o incidente que originou o Pacote A).
 */
export async function aquecerInventarioWavoip(tetoMs = 2500): Promise<void> {
  await new Promise<void>((resolve) => {
    let resolvido = false;
    const finalizar = (): void => {
      if (resolvido) return;
      resolvido = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finalizar, tetoMs);
    timer.unref?.();
    void garantirInventarioWavoip()
      .catch(() => {})
      .then(finalizar);
  });
}

/** Handle do refresh periódico de background (A5) — idempotente. */
let refreshInvHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Arma o refresh periódico do inventário em BACKGROUND (A5) — desacopla o
 * invCache de bater na API só quando uma requisição de discagem passa por
 * /config. Idempotente (segunda chamada é no-op); só arma quando a API Wavoip
 * está configurada; `unref()` no timer pra não segurar o processo vivo (molde
 * de iniciarChecagemAlertas em alertas.ts).
 */
export function iniciarRefreshInventarioWavoip(intervaloMs = 60_000): void {
  if (refreshInvHandle) return;
  if (!wavoipApiConfigurada()) return;
  refreshInvHandle = setInterval(() => void garantirInventarioWavoip().catch(() => {}), intervaloMs);
  refreshInvHandle.unref?.();
  console.log(`[wavoip-api] refresh periódico do inventário ativo (intervalo=${intervaloMs}ms, modo=${MODO_INV})`);
}

/** Para o refresh periódico do inventário (molde de fecharAlertas). No-op se não iniciado. */
export function fecharRefreshInventarioWavoip(): void {
  if (refreshInvHandle) {
    clearInterval(refreshInvHandle);
    refreshInvHandle = null;
  }
}

/** Fecha o cliente Redis do inventário (graceful shutdown) — no-op em modo memória. */
export async function fecharInventarioWavoip(): Promise<void> {
  if (clienteInv) {
    await clienteInv.quit();
    clienteInv = null;
  }
}

console.log(
  MODO_INV === 'redis'
    ? '[wavoip-api] inventario de devices espelhado em Redis (sobrevive a restart)'
    : '[wavoip-api] inventario de devices em memoria (nao sobrevive a restart)',
);

/** Token de um device pelo id, do inventário vivo em cache (server-side). null se ausente. */
export function tokenDeviceWavoip(deviceId: string): string | null {
  const e = invCache.mapa.get(String(deviceId));
  return e ? e.token : null;
}

/**
 * Status de conexão de um device pelo id, do inventário vivo em cache
 * (DEVICE-04): true=conectado (status 'open'), false=caiu do WhatsApp
 * (hibernating/etc — discar por ele vai falhar), null=fora do cache vivo
 * (device só-env sem tracking de status — não bloqueia, comportamento atual).
 */
export function deviceConectadoWavoip(deviceId: string): boolean | null {
  const e = invCache.mapa.get(String(deviceId));
  return e ? e.conectado : null;
}

/**
 * Snapshot dos devices do inventário vivo, SEM token (LGPD/segredo), para o
 * painel "chamadas por número". Lê o cache — barato de chamar (o refresh
 * respeita o TTL de garantirInventarioWavoip). Vazio se o cache não montou.
 */
export function snapshotDevicesWavoip(): DeviceWavoipPublico[] {
  const out: DeviceWavoipPublico[] = [];
  for (const [id, e] of invCache.mapa) {
    out.push({ id, nome: e.nome, numero: e.numero, status: e.status, conectado: e.conectado, callsMade: e.callsMade });
  }
  return out;
}

/** Lê o webhook de um device. `null` quando ainda não setado (404). Lança em outros erros. */
export async function lerWebhookDispositivo(id: number): Promise<WebhookDispositivo | null> {
  const res = await apiFetch(`/devices/${id}/webhook/settings`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`[wavoip-api] GET webhook/settings ${id} falhou (${res.status})`);
  const j = (await res.json().catch(() => ({}))) as { data?: WebhookDispositivo } & Partial<WebhookDispositivo>;
  const s = (j.data ?? j) as Partial<WebhookDispositivo>;
  return {
    url: String(s.url ?? ''),
    active: Boolean(s.active),
    call_event: Boolean(s.call_event),
    record_event: Boolean(s.record_event),
    device_event: Boolean(s.device_event),
  };
}

/** URL pública do webhook de prod já com `?token=` anexado. '' quando não configurada. */
export function urlWebhookProd(): string {
  if (!WAVOIP_WEBHOOK_URL) return '';
  if (!WAVOIP_WEBHOOK_TOKEN) return WAVOIP_WEBHOOK_URL;
  const sep = WAVOIP_WEBHOOK_URL.includes('?') ? '&' : '?';
  return `${WAVOIP_WEBHOOK_URL}${sep}token=${encodeURIComponent(WAVOIP_WEBHOOK_TOKEN)}`;
}

/** Já existe o auto-webhook (URL de prod configurada)? */
export function autoWebhookConfigurado(): boolean {
  return Boolean(urlWebhookProd());
}

/** Um device já aponta pro nosso webhook de prod (mesma URL, ativo, eventos ligados)? */
export function webhookBate(atual: WebhookDispositivo | null, alvo: string): boolean {
  return Boolean(
    atual &&
      atual.active &&
      atual.url === alvo &&
      atual.call_event &&
      atual.record_event &&
      atual.device_event,
  );
}

/** Grava (PUT) o webhook de prod num device, com todos os eventos ligados. Lança em falha. */
export async function configurarWebhookDispositivo(id: number): Promise<void> {
  const alvo = urlWebhookProd();
  if (!alvo) throw new Error('[wavoip-api] WAVOIP_WEBHOOK_URL ausente — sem URL de prod para gravar');
  const res = await apiFetch(`/devices/${id}/webhook/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: alvo, active: true, call_event: true, record_event: true, device_event: true }),
  });
  if (!res.ok) throw new Error(`[wavoip-api] PUT webhook/settings ${id} falhou (${res.status})`);
}
