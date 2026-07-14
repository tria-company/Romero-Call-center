# SDR Auton

Agente de WhatsApp que qualifica alunos da base USI (profissionais de saude que ja
compraram a pos de saude integrativa) via BANT×SPIN e agenda calls comerciais com um
closer humano, movendo o card no pipeline COMERCIAL USI (GoHighLevel). E um **SDR**
(qualifica + agenda, nao fecha venda). Stack: **Mastra + GoHighLevel (GHL) + Supabase +
Azure OpenAI**.

## Como comecar

```shell
npm install
cp .env.example .env   # preencha as chaves
npm run dev            # Mastra Studio em http://localhost:4111
```

## Estrutura (resumo)

| Pasta | Para que serve |
|---|---|
| [docs/](docs/) | Docs vivos do SDR AUTON (CONTEXT.md, sql/auton_sdr/). Docs historicos do bot Closer original ficam num subdiretorio de arquivo dentro de `docs/` — ver README de origem la dentro para o nome exato e o escopo. |
| [src/mastra/](src/mastra/) | Codigo do agente. Veja [src/mastra/CONTEXT.md](src/mastra/CONTEXT.md). |
| [src/mastra/agents/](src/mastra/agents/) | `qualificador.ts` (avalia BANT via formulario) e `camila.ts` (SPIN + agendamento, runtime). |
| [src/mastra/tools/](src/mastra/tools/) | Tools GHL (`read-lead-ficha`, `update-contact-field`, `move-pipeline-stage`, `create-calendar-event`, `create-task`, `log-note`, `read-conversation-history`, `send-whatsapp-message`) e `escalate-to-human`. |

A organizacao segue o padrao **CLAUDE.md (mapa) + CONTEXT.md (workspace)**. Comece pelo [CLAUDE.md](CLAUDE.md) para entender o roteamento.

## Endpoints

- `POST /api/webhook/formulario` — recebe submissao do formulario 14q (dispara Qualificador).
- `POST /api/webhook/gravacao` — recebe gravacao de call/ligacao concluida.
- `POST /api/webhook/evolution` — recebe mensagens de WhatsApp (path legado mantido; origem hoje e workflow GHL, nao a Evolution API).
- `POST /api/desbloquear` — reativa a IA depois que humano termina o atendimento. Body: `{ "telefone": "5511..." }`.
- `GET /api/dashboard` — dashboard de metricas (Basic Auth).

## Migrations

Migrations vivas em [docs/sql/auton_sdr/](docs/sql/auton_sdr/) (tabelas com prefixo `auton_sdr_`, banco Supabase dedicado do SDR AUTON).

## Historico

Este projeto reaproveita a infraestrutura Mastra do bot Closer original (agente de WhatsApp
vendedor de curso/infoproduto) — canal, memoria, buffer, follow-up e dashboard. Os docs de
PRD/arquitetura daquela era ficam preservados como referencia num subdiretorio de arquivo
dentro de `docs/` (ver README de origem la dentro para o nome exato e o escopo) e nao
refletem o SDR AUTON atual.
