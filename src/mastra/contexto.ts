// Lógica pura do Agente Contexto — consolidação do lead (OPER-05, Fase 03 Plano 04).
//
// MÓDULO PURO: sem imports (nem relativos, nem de pacotes) — precisa ser
// importável via `node --experimental-strip-types` a partir dos scripts de
// smoke/runner sem depender de resolução de módulo do bundler. Mapas de
// field-id (CAMPOS_LEADS) NÃO são usados aqui — a leitura/escrita por
// field-id é responsabilidade de clickup.ts (consolidarLead); este módulo só
// monta o prompt do LLM e calcula regras determinísticas sobre valores já
// normalizados (injetados pelo caller).
//
// Regras de negócio (D-P3-12/13/14/15, ver 03-CONTEXT.md):
// - OBSERVACAO_CONSOLIDADA é um resumo vivo: o Agente Contexto lê a
//   observação atual + o resultado da nova ligação e REESCREVE o resumo
//   consolidado (o que importa saber do lead hoje). Histórico detalhado fica
//   nas tasks de Ligação (Lista 02) — não é um histórico completo (D-P3-13).
// - PROXIMO_CONTATO: DATA_RETORNO (compromisso falado) sempre vence; sem
//   ela, regra fixa parametrizável — não atendeu → hoje + diasNaoAtendeu;
//   atendeu sem retorno combinado → hoje + diasDefault (D-P3-14).
// - Contadores mecânicos (QTD_TENTATIVAS sempre incrementa; QTD_ATENDIMENTOS
//   OU QTD_NAO_ATENDIMENTOS conforme ATENDEU; ULTIMO_CONTATO sempre atualiza;
//   ULTIMO_ATENDIMENTO só quando atendeu) — Claude's Discretion, 03-CONTEXT.md.
// - Opt-out falado NÃO remove o lead automaticamente (D-P3-15) — este módulo
//   não decide isso; só monta o resumo/prompt, a decisão de remoção é humana.

/** Retorno combinado normalizado (mesmo shape de `extrairRetorno` em analise.ts). */
export interface RetornoConsolidacao {
  necessario: boolean;
  data: Date | null;
}

function formatarData(data: Date | null): string {
  if (!data) return '(sem data)';
  return data.toISOString().slice(0, 10);
}

/**
 * Monta o pedido ao LLM (Agente Contexto, D-P3-13) para reescrever o resumo
 * consolidado do lead, integrando a observação atual + o resultado da nova
 * ligação. NÃO chama o LLM (isso é do webhook via `chamarLLM`) — só monta
 * `system`/`prompt`, puro e determinístico. Mesmo molde de `montarPromptScript`
 * (lote.ts) / `montarPromptAnalise` (analise.ts): pt-BR, retorna `{ system, prompt }`.
 */
export function montarPromptContexto({
  observacaoAtual,
  atendeu,
  resumoAnalise,
  aderencia,
  retorno,
}: {
  observacaoAtual: string;
  atendeu: boolean;
  resumoAnalise: string;
  aderencia: number | null;
  retorno: RetornoConsolidacao;
}): { system: string; prompt: string } {
  const system = [
    'Você é o Agente Contexto da campanha RomeroCall.',
    'Sua tarefa é manter um RESUMO VIVO e consolidado de cada lead, sempre atualizado com o resultado da ligação mais recente.',
    'Responda sempre em português do Brasil, num tom objetivo e conciso — o resumo é lido rapidamente pelo vendedor antes da próxima ligação.',
    'REGRA CRÍTICA (nunca invente): use SOMENTE informações presentes na observação atual e no resultado da ligação abaixo. Se um dado — nome de pessoa, nome de animal, endereço, situação específica — não aparecer nessas fontes, NÃO o crie, deduza ou complete: simplesmente omita. Este resumo vira base do roteiro do áudio; um nome ou fato inventado aqui faz o operador falar algo falso ao lead e destrói a confiança.',
    'Devolva APENAS o texto do novo resumo consolidado, sem comentários fora dele, sem JSON, sem cercas de código.',
  ].join(' ');

  const linhas: string[] = [
    'Reescreva o resumo consolidado do lead abaixo, integrando o resultado da ligação mais recente.',
    'O resumo deve trazer o que importa saber HOJE sobre este lead — não é um histórico completo (o histórico detalhado de cada ligação já fica registrado separadamente, nas tasks de Ligação).',
    '',
    '=== OBSERVAÇÃO CONSOLIDADA ATUAL ===',
    observacaoAtual || '(nenhuma observação anterior — este é o primeiro contato registrado)',
    '',
    '=== RESULTADO DA LIGAÇÃO MAIS RECENTE ===',
    `Atendeu: ${atendeu ? 'sim' : 'não'}`,
  ];
  if (aderencia !== null) linhas.push(`Aderência ao script: ${aderencia}/10`);
  if (resumoAnalise) linhas.push(`Resumo da análise: ${resumoAnalise}`);
  linhas.push(`Retorno combinado: ${retorno.necessario ? `sim, para ${formatarData(retorno.data)}` : 'não'}`);
  linhas.push('');
  linhas.push('Responda SOMENTE com o novo texto do resumo consolidado (sem título, sem aspas, sem comentários fora dele).');

  return { system, prompt: linhas.join('\n') };
}

function somarDias(base: Date, dias: number): Date {
  return new Date(base.getTime() + dias * 24 * 60 * 60 * 1000);
}

/**
 * Deriva PROXIMO_CONTATO (D-P3-14): `dataRetorno` (compromisso falado na
 * ligação) SEMPRE vence quando presente; sem ela, aplica a regra fixa
 * parametrizável — não atendeu → `hoje + diasNaoAtendeu`; atendeu sem
 * retorno combinado → `hoje + diasDefault`. Função nomeada isolada (mesmo
 * racional de `derivarRetornoNecessario` em lote.ts) — a regra pode mudar
 * sem tocar no resto da cadeia.
 */
export function proximoContato(opts: {
  dataRetorno: Date | null;
  atendeu: boolean;
  hoje: Date;
  diasNaoAtendeu: number;
  diasDefault: number;
}): Date {
  if (opts.dataRetorno) return opts.dataRetorno;
  if (!opts.atendeu) return somarDias(opts.hoje, opts.diasNaoAtendeu);
  return somarDias(opts.hoje, opts.diasDefault);
}

/** Patch de contadores mecânicos do lead (Claude's Discretion, 03-CONTEXT.md), consistente com ATENDEU. */
export interface ContadoresLead {
  tentativas: number;
  atendimentos: number;
  naoAtendimentos: number;
  /** Epoch ms — sempre atualizado (houve contato, atendido ou não). */
  ultimoContato: number;
  /** Epoch ms — só definido (não-null) quando `atendeu === true`. */
  ultimoAtendimento: number | null;
  /** Rótulo curto do resultado ("atendeu" | "nao atendeu"). */
  ultimoResultado: string;
}

/**
 * Deriva o patch de contadores do lead: `tentativas` sempre incrementa;
 * `atendimentos` OU `naoAtendimentos` incrementa conforme `atendeu`;
 * `ultimoContato` sempre atualiza para `hoje`; `ultimoAtendimento` só quando
 * atendeu. Pura, consistente com ATENDEU — sem I/O.
 */
export function derivarContadores(opts: {
  atendeu: boolean;
  tentativasAtuais: number;
  atendimentosAtuais: number;
  naoAtendimentosAtuais: number;
  hoje: Date;
}): ContadoresLead {
  return {
    tentativas: opts.tentativasAtuais + 1,
    atendimentos: opts.atendeu ? opts.atendimentosAtuais + 1 : opts.atendimentosAtuais,
    naoAtendimentos: opts.atendeu ? opts.naoAtendimentosAtuais : opts.naoAtendimentosAtuais + 1,
    ultimoContato: opts.hoje.getTime(),
    ultimoAtendimento: opts.atendeu ? opts.hoje.getTime() : null,
    ultimoResultado: opts.atendeu ? 'atendeu' : 'nao atendeu',
  };
}
