// Mapa operador do discador <-> assignee ClickUp (Fase 02 Plano 02, D-P2-06
// sub-ponto). O login do discador vive em `DISCADOR_USERS` (discador-auth.ts);
// o assignee de uma task do ClickUp é um member id numérico da workspace. A
// skill `gerar-lote-diario` precisa traduzir "usuário do discador" ->
// "memberId do ClickUp" para atribuir a Ligação ao operador certo (e o
// discador poder filtrar "minhas tasks" por esse mesmo assignee).
//
// MÓDULO SEM IMPORTS (nem relativos, nem de pacotes) — só `process.env` — para
// ser importável tanto pelo bundle Mastra quanto por
// `node --experimental-strip-types` a partir dos scripts de smoke/runner.
//
// DISCADOR_ASSIGNEES: "usuario1:memberId1,usuario2:memberId2" (ex:
// "admin:88123456"). O memberId vem de ClickUp -> Settings -> Members (ou
// GET /team). v1 é single-operator (D-P2-08 sub-ponto): normalmente só um par
// usuario:memberId é usado, via `LOTE_OPERADOR_DEFAULT`.

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

const ASSIGNEES = carregarAssignees();

if (!process.env.DISCADOR_ASSIGNEES) {
  console.warn(
    '[operadores] DISCADOR_ASSIGNEES vazio: a skill gerar-lote-diario nao consegue atribuir ' +
      'Ligacoes a nenhum operador do ClickUp. Configure "usuario:memberId,..." no .env ' +
      '(memberId em ClickUp -> Settings -> Members).',
  );
}

/** Retorna uma cópia do mapa usuário-do-discador -> memberId-do-ClickUp (DISCADOR_ASSIGNEES). */
export function mapaOperadorParaAssignee(): Map<string, string> {
  return new Map(ASSIGNEES);
}

/** Resolve o memberId do ClickUp para um usuário do discador, ou `null` se não mapeado. */
export function assigneeDoOperador(usuario: string): string | null {
  const u = (usuario || '').trim().toLowerCase();
  return ASSIGNEES.get(u) ?? null;
}
