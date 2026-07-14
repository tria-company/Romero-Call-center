// HARD-07 (Fase 5, plano 05-04): FALLBACK EM CASCATA quando o LLM primario
// (Camila, GPT-5.1) falha — em vez de silenciar (comportamento anterior:
// catch generico em index.ts = silencio pro lead + alerta ao suporte), o
// sistema tenta em cascata: (1) LLM secundario -> (2) cache de fallback
// (ultima resposta boa do PROPRIO lead) -> (3) resposta segura.
//
// ============================================================================
// NUANCE CRITICA DO SDR (nao remover sem revisao — ver arquitetura-referencia
// linha 46-48 + comentario 413-418 de index.ts, "Teste 4"/ClickUp 868jjn1f4):
//
//   A "resposta segura" final deste modulo e SEMPRE HANDOFF HUMANO
//   (escalate_to_human), NUNCA uma frase automatica/canned repetida ao
//   lead. Uma mensagem de erro visivel ("tive um problema, pode reenviar?")
//   vira LOOP quando o erro persiste turno apos turno — foi exatamente esse
//   bug removido na virada do ex-bot Closer (6 de 9 cenarios reprovados no
//   Teste 4 tinham esse loop). O fim de linha do fallback e um HUMANO assumindo, nunca um
//   robo repetindo.
//
//   Consequencia direta: cada nivel da cascata roda no MAXIMO 1x por
//   chamada. resolverFallback NUNCA se re-chama nem repete a mesma resposta
//   — se todos os niveis falharem, cai direto no handoff (fail-safe).
// ============================================================================
//
// CRISE: se o turno e de crise (ctx.crise === true), a cascata vai DIRETO
// pro handoff — nao gasta uma tentativa de LLM secundario (nem de cache)
// que atrasaria a escalacao de um lead em sofrimento agudo. Mesmo espirito
// de fila.ts (HARD-03) e resiliencia.ts (HARD-05, bypass {crise:true}):
// crise tem caminho direto e prioritario, sempre.
//
// ISOLAMENTO POR LEAD: o cache de fallback (cacheBuscar) e SEMPRE consultado
// com o `lead` do PROPRIO processo — nunca serve resposta de outro lead
// (reusa a fronteira de particao por lead ja provada pelo cache semantico do
// 05-02, CacheSemantico.buscar).
//
// SCHEMA/GUARDRAILS: a saida do LLM secundario e tao nao-confiavel quanto a
// do primario — passa pelo MESMO parse (parseSaidaCamila, camila-schema.ts)
// antes de ser aceita como nivel 'secundario'. Uma saida de fallback NUNCA
// contorna o contrato JSON estrito da Camila.
//
// Modulo com dependencias 100% INJETAVEIS (secundario/cacheBuscar/
// montarHandoff entram por parametro) — smoke-avel sem rede/credenciais,
// mesmo padrao de fila.ts/resiliencia.ts/cache-semantico.ts. So importa
// camila-schema.ts (modulo puro, sem azure/config) pra reusar o MESMO parse
// — zero import de azure/config/index no topo, zero dependencia npm nova.

import { parseSaidaCamila } from './camila-schema.ts';

/** Nivel da cascata que efetivamente respondeu por este turno. */
export type TipoFallback = 'secundario' | 'cache' | 'handoff';

export interface ResultadoFallback {
  tipo: TipoFallback;
  /** Texto no shape JSON estrito da Camila — re-passa pelo MESMO dispatcher
   * (despacharSaidaCamila) de validacao/envio, igual a saida do primario. */
  saida: string;
}

export interface ContextoFallback {
  /** Telefone do lead (chave de isolamento do cache — nunca outro identificador). */
  lead: string;
  /** Texto do turno atual (o que o lead disse), usado pelo secundario/cache. */
  texto: string;
  /** true quando este turno e de CRISE (lexico de sofrimento agudo / lead ja
   * em bloqueio duravel) — pula secundario/cache e vai DIRETO pro handoff. */
  crise?: boolean;
  /** Chama o LLM secundario com o MESMO contrato de saida JSON da Camila.
   * Retorna o texto bruto (ainda nao validado) ou null/lanca em falha. */
  secundario: (texto: string) => Promise<string | null>;
  /** Busca a ultima resposta boa cacheada do PROPRIO lead (reuso do cache
   * semantico do 05-02 — CacheSemantico.buscar). null/undefined = miss. */
  cacheBuscar: (lead: string, texto: string) => Promise<string | null | undefined>;
  /** Monta a saida SEGURA (handoff humano) no shape valido da Camila. */
  montarHandoff: (lead: string) => string;
}

/**
 * Orquestra a cascata de fallback SEM LOOP: secundario -> cache -> handoff.
 * Cada nivel e tentado no MAXIMO 1x; a funcao nunca se re-chama nem repete a
 * mesma resposta automatica. Crise pula direto pro handoff (T-05-04-04).
 */
export async function resolverFallback(ctx: ContextoFallback): Promise<ResultadoFallback> {
  const { lead, texto, crise, secundario, cacheBuscar, montarHandoff } = ctx;

  // 1) CRISE: caminho direto, sem gastar tentativa de secundario/cache que
  // atrasaria a escalacao (T-05-04-04 — DoS de seguranca inaceitavel).
  if (crise) {
    return { tipo: 'handoff', saida: montarHandoff(lead) };
  }

  // 2) LLM secundario — UMA tentativa. A saida so e aceita se PARSEIA pelo
  // MESMO schema estrito da Camila (T-05-04-02: secundario nunca contorna
  // schema/guardrails). Qualquer excecao do secundario e tratada como falha
  // deste nivel (cai pro proximo), nunca propaga/derruba o turno.
  try {
    const saidaSecundario = await secundario(texto);
    if (saidaSecundario) {
      const parse = parseSaidaCamila(saidaSecundario);
      if (parse.ok) {
        return { tipo: 'secundario', saida: saidaSecundario };
      }
      console.warn('[fallback] secundario retornou JSON invalido — schema:', parse.erro);
    }
  } catch (e) {
    console.error('[fallback] secundario falhou:', (e as Error)?.message || e);
  }

  // 3) Cache de fallback — UMA tentativa, SEMPRE isolado por `lead`
  // (T-05-04-03: nunca serve resposta de outro lead).
  try {
    const cacheHit = await cacheBuscar(lead, texto);
    if (cacheHit) {
      return { tipo: 'cache', saida: cacheHit };
    }
  } catch (e) {
    console.error('[fallback] cacheBuscar falhou:', (e as Error)?.message || e);
  }

  // 4) Resposta segura final = HANDOFF HUMANO (nunca canned/texto livre
  // repetido — T-05-04-01, a licao do Teste 4).
  return { tipo: 'handoff', saida: montarHandoff(lead) };
}

/**
 * CR-02 (review Fase 5): mensagem de crise do Safety Envelope item 13a
 * (agents/camila.ts, CAM-05) — texto REUSADO verbatim do protocolo de
 * sofrimento agudo do system prompt (nao inventado aqui). Quando o LLM esta
 * indisponivel e o turno e de CRISE, o lead NUNCA pode receber silencio no
 * lugar da mensagem CVV-188 mandada pelo protocolo.
 */
export const MENSAGEM_CVV_188 =
  'Preciso te dizer uma coisa: o que voce escreveu me deixou preocupada. Se voce ta num momento de crise, o CVV atende 24h no 188 e no cvv.org.br — e anonimo e gratuito. Vou pausar nossa conversa aqui e um humano da AUTON vai te procurar em breve. Voce ta segura agora?';

/**
 * Helper padrao de `montarHandoff`: produz uma saida VALIDA no shape da
 * Camila que DECLARA escalate_to_human em vez de texto canned.
 *
 * CR-02 (review Fase 5): o handoff e SENSIVEL A CRISE. Com `crise=false`
 * (falha tecnica comum): motivo 'falha_tecnica', mensagens[] vazio de
 * proposito (`acao:'escalar'` nao exige mensagens — camila-schema.ts,
 * ACOES_QUE_EXIGEM_MENSAGEM so cobre 'responder'; o objetivo e um humano
 * assumir, nao um robo repetir frase). Com `crise=true`: motivo
 * 'sofrimento_agudo' (acionarHumanoGarantido em escalate-to-human.ts marca a
 * task URGENTE com "protocolo CVV 188 / contato IMEDIATO" SO quando o motivo
 * e sofrimento_agudo), sinal_alerta 'sofrimento_agudo' e a mensagem CVV-188
 * do Safety Envelope item 13 em mensagens[] — um lead em sofrimento agudo
 * nunca recebe silencio so porque o LLM caiu.
 *
 * `telefone` em args e so um placeholder informativo: o dispatcher real
 * (despacharSaidaCamila, index.ts) SEMPRE sobrescreve args.telefone com o
 * numero confiavel do processo antes de executar a tool.
 */
export function montarHandoffPadrao(lead: string, crise = false): string {
  return JSON.stringify({
    acao: 'escalar',
    mensagens: crise ? [MENSAGEM_CVV_188] : [],
    proximo_estado: 'PAUSADO_HUMANO',
    tools_a_executar: [
      {
        tool: 'escalate_to_human',
        args: {
          telefone: lead,
          motivo: crise ? 'sofrimento_agudo' : 'falha_tecnica',
          resumo: crise
            ? 'CRISE detectada com LLM indisponivel (fallback em cascata) — protocolo CVV 188, contato humano IMEDIATO necessario.'
            : 'Fallback em cascata esgotado (LLM secundario indisponivel/invalido e cache sem hit) — atender manualmente.',
        },
      },
    ],
    sinal_alerta: crise ? 'sofrimento_agudo' : null,
    log_interno: crise
      ? 'fallback HARD-07: turno de CRISE com LLM indisponivel — handoff crise-aware (CVV 188, sofrimento_agudo)'
      : 'fallback HARD-07: cascata esgotada, handoff humano acionado (nunca canned)',
  });
}
