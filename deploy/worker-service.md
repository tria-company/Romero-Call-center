# Serviço `discador_worker` — worker BullMQ em processo separado

Fase 6 Plano 04 (`escala-150-atendentes`). Este documento é para o **operador** aplicar
no `~/discador.yaml` da VPS (fora deste repo) — o código deste plano só produz o
entrypoint (`src/mastra/worker.ts`) e o bundle (`worker.mjs`, via `Dockerfile`); ele NÃO
altera o discador atual nem faz deploy sozinho.

## O que é

O worker consome a fila `processamento-ligacao` (BullMQ/Redis) fora do caminho da
requisição do webhook Wavoip: transcreve (Deepgram), roda o Agente Análise e o Agente
Contexto, e fecha a Ligação — a mesma lógica de `src/mastra/processador.ts` que hoje roda
inline quando não há `REDIS_URL`. Usa a **MESMA imagem** `discador-wavoip:latest` (o
`Dockerfile` já bundla `worker.mjs` no stage `builder`, junto do `index.mjs`), só que o
serviço do swarm sobrescreve o `command` para rodar `node worker.mjs` em vez de
`node index.mjs`.

## Pré-requisito: Redis acessível

O serviço `redis` (já no ar, `discador_redis`) precisa estar acessível como
`REDIS_URL=redis://redis:6379` — tanto para o `discador` (web) quanto para o
`discador_worker`. Sem essa env, `fila.ts`/`estado-webhook.ts` degradam para modo
memória/inline em CADA processo isoladamente (comportamento de 1 instância) — o worker
detecta isso no boot e **encerra limpo** (não fica um serviço "rodando" sem nada para
consumir).

## Bloco YAML para o `~/discador.yaml`

Adicionar este serviço ao MESMO arquivo `~/discador.yaml` que já tem o serviço
`discador` (molde: `deploy/discador.swarm.yaml` deste repo) — mesma imagem, mesma
network, mesmas envs do discador **mais** `REDIS_URL` e `ALERT_WEBHOOK_URL`:

```yaml
  discador_worker:
    image: discador-wavoip:latest ## MESMA imagem do discador — nao precisa build separado

    command: node worker.mjs ## sobrescreve o CMD do runner (que continua node index.mjs)

    networks:
      - public_network ## mesma rede interna do discador (e do discador_redis)

    environment:
      ## Mesmas envs do servico `discador` (deploy/discador.swarm.yaml) — o worker
      ## chama os MESMOS helpers (clickup.ts/deepgram.ts/llm.ts/supabase.ts) que o web.
      - GHL_PIT_TOKEN=${GHL_PIT_TOKEN}
      - GHL_API_VERSION_V2=${GHL_API_VERSION_V2}
      - GHL_LOCATION_ID=${GHL_LOCATION_ID}
      - GHL_PIPELINE_ID=${GHL_PIPELINE_ID}
      - WAVOIP_DEVICE_TOKEN=${WAVOIP_DEVICE_TOKEN}
      - DISCADOR_USERS=${DISCADOR_USERS}
      - DISCADOR_SESSION_SECRET=${DISCADOR_SESSION_SECRET}
      - NODE_ENV=production
      - TZ=America/Sao_Paulo

      ## Escala (Fase 5/6) — SEM estas duas envs o worker roda em modo inline/memoria
      ## e encerra sozinho no boot (nada para consumir):
      - REDIS_URL=${REDIS_URL} ## mesma URL do discador — ex.: redis://redis:6379
      - ALERT_WEBHOOK_URL=${ALERT_WEBHOOK_URL} ## opcional — alerta de DLQ (FILA-04); vazio = so log [ALERTA][DLQ]

      ## O worker roda a MESMA logica pesada do webhook (Deepgram/LLM/ClickUp/Supabase) —
      ## precisa das mesmas credenciais que o discador ja usa: DEEPGRAM_API_KEY,
      ## LLM_PROVIDER (+ OPENAI_API_KEY ou AZURE_OPENAI_*), CLICKUP_API_TOKEN,
      ## SUPABASE_URL/SUPABASE_SERVICE_KEY. Copiar do bloco `environment` real do
      ## servico `discador` no ~/discador.yaml (nao estao no molde
      ## deploy/discador.swarm.yaml deste repo, que documenta so o subconjunto minimo).

    deploy:
      mode: replicated
      replicas: 1 ## pode escalar depois (FILA_CONCURRENCY controla jobs simultaneos DENTRO de cada replica)
      placement:
        constraints:
          - node.role == manager
      resources:
        limits:
          cpus: "1"
          memory: 768M ## >= 512M — o job de RECORD carrega transcricao (Deepgram) + prompt do Agente Analise/Contexto (LLM)
      ## stop_grace_period: tempo que o swarm espera entre o SIGTERM (deploy/scale-down/
      ## restart) e o SIGKILL forcado. O worker.ts trata SIGTERM chamando worker.close(),
      ## que DRENA o job em andamento (INFRA-05) — espera o processor atual terminar antes
      ## de fechar a conexao. Recomendado 120s: cobre a maioria dos jobs (transcricao +
      ## 2 chamadas de LLM), mas NAO cobre o pior caso (Deepgram pode levar ate 600s num
      ## audio muito longo). TRADE-OFF explicito: se o job nao terminar dentro da janela,
      ## o swarm manda SIGKILL e o job morre no meio — mas isso e SEGURO aqui, nao perde
      ## nada: o dedup e SETNX (marcarRecordProcessado/marcarCallFalhaProcessada,
      ## estado-webhook.ts) mais a durabilidade do evento cru (webhook_eventos, Fase 2)
      ## garantem que o job e REPROCESSADO com seguranca (retry do BullMQ ou reprocesso
      ## manual via CLI, 06-05). Aumentar a janela (ex.: 300s) reduz a chance de
      ## reprocesso ao custo de deploys/restarts mais lentos — ajustar conforme a
      ## distribuicao real de duracao das chamadas em producao.
      stop_grace_period: 120s

    ## SEM labels do Traefik — o worker nao expoe HTTP, so consome a fila.
```

## Aplicar

1. Adicionar o bloco `discador_worker` acima ao `~/discador.yaml` na VPS (junto do
   `discador` e do `discador_redis` já existentes), preenchendo o bloco `environment`
   completo com as credenciais reais (copiar do serviço `discador` já em produção —
   `DEEPGRAM_API_KEY`, `LLM_PROVIDER`/`OPENAI_API_KEY`/`AZURE_OPENAI_*`,
   `CLICKUP_API_TOKEN`, `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`, `REDIS_URL`,
   `ALERT_WEBHOOK_URL`).
2. Rebuild da imagem (a mesma usada pelo `discador`, já inclui `worker.mjs` desde este
   plano): `docker build -t discador-wavoip:latest /opt/discador`.
3. `docker stack deploy -c ~/discador.yaml discador` (ou o nome da stack já em uso) —
   sobe o novo serviço `discador_worker` ao lado do `discador` existente.
4. Verificar: `docker service logs discador_discador_worker` deve mostrar
   `[worker] consumindo a fila processamento-ligacao (concurrency=4)`. Sem
   `REDIS_URL`/Redis inacessível, o log mostra
   `[worker] REDIS_URL ausente — sem fila para consumir; encerrando` e o serviço fica
   reiniciando (esperado até o Redis/env estarem corretos — nesse meio-tempo o
   processamento continua inline no `discador`, sem perda de ligação).
