# --- Stage 1: Build ---
FROM node:22-alpine AS builder

WORKDIR /app

# Copiar package files e instalar deps
COPY package.json package-lock.json ./
RUN npm ci

# Copiar codigo fonte
COPY src ./src

# Build com Mastra CLI
RUN npx mastra build

# Bundle do worker BullMQ (Fase 6 Plano 04, escala-150-atendentes) num
# arquivo auto-contido dentro do output do Mastra — assim o
# `COPY --from=builder /app/.mastra/output ./` do runner ja o leva junto,
# sem alterar o COPY nem inchar a imagem final. ai-sdk/openai/azure/etc
# viram parte do worker.mjs; so os builtins do Node ficam externos
# (--platform=node). `bullmq`, `ioredis` e `@vercel/oidc` ficam --external:
# os 3 usam `require(<variavel>)` (nao um literal estatico) pra carregar
# builtins do Node (child_process/path/events) em algum caminho interno —
# o bundler nao consegue resolver esse require dinamico em runtime ESM
# (`Dynamic require of "..." is not supported`, confirmado rodando o
# bundle localmente). Os 3 ja estao em `.mastra/output/node_modules`
# (dependencies do package.json que o `mastra build` acima ja instalou),
# entao o `import` externo resolve normalmente em runtime. O worker roda
# como um servico SEPARADO do swarm (mesma imagem, CMD sobrescrito para
# `node worker.mjs` — deploy/worker-service.md); o CMD do runner abaixo
# continua o mesmo (o web).
RUN npx esbuild src/mastra/worker.ts --bundle --platform=node --format=esm \
  --target=node22 --external:bullmq --external:ioredis --external:@vercel/oidc \
  --outfile=.mastra/output/worker.mjs

# --- Stage 2: Production ---
FROM node:22-alpine AS runner

WORKDIR /app

# Copiar output do build
COPY --from=builder /app/.mastra/output ./

# Expor porta padrao do Mastra
EXPOSE 4111

# Iniciar servidor
CMD ["node", "index.mjs"]
