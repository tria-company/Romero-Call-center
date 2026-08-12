#!/usr/bin/env node
// scripts/llm-endpoint-azure.smoke.mjs
//
// Smoke determinístico (sem rede) de `normalizarEndpointAzure` (src/mastra/llm.ts) —
// prova que a normalização do endpoint Azure trata corretamente os DOIS esquemas
// suportados (WR-01, quick-260812-isb): Azure AI Foundry (esquema /v1, sufixo
// garantido) e recurso clássico *.openai.azure.com (inalterado, sem /v1 forçado).
//
// Uso: node --experimental-strip-types scripts/llm-endpoint-azure.smoke.mjs

import { normalizarEndpointAzure } from '../src/mastra/llm.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

function testarNormalizacao() {
  // (a) sufixo acidental /responses colado do painel Foundry -> vira /v1
  checar(
    normalizarEndpointAzure('https://x.services.ai.azure.com/api/projects/x/openai/v1/responses') ===
      'https://x.services.ai.azure.com/api/projects/x/openai/v1',
    '(a) sufixo /responses deveria virar /v1',
  );

  // (b) sufixo acidental /chat/completions -> vira /v1
  checar(
    normalizarEndpointAzure('https://foo.example.com/openai/v1/chat/completions') ===
      'https://foo.example.com/openai/v1',
    '(b) sufixo /chat/completions deveria virar /v1',
  );

  // (c) faltando /v1 -> adiciona
  checar(
    normalizarEndpointAzure('https://x.services.ai.azure.com/api/projects/x/openai') ===
      'https://x.services.ai.azure.com/api/projects/x/openai/v1',
    '(c) endpoint sem /v1 deveria ganhar /v1',
  );

  // (d) já termina em /v1 -> inalterado
  checar(
    normalizarEndpointAzure('https://foo.example.com/openai/v1') === 'https://foo.example.com/openai/v1',
    '(d) endpoint ja com /v1 deveria ficar inalterado',
  );

  // (e) barra final removida (sem sufixo acidental, sem /v1 ainda)
  checar(
    normalizarEndpointAzure('https://foo.example.com/openai/v1/') === 'https://foo.example.com/openai/v1',
    '(e) barra final deveria ser removida',
  );

  // (f) recurso clássico *.openai.azure.com -> inalterado (NÃO ganha /v1)
  checar(
    normalizarEndpointAzure('https://meurecurso.openai.azure.com/openai') ===
      'https://meurecurso.openai.azure.com/openai',
    '(f) endpoint classico nao deveria ganhar /v1',
  );

  // (g) clássico com barra final -> só remove a barra
  checar(
    normalizarEndpointAzure('https://meurecurso.openai.azure.com/openai/') ===
      'https://meurecurso.openai.azure.com/openai',
    '(g) endpoint classico com barra final deveria so remover a barra',
  );
}

testarNormalizacao();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
