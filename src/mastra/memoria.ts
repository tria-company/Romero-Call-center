import { Memory } from '@mastra/memory';
import { PostgresStore, PgVector } from '@mastra/pg';
import { openai } from '@ai-sdk/openai';

const connectionString = process.env.SUPABASE_DB_URL || '';

// Instancias compartilhadas — reutilizadas pelo Mastra e pela Memory
// para nao estourar o limite de conexoes do pooler Supabase (15)
export const pgStore = new PostgresStore({
  id: 'roberth-storage',
  connectionString,
});

export const pgVector = new PgVector({
  id: 'roberth-vector',
  connectionString,
});

/**
 * Instancia compartilhada de Memory para o agente vendedor (Roberth).
 *
 * Storage: Supabase/PostgreSQL.
 * - Working Memory por resource (telefone) — persiste perfil do lead entre conversas.
 * - Semantic Recall topK=3 — recupera as 3 mensagens passadas mais relevantes.
 * - lastMessages=40 — janela de contexto recente.
 */
export const memoria = new Memory({
  storage: pgStore,
  vector: pgVector,
  embedder: openai.embedding('text-embedding-3-small'),
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
