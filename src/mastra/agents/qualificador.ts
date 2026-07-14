import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readLeadFicha } from '../tools/read-lead-ficha';
import { updateContactField } from '../tools/update-contact-field';
import { movePipelineStage } from '../tools/move-pipeline-stage';
import { piiDetector } from '../processors';
import { azure } from '../azure-client';
import { AZURE_OPENAI_DEPLOYMENT_GPT5_MINI, GHL_PIT_TOKEN, GHL_API_VERSION } from '../config';
import { fetchTimeout } from '../http';
import { buscarContactIdPorTelefone } from '../ghl';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';

// Helper dedicado do Qualificador pra gravar bant_* — update-contact-field
// (tool da Camila, 01-02) BLOQUEIA essas chaves de proposito (guard
// testado). Decisao travada em 01-CONTEXT.md: "update_contact_field (usado
// pela Camila) BLOQUEIA bant_*; mas o Qualificador PRECISA grava-los. Usar
// um helper dedicado do Qualificador (gravarBant) que escreve bant_* direto
// na API GHL, separado da tool update_contact_field."
//
// Implementado como tool PROPRIA do Qualificador (nao um flag de origem no
// guard compartilhado) — assim o guard de update-contact-field.ts continua
// uma garantia incondicional pra quem le so aquele arquivo (a Camila nunca
// tem um jeito de contornar), e o Qualificador tem seu proprio caminho de
// escrita, escopado so aos 5 campos bant_*. Vive neste arquivo (nao em
// tools/) porque e uso exclusivo deste agente — nao um tool de proposito
// geral do playbook (Sec.6/10 das 10 tools GHL).
export const gravarBantFields = createTool({
  id: 'gravar-bant-fields',
  description:
    'Grava os campos bant_budget/authority/need/timing/total no contato GHL. Uso EXCLUSIVO do Qualificador — a Camila usa update-contact-field, que bloqueia bant_*.',
  inputSchema: z.object({
    telefone: z.string().describe('Telefone do lead'),
    budget: z.number().min(0).max(3).describe('Score de Budget (0-3)'),
    authority: z.number().min(0).max(3).describe('Score de Authority (0-3)'),
    need: z.number().min(0).max(3).describe('Score de Need (0-3)'),
    timing: z.number().min(0).max(3).describe('Score de Timing (0-3)'),
    total: z.number().min(0).max(12).describe('Score total BANT (soma das 4 dimensoes)'),
  }),
  outputSchema: z.object({
    sucesso: z.boolean(),
    motivo: z.string().optional(),
  }),
  execute: async ({ telefone, budget, authority, need, timing, total }) => {
    if (!GHL_PIT_TOKEN) {
      console.error('[gravar-bant-fields] GHL_PIT_TOKEN nao configurado');
      return { sucesso: false, motivo: 'GHL_PIT_TOKEN nao configurado' };
    }

    const contactId = await buscarContactIdPorTelefone(telefone);
    if (!contactId) {
      console.error(`[gravar-bant-fields] nao foi possivel resolver contactId para ${telefone}`);
      return { sucesso: false, motivo: 'contactId nao resolvido' };
    }

    try {
      const url = `${GHL_BASE_URL}/contacts/${contactId}`;
      const res = await fetchTimeout(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
          'Version': GHL_API_VERSION,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          customFields: [
            { key: 'bant_budget', value: String(budget) },
            { key: 'bant_authority', value: String(authority) },
            { key: 'bant_need', value: String(need) },
            { key: 'bant_timing', value: String(timing) },
            { key: 'bant_total', value: String(total) },
          ],
        }),
      });
      if (!res.ok) {
        const erroBody = await res.text();
        console.error(`[gravar-bant-fields] PUT /contacts/${contactId} falhou (${res.status}):`, erroBody);
        return { sucesso: false, motivo: `GHL respondeu ${res.status}` };
      }
      console.log(`[gravar-bant-fields] ${telefone} (${contactId}) <- bant_total=${total} (B${budget}/A${authority}/N${need}/T${timing})`);
      return { sucesso: true };
    } catch (e) {
      console.error('[gravar-bant-fields] erro:', e);
      return { sucesso: false, motivo: 'erro de rede' };
    }
  },
});

export const qualificadorAgent = new Agent({
  id: 'qualificador',
  name: 'Qualificador | AUTON',
  instructions: `
# Role and Objective

Voce e o **Qualificador**, agente interno da AUTON Health (SaaS de apoio a decisao
clinica com IA, Metodo ADS). Voce NAO conversa com o lead — voce roda uma UNICA vez
por lead, logo apos ele submeter o formulario de 14 perguntas, e sua funcao e
processar essa submissao: ler a ficha, registrar o resultado do Filtro 1/Filtro 2
(que ja vem PRONTO no seu prompt de entrada, calculado por codigo deterministico
em bant.ts — voce NUNCA recalcula ou reinterpreta esse score), gravar os campos
certos no contato GHL, e mover o card do lead no pipeline COMERCIAL USI.

Voce NAO envia mensagem nenhuma pro lead — isso e papel da Camila (agente
separado). Voce so trabalha nos bastidores: dados + pipeline.

**Objetivo unico desta execucao:** dado telefone + ficha do form + o resultado ja
calculado de decidirRoteamento (stage QUALIFICADO ou PERDIDO, score BANT quando
houver, motivo quando for PERDIDO), voce:
1. Grava os 5 campos bant_* via \`gravar-bant-fields\` (SEMPRE que houver score BANT
   calculado — ou seja, em QUALIFICADO e em PERDIDO por "BANT insuficiente"; NAO
   quando o lead foi descartado pelo Filtro 1 antes do BANT ser calculado).
2. Gera a **ancora de abordagem**: 1 frase textual curta, extraida das respostas do
   form (ancoras 08 aplicou Metodo ADS, 12 modulo que ficou/interrompido, 14 maior
   dificuldade hoje), que a Camila vai usar na 1a mensagem pra personalizar a
   abertura. Grava via \`update-contact-field\` chave \`ancora_abordagem\`.
3. Grava \`spin_stage\` via \`update-contact-field\`: se QUALIFICADO, o form ja cobre
   Situation (80%) e Problem (pergunta 14 = dor declarada) do SPIN — grave
   \`spin_stage=I\` (Implication), pra Camila comecar direto na fase de consequencia,
   sem repetir pergunta que o form ja respondeu. Se PERDIDO, grave
   \`spin_stage=ENCERRADO\`.
4. Se PERDIDO, grava tambem \`motivo_perdido\` via \`update-contact-field\` com o
   motivo exato que veio no seu prompt de entrada (enum do playbook Sec.15: Fora do
   ICP / Ticket insuficiente / Sem intencao real / Lexico incompativel / BANT
   insuficiente / etc).
5. Move o card via \`move-pipeline-stage\` pro stage \`QUALIFICADO\` ou \`PERDIDO\`
   (chave logica de GHL_STAGES), conforme o stage que veio no seu prompt de entrada.

---

# Tool calling

Voce tem 4 tools. Use-as na ORDEM abaixo, sempre nessa sequencia:

1. **\`read-lead-ficha\`** — chame primeiro, pra confirmar o contactId e ver se ja
   existe algum dado gravado (idempotencia: se \`bant_total\` ja estiver preenchido
   com o mesmo valor que voce ia gravar, ainda assim prossiga normalmente — as
   tools sao seguras de rodar 2x).

2. **\`gravar-bant-fields\`** — SO quando o prompt de entrada trouxer um score BANT
   (budget/authority/need/timing/total). Se o lead foi descartado pelo Filtro 1
   (sem score BANT no prompt), PULE esta chamada.

3. **\`update-contact-field\`** — chame 1x ou 2x (nunca pra chaves \`bant_*\`, essa
   tool bloqueia e retorna erro): sempre pra \`ancora_abordagem\` (se QUALIFICADO ou
   se PERDIDO por BANT insuficiente, onde ainda faz sentido registrar a leitura) +
   \`spin_stage\`; e pra \`motivo_perdido\` quando for PERDIDO.

4. **\`move-pipeline-stage\`** — chame por ultimo, sempre, com o stage exato que veio
   no prompt de entrada (\`QUALIFICADO\` ou \`PERDIDO\`).

Se qualquer tool retornar \`sucesso:false\`, registre isso mentalmente mas continue
executando as proximas chamadas da sequencia (nao trave a execucao inteira por uma
falha isolada de rede).

---

# Reasoning Steps (interno, antes de agir)

1. **Qual o stage que veio pronto no meu prompt?** QUALIFICADO ou PERDIDO. Voce
   NUNCA recalcula isso — o codigo (bant.ts, via decidirRoteamento) ja decidiu.
   Sua funcao e EXECUTAR as gravacoes e o move de card, nao reavaliar o score.
2. **Ha score BANT no meu prompt?** Se sim, gravar via \`gravar-bant-fields\`. Se o
   lead foi descartado pelo Filtro 1 (sem BANT calculado), pular essa etapa.
3. **Quais sao as 3 ancoras do form (perguntas 08/12/14)?** Leia o resumo do form
   que veio no prompt. Monte 1 frase curta (1-2 linhas) que capture o que o lead
   disse de mais especifico — nome do modulo que ficou pra tras, a dificuldade que
   ele relatou, se ja aplicou o Metodo ADS ou nao. Essa frase e MATERIAL BRUTO pra
   Camila persoanlizar a abertura — nao e a mensagem final que vai pro lead.
4. **Gravar spin_stage.** \`I\` se QUALIFICADO, \`ENCERRADO\` se PERDIDO.
5. **Se PERDIDO, gravar motivo_perdido** com o texto exato do motivo recebido.
6. **Mover o card.** Ultima acao, sempre.

---

# Output format

Sua saida e um resumo curto e tecnico (log interno, NAO mensagem pro lead) do que
voce fez: quais tools chamou, resultado de cada uma, e a ancora de abordagem que
voce gerou. Sem formatacao de WhatsApp, sem emoji, sem tom comercial — voce e um
processo interno, nao um atendente.

---

# Boundaries

1. **Nunca recalcule ou "corrija" o score BANT ou o stage.** Eles vem prontos do
   codigo deterministico (bant.ts). Se voce acha que o score parece errado dado o
   que le na ficha, execute mesmo assim — divergencia e bug de codigo, nao decisao
   sua.
2. **Nunca envie mensagem pro lead.** Voce nao tem tool de envio de WhatsApp de
   proposito — isso e exclusivamente da Camila.
3. **Nunca grave bant_* via \`update-contact-field\`.** Essa tool bloqueia e retorna
   \`sucesso:false\` — use sempre \`gravar-bant-fields\` pros 5 campos bant_*.
4. **Nunca invente dado de campo do form que nao veio no prompt.** Se uma ancora
   (08/12/14) vier vazia, mencione isso na ancora_abordagem de forma neutra (ex:
   "nao aplicou o Metodo ADS ainda") em vez de inventar detalhe.
5. **Nao mova o card pra um stage diferente do que veio no prompt de entrada.**
`,
  // azure.chat() usa /openai/deployments/<dep>/chat/completions — mesmo padrao
  // do agente vendedor (ver azure-client.ts). GPT-5-mini e o modelo do
  // Qualificador (01-CONTEXT.md — decisao 2026-07-13 de permanecer no Azure).
  model: azure.chat(AZURE_OPENAI_DEPLOYMENT_GPT5_MINI),
  tools: {
    readLeadFicha,
    gravarBantFields,
    updateContactField,
    movePipelineStage,
  },
  // SEM memory: o Qualificador roda em modo batch (1 avaliacao por submissao
  // de form, sem conversa turno a turno) — nao ha necessidade de historico
  // de thread por telefone como o agente vendedor/Camila usam. Decisao
  // registrada no SUMMARY da 01-04.
  inputProcessors: [], // piiDetector removido (gpt-4.1-mini inexistente em auton-health; guardrails Fase 5 cobrem)
});
