// Modulo de metricas operacionais (Fase 10, escala-150-atendentes, OBS-02, D-06).
//
// Colhe/le as metricas que alimentam o painel (10-05) e os alertas de
// threshold (10-04): atendentes online, chamadas ativas, profundidade da
// fila, erros do dia e taxa de erro por etapa, contagem de 429 do ClickUp.
// Mesma casca Redis-ou-memoria de rate-limiter-clickup.ts: MODO decidido UMA
// vez no boot pelo valor de REDIS_URL, cliente lazy singleton, NUNCA lanca
// pro chamador — qualquer falha do Redis em runtime degrada para o valor
// neutro (0) daquele campo. Sem REDIS_URL, aplica o MESMO algoritmo num
// estado local por processo.
//
// LGPD: este modulo NUNCA loga telefone/CPF/token — so o modo, o operadorId
// de sessao (nao e PII de lead) e a classe/mensagem do erro.

import Redis from 'ioredis';
import {
  REDIS_URL,
  METRICAS_ERRO_JANELA_MS,
  METRICAS_429_JANELA_MS,
  METRICAS_PRESENCA_TTL_MS,
  METRICAS_SERIE_TTL_MS,
} from './config.ts';
import { profundidadeFila } from './fila.ts';
import { contarChamadasAtivas } from './estado-webhook.ts';

export type EtapaMetrica = 'webhook' | 'transcricao' | 'analise' | 'sync';

export interface MetricasSnapshot {
  atendentesOnline: number;
  chamadasAtivas: number;
  profundidadeFila: number;
  errosDia: number;
  taxaErroPorEtapa: Record<EtapaMetrica, { erros: number; total: number; taxa: number }>;
  contagem429: number;
}

const MODO: 'redis' | 'memoria' = REDIS_URL ? 'redis' : 'memoria';

const ETAPAS: EtapaMetrica[] = ['webhook', 'transcricao', 'analise', 'sync'];

const DIA_TTL_MS = 48 * 60 * 60 * 1000; // 48h — contador diario de erros

// ===== Backend REDIS — cliente lazy singleton =====

let cliente: Redis | null = null;

/** Instancia o cliente na primeira operacao (lazy) e reusa depois (singleton) — mesmo molde de rate-limiter-clickup.ts. */
function garantirCliente(): Redis {
  if (!cliente) {
    cliente = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectTimeout: 5000,
    });
    // So para nao derrubar o processo com unhandled error — mensagem curta,
    // NUNCA a REDIS_URL (pode embutir credencial).
    cliente.on('error', (e) => {
      console.error('[metricas] erro de conexao Redis (degradando):', e instanceof Error ? e.message : String(e));
    });
  }
  return cliente;
}

const PREFIXO_PRESENCA = 'met:presenca:';
const PREFIXO_ETAPA = 'met:etapa:'; // + etapa + ':' + (erros|total) + ':' + bucket
const PREFIXO_DIA = 'met:dia:'; // + data (YYYY-MM-DD)
const PREFIXO_429 = 'met:429:'; // + bucket
const PREFIXO_SERIE = 'met:serie:'; // + metrica-chave (ex.: erro:webhook, sucesso:sync, 429) + ':' + data (YYYY-MM-DD)

/** Bucket de janela fixa — a chave muda a cada janela, TTL cobre a janela inteira (contador janelado sem sorted set). */
function bucketJanela(janelaMs: number): number {
  return Math.floor(Date.now() / janelaMs);
}

function diaHojeStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// Dia OPERACIONAL em horário de Brasília (America/Sao_Paulo). O "hoje" das
// chamadas por número é o dia do operador (BR), não o dia UTC — senão o dia
// "vira" às 21h BRT (00h UTC) e as ligações da noite caem no dia seguinte.
// Usado SÓ pelos contadores por-device; o resto das métricas segue o dia UTC.
// en-CA formata YYYY-MM-DD (mesma forma de diaHojeStr).
function diaOperacionalStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function chaveDiaHoje(): string {
  return PREFIXO_DIA + diaHojeStr();
}

// ===== Backend MEMORIA — mesmo algoritmo, estado local por processo =====

const presencaMem = new Map<string, number>(); // operadorId -> ts visto
const etapaMem = new Map<EtapaMetrica, { erros: number; total: number; bucket: number }>();
const contador429Mem = { bucket: 0, contagem: 0 };
let errosDiaMem = { data: '', contagem: 0 };

function podarPresencaMem(): void {
  const agora = Date.now();
  for (const [k, ts] of presencaMem) {
    if (agora - ts > METRICAS_PRESENCA_TTL_MS) presencaMem.delete(k);
  }
}

function registrarPresencaMem(operadorId: string): void {
  presencaMem.set(operadorId, Date.now());
  if (presencaMem.size > 1000) podarPresencaMem();
}

function atendentesOnlineMem(): number {
  podarPresencaMem();
  return presencaMem.size;
}

function garantirContadorEtapaMem(etapa: EtapaMetrica): { erros: number; total: number; bucket: number } {
  const bucketAtual = bucketJanela(METRICAS_ERRO_JANELA_MS);
  const existente = etapaMem.get(etapa);
  if (!existente || existente.bucket !== bucketAtual) {
    const novo = { erros: 0, total: 0, bucket: bucketAtual };
    etapaMem.set(etapa, novo);
    return novo;
  }
  return existente;
}

function registrarErroDiaMem(): void {
  const hoje = diaHojeStr();
  if (errosDiaMem.data !== hoje) errosDiaMem = { data: hoje, contagem: 0 };
  errosDiaMem.contagem += 1;
}

function registrarErroEtapaMem(etapa: EtapaMetrica): void {
  const c = garantirContadorEtapaMem(etapa);
  c.erros += 1;
  c.total += 1;
  registrarErroDiaMem();
  incrementarSerieMem('erro:' + etapa); // F1 — serie duravel
}

function registrarSucessoEtapaMem(etapa: EtapaMetrica): void {
  const c = garantirContadorEtapaMem(etapa);
  c.total += 1;
  incrementarSerieMem('sucesso:' + etapa); // F1 — serie duravel
}

function taxaErroPorEtapaMem(): Record<EtapaMetrica, { erros: number; total: number; taxa: number }> {
  const bucketAtual = bucketJanela(METRICAS_ERRO_JANELA_MS);
  const resultado = {} as Record<EtapaMetrica, { erros: number; total: number; taxa: number }>;
  for (const etapa of ETAPAS) {
    const c = etapaMem.get(etapa);
    const valido = !!c && c.bucket === bucketAtual;
    const erros = valido ? (c as any).erros : 0;
    const total = valido ? (c as any).total : 0;
    resultado[etapa] = { erros, total, taxa: total > 0 ? erros / total : 0 };
  }
  return resultado;
}

function errosDiaLerMem(): number {
  return errosDiaMem.data === diaHojeStr() ? errosDiaMem.contagem : 0;
}

function registrar429Mem(): void {
  const atual = bucketJanela(METRICAS_429_JANELA_MS);
  if (contador429Mem.bucket !== atual) {
    contador429Mem.bucket = atual;
    contador429Mem.contagem = 0;
  }
  contador429Mem.contagem += 1;
  incrementarSerieMem('429'); // F1 — serie duravel
}

function contagem429Mem(): number {
  return contador429Mem.bucket === bucketJanela(METRICAS_429_JANELA_MS) ? contador429Mem.contagem : 0;
}

// ===== F1 — serie diaria DURAVEL (retencao METRICAS_SERIE_TTL_MS), separada dos
// contadores janelados acima. Write-side p/ investigacao pos-incidente; NAO
// alimenta lerMetricas()/avaliarThresholds (essas seguem os contadores
// janelados de sempre). LGPD: metrica-chave e so um rotulo de etapa/tipo
// (ex. 'erro:webhook', '429') — NUNCA telefone/CPF.

const serieMem = new Map<string, number>(); // `${metrica}:${data}` -> contagem

function chaveSerieMem(metrica: string, data: string): string {
  return `${metrica}:${data}`;
}

/** Poda best-effort (mesmo espirito do backstop de recordsMem) — modo memoria e 1 instancia, entao um Map ilimitado vazaria memoria ao longo de 90 dias simulados via reinicios frequentes; mantem so o dia de hoje quando estoura o teto. */
function podarSerieMem(): void {
  if (serieMem.size <= 20000) return;
  const hoje = diaHojeStr();
  for (const chave of serieMem.keys()) {
    if (!chave.endsWith(':' + hoje)) serieMem.delete(chave);
  }
}

function incrementarSerieMem(metrica: string): void {
  const chave = chaveSerieMem(metrica, diaHojeStr());
  serieMem.set(chave, (serieMem.get(chave) || 0) + 1);
  if (serieMem.size > 20000) podarSerieMem();
}

function ultimosDias(dias: number): string[] {
  const out: string[] = [];
  const hoje = new Date();
  for (let i = 0; i < dias; i++) {
    const d = new Date(hoje);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function lerSerieDiariaMem(metrica: string, dias: number): Array<{ data: string; contagem: number }> {
  return ultimosDias(dias).map((data) => ({ data, contagem: serieMem.get(chaveSerieMem(metrica, data)) || 0 }));
}

// ===== Backend REDIS — contadores janelados via chave+bucket + PEXPIRE =====

async function registrarPresencaRedis(operadorId: string): Promise<void> {
  await garantirCliente().set(PREFIXO_PRESENCA + operadorId, '1', 'PX', METRICAS_PRESENCA_TTL_MS);
}

async function atendentesOnlineRedis(): Promise<number> {
  let cursor = '0';
  let total = 0;
  do {
    const [proximoCursor, chaves] = await garantirCliente().scan(
      cursor,
      'MATCH',
      PREFIXO_PRESENCA + '*',
      'COUNT',
      200,
    );
    cursor = proximoCursor;
    total += chaves.length;
  } while (cursor !== '0');
  return total;
}

function chaveEtapa(etapa: EtapaMetrica, campo: 'erros' | 'total'): string {
  return `${PREFIXO_ETAPA}${etapa}:${campo}:${bucketJanela(METRICAS_ERRO_JANELA_MS)}`;
}

async function incrementarEtapaRedis(etapa: EtapaMetrica, campo: 'erros' | 'total'): Promise<void> {
  const chave = chaveEtapa(etapa, campo);
  const cli = garantirCliente();
  await cli.incr(chave);
  await cli.pexpire(chave, METRICAS_ERRO_JANELA_MS * 2);
}

async function registrarErroEtapaRedis(etapa: EtapaMetrica): Promise<void> {
  await incrementarEtapaRedis(etapa, 'erros');
  await incrementarEtapaRedis(etapa, 'total');
  const cli = garantirCliente();
  const chaveDia = chaveDiaHoje();
  await cli.incr(chaveDia);
  await cli.pexpire(chaveDia, DIA_TTL_MS);
  await incrementarSerieRedis('erro:' + etapa); // F1 — serie duravel
}

async function registrarSucessoEtapaRedis(etapa: EtapaMetrica): Promise<void> {
  await incrementarEtapaRedis(etapa, 'total');
  await incrementarSerieRedis('sucesso:' + etapa); // F1 — serie duravel
}

async function taxaErroPorEtapaRedis(): Promise<Record<EtapaMetrica, { erros: number; total: number; taxa: number }>> {
  const cli = garantirCliente();
  const resultado = {} as Record<EtapaMetrica, { erros: number; total: number; taxa: number }>;
  for (const etapa of ETAPAS) {
    const [errosStr, totalStr] = await Promise.all([
      cli.get(chaveEtapa(etapa, 'erros')),
      cli.get(chaveEtapa(etapa, 'total')),
    ]);
    const erros = Number(errosStr) || 0;
    const total = Number(totalStr) || 0;
    resultado[etapa] = { erros, total, taxa: total > 0 ? erros / total : 0 };
  }
  return resultado;
}

async function errosDiaLerRedis(): Promise<number> {
  const valor = await garantirCliente().get(chaveDiaHoje());
  return Number(valor) || 0;
}

function chave429(): string {
  return `${PREFIXO_429}${bucketJanela(METRICAS_429_JANELA_MS)}`;
}

async function registrar429Redis(): Promise<void> {
  const chave = chave429();
  const cli = garantirCliente();
  await cli.incr(chave);
  await cli.pexpire(chave, METRICAS_429_JANELA_MS * 2);
  await incrementarSerieRedis('429'); // F1 — serie duravel
}

async function contagem429Redis(): Promise<number> {
  const valor = await garantirCliente().get(chave429());
  return Number(valor) || 0;
}

// ===== F1 — serie diaria DURAVEL (Redis) — ver comentario da variante mem acima. =====

function chaveSerieRedis(metrica: string, data: string): string {
  return `${PREFIXO_SERIE}${metrica}:${data}`;
}

async function incrementarSerieRedis(metrica: string): Promise<void> {
  const cli = garantirCliente();
  const chave = chaveSerieRedis(metrica, diaHojeStr());
  await cli.incr(chave);
  await cli.pexpire(chave, METRICAS_SERIE_TTL_MS);
}

async function lerSerieDiariaRedis(metrica: string, dias: number): Promise<Array<{ data: string; contagem: number }>> {
  const cli = garantirCliente();
  const out: Array<{ data: string; contagem: number }> = [];
  for (const data of ultimosDias(dias)) {
    const valor = await cli.get(chaveSerieRedis(metrica, data));
    out.push({ data, contagem: Number(valor) || 0 });
  }
  return out;
}

// ===== Chamadas por device (por numero) — contador diario total/atendida/nao =====
// Alimenta a tabela "chamadas por numero" do painel. Mesma casca janelada
// (chave + data, PEXPIRE 48h) das outras metricas. deviceId = id do device
// Wavoip (o wavoip_device_id do operador). LGPD: NUNCA loga numero/token.

export type TipoChamadaDevice = 'total' | 'atendida' | 'nao';
export interface ContagemDeviceDia {
  total: number;
  atendidas: number;
  nao: number;
}

const PREFIXO_DEV = 'met:dev:'; // + deviceId + ':' + data + ':' + (total|atendida|nao)

const devMem = new Map<string, { data: string } & ContagemDeviceDia>();

function registrarChamadaDeviceMem(deviceId: string, tipo: TipoChamadaDevice): void {
  const hoje = diaOperacionalStr();
  let e = devMem.get(deviceId);
  if (!e || e.data !== hoje) {
    e = { data: hoje, total: 0, atendidas: 0, nao: 0 };
    devMem.set(deviceId, e);
  }
  if (tipo === 'total') e.total += 1;
  else if (tipo === 'atendida') e.atendidas += 1;
  else e.nao += 1;
}

function lerChamadasDevicesHojeMem(): Record<string, ContagemDeviceDia> {
  const hoje = diaOperacionalStr();
  const out: Record<string, ContagemDeviceDia> = {};
  for (const [id, e] of devMem) {
    if (e.data === hoje) out[id] = { total: e.total, atendidas: e.atendidas, nao: e.nao };
  }
  return out;
}

function chaveDev(deviceId: string, tipo: TipoChamadaDevice): string {
  return `${PREFIXO_DEV}${deviceId}:${diaOperacionalStr()}:${tipo}`;
}

async function registrarChamadaDeviceRedis(deviceId: string, tipo: TipoChamadaDevice): Promise<void> {
  const cli = garantirCliente();
  const chave = chaveDev(deviceId, tipo);
  await cli.incr(chave);
  await cli.pexpire(chave, DIA_TTL_MS);
}

async function lerChamadasDevicesHojeRedis(): Promise<Record<string, ContagemDeviceDia>> {
  const hoje = diaOperacionalStr();
  const cli = garantirCliente();
  const out: Record<string, ContagemDeviceDia> = {};
  let cursor = '0';
  const chaves: string[] = [];
  do {
    const [proximo, lote] = await cli.scan(cursor, 'MATCH', `${PREFIXO_DEV}*:${hoje}:*`, 'COUNT', 300);
    cursor = proximo;
    chaves.push(...lote);
  } while (cursor !== '0');
  for (const chave of chaves) {
    // met:dev:<deviceId>:<YYYY-MM-DD>:<tipo> — deviceId sem ':', data sem ':'
    const partes = chave.slice(PREFIXO_DEV.length).split(':'); // [deviceId, data, tipo]
    const deviceId = partes[0];
    const tipo = partes[2] as TipoChamadaDevice;
    if (!deviceId || !tipo) continue;
    const val = Number(await cli.get(chave)) || 0;
    const reg = out[deviceId] || (out[deviceId] = { total: 0, atendidas: 0, nao: 0 });
    if (tipo === 'total') reg.total = val;
    else if (tipo === 'atendida') reg.atendidas = val;
    else if (tipo === 'nao') reg.nao = val;
  }
  return out;
}

// ===== Superficie publica — despacha para o backend escolhido no boot, NUNCA lanca =====

/**
 * Marca o operador como visto agora (janela METRICAS_PRESENCA_TTL_MS decide
 * se ainda conta como "online" em lerMetricas()). Sincrona pro chamador — em
 * modo Redis dispara a escrita em background (fire-and-forget), nunca segura
 * quem chamou; qualquer falha so loga, NUNCA lanca/rejeita sem catch.
 */
export function registrarPresenca(operadorId: string): void {
  try {
    if (MODO === 'redis') {
      registrarPresencaRedis(operadorId).catch((e) => {
        console.error(
          '[metricas] falha ao registrar presenca (degradando p/ no-op):',
          e instanceof Error ? e.message : String(e),
        );
      });
    } else {
      registrarPresencaMem(operadorId);
    }
  } catch (e) {
    console.error(
      '[metricas] falha ao registrar presenca (degradando p/ no-op):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Incrementa erro + total da etapa (janela METRICAS_ERRO_JANELA_MS) e o contador diario. NUNCA lanca. */
export function registrarErroEtapa(etapa: EtapaMetrica): void {
  try {
    if (MODO === 'redis') {
      registrarErroEtapaRedis(etapa).catch((e) => {
        console.error(
          '[metricas] falha ao registrar erro de etapa (degradando p/ no-op):',
          e instanceof Error ? e.message : String(e),
        );
      });
    } else {
      registrarErroEtapaMem(etapa);
    }
  } catch (e) {
    console.error(
      '[metricas] falha ao registrar erro de etapa (degradando p/ no-op):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Incrementa so o total da etapa (janela METRICAS_ERRO_JANELA_MS) — sucesso nao conta como erro nem alimenta errosDia. NUNCA lanca. */
export function registrarSucessoEtapa(etapa: EtapaMetrica): void {
  try {
    if (MODO === 'redis') {
      registrarSucessoEtapaRedis(etapa).catch((e) => {
        console.error(
          '[metricas] falha ao registrar sucesso de etapa (degradando p/ no-op):',
          e instanceof Error ? e.message : String(e),
        );
      });
    } else {
      registrarSucessoEtapaMem(etapa);
    }
  } catch (e) {
    console.error(
      '[metricas] falha ao registrar sucesso de etapa (degradando p/ no-op):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Incrementa a contagem de 429 do ClickUp na janela METRICAS_429_JANELA_MS. NUNCA lanca. */
export function registrar429ClickUp(): void {
  try {
    if (MODO === 'redis') {
      registrar429Redis().catch((e) => {
        console.error('[metricas] falha ao registrar 429 (degradando p/ no-op):', e instanceof Error ? e.message : String(e));
      });
    } else {
      registrar429Mem();
    }
  } catch (e) {
    console.error('[metricas] falha ao registrar 429 (degradando p/ no-op):', e instanceof Error ? e.message : String(e));
  }
}

/** Conta uma chamada do device (por numero) no dia — total/atendida/nao. NUNCA lanca. */
export function registrarChamadaDevice(deviceId: string, tipo: TipoChamadaDevice): void {
  if (!deviceId) return;
  try {
    if (MODO === 'redis') {
      registrarChamadaDeviceRedis(deviceId, tipo).catch((e) => {
        console.error('[metricas] falha ao contar chamada de device (degradando p/ no-op):', e instanceof Error ? e.message : String(e));
      });
    } else {
      registrarChamadaDeviceMem(deviceId, tipo);
    }
  } catch (e) {
    console.error('[metricas] falha ao contar chamada de device (degradando p/ no-op):', e instanceof Error ? e.message : String(e));
  }
}

/** Contagem de chamadas de hoje por deviceId. Degrada p/ {} em falha. NUNCA lanca. */
export async function lerChamadasDevicesHoje(): Promise<Record<string, ContagemDeviceDia>> {
  try {
    return MODO === 'redis' ? await lerChamadasDevicesHojeRedis() : lerChamadasDevicesHojeMem();
  } catch (e) {
    console.error('[metricas] falha ao ler chamadas por device (degradando p/ vazio):', e instanceof Error ? e.message : String(e));
    return {};
  }
}

/**
 * F1 — leitor OPCIONAL da serie diaria duravel (retencao METRICAS_SERIE_TTL_MS,
 * 90 dias por default). `metrica` e um rotulo (`'erro:webhook'`, `'sucesso:sync'`,
 * `'429'`, etc — os mesmos usados internamente por registrarErroEtapa/
 * registrarSucessoEtapa/registrar429ClickUp). Write-side p/ investigacao
 * pos-incidente — NAO alimenta o painel (lerMetricas/avaliarThresholds seguem
 * os contadores janelados de sempre, inalterados). Degrada p/ [] em falha,
 * NUNCA lanca.
 */
export async function lerSerieDiaria(
  metrica: string,
  dias = 7,
): Promise<Array<{ data: string; contagem: number }>> {
  try {
    return MODO === 'redis' ? await lerSerieDiariaRedis(metrica, dias) : lerSerieDiariaMem(metrica, dias);
  } catch (e) {
    console.error('[metricas] falha ao ler serie diaria (degradando p/ vazio):', e instanceof Error ? e.message : String(e));
    return [];
  }
}

// ===== Operação ao vivo (Fase 2): LISTAR quem está online + quem está EM CHAMADA =====
//
// "online" reutiliza a presença (met:presenca:<usuario>) — agora alimentada por
// um heartbeat do discador, não só por login/ligando/desfecho. "em chamada" é um
// estado POR OPERADOR (met:chamada:<usuario>), marcado no /ligando e limpo no
// /desfecho, com TTL de teto (some sozinho se o desfecho falhar). LGPD: chaveado
// por USUÁRIO, nunca por telefone/CPF.

const PREFIXO_CHAMADA = 'met:chamada:'; // + usuario (operador em chamada agora)
const EM_CHAMADA_TTL_MS = 15 * 60 * 1000; // teto de uma chamada; auto-limpa se faltar o desfecho
const emChamadaMem = new Map<string, number>(); // usuario -> ts (memoria)

function listarAtendentesOnlineMem(): string[] {
  podarPresencaMem();
  return Array.from(presencaMem.keys());
}
async function listarAtendentesOnlineRedis(): Promise<string[]> {
  let cursor = '0';
  const out: string[] = [];
  do {
    const [proximo, chaves] = await garantirCliente().scan(cursor, 'MATCH', PREFIXO_PRESENCA + '*', 'COUNT', 200);
    cursor = proximo;
    for (const k of chaves) out.push(k.slice(PREFIXO_PRESENCA.length));
  } while (cursor !== '0');
  return out;
}

function podarEmChamadaMem(): void {
  const agora = Date.now();
  for (const [k, ts] of emChamadaMem) {
    if (agora - ts > EM_CHAMADA_TTL_MS) emChamadaMem.delete(k);
  }
}
async function marcarEmChamadaRedis(usuario: string): Promise<void> {
  await garantirCliente().set(PREFIXO_CHAMADA + usuario, '1', 'PX', EM_CHAMADA_TTL_MS);
}
async function limparEmChamadaRedis(usuario: string): Promise<void> {
  await garantirCliente().del(PREFIXO_CHAMADA + usuario);
}
async function listarEmChamadaRedis(): Promise<string[]> {
  let cursor = '0';
  const out: string[] = [];
  do {
    const [proximo, chaves] = await garantirCliente().scan(cursor, 'MATCH', PREFIXO_CHAMADA + '*', 'COUNT', 200);
    cursor = proximo;
    for (const k of chaves) out.push(k.slice(PREFIXO_CHAMADA.length));
  } while (cursor !== '0');
  return out;
}

/** Marca o operador como EM CHAMADA agora (no /ligando). NUNCA lança. */
export function marcarEmChamada(usuario: string): void {
  if (!usuario) return;
  try {
    if (MODO === 'redis') {
      marcarEmChamadaRedis(usuario).catch((e) => console.error('[metricas] marcarEmChamada (ignorado):', e instanceof Error ? e.message : String(e)));
    } else {
      emChamadaMem.set(usuario, Date.now());
    }
  } catch (e) {
    console.error('[metricas] marcarEmChamada (ignorado):', e instanceof Error ? e.message : String(e));
  }
}

/** Limpa o EM CHAMADA do operador (no /desfecho). NUNCA lança. */
export function limparEmChamada(usuario: string): void {
  if (!usuario) return;
  try {
    if (MODO === 'redis') {
      limparEmChamadaRedis(usuario).catch((e) => console.error('[metricas] limparEmChamada (ignorado):', e instanceof Error ? e.message : String(e)));
    } else {
      emChamadaMem.delete(usuario);
    }
  } catch (e) {
    console.error('[metricas] limparEmChamada (ignorado):', e instanceof Error ? e.message : String(e));
  }
}

/** Remove a presença do operador AGORA (logout explícito) — não espera o TTL de 120s. NUNCA lança. */
export function limparPresenca(usuario: string): void {
  if (!usuario) return;
  try {
    if (MODO === 'redis') {
      garantirCliente()
        .del(PREFIXO_PRESENCA + usuario)
        .catch((e) => console.error('[metricas] limparPresenca (ignorado):', e instanceof Error ? e.message : String(e)));
    } else {
      presencaMem.delete(usuario);
    }
  } catch (e) {
    console.error('[metricas] limparPresenca (ignorado):', e instanceof Error ? e.message : String(e));
  }
}

/** Usuários online agora (presença). Degrada p/ [] em falha. NUNCA lança. */
export async function listarAtendentesOnline(): Promise<string[]> {
  try {
    return MODO === 'redis' ? await listarAtendentesOnlineRedis() : listarAtendentesOnlineMem();
  } catch (e) {
    console.error('[metricas] listarAtendentesOnline (degrada p/ []):', e instanceof Error ? e.message : String(e));
    return [];
  }
}

/** Usuários em chamada agora. Degrada p/ [] em falha. NUNCA lança. */
export async function listarEmChamada(): Promise<string[]> {
  try {
    return MODO === 'redis' ? await listarEmChamadaRedis() : (podarEmChamadaMem(), Array.from(emChamadaMem.keys()));
  } catch (e) {
    console.error('[metricas] listarEmChamada (degrada p/ []):', e instanceof Error ? e.message : String(e));
    return [];
  }
}

async function lerAtendentesOnline(): Promise<number> {
  try {
    return MODO === 'redis' ? await atendentesOnlineRedis() : atendentesOnlineMem();
  } catch (e) {
    console.error('[metricas] falha ao ler atendentes online (degradando p/ 0):', e instanceof Error ? e.message : String(e));
    return 0;
  }
}

async function lerErrosDia(): Promise<number> {
  try {
    return MODO === 'redis' ? await errosDiaLerRedis() : errosDiaLerMem();
  } catch (e) {
    console.error('[metricas] falha ao ler erros do dia (degradando p/ 0):', e instanceof Error ? e.message : String(e));
    return 0;
  }
}

async function lerTaxaErroPorEtapa(): Promise<Record<EtapaMetrica, { erros: number; total: number; taxa: number }>> {
  try {
    return MODO === 'redis' ? await taxaErroPorEtapaRedis() : taxaErroPorEtapaMem();
  } catch (e) {
    console.error(
      '[metricas] falha ao ler taxa de erro por etapa (degradando p/ zerado):',
      e instanceof Error ? e.message : String(e),
    );
    const zerado = {} as Record<EtapaMetrica, { erros: number; total: number; taxa: number }>;
    for (const etapa of ETAPAS) zerado[etapa] = { erros: 0, total: 0, taxa: 0 };
    return zerado;
  }
}

async function lerContagem429(): Promise<number> {
  try {
    return MODO === 'redis' ? await contagem429Redis() : contagem429Mem();
  } catch (e) {
    console.error('[metricas] falha ao ler contagem de 429 (degradando p/ 0):', e instanceof Error ? e.message : String(e));
    return 0;
  }
}

/**
 * Monta o snapshot completo consumido pelo painel (10-05) e pelos alertas
 * (10-04). Cada campo degrada para o valor neutro (0) SE a fonte falhar —
 * uma fonte fora do ar nunca derruba o snapshot inteiro nem trava o
 * chamador (T-10-02-D1). Resolve todas as fontes em paralelo; NUNCA rejeita.
 */
export async function lerMetricas(): Promise<MetricasSnapshot> {
  const [atendentesOnline, chamadasAtivas, profFila, errosDia, taxaErroPorEtapa, contagem429] = await Promise.all([
    lerAtendentesOnline(),
    contarChamadasAtivas().catch((e) => {
      console.error(
        '[metricas] falha ao ler chamadas ativas (degradando p/ 0):',
        e instanceof Error ? e.message : String(e),
      );
      return 0;
    }),
    profundidadeFila().catch((e) => {
      console.error(
        '[metricas] falha ao ler profundidade da fila (degradando p/ 0):',
        e instanceof Error ? e.message : String(e),
      );
      return 0;
    }),
    lerErrosDia(),
    lerTaxaErroPorEtapa(),
    lerContagem429(),
  ]);
  return {
    atendentesOnline,
    chamadasAtivas,
    profundidadeFila: profFila,
    errosDia,
    taxaErroPorEtapa,
    contagem429,
  };
}

/** 'redis' ou 'memoria' — usado pelo smoke e pelo log de boot. */
export function modoMetricas(): 'redis' | 'memoria' {
  return MODO;
}

/** Fecha o cliente Redis (graceful shutdown) — no-op em modo memoria. */
export async function fecharMetricas(): Promise<void> {
  if (cliente) {
    await cliente.quit();
    cliente = null;
  }
}

console.log(
  MODO === 'redis'
    ? '[metricas] coleta/leitura de metricas via Redis (compartilhado)'
    : '[metricas] coleta/leitura de metricas em memoria (1 instancia)',
);
