---
status: draft
ultima_revisao: 2026-05-07
responsavel: QA (Roberth + assistente IA)
fase: QA checklist
---

# QA Checklist — Criterios de aceite por historia

> Para cada historia em [05_historias.md](05_historias.md), os checks abaixo precisam passar antes de ela virar `done`.

---

## H1 — Saudacao reconhecendo lista quente

- [ ] Lead novo recebe saudacao do **modelo B** ("Sofia falando, do time do Roberth...").
- [ ] Lead com `customer.nome` preenchido recebe **modelo A** ("Oi [Nome]!").
- [ ] Mensagem de grupo (`@g.us`) **nao** dispara saudacao.
- [ ] Saudacao chega em < 15s do envio do lead (10s buffer + 2-5s gerar).

## H2 — Qualificacao em ate 2 perguntas

- [ ] Sofia faz no maximo 2 perguntas antes de ir para link/objecao.
- [ ] Quando lead responde com nome → `salvar-dados-sessao` e chamada.
- [ ] `customers_roberth.nome` aparece preenchido no banco apos a conversa.

## H3 — Detectar intencao clara

- [ ] Frases "manda o link" / "quero comprar" / "quanto ta" disparam Estagio 4 sem mais perguntas.
- [ ] `enviar-checkout` e chamado uma unica vez na conversa.

## H4 — Objecao de preco

- [ ] `objecoes_roberth` recebe linha com `categoria='preco'` e `texto_original` igual ao trecho do lead.
- [ ] Sofia responde em ate 3 linhas, sem agressividade.
- [ ] No 3o "nao", Sofia encerra com leveza e nao manda link.

## H5 — Objecoes (tempo / duvida / concorrente / momento)

- [ ] Cada categoria gera linha em `objecoes_roberth` com a categoria correta.
- [ ] Sofia nao confunde uma objecao com outra (preco != tempo).
- [ ] Sofia nao fala mal de concorrente.

## H6 — Entregar link

- [ ] Link enviado tem todos os UTMs: `utm_source=whatsapp`, `utm_medium=agente-ia`, `utm_campaign=$CAMPANHA_NOME`, `utm_content=<conversaId>`.
- [ ] `conversations_roberth.link_enviado=true` apos a tool rodar.
- [ ] `link_enviado_em` e `oferta_enviada` preenchidos.
- [ ] `messages_roberth` recebe linha com `tool_name='enviar-checkout'`.
- [ ] Sofia **nao** repete a URL no texto fora da tool.

## H7 — Handoff humano

- [ ] Lead que pede "quero falar com pessoa" gera chamada de `handoff-humano`.
- [ ] `conversations_roberth.status='aguardando_humano'` apos a tool.
- [ ] Sessao em cache muda `agenteAtual='humano'`.
- [ ] Proxima mensagem do lead **nao** dispara o agente (sem resposta automatica).

## H8 — Pausar IA quando humano responde

- [ ] Mensagem do humano (fromMe sem ser do bot) chama `bloquearNumero`.
- [ ] Cache `bloqueios` armazena `telefone → desbloqueioEm`.
- [ ] `conversations_roberth.metadata.bloqueado_ate` preenchido.
- [ ] Mensagens subsequentes do lead retornam `status: bloqueado_humano` no webhook.
- [ ] Reativacao: `POST /api/desbloquear { telefone }` muda status para `em_atendimento` e libera o cache.

## H9 — Audio

- [ ] Audio enviado pelo lead e baixado em base64.
- [ ] Whisper transcreve corretamente (validar manualmente em 3 amostras).
- [ ] Texto transcrito entra no fluxo como se fosse texto.
- [ ] Falha na transcricao → mensagem "Nao consegui entender o audio. Pode mandar em texto?".

## H10 — Persistencia entre conversas

- [ ] Lead que volta dias depois recebe saudacao com nome (se ja tinha).
- [ ] Working memory mostra perfil persistido (testar via Mastra Studio).
- [ ] Semantic recall traz mensagens passadas relevantes ao contexto.

## H11 — Migracao SQL

- [ ] Rodar `01_init.sql` cria 4 tabelas + 3 enums sem erro.
- [ ] Rodar 2x e idempotente (usa `IF NOT EXISTS`).
- [ ] FK constraints funcionam (deletar customer cascateia conversa).


---

## Smoke test pos-deploy

1. `npm run build` — passa sem erro.
2. `npm run dev` — Studio abre em `localhost:4111`.
3. Studio mostra **so** o agente `vendedorAgent` registrado.
4. Mandar 1 mensagem fake pelo Studio — Sofia responde sem erro.
5. Apontar Evolution para `/api/webhook/evolution` e mandar mensagem real.
6. Conferir `messages_roberth` no Supabase.
7. Mandar mensagem do bot pelo WhatsApp manualmente — `bloqueio` ativa.
8. `POST /api/desbloquear` — IA volta a responder.

## Pre-prod

- [ ] Rodar smoke test em ambiente de teste com Evolution real.
- [ ] Preencher `.env` com chaves de prod.
- [ ] Validar UTM no Google Analytics / dashboard do checkout.
- [ ] Confirmar com Roberth que o argumento de objecao bate com a marca.
- [ ] Definir RLS policies no Supabase.
