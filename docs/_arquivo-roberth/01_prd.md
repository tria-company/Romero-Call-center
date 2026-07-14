---
status: draft
ultima_revisao: 2026-05-07
responsavel: Roberth + assistente IA
fase: PRD (PM) — INCREMENTAL
---

# PRD — Agente Vendedor WhatsApp (Projeto Roberth)

> **PRD incremental.** Este documento e revisitado sempre que `02_ux-spec.md` ou `03_arquitetura.md` revelar restricao ou oportunidade nova. Ao mudar, marcar `status: draft` ate o PO revalidar (`04_po-checklist.md`).

## 1. Objetivo

Aumentar a conversao da lista quente nos lancamentos de Roberth, atendendo no WhatsApp em escala com qualidade consistente, sem depender de ser-humano-na-tela em tempo real.

## 2. Persona do agente (placeholder — ajustar no briefing)

| Atributo | Valor inicial |
|---|---|
| Nome | Sofia |
| Cargo | Consultora de vendas do time do Roberth |
| Tom | Conversacional brasileiro, proximo, sem juridiques. |
| Estilo de mensagem | Curto (1-3 linhas), padrao WhatsApp. Emoji ocasional. |
| Postura | Consultiva, nao agressiva. Respeita o "nao agora". |

A persona completa esta em `src/mastra/agents/vendedor.ts` (secao `<Persona>`). Mude la o que quiser ajustar — este PRD aponta o "o que", o codigo carrega o "como".

## 3. Funcionalidades (escopo)

### F1 — Recepcionar e qualificar lead da lista quente
- Ao receber a primeira mensagem, saudar reconhecendo o contexto de lancamento.
- Em ate 2 perguntas curtas, descobrir momento + intencao.
- Salvar nome/email/interesse via `salvar-dados-sessao` quando aparecerem.

### F2 — Tratar objecao curta
- Detectar uma das 6 categorias: `preco | tempo | duvida | concorrente | momento | outro`.
- **Antes** de contornar, registrar via `registrar-objecao`.
- Maximo 2 ciclos de objecao por conversa.

### F3 — Entregar link de checkout
- So enviar quando lead pedir explicitamente OU demonstrar intencao clara.
- Sempre via tool `enviar-checkout` (UTM automatica + log no banco).
- Suporta oferta `principal` (default) e `orderbump` (opcional).

### F4 — Handoff para humano
- Lead pediu pessoa, irritou, problema de pagamento ja efetuado, suporte tecnico, juridico, ou agente sem confianca na resposta.
- Tool `handoff-humano` muda agente da sessao para `humano`.
- A IA fica pausada por 1 dia (ou ate `/api/desbloquear` ser chamado).

### F5 — Pausar IA quando humano responder
- Se um humano enviar mensagem pelo WhatsApp do bot, `bloqueio.ts` pausa a IA por 1 dia.
- Detectado em `index.ts` no webhook (`fromMe && !foiEnviadaPeloBot(messageId)`).

### F6 — Memoria conversacional
- Working memory por telefone (scope `resource`) — perfil do lead persiste entre conversas.
- Semantic recall topK=3 para puxar mensagens passadas relevantes.
- Janela de 40 mensagens recentes em contexto.

### F7 — Audio
- Mensagens de audio sao transcritas com Whisper (em `evolution.ts`) antes de chegar no agente.
- Fallback: pedir para o lead reenviar em texto.

## 4. Fora de escopo (v1)

- Outbound ativo (puxar conversa com lead que nao escreveu primeiro).
- Cobranca pos-checkout (boleto vencido, cartao recusado).
- Suporte tecnico do produto (acesso ao curso, login, video que nao toca).
- Multiplos produtos simultaneos. **V1 = 1 oferta por vez.**
- Multilingual. Apenas portugues do Brasil.

## 5. Metricas

| Metrica | Como medir | Alvo inicial |
|---|---|---|
| Tempo de resposta | log do webhook → log de `enviarMensagem` | < 15s |
| Taxa de envio do link | `count(link_enviado=true) / count(conversas)` | a definir |
| Conversao pos-link | UTM no checkout, vinculado a `utm_content=conversaId` | a definir |
| % handoff humano | `agente_atual=humano / total conversas` | < 30% |
| Distribuicao de objecoes | grafico em `objecoes_roberth` por categoria | observar |

## 6. Restricoes tecnicas

- Node `>=22.13.0`, Mastra `^1.17.0`.
- Pooler Supabase com limite de 15 conexoes — `pgStore` e `pgVector` instanciados uma vez (`memoria.ts`).
- Evolution API: 1 instancia por numero de WhatsApp.
- OpenAI: modelo do agente fixado em `openai/gpt-4.1`. Whisper para transcricao de audio.

## 7. Politica de seguranca

- `processors.ts` aplica anti prompt-injection no input e scrubber de system prompt no output.
- Nada de logar conteudo de mensagem em servico externo sem mascarar.
- Bloqueio de mensagens de grupo (`@g.us`) — agente nao opera em grupo.

## 8. Pontos abertos (referencia ao briefing)

Os 7 itens do `00_briefing.md` secao 8. Sem fechamento desses, este PRD permanece `draft`.
