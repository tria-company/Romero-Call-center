import { Memory } from '@mastra/memory';
import { PostgresStore, PgVector } from '@mastra/pg';
import { azure } from './azure-client';
import { AZURE_OPENAI_DEPLOYMENT_EMBEDDING } from './config';

const connectionString = process.env.SUPABASE_DB_URL || '';

// Instancias compartilhadas — reutilizadas pelo Mastra e pela Memory
// para nao estourar o limite de conexoes do pooler Supabase (15)
export const pgStore = new PostgresStore({
  id: 'sdr-auton-storage',
  connectionString,
});

export const pgVector = new PgVector({
  id: 'sdr-auton-vector',
  connectionString,
});

/**
 * Instancia compartilhada de Memory para o agente SDR (Camila).
 *
 * Storage: Supabase/PostgreSQL.
 * - Working Memory por resource (telefone) — persiste perfil do lead entre conversas.
 * - Semantic Recall topK=3 — recupera as 3 mensagens passadas mais relevantes.
 * - lastMessages=40 — janela de contexto recente.
 */
export const memoria = new Memory({
  storage: pgStore,
  vector: pgVector,
  // text-embedding-3-large com 1536 dim (em vez do default 3072) por causa do
  // limite de 2000 dim do pgvector antigo no Supabase Cloud (IVFFlat e HNSW).
  // Ainda melhor que text-embedding-3-small com 1536 nativo — Matryoshka:
  // 3-large truncado pra 1536 dim mantem qualidade superior ao 3-small.
  embedder: azure.embedding(AZURE_OPENAI_DEPLOYMENT_EMBEDDING, { dimensions: 1536 }),
  options: {
    lastMessages: 40,
    workingMemory: {
      enabled: true,
      scope: 'resource',
      template: `# Perfil da Rainha
- **Nome**:
- **Telefone**:
- **Email**:
- **Pilar que mais ressoou**: (Auto-Resgate | Energia de Rainha | Soberania | ainda nao identificado)
- **Origem**: (lista quente | aluno antigo | trafego do lancamento | inbound)
- **Estagio da conversa**: (saudacao | qualificacao | objecao | fechamento | pos-link)
- **Objecoes ja registradas**:
- **Link enviado?**: (sim/nao + data)
- **Historico resumido**:`,
    },
    semanticRecall: {
      topK: 3,
      messageRange: { before: 2, after: 1 },
    },
  },
});
