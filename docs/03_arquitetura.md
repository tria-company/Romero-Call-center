---
status: draft
ultima_revisao: 2026-05-07
responsavel: Roberth + assistente IA
fase: arquitetura (arquiteto fullstack)
---

# Arquitetura — Projeto Roberth

> Saida da fase **arquiteto**. Documenta arvore de arquivos, contratos das tools, schema do banco, fluxo de dados, env vars. Mudancas aqui que impactem funcionalidade voltam pro `01_prd.md`.

## 1. Stack

- **Mastra** `^1.17.0` — framework do agente.
- **@ai-sdk/openai** — modelo `openai/gpt-4.1` para o agente, `gpt-4.1-mini` para processors, `text-embedding-3-small` para semantic recall, `whisper-1` para transcricao de audio.
- **@mastra/pg** — `PostgresStore` + `PgVector` apontando para Supabase (pooler).
- **Evolution API** — gateway WhatsApp (self-hosted ou managed). Endpoints usados: `sendText`, `sendPresence`, `getBase64FromMediaMessage`.
- **Supabase** — Postgres com tabelas `customers_roberth`, `conversations_roberth`, `messages_roberth`, `objecoes_roberth`.
- **Node** `>=22.13.0`.

## 2. Arvore de arquivos (so o que importa)

```
Projeto_Roberth/
├── CLAUDE.md
├── README.md
├── package.json
├── .env.example
├── docs/
│   ├── CONTEXT.md
│   ├── 00_briefing.md
│   ├── 01_prd.md
│   ├── 02_ux-spec.md
│   ├── 03_arquitetura.md   ← este
│   ├── 04_po-checklist.md
│   ├── 05_historias.md
│   ├── 06_qa-checklist.md
│   └── sql/
│       └── 01_init.sql
└── src/
    └── mastra/
        ├── CONTEXT.md
        ├── index.ts          (bootstrap + webhook + endpoints HTTP)
        ├── config.ts         (env + URLs)
        ├── memoria.ts        (pgStore, pgVector, Memory)
        ├── sessao.ts         (cache + Supabase de sessao)
        ├── supabase.ts       (REST client das tabelas)
        ├── evolution.ts      (cliente WhatsApp)
        ├── buffer.ts         (debounce 10s)
        ├── bloqueio.ts       (pausa IA quando humano assume)
        ├── processors.ts     (anti-injection, PII, scrubber)
        ├── agents/
        │   └── vendedor.ts   (UNICO agente)
        └── tools/
            ├── salvar-sessao.ts
            ├── handoff-humano.ts
            ├── enviar-checkout.ts
            └── registrar-objecao.ts
```

## 3. Fluxo de uma mensagem (hot path)

```
Lead manda WhatsApp
        │
        ▼
Evolution API → POST /api/webhook/evolution
        │
        ▼
[index.ts] webhook handler
  │ - ignora grupo, fromMe-bot, eventos != messages.upsert
  │ - se fromMe humano: bloqueio.bloquearNumero()
  │ - extrai numero + texto (transcreve audio se preciso)
  │ - estaBloqueado(numero)? → silencio
  │ - adiciona ao buffer (10s)
  ▼
[buffer.ts] junta msgs no intervalo
  ▼
[index.ts] processarMensagem()
  │ - getSessao() / criarSessao()
  │ - salva mensagem do user em messages_roberth
  │ - se agente=humano: avisa e sai
  │ - vendedorAgent.generate(prompt, threadId/resourceId=numero)
  ▼
[vendedor.ts] gpt-4.1 com tools
  │ - chama processors (input)
  │ - eventualmente invoca tools (salvar-sessao / registrar-objecao / enviar-checkout / handoff-humano)
  │ - chama processors (output)
  ▼
[index.ts] envia resposta via evolution.enviarMensagem()
[index.ts] salva resposta em messages_roberth
```

## 4. Schema Supabase

Ver `sql/01_init.sql` para o DDL completo. Resumo:

### `customers_roberth`
| coluna | tipo | nota |
|---|---|---|
| id | uuid PK | |
| telefone | text UNIQUE NOT NULL | identificador principal |
| nome | text NULL | preenchido quando lead se apresenta |
| email | text NULL | opcional |
| created_at, updated_at | timestamptz | |

### `conversations_roberth`
| coluna | tipo | nota |
|---|---|---|
| id | uuid PK | |
| customer_id | uuid FK → customers_roberth | |
| canal | text default 'whatsapp' | |
| status | enum status_conversa_roberth | em_atendimento, aguardando_humano, encerrada |
| agente_atual | enum agente_tipo_roberth | vendedor, atendimento_humano |
| started_at | timestamptz default now() | |
| ended_at | timestamptz NULL | |
| data_ultima_mensagem | timestamptz | atualizado em cada msg |
| metadata | jsonb default '{}' | guarda interesse, bloqueado_ate |
| link_enviado | bool default false | atualizado por `enviar-checkout` |
| link_enviado_em | timestamptz NULL | |
| oferta_enviada | text NULL | "principal" / "orderbump" |

### `messages_roberth`
| coluna | tipo | nota |
|---|---|---|
| id | uuid PK | |
| conversation_id | uuid FK | |
| role | text | user / assistant / system |
| content | text | |
| agent_table | text NULL | qual agente atendeu (sempre `vendedor` na v1) |
| tool_name | text NULL | quando vier de tool |
| tool_input | jsonb NULL | |
| tool_output | jsonb NULL | |
| created_at | timestamptz default now() | |

### `objecoes_roberth`
| coluna | tipo | nota |
|---|---|---|
| id | uuid PK | |
| conversation_id | uuid FK | |
| customer_id | uuid FK | |
| telefone | text | desnormalizado pra query rapida |
| categoria | enum categoria_objecao_roberth | preco, tempo, duvida, concorrente, momento, outro |
| texto_original | text | |
| contornada | bool default false | |
| created_at | timestamptz default now() | |

## 5. Contratos das tools (schemas zod)

### `salvar-dados-sessao`
- input: `{ telefone, nome?, email?, interesse? }`
- output: `{ sucesso }`

### `registrar-objecao`
- input: `{ telefone, categoria, textoOriginal, contornada? }`
- output: `{ sucesso }`

### `enviar-checkout`
- input: `{ telefone, motivoFechamento, oferta? = 'principal', mensagemAcompanhante? }`
- output: `{ sucesso, linkEnviado }`
- side effect: envia mensagem no WhatsApp + grava em `messages_roberth` + atualiza `conversations_roberth.link_enviado=true`.

### `handoff-humano`
- input: `{ telefone, motivo }`
- output: `{ sucesso, mensagem }`
- side effect: muda `sessao.agenteAtual` para `humano` e atualiza `conversations_roberth.status=aguardando_humano`.

## 6. Endpoints HTTP

- `POST /api/webhook/evolution` — recebe payload `messages.upsert` da Evolution.
- `POST /api/desbloquear` — body `{ telefone }`. Reativa a IA depois do humano terminar.

## 7. Variaveis de ambiente

Ver `.env.example`. Resumo:

| Var | Descricao |
|---|---|
| `OPENAI_API_KEY` | chave da OpenAI |
| `EVOLUTION_API_URL` | URL da Evolution |
| `EVOLUTION_API_KEY` | chave da Evolution |
| `EVOLUTION_INSTANCE_NAME` | nome da instancia (numero) |
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | chaves Supabase |
| `SUPABASE_DB_URL` | URL do pooler para `pgStore`/`pgVector` |
| `CHECKOUT_URL_PRINCIPAL` | URL base do checkout (Kiwify/Eduzz/Cakto/...) |
| `CHECKOUT_URL_ORDERBUMP` | opcional |
| `CAMPANHA_NOME` | utm_campaign — ex: `lancamento_2026_q2` |

## 8. Decisoes de arquitetura

- **1 agente, 0 workflows.** Para essa simplicidade de fluxo, `agent.generate()` orquestrando tools e suficiente. Workflows seriam overhead.
- **Working memory por `resource` (telefone)** — perfil persiste entre conversas; threads = telefone tambem.
- **Buffer de 10s antes de processar** — leads frequentemente dividem 1 pensamento em 3 mensagens.
- **Bloqueio por 1 dia quando humano assume** — passou disso, presume-se que o atendimento humano acabou e o lead pode interagir com IA de novo (a equipe pode fazer `/api/desbloquear` antes).
- **Sem CPF.** Diferente do projeto base (que era seguro de carro), aqui nao precisamos. Reduz LGPD e simplifica o fluxo.

## 9. Pendencias para fechar

- [ ] URL real do checkout (vai pro `.env`).
- [ ] Definir nome final da campanha (UTM).
- [ ] Confirmar quem recebe handoff humano (numero / equipe / horario).
- [ ] RLS policy no Supabase (definir antes de prod).
