// discador_usuarios — store persistente de operadores do discador (Fase 11, D-01/D-02).
//
// Camada de acesso via PostgREST (molde de supabase.ts) + snapshot em memória para leitura
// rápida sem I/O por request (molde lazy-singleton de dispositivos.ts) + migração-seed
// idempotente que importa os usuários hoje vividos em DISCADOR_USERS/DISCADOR_ASSIGNEES/
// WAVOIP_USER_DEVICES (D-02) — admin vira gestor (D-06), preservando o acesso de produção
// (USER-05).
//
// Este é o "system of record" novo dos operadores. Auth (11-03), resolução de
// assignee/device (11-03) e rotas admin (11-04) leem daqui.
//
// Contrato de erro (WR-03, molde de supabase.ts checarConfig()-then-throw): leituras de
// SEGURANÇA (buscarUsuario) LANÇAM em falha de config/rede/HTTP — fail-closed, nunca
// degradam para "credencial válida" (T-11-02-D1). `null` fica reservado a "não encontrado"
// legítimo.
//
// LGPD: NUNCA logar senha/senha_hash/senha_salt/token — só usuario/contagem/status.

import { createHash } from 'crypto';
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_TABLE_USUARIOS } from './config.ts';
import { fetchTimeout } from './http.ts';
import { hashSenhaScrypt } from './senha.ts';

export const SUPABASE_REST_URL = `${SUPABASE_URL}/rest/v1`;

function headers(): Record<string, string> {
  return {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

/** Lança erro claro de config ausente (WR-03) — nunca resolve vazio. */
function checarConfig(): void {
  if (!SUPABASE_URL) {
    throw new Error('[usuarios] SUPABASE_URL ausente — nao da para ler a base self-hosted');
  }
  if (!SUPABASE_SERVICE_KEY) {
    throw new Error('[usuarios] SUPABASE_SERVICE_KEY ausente — nao da para autenticar na base self-hosted');
  }
}

export interface RegistroUsuario {
  id: string;
  usuario: string;
  senha_hash: string;
  senha_salt: string | null;
  senha_algo: 'scrypt' | 'sha256-legado';
  papel: 'gestor' | 'atendente';
  clickup_member_id: string | null;
  wavoip_device_id: string | null;
  criado_em: string;
  atualizado_em: string | null;
}

export type UsuarioPublico = Omit<RegistroUsuario, 'senha_hash' | 'senha_salt' | 'senha_algo'>;

const SELECT_PUBLICO = 'id,usuario,papel,clickup_member_id,wavoip_device_id,criado_em';

/**
 * Leitura FRESCA (sem cache) por usuário — usada pelo login e pelo gate de gestor. Traz o
 * hash (select=*) porque quem chama precisa verificar a senha. LANÇA em falha de
 * config/rede/HTTP (WR-03, T-11-02-D1: fail-closed, nunca degrada para "credencial válida").
 * `null` = não encontrado (legítimo).
 */
export async function buscarUsuario(usuario: string): Promise<RegistroUsuario | null> {
  checarConfig();
  const u = (usuario || '').trim().toLowerCase();
  if (!u) return null;
  const params = new URLSearchParams({
    select: '*',
    usuario: `eq.${u}`,
    limit: '1',
  });
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_USUARIOS}?${params.toString()}`, {
      headers: headers(),
    });
  } catch (e) {
    throw new Error(`[usuarios] falha de rede ao buscar usuario: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[usuarios] GET /${SUPABASE_TABLE_USUARIOS} (buscarUsuario) falhou (${res.status})`);
  }
  const data = await res.json();
  const linhas: RegistroUsuario[] = Array.isArray(data) ? data : [];
  return linhas[0] ?? null;
}

/**
 * Lista todos os operadores para a tela de gestão do painel admin. Select SOMENTE de colunas
 * públicas — NUNCA inclui senha_hash/senha_salt/senha_algo (T-11-02-I1: o hash nunca sai
 * para o cliente).
 */
export async function listarUsuarios(): Promise<UsuarioPublico[]> {
  checarConfig();
  const params = new URLSearchParams({ select: SELECT_PUBLICO, order: 'usuario.asc' });
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_USUARIOS}?${params.toString()}`, {
      headers: headers(),
    });
  } catch (e) {
    throw new Error(`[usuarios] falha de rede ao listar usuarios: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[usuarios] GET /${SUPABASE_TABLE_USUARIOS} (listarUsuarios) falhou (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data) ? (data as UsuarioPublico[]) : [];
}

export interface DadosCriarUsuario {
  usuario: string;
  senha: string;
  papel: 'gestor' | 'atendente';
  clickup_member_id?: string | null;
  wavoip_device_id?: string | null;
}

/**
 * Cria um operador novo. Hasheia `dados.senha` via scrypt (D-08) — senha em claro nunca é
 * persistida/logada. `usuario` gravado lowercased.
 */
export async function criarUsuario(dados: DadosCriarUsuario): Promise<UsuarioPublico> {
  checarConfig();
  const { hash, salt } = hashSenhaScrypt(dados.senha);
  const corpo = [{
    usuario: (dados.usuario || '').trim().toLowerCase(),
    senha_hash: hash,
    senha_salt: salt,
    senha_algo: 'scrypt',
    papel: dados.papel,
    clickup_member_id: dados.clickup_member_id ?? null,
    wavoip_device_id: dados.wavoip_device_id ?? null,
  }];
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_USUARIOS}`, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'return=representation' },
      body: JSON.stringify(corpo),
    });
  } catch (e) {
    throw new Error(`[usuarios] falha de rede ao criar usuario: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[usuarios] POST /${SUPABASE_TABLE_USUARIOS} (criarUsuario) falhou (${res.status})`);
  }
  const linhas = (await res.json()) as RegistroUsuario[];
  const linha = linhas?.[0];
  if (!linha) {
    throw new Error('[usuarios] criarUsuario: resposta sem representacao da linha criada');
  }
  const { senha_hash: _h, senha_salt: _s, senha_algo: _a, ...publico } = linha;
  return publico;
}

/** Atualiza campos não sensíveis de um operador (papel/vínculos). */
export async function atualizarUsuario(
  id: string,
  campos: Partial<{ papel: 'gestor' | 'atendente'; clickup_member_id: string | null; wavoip_device_id: string | null }>,
): Promise<void> {
  checarConfig();
  const corpo: Record<string, unknown> = { ...campos, atualizado_em: new Date().toISOString() };
  let res: Response;
  try {
    res = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_USUARIOS}?id=eq.${encodeURIComponent(id)}`,
      { method: 'PATCH', headers: headers(), body: JSON.stringify(corpo) },
    );
  } catch (e) {
    throw new Error(`[usuarios] falha de rede ao atualizar usuario: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[usuarios] PATCH /${SUPABASE_TABLE_USUARIOS} (atualizarUsuario ${id}) falhou (${res.status})`);
  }
}

/**
 * Troca a senha de um operador (reset do gestor OU upgrade-on-login do 11-03). Hasheia via
 * scrypt (D-08) — senha em claro nunca é persistida/logada.
 */
export async function atualizarSenha(id: string, senha: string): Promise<void> {
  checarConfig();
  const { hash, salt } = hashSenhaScrypt(senha);
  const corpo = {
    senha_hash: hash,
    senha_salt: salt,
    senha_algo: 'scrypt',
    atualizado_em: new Date().toISOString(),
  };
  let res: Response;
  try {
    res = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_USUARIOS}?id=eq.${encodeURIComponent(id)}`,
      { method: 'PATCH', headers: headers(), body: JSON.stringify(corpo) },
    );
  } catch (e) {
    throw new Error(`[usuarios] falha de rede ao atualizar senha: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[usuarios] PATCH /${SUPABASE_TABLE_USUARIOS} (atualizarSenha ${id}) falhou (${res.status})`);
  }
}

/** Remove um operador. */
export async function removerUsuario(id: string): Promise<void> {
  checarConfig();
  let res: Response;
  try {
    res = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_USUARIOS}?id=eq.${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: headers() },
    );
  } catch (e) {
    throw new Error(`[usuarios] falha de rede ao remover usuario: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`[usuarios] DELETE /${SUPABASE_TABLE_USUARIOS} (removerUsuario ${id}) falhou (${res.status})`);
  }
}

// ===== Snapshot em memória (leitura rápida, NÃO-segurança) =====
//
// Molde lazy-singleton de dispositivos.ts: nenhum I/O no import (lazy), MODO decidido só
// quando recarregarUsuarios() é chamado (pelo boot/rota), e NUNCA lança — em erro loga e
// mantém o snapshot anterior. Este snapshot é para lookups rápidos (papel/assignee/device
// sem round-trip por request); a leitura de SEGURANÇA (login) usa buscarUsuario, sempre
// fresca.

let SNAPSHOT = new Map<string, RegistroUsuario>();

/**
 * Repopula o snapshot em memória a partir da tabela inteira. NUNCA lança — em erro (config
 * ausente/rede/HTTP) loga e mantém o snapshot anterior intacto (degradação graciosa, molde
 * "MODO decidido no boot, nunca lança" de dispositivos.ts).
 */
export async function recarregarUsuarios(): Promise<void> {
  try {
    checarConfig();
    const params = new URLSearchParams({ select: '*' });
    const res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_USUARIOS}?${params.toString()}`, {
      headers: headers(),
    });
    if (!res.ok) {
      throw new Error(`GET /${SUPABASE_TABLE_USUARIOS} (recarregarUsuarios) falhou (${res.status})`);
    }
    const data = await res.json();
    const linhas: RegistroUsuario[] = Array.isArray(data) ? data : [];
    const novo = new Map<string, RegistroUsuario>();
    for (const linha of linhas) {
      if (linha?.usuario) novo.set(linha.usuario.toLowerCase(), linha);
    }
    SNAPSHOT = novo;
    console.log(`[usuarios] snapshot recarregado: ${SNAPSHOT.size} usuario(s)`);
  } catch (e) {
    console.error(
      `[usuarios] falha ao recarregar snapshot (mantendo anterior, ${SNAPSHOT.size} usuario(s)):`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Cópia do snapshot em memória (usuario lowercased -> RegistroUsuario). */
export function snapshotUsuarios(): Map<string, RegistroUsuario> {
  return new Map(SNAPSHOT);
}

/** Papel do usuário a partir do snapshot em memória, ou null se não encontrado. */
export function papelDoUsuario(usuario: string): 'gestor' | 'atendente' | null {
  const u = (usuario || '').trim().toLowerCase();
  return SNAPSHOT.get(u)?.papel ?? null;
}

/**
 * Exclusividade device↔operador: `usuario` que já usa este `wavoip_device_id`,
 * ignorando `excetoId` (o próprio operador em edição). null se o device está
 * livre. Lê o snapshot em memória — a MESMA fonte que resolverConfigDoUsuario
 * usa pro roteamento — então a checagem é consistente com quem realmente liga.
 */
export function donoDoDevice(deviceId: string, excetoId?: string): string | null {
  const alvo = String(deviceId || '');
  if (!alvo) return null;
  for (const u of SNAPSHOT.values()) {
    if (u.wavoip_device_id && String(u.wavoip_device_id) === alvo && u.id !== excetoId) {
      return u.usuario;
    }
  }
  return null;
}

/** Device (wavoip_device_id) associado ao operador, do snapshot. null se sem vínculo. */
export function deviceIdDoUsuario(usuario: string): string | null {
  const u = (usuario || '').trim().toLowerCase();
  const dev = SNAPSHOT.get(u)?.wavoip_device_id;
  return dev ? String(dev) : null;
}

/** Mapa deviceId -> usuario dono (para a tabela "chamadas por numero" do painel). */
export function donosDevices(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const u of SNAPSHOT.values()) {
    if (u.wavoip_device_id) out[String(u.wavoip_device_id)] = u.usuario;
  }
  return out;
}

// ===== Migração-seed idempotente env→Postgres (D-02/D-06/USER-05) =====

export interface LinhaSeed {
  usuario: string;
  senha_hash: string;
  senha_salt: null;
  senha_algo: 'sha256-legado';
  papel: 'gestor' | 'atendente';
  clickup_member_id: string | null;
  wavoip_device_id: string | null;
}

/**
 * Parser do `usuario:valor` idêntico ao usado em operadores.ts/dispositivos.ts/
 * discador-auth.ts — usuario lowercased.
 */
function parsePares(raw: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const par of raw.split(',')) {
    const i = par.indexOf(':');
    if (i === -1) continue;
    const chave = par.slice(0, i).trim().toLowerCase();
    const valor = par.slice(i + 1).trim();
    if (chave && valor) m.set(chave, valor);
  }
  return m;
}

/**
 * PURA (sem I/O): monta as linhas do seed a partir dos 3 mapas env, casando pela chave
 * `usuario`. Para `rawUsers` vazio usa o MESMO default de discador-auth.ts
 * (`admin:sha256('admin')`) para NÃO trancar o admin de produção (USER-05).
 * `admin` -> papel 'gestor' (D-06); todos os demais -> 'atendente'.
 */
export function montarLinhasSeed(rawUsers: string, rawAssignees: string, rawDevices: string): LinhaSeed[] {
  const usuarios = parsePares(rawUsers || `admin:${sha256Legado('admin')}`);
  const assignees = parsePares(rawAssignees || '');
  const devices = parsePares(rawDevices || '');
  const linhas: LinhaSeed[] = [];
  for (const [usuario, hashHex] of usuarios) {
    linhas.push({
      usuario,
      senha_hash: hashHex,
      senha_salt: null,
      senha_algo: 'sha256-legado',
      papel: usuario === 'admin' ? 'gestor' : 'atendente',
      clickup_member_id: assignees.get(usuario) ?? null,
      wavoip_device_id: devices.get(usuario) ?? null,
    });
  }
  return linhas;
}

// sha256 hex local, idêntico ao de senha.ts/discador-auth.ts — o default do seed é o
// legado sha256, não scrypt (o admin importado é re-hasheado no upgrade-on-login do 11-03).
function sha256Legado(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Migração-seed idempotente: importa DISCADOR_USERS/DISCADOR_ASSIGNEES/WAVOIP_USER_DEVICES
 * para a tabela SÓ se ela estiver vazia (não reimporta, não duplica, não tranca o admin —
 * T-11-02-T1). Se SUPABASE não configurado, no-op com log (a tabela só existe em prod).
 * NUNCA lança — envolve tudo em try/catch (molde "nunca lança" do boot). NUNCA loga
 * senha/hash.
 */
export async function semearUsuariosSeVazio(): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.log('[usuarios] semearUsuariosSeVazio: Supabase nao configurado, seed pulado (no-op).');
    return;
  }
  try {
    const paramsCheck = new URLSearchParams({ select: 'id', limit: '1' });
    const resCheck = await fetchTimeout(
      `${SUPABASE_REST_URL}/${SUPABASE_TABLE_USUARIOS}?${paramsCheck.toString()}`,
      { headers: headers() },
    );
    if (!resCheck.ok) {
      throw new Error(`GET /${SUPABASE_TABLE_USUARIOS} (checagem seed) falhou (${resCheck.status})`);
    }
    const dataCheck = await resCheck.json();
    const jaTemLinha = Array.isArray(dataCheck) && dataCheck.length > 0;
    if (jaTemLinha) {
      console.log('[usuarios] semearUsuariosSeVazio: tabela ja populada, seed pulado (idempotente).');
      return;
    }
    const linhas = montarLinhasSeed(
      process.env.DISCADOR_USERS || '',
      process.env.DISCADOR_ASSIGNEES || '',
      process.env.WAVOIP_USER_DEVICES || '',
    );
    if (linhas.length === 0) {
      console.log('[usuarios] semearUsuariosSeVazio: nenhuma linha para importar.');
      return;
    }
    const resSeed = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_USUARIOS}`, {
      method: 'POST',
      headers: { ...headers(), 'Prefer': 'return=representation' },
      body: JSON.stringify(linhas),
    });
    if (!resSeed.ok) {
      throw new Error(`POST /${SUPABASE_TABLE_USUARIOS} (seed) falhou (${resSeed.status})`);
    }
    console.log(`[usuarios] semearUsuariosSeVazio: ${linhas.length} usuario(s) importado(s) do env.`);
  } catch (e) {
    console.error('[usuarios] falha no seed (nao-fatal, boot continua):', e instanceof Error ? e.message : String(e));
  }
}
