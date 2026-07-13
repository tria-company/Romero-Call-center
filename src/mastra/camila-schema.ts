// Schema JSON estrito da saida da Camila (SDR AUTON) + parse seguro.
//
// Fonte: playbook SDR AUTON v1.0 Sec.16 Sec.8 (Output Schema). Os nomes de
// campo aqui (mensagens, delay_ms, tools_a_executar[].args) sao os
// CANONICOS pro codigo (01-05-PLAN.md Task 1) — o texto do system prompt da
// Camila (agents/camila.ts, Task 2) foi harmonizado pra descrever exatamente
// esses nomes, mesmo que o doc fonte docs/persona-camila.md Sec.8 use nomes
// levemente diferentes (delay_antes_seg/delay_entre_fragmentos_seg,
// tools_a_executar[].params). Ver nota de deviation no SUMMARY da 01-05.
//
// T-05-JSON (threat model da 01-05-PLAN.md): parseSaidaCamila NUNCA retorna
// `ok:true` com dado invalido — falha de parse ou de schema sempre vira
// `ok:false`, e quem chama (index.ts) decide o fallback seguro (nunca manda
// lixo pro lead).

import { z } from 'zod';

// Allowlist de tools que a Camila pode DECLARAR em tools_a_executar. So
// serve pra validar o JSON de saida — a Camila NAO executa tool nenhuma
// nativamente (contrato travado em 01-CONTEXT.md: o dispatcher em index.ts
// e o UNICO executor, evita dupla execucao/double-booking).
//
// create_calendar_event entra no enum porque faz parte do allowlist do
// playbook, mas o dispatcher (01-05 Task 3) ainda NAO tem handler pra ele —
// a tool de calendario e a 01-07. Se a Camila declarar essa tool antes da
// 01-07, o dispatcher loga e ignora (nao quebra o resto do despacho).
export const CAMILA_TOOL_ALLOWLIST = [
  'read_lead_ficha',
  'read_conversation_history',
  'send_whatsapp_message',
  'update_contact_field',
  'move_pipeline_stage',
  'create_task',
  'create_calendar_event',
  'escalate_to_human',
  'log_note',
] as const;

export const CamilaToolIdSchema = z.enum(CAMILA_TOOL_ALLOWLIST);
export type CamilaToolId = z.infer<typeof CamilaToolIdSchema>;

// Estados do funil SPIN (playbook Sec.16 Sec.7). Usa as LETRAS soltas
// (S/P/I/N) pro meio do SPIN — mesma convencao ja gravada pelo Qualificador
// em spin_stage (01-04: "grave spin_stage=I"), pra nao divergir do valor
// que ja vai pro custom field do GHL. ENCERRADO tambem e aceito (valor que
// o Qualificador grava quando PERDIDO) alem de ENCERRADO_GANHO/PERDIDO
// (estados finais que a propria Camila pode declarar).
export const SPIN_STATES = [
  'AGUARDANDO_QUALIFICACAO',
  'S',
  'P',
  'I',
  'N',
  'CONVITE_CALL',
  'AGENDANDO',
  'AGUARDANDO_CALL',
  'LEMBRETE_D1',
  'LEMBRETE_H1',
  'LEMBRETE_5MIN',
  'LOOP_NO_SHOW',
  'PAUSADO_HUMANO',
  'ENCERRADO',
  'ENCERRADO_GANHO',
  'ENCERRADO_PERDIDO',
] as const;

export const ProximoEstadoSchema = z.enum(SPIN_STATES);
export type ProximoEstado = z.infer<typeof ProximoEstadoSchema>;

// sinal_alerta: valores fechados do playbook Sec.16 Sec.8. null = sem alerta.
export const SinalAlertaSchema = z
  .enum(['injection_attempt', 'sofrimento_agudo', 'lexico_lead_proibido', 'ambiguidade'])
  .nullable()
  .optional();

// Item de tools_a_executar[]. `args` (nao `params`) e o nome canonico pro
// codigo — ver nota no topo do arquivo.
export const ToolExecucaoSchema = z.object({
  tool: CamilaToolIdSchema,
  args: z.record(z.string(), z.unknown()).default({}),
});
export type ToolExecucao = z.infer<typeof ToolExecucaoSchema>;

export const AcaoSchema = z.enum(['responder', 'aguardar', 'escalar', 'avancar_estado', 'encerrar']);
export type Acao = z.infer<typeof AcaoSchema>;

// Acoes que OBRIGAM pelo menos 1 mensagem em mensagens[] — "acao envia"
// no <behavior> da 01-05-PLAN.md Task 1. `escalar` e `aguardar` podem nao
// mandar nada pro lead nesse turno (playbook Sec.16 Sec.8: "escalar -> inclui
// motivo_escalacao + urgencia, sem mensagens"; "aguardar -> inclui
// aguardar_ate_seg").
const ACOES_QUE_EXIGEM_MENSAGEM: ReadonlySet<Acao> = new Set(['responder']);

export const SaidaCamilaSchema = z
  .object({
    acao: AcaoSchema,
    mensagens: z.array(z.string().min(1)).default([]),
    delay_ms: z.array(z.number().int().nonnegative()).optional(),
    proximo_estado: ProximoEstadoSchema,
    tools_a_executar: z.array(ToolExecucaoSchema).default([]),
    sinal_alerta: SinalAlertaSchema,
    log_interno: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (ACOES_QUE_EXIGEM_MENSAGEM.has(data.acao) && data.mensagens.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: `acao="${data.acao}" exige pelo menos 1 item em mensagens[]`,
        path: ['mensagens'],
      });
    }
  });

export type SaidaCamila = z.infer<typeof SaidaCamilaSchema>;

export type ParseSaidaCamilaResultado =
  | { ok: true; data: SaidaCamila }
  | { ok: false; erro: string };

/**
 * Extrai o parse seguro do JSON estrito da Camila a partir do texto bruto
 * devolvido pelo LLM (resposta.text). NUNCA retorna `ok:true` com dado
 * invalido (T-05-JSON) — falha de extracao, JSON malformado ou schema
 * invalido sempre vira `ok:false, erro`. Quem chama decide o fallback
 * seguro (index.ts: nao envia nada ao lead + loga + notifica suporte).
 */
export function parseSaidaCamila(raw: string): ParseSaidaCamilaResultado {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, erro: 'saida vazia ou nao-string' };
  }

  const blocoJson = extrairBlocoJson(raw);
  if (!blocoJson) {
    return { ok: false, erro: 'nenhum bloco JSON encontrado na saida' };
  }

  let candidato: unknown;
  try {
    candidato = JSON.parse(blocoJson);
  } catch (e) {
    return { ok: false, erro: `JSON invalido: ${(e as Error).message}` };
  }

  const resultado = SaidaCamilaSchema.safeParse(candidato);
  if (!resultado.success) {
    const detalhe = resultado.error.issues
      .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('; ');
    return { ok: false, erro: `schema invalido: ${detalhe}` };
  }

  return { ok: true, data: resultado.data };
}

// Extrai o primeiro bloco {...} balanceado do texto. Modelos as vezes
// envolvem o JSON em cercas ```json ... ``` ou adicionam texto antes/depois
// apesar da instrucao de saida estrita — o parse e tolerante a isso, mas o
// zod continua validando o CONTEUDO com rigor total (nada de invalido passa
// como ok).
function extrairBlocoJson(raw: string): string | null {
  const semCercas = raw.replace(/```json/gi, '```').trim();
  const inicioCerca = semCercas.indexOf('```');
  let texto = semCercas;
  if (inicioCerca !== -1) {
    const fimCerca = semCercas.indexOf('```', inicioCerca + 3);
    if (fimCerca !== -1) {
      texto = semCercas.slice(inicioCerca + 3, fimCerca).trim();
    }
  }

  const primeiraChave = texto.indexOf('{');
  if (primeiraChave === -1) return null;

  let profundidade = 0;
  for (let i = primeiraChave; i < texto.length; i++) {
    const char = texto[i];
    if (char === '{') profundidade++;
    else if (char === '}') {
      profundidade--;
      if (profundidade === 0) {
        return texto.slice(primeiraChave, i + 1);
      }
    }
  }
  return null;
}
