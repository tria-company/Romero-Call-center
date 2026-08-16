// Mapa operador do discador <-> assignee ClickUp (Fase 02 Plano 02, D-P2-06
// sub-ponto). Desde a Fase 11 (D-02) a fonte primária é o snapshot em memória
// de `discador_usuarios` (Postgres) — `assigneeDoOperador`/
// `mapaOperadorParaAssignee` leem `clickup_member_id` do snapshot. O mapa
// `DISCADOR_ASSIGNEES` do env vira fallback SOMENTE de degradação (snapshot
// vazio — store não aquecido ainda/indisponível): não é uma segunda fonte
// viva, o store é a fonte de verdade quando aquecido.
//
// Importa `snapshotUsuarios` de `./usuarios.ts` (extensão `.ts` explícita —
// mantém importável por `node --experimental-strip-types` a partir dos
// scripts de smoke/runner, mesmo padrão do resto do módulo).
//
// DISCADOR_ASSIGNEES: "usuario1:memberId1,usuario2:memberId2" (ex:
// "admin:88123456"). O memberId vem de ClickUp -> Settings -> Members (ou
// GET /team).

import { snapshotUsuarios } from './usuarios.ts';

/**
 * Papel do operador (`'gestor' | 'atendente' | null`) a partir do snapshot em
 * memória de `discador_usuarios` (D-02), ou `null` se não encontrado — molde de
 * `assigneeDoOperador` (lê o mesmo snapshot). Usado pelo gate de leitura da
 * Lista 01 LEADS (quick 260815-r12): só gestor vê a visão total do lead. A conta
 * de serviço do mobile (admin) é gestor no seed (D-06). NUNCA loga PII.
 */
export function papelDoOperador(usuario: string): 'gestor' | 'atendente' | null {
  const u = (usuario || '').trim().toLowerCase();
  return snapshotUsuarios().get(u)?.papel ?? null;
}

function carregarAssignees(): Map<string, string> {
  const raw = process.env.DISCADOR_ASSIGNEES || '';
  const m = new Map<string, string>();
  for (const par of raw.split(',')) {
    const i = par.indexOf(':');
    if (i === -1) continue;
    const usuario = par.slice(0, i).trim().toLowerCase();
    const memberId = par.slice(i + 1).trim();
    if (usuario && memberId) m.set(usuario, memberId);
  }
  return m;
}

// Mantido só como fallback de degradação (ver nota acima) — carregado 1x no
// boot, igual antes da Fase 11.
const ASSIGNEES = carregarAssignees();

if (!process.env.DISCADOR_ASSIGNEES && snapshotUsuarios().size === 0) {
  console.warn(
    '[operadores] DISCADOR_ASSIGNEES vazio e snapshot do store ainda nao aquecido: a skill ' +
      'gerar-lote-diario pode nao conseguir atribuir Ligacoes a nenhum operador do ClickUp ' +
      'ate o boot rodar recarregarUsuarios(). Configure clickup_member_id em discador_usuarios ' +
      '(ou DISCADOR_ASSIGNEES "usuario:memberId,..." como fallback).',
  );
}

/**
 * Retorna o mapa usuário-do-discador -> memberId-do-ClickUp. Fonte primária:
 * snapshot do store (D-02); fallback de degradação pro mapa `DISCADOR_ASSIGNEES`
 * do env SOMENTE quando o snapshot está vazio.
 */
export function mapaOperadorParaAssignee(): Map<string, string> {
  const snap = snapshotUsuarios();
  if (snap.size === 0) return new Map(ASSIGNEES);
  const m = new Map<string, string>();
  for (const [usuario, reg] of snap) {
    if (reg.clickup_member_id) m.set(usuario, reg.clickup_member_id);
  }
  return m;
}

/**
 * Resolve o memberId do ClickUp para um usuário do discador, ou `null` se não
 * mapeado. Fonte primária: snapshot do store (D-02) — `clickup_member_id` do
 * registro do usuário. Fallback SOMENTE de degradação (snapshot vazio) pro
 * mapa `DISCADOR_ASSIGNEES` do env — não é uma segunda fonte viva, o store é
 * a fonte de verdade quando aquecido.
 */
export function assigneeDoOperador(usuario: string): string | null {
  const u = (usuario || '').trim().toLowerCase();
  const snap = snapshotUsuarios();
  if (snap.size > 0) {
    return snap.get(u)?.clickup_member_id ?? null;
  }
  return ASSIGNEES.get(u) ?? null;
}
