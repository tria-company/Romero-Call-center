# Discador Wavoip — mapa

PWA de discagem para closers: lista os leads **QUALIFICADOS** do pipeline COMERCIAL USI
(GoHighLevel) e liga via **SDK Wavoip** (WebRTC) no navegador. A ligação acontece 100% no
cliente — não há telefonia no backend. Stack: **Mastra** (servidor HTTP/rotas, na VPS) +
**web/** (frontend estático, deploy separado no Vercel) + **GHL** (lista de leads) +
**Wavoip**. Em português do Brasil.

**Arquitetura (desde a separação front/back):** o frontend (`web/`) é hospedado no Vercel;
o backend (Mastra) fica na VPS só com API + webhook. `web/vercel.json` faz *rewrite* de
`/api/*` pro backend — sem CORS, autenticação por Bearer token inalterada. O backend
continua servindo a mesma UI em `/discador/*` (rotas antigas) como rollback, a partir do
mesmo código-fonte em `discador-pwa.ts` — **os dois precisam ser mantidos em sincronia
manualmente** até as rotas antigas serem removidas.

## Estrutura (3 camadas)

Organização de contexto em 3 camadas — o detalhe fica nas *salas*, não neste mapa:

- **Mapa** — este `CLAUDE.md` (curto, ~1 tela): quem/o quê + routing table + convenções.
- **Salas** — um `CONTEXT.md` por workspace, lido **só** ao trabalhar ali (detalhe dos módulos).
- **Ferramentas** — as skills GSD (`/gsd-*`) que executam o trabalho com commits atômicos.

## Routing table

| Tarefa | Vai para | Ler (CONTEXT.md) | Skills |
|---|---|---|---|
| Backend: rotas, API do discador, webhook Wavoip | [src/mastra/](src/mastra/) | [src/mastra/CONTEXT.md](src/mastra/CONTEXT.md) | `/gsd-quick`, `/gsd-execute-phase` |
| Frontend PWA — produção (Vercel) | [web/](web/) | [web/CONTEXT.md](web/CONTEXT.md) | `/gsd-quick` |
| Frontend PWA — rollback (servido pela VPS, **sincronia manual**) | [src/mastra/discador-pwa.ts](src/mastra/discador-pwa.ts) | [src/mastra/CONTEXT.md](src/mastra/CONTEXT.md) | `/gsd-quick` |
| Migrações do banco | [sql/](sql/) | [sql/CONTEXT.md](sql/CONTEXT.md) | `/gsd-quick` |
| Smokes / utilitários operacionais | [scripts/](scripts/) | [scripts/CONTEXT.md](scripts/CONTEXT.md) | `/gsd-quick` |
| Planejamento / fases / debug | `.planning/` | — | `/gsd-plan-phase`, `/gsd-execute-phase`, `/gsd-debug` |
| Variáveis de ambiente | `.env` | — | — |

## Convenções

- **Nomes:** arquivos de código `kebab-case.ts`; migrações `NN_nome.sql` (numeradas por milestone);
  quick tasks GSD `YYYYMMDD-{slug}/`.
- **Idioma no código:** português quando reflete domínio (`telefone`, `qualificado`); inglês para
  padrões de framework (`server`, `handler`).
- O token do device Wavoip (`WAVOIP_DEVICE_TOKEN`) é exposto client-side por design — o SDK do navegador precisa dele.
- **LGPD:** nunca logar telefone/CPF em claro.

## Boundaries

- **Sempre** rodar `npm run build` antes de commitar para verificar compilação.
- O login seed é `admin/admin` — trocar via `DISCADOR_USERS`/`DISCADOR_SESSION_SECRET` em produção.

## Comandos

```shell
npm run dev      # servidor em localhost:4111 (/discador)
npm run build    # build de produção
npm run start    # roda o servidor de produção
```
