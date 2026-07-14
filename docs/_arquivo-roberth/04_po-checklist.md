---
status: draft
ultima_revisao: 2026-05-07
responsavel: Roberth (PO) + assistente IA
fase: PO checklist (consistencia)
---

# PO Checklist — Consistencia entre PRD ↔ UX ↔ Arquitetura

> Saida da fase **PO**. Garante que cada funcionalidade descrita no PRD tem reflexo concreto no UX-spec e no codigo. Encontrou inconsistencia? volta o doc afetado para `status: draft` e revalida.

## A. Coerencia funcionalidade → fluxo → codigo

| F# | PRD `01_prd.md` | UX `02_ux-spec.md` | Codigo `03_arquitetura.md` | OK? |
|---|---|---|---|---|
| F1 | Recepcionar e qualificar | §3.1 Saudacao + §3.2 Qualificacao | `vendedor.ts` Estagios 1-2; `salvar-sessao` | [ ] |
| F2 | Tratar objecao curta | §3.3 (5 categorias + limite 2 ciclos) | `vendedor.ts` Estagio 3; `registrar-objecao` | [ ] |
| F3 | Entregar link checkout | §3.4 Fechamento | `enviar-checkout` (UTM + log) | [ ] |
| F4 | Handoff humano | §3.6 | `handoff-humano` + `bloqueio.ts` | [ ] |
| F5 | Pausar IA quando humano responde | (nao tem turno — comportamento de sistema) | `index.ts` webhook + `bloqueio.ts` | [ ] |
| F6 | Memoria conversacional | (transparente no fluxo) | `memoria.ts` (working memory + semantic recall) | [ ] |
| F7 | Audio | §4 fallback | `evolution.ts` transcricao Whisper | [ ] |

## B. Estrutura de pastas/arquivos

- [ ] `CLAUDE.md` na raiz tem routing table.
- [ ] Cada workspace (`docs/`, `src/mastra/`) tem `CONTEXT.md`.
- [ ] `docs/` tem 7 arquivos numerados (00..06) + `sql/`.
- [ ] `src/mastra/agents/` tem **so** `vendedor.ts`.
- [ ] `src/mastra/tools/` tem **so** as 4 tools.
- [ ] `src/mastra/workflows/` **nao existe**.
- [ ] `src/mastra/scorers/` **nao existe**.

## C. Coerencia de schema

- [ ] Tabelas no SQL `01_init.sql` usam sufixo `_roberth`.
- [ ] `supabase.ts` referencia exatamente as mesmas tabelas e colunas.
- [ ] Enums (`status_conversa_roberth`, `agente_tipo_roberth`, `categoria_objecao_roberth`) batem com os literais usados no codigo.

## D. Env vars

- [ ] Cada var em `.env.example` aparece em algum lugar do codigo (`grep`).
- [ ] Toda var lida no codigo aparece em `.env.example`.
- [ ] Nao sobrou nenhum `LOOVI_*`, `AUTH_TOKEN`, `API_KEY`, `LOOVI_ENV`, `API_CONTRATOS` etc.

## E. Persona / blacklist

- [ ] Persona da Sofia em `vendedor.ts` reflete o PRD §2.
- [ ] Blacklist veta o que o PRD §4 marcou como fora de escopo.
- [ ] Tons (UX §1) batem com `<Persona>` do agente.

## F. Tools

- [ ] Cada tool tem `inputSchema` zod com tipos basicos.
- [ ] `enviar-checkout` adiciona UTM e atualiza `link_enviado` na conversa.
- [ ] `registrar-objecao` insere em `objecoes_roberth` ANTES de o agente formular o contorno.
- [ ] `handoff-humano` muda agente da sessao e nao quebra o webhook (lead ainda consegue ser bloqueado normalmente).

## G. Fluxo end-to-end

- [ ] Webhook → buffer → bloqueio → agente → tool → resposta WhatsApp todo coberto.
- [ ] Audio → Whisper → texto cobre o caso de input por voz.
- [ ] Mensagem de grupo (`@g.us`) ignorada.
- [ ] `pushName` da Evolution e usado quando `customer.nome` esta vazio.

## H. Politicas

- [ ] Limite de 2 ciclos de objecao esta no system prompt do agente.
- [ ] Lead nao recebe link sem ter pedido / sinalizado intencao.
- [ ] Sofia nao inventa preco/bonus/prazo (Blacklist).
- [ ] Prompt injection esta neutralizado (`processors.ts`).

## I. Inconsistencias detectadas

> Listar aqui o que precisa voltar para PRD/UX/arq antes de gerar historias.

- (vazio — preencher na revisao)
