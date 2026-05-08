---
status: draft
ultima_revisao: 2026-05-07
responsavel: Roberth + assistente IA
fase: briefing (analista)
---

# Briefing — Projeto Roberth

> Saida da fase **analista** do pipeline. Entra nas reunioes do PM (`01_prd.md`).

## 1. Problema que estamos resolvendo

Roberth tem uma **lista quente** (alunos antigos / gente que ja interagiu com a marca) e periodicamente faz **lancamentos** de um curso/infoproduto. Hoje a conversao dessa lista depende de:
- Roberth (ou alguem do time) responder manualmente cada lead no WhatsApp.
- Repetir 80% das mesmas perguntas/objecoes.
- Mandar manualmente o link de checkout.

Resultado: **alguns leads esfriam** porque ninguem respondeu a tempo, e o time gasta horas em conversa repetitiva em vez de focar em casos que realmente precisam de toque humano.

## 2. Solucao proposta

Um agente unico de WhatsApp (Sofia, placeholder de persona) que:
1. Identifica o lead pelo telefone (lista quente / aluno antigo).
2. Qualifica em 1-2 perguntas o momento e a intencao.
3. Trata objecao curta com argumento validado.
4. Entrega o link de checkout com UTM no momento certo.
5. Aciona handoff humano se sair do trilho.

Tudo dentro do WhatsApp, sem desviar para landing page.

## 3. Publico-alvo

- **Primario:** lista quente / alunos antigos do Roberth durante a janela de lancamento.
- **Secundario (a confirmar):** trafego organico (Instagram/YouTube) que entra no WhatsApp ja com algum nivel de aquecimento.

> ⚠️ Nao usar para lead frio de trafego pago — o agente nao foi calibrado para educar do zero.

## 4. Oferta — fechado em 2026-05-07

- **Produto:** **MCR — Movimento das Rainhas** (do Roberth).
- **Posicionamento:** "para a mulher que decidiu nunca mais aceitar migalhas emocionais."
- **Linguagem de tribo (obrigatoria no atendimento):** Rainha (nao aluna), Caminho (entrar no Movimento), Mesa da Rainha (encontros ao vivo), Comunidade das Rainhas, Pilares (modulos).
- **6 componentes:**
  1. Pilar Auto-Resgate — 13 aulas (R$1.497)
  2. Pilar Energia de Rainha — 17 aulas (R$1.997)
  3. Pilar Soberania — 11 aulas (R$1.497)
  4. Ferramentas de Implementacao Imediata — 4 itens (R$497, R$297, R$697, R$397)
  5. Mesa da Rainha — 12 encontros mensais ao vivo com Roberth (R$1.497)
  6. Comunidade das Rainhas + Workbook Digital (R$997)
- **Valor real somado:** R$6.879+
- **Investimento:** **12x R$197** ou **R$1.997 a vista**.

### Ainda em aberto

- [ ] **Plataforma de checkout:** Kiwify, Eduzz, Cakto, Hotmart? (definir antes de testar `enviar-checkout`)
- [ ] **Datas do lancamento** — abertura e fechamento do carrinho.
- [ ] **Order bump** — se existir uma oferta secundaria, definir URL e usar `oferta: "orderbump"` na tool.
- [ ] **Garantia** — existe? em quantos dias? (Sofia nao pode mencionar se nao for confirmado)
- [ ] **Prova social que pode ser citada** (numero de Rainhas no Movimento, depoimentos curtos pre-aprovados).
- [ ] **Quem recebe handoff humano** — numero/equipe que assume conversas que saem do escopo.

## 5. Restricoes

- WhatsApp pessoal/comercial via Evolution API (ja configurado).
- Operar **somente** dentro da janela do lancamento (definir).
- LGPD: nao guardar CPF nem dado sensivel sem necessidade. Por padrao guardamos so telefone, nome e email (se o lead der).
- Politica de horario: a definir (responder fora do horario comercial?).

## 6. Riscos

| Risco | Mitigacao |
|---|---|
| Agente prometer algo que nao esta na oferta | Blacklist no system prompt + handoff em duvida (`Blacklist` em `vendedor.ts`). |
| Lead irritado conversando com IA | `handoff-humano` na primeira frase de irritacao + bloqueio quando humano responder. |
| Mensagens em audio | Whisper transcreve em `evolution.ts`. Audio que falhar → fallback para texto. |
| Prompt injection | `processors.ts` neutraliza com `PromptInjectionDetector`. |
| Link sem rastreio | Tool `enviar-checkout` adiciona UTM com conversaId. |

## 7. Metas (a refinar no PRD)

- **Tempo de resposta** < 15s do envio do lead (buffer de 10s + 2-5s do modelo).
- **Taxa de envio do link** entre leads que iniciaram conversa: definir baseline com Roberth.
- **Conversao apos link** (checkout pago / link enviado): observar com UTM no checkout.
- **% de handoff humano** — proxy para qualidade do agente. Alvo inicial: <30%.

## 8. Perguntas para Roberth fechar antes de aprovar

1. Qual plataforma de checkout vamos usar?
2. Qual a oferta principal completa (preco/parcelamento/bonus)?
3. Quando comeca e quando acaba o lancamento?
4. Tem texto/argumento ja validado para as 3 objecoes mais comuns (preco, tempo, duvida)?
5. Quem e o atendente humano que recebe o handoff?
6. O agente pode operar 24/7 ou so em horario comercial?
7. Existe lista de leads para "puxar conversa" ou so respondemos quem chega?
