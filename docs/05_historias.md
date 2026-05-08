---
status: draft
ultima_revisao: 2026-05-07
responsavel: Scrum Master (Roberth + assistente IA)
fase: historias (Scrum Master)
---

# Historias de usuario

> Saida da fase **Scrum Master**. Cada historia e uma unidade executavel — idealmente 1 historia = 1 PR. Toda historia tem **pre-condicao**, **passos**, **criterios de aceite** (em [06_qa-checklist.md](06_qa-checklist.md)) e referencias para o codigo.

Formato: "Como [persona], eu quero [acao] para [valor]".

---

## H1 — Saudacao reconhecendo lista quente

**Como** lead da lista quente,
**quero** que a Sofia me cumprimente reconhecendo que ja interagi com a marca,
**para** sentir que nao e um robo generico mandando spam.

**Pre-condicao:** mensagem inicial chega no webhook, lead pode ou nao estar em `customers_roberth`.

**Passos:**
1. Webhook → `buffer.adicionarAoBuffer()`.
2. Apos 10s, `processarMensagem()` busca/cria sessao.
3. `vendedorAgent.generate()` recebe prompt com nome (se houver) + telefone.
4. Sofia segue Estagio 1 do `<Instrucoes>`.

**Onde mexer:** `src/mastra/agents/vendedor.ts` (Persona + Instrucoes Estagio 1), `src/mastra/index.ts` (montagem do prompt).

---

## H2 — Qualificacao em ate 2 perguntas curtas

**Como** lead que respondeu a saudacao,
**quero** receber 1-2 perguntas curtas e relevantes,
**para** nao perder tempo com formulario antes de ver a oferta.

**Pre-condicao:** sessao ja existe.

**Passos:** Sofia segue Estagio 2 (escuta + qualificacao). Salva nome via `salvar-dados-sessao` se aparecer.

**Onde mexer:** `vendedor.ts` Instrucoes Estagio 2; `tools/salvar-sessao.ts`.

---

## H3 — Detectar intencao clara e pular para fechamento

**Como** lead que ja decidiu comprar,
**quero** que a Sofia mande o link sem me fazer mais perguntas,
**para** nao ser empurrado de volta para qualificacao.

**Pre-condicao:** lead disse "manda o link", "quanto ta", "quero comprar" etc.

**Passos:**
1. Sofia detecta o sinal e salta direto para Estagio 4.
2. Chama `enviar-checkout` com `motivoFechamento` apropriado.

**Onde mexer:** `vendedor.ts` (regra de salto entre Estagio 2 e 4). Eventualmente uma frase em `<Instrucoes>` Estagio 2 lista os sinais.

---

## H4 — Registrar e tratar objecao de preco

**Como** lead que disse "ta caro",
**quero** ouvir um argumento curto e nao agressivo,
**para** decidir com calma se faz sentido pra mim.

**Pre-condicao:** lead trouxe objecao de preco no Estagio 2 ou 3.

**Passos:**
1. Sofia chama `registrar-objecao` com `categoria='preco'`.
2. Responde com argumento + pergunta curta.
3. Maximo 2 ciclos. No 3o "nao", encerra com leveza.

**Onde mexer:** `tools/registrar-objecao.ts`, `vendedor.ts` Estagio 3.

---

## H5 — Tratar demais objecoes (tempo, duvida, concorrente, momento)

**Como** lead que trouxe outro tipo de objecao,
**quero** receber resposta especifica e nao um script generico de preco,
**para** sentir que a conversa e real.

**Onde mexer:** `vendedor.ts` Estagio 3 (4 sub-cases). UX-spec §3.3 ja tem o copy modelo.

---

## H6 — Entregar link de checkout com UTM

**Como** lead pronto pra comprar,
**quero** receber o link e conseguir pagar imediatamente,
**para** nao perder o impulso da decisao.

**Pre-condicao:** intencao clara confirmada.

**Passos:**
1. Sofia chama `enviar-checkout`.
2. Tool monta URL com `utm_source=whatsapp&utm_medium=agente-ia&utm_campaign=$CAMPANHA_NOME&utm_content=<conversaId>`.
3. Tool envia mensagem via Evolution.
4. Tool grava em `messages_roberth` e atualiza `conversations_roberth.link_enviado=true`.
5. Sofia confirma com 1 frase pos-link.

**Onde mexer:** `tools/enviar-checkout.ts`, `vendedor.ts` Estagio 4-5.

---

## H7 — Handoff para humano

**Como** lead com problema fora do escopo (suporte, juridico, pagamento ja efetuado),
**quero** ser conectado com pessoa real,
**para** nao ficar preso conversando com IA.

**Passos:**
1. Sofia detecta gatilho (lead pediu pessoa / irritou / fora de escopo).
2. Sofia avisa "vou te conectar".
3. Chama `handoff-humano`.
4. `sessao.agenteAtual` vira `humano`. Conversa muda status no Supabase.
5. Proximas mensagens do lead retornam silencio do bot (porque a IA esta no estado `humano`).

**Onde mexer:** `tools/handoff-humano.ts`, `vendedor.ts` Estagio 5, `sessao.ts`, `index.ts`.

---

## H8 — Pausar IA quando humano responde

**Como** atendente humano,
**quero** poder responder o lead direto pelo WhatsApp e a IA parar de responder,
**para** evitar resposta dupla.

**Passos:**
1. Webhook recebe `fromMe=true`.
2. `foiEnviadaPeloBot(messageId)` retorna falso → e humano.
3. `bloqueio.bloquearNumero(telefone)` por 1 dia (cache + Supabase).
4. Proximas mensagens do lead → webhook detecta bloqueio → ignora.

**Onde mexer:** `index.ts`, `bloqueio.ts`, `evolution.ts`.

**Reativacao:** `POST /api/desbloquear` com `{ telefone }`.

---

## H9 — Lidar com audio

**Como** lead que prefere audio,
**quero** mandar audio e ser entendido,
**para** nao precisar digitar.

**Passos:**
1. Webhook detecta audio (`ehMensagemAudio`).
2. Baixa base64 e chama Whisper (`transcreverAudio`).
3. Texto entra no fluxo normal.
4. Se transcricao falhar, agente pede texto.

**Onde mexer:** `evolution.ts`, `index.ts`.

---

## H10 — Persistir perfil entre conversas

**Como** lead que volta dias depois,
**quero** que a Sofia se lembre de quem sou e do que falamos,
**para** nao precisar repetir tudo.

**Passos:**
1. `Memory` com `scope: 'resource'` carrega working memory por telefone.
2. Semantic recall topK=3 recupera mensagens passadas relevantes.
3. `getSessao()` reconstroi sessao se houver `customers_roberth` + conversa < 24h.

**Onde mexer:** `memoria.ts`, `sessao.ts`.

---

## H11 — Migracao SQL aplicada no Supabase

**Como** dev,
**quero** rodar `01_init.sql` e ter as tabelas/enums/indices criados,
**para** subir o bot sem quebrar persistencia.

**Onde mexer:** `docs/sql/01_init.sql`.


---

## Cadencia sugerida (1 PR por historia)

1. H11 (banco) — pre-requisito de tudo.
2. H1 + H2 — agente basico saudando e qualificando.
3. H3 + H6 — caminho feliz: lead pediu → link enviado.
4. H4 + H5 — objecoes.
5. H7 + H8 — handoff e bloqueio.
6. H9 — audio.
7. H10 — memoria/working memory (validar).

Cada PR deve trazer **so a historia + criterios de aceite passando**, sem refatoracao paralela.
