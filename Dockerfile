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

# --- Stage 2: Production ---
FROM node:22-alpine AS runner

WORKDIR /app

# Copiar output do build
COPY --from=builder /app/.mastra/output ./

# Expor porta padrao do Mastra
EXPOSE 4111

# Iniciar servidor
CMD ["node", "index.mjs"]
