---
titulo: Ambiente de Homologação — setup, acesso e como iniciar as fases da inversão
data: 2026-08-20
branch: homolog
relacionado: inversao-supabase-fonte-da-verdade.md
---

# Homolog RomeroCall — o que está no ar e como usar

Ambiente paralelo à produção para desenvolver a inversão Supabase-fonte-da-verdade
**sem tocar produção**. Roda na MESMA VPS, isolado por rede/redis/porta/imagem/env.

## 1. O que já está no ar (backend)

Stack Swarm `homolog` na VPS `85.155.178.244` (deploy de `deploy/homolog.swarm.yaml`):

| Serviço | Papel | Porta |
|---|---|---|
| `homolog_discador` | API + PWA (mesma imagem, branch `homolog`) | host **4112** → 4111 |
| `homolog_worker` | `node worker.mjs` — fila BullMQ | — |
| `homolog_redis` | Redis dedicado (rede `homolog_net`) | interna |

**Isolamento (4 eixos + env):** rede própria `homolog_net`, Redis próprio, porta 4112,
imagem `discador-wavoip-homolog:latest`. No env (`deploy/homolog.env`, não versionado):

- `CLICKUP_ESCRITA_HABILITADA=false` → **ClickUp de produção é só-leitura**. Provado ao
  vivo: um POST de voto retorna 502 e o log mostra `escrita bloqueada … POST não permitido`.
  O homolog LÊ tasks reais (para desenvolver as leituras da inversão) mas **não altera nenhuma**.
- Tabelas `hml_*` (mesma instância Supabase) → a escrita do homolog não toca dados de prod.
  Criadas por `sql/homolog/00_homolog_tabelas.sql` (`LIKE … INCLUDING ALL`).
- `EVOLUTION_API_URL=` e `EVOLUTION_WEBHOOK_TOKEN=` vazios → **sem WhatsApp real** (não
  envia nem recebe).
- Login próprio (`admin` / `homolog@2026`), sessão com segredo próprio.

**Acesso ao backend:** `http://85.155.178.244:4112/discador` (login `admin`/`homolog@2026`).

## 2. Ciclo de trabalho das fases (redeploy do homolog)

Toda a inversão é desenvolvida na branch **`homolog`**. Para publicar uma mudança no
ambiente de homolog:

```bash
ssh root@85.155.178.244
cd /opt/discador-homolog
git pull origin homolog
docker build -t discador-wavoip-homolog:latest .
docker service update --force homolog_discador
docker service update --force homolog_worker   # se mexeu no worker
# migrações novas de sql/homolog ou sql/escala (no schema hml_):
node --env-file=deploy/homolog.env scripts/aplicar-sql.mjs sql/homolog/<arquivo>.sql
```

Rollback do ambiente: `docker stack rm homolog` remove tudo (dados hml_ ficam no
Supabase; o Redis do homolog é um volume próprio).

## 3. Frontends no Vercel (você executa — precisa da sua conta)

Criar **projetos Vercel separados** a partir da branch `homolog`, apontando pro backend
de homolog (`:4112`). Faça primeiro o **romero-mobile** (é o app das telas da inversão).

### romero-mobile-homolog

1. Vercel → **Add New Project** → mesmo repositório GitHub → **Root Directory:** `romero-mobile`.
2. **Settings → Git → Production Branch:** `homolog`.
3. **Settings → Environment Variables** (scope Production):

   | Variável | Valor | Porquê |
   |---|---|---|
   | `DISCADOR_ORIGIN` | `http://85.155.178.244:4112` | rewrites `/api/discador/*`, `/admin/*` → backend homolog |
   | `CALLCENTER_URL` | `http://85.155.178.244:4112` | chamadas server-side do BFF + delegação do login |
   | `NEXT_PUBLIC_CALLCENTER_URL` | `https://romero-mobile-homolog.vercel.app` | link client-side (https, evita mixed-content) — ajustar pro domínio real do projeto após o 1º deploy |
   | `AUTH_SECRET` | *(gerar novo: `openssl rand -hex 32`)* | segredo HMAC da sessão do mobile (não reusar o de prod) |
   | `AUTH_TTL_HORAS` | copiar de produção | TTL da sessão |
   | `NEXT_PUBLIC_META_*`, `NEXT_PUBLIC_SEGUIDORES_*` | copiar de produção | metas/seguidores exibidos |

4. **Deploy.** Login no mobile = credenciais do backend homolog (`admin`/`homolog@2026`),
   porque `/api/auth/login` delega a `CALLCENTER_URL/api/discador/login`.
5. Após o 1º deploy, ajustar `NEXT_PUBLIC_CALLCENTER_URL` pro domínio real que o Vercel deu.

> Backend HTTP (`:4112`, sem TLS) é chamado **server-side** pelo Vercel — sem mixed-content
> no browser (idêntico ao prod, que usa `:4111`). As chamadas do browser vão pro domínio
> https do Vercel e são reescritas no servidor.

### web/ (PWA do closer) — opcional

Só se precisar do PWA antigo em homolog. Como `web/vercel.json` tem o IP fixo do backend,
o modo limpo é um projeto Vercel com **Root Directory:** `web` na branch `homolog` e um
`web/vercel.json` de homolog apontando `:4112` (manter só na branch homolog, não mesclar
pro main). Para as fases da inversão, o romero-mobile basta.

### (Opcional) redirecionar o login do backend pro painel de homolog

O login do backend devolve `panelUrl` apontando pro Vercel de produção. Se quiser que o
homolog aponte pro painel de homolog, setar no `deploy/homolog.env` a env de painel do
backend (mesma que produção usa) com a URL do mobile-homolog e `docker service update --force homolog_discador`.

## 4. Como voltar/promover para produção

Nada no **código** é específico de ambiente — a diferença vive 100% no env e no stack:

- **Backend:** o comportamento de prod é o default (`CLICKUP_ESCRITA_HABILITADA` ausente
  = escreve; tabelas sem prefixo `hml_`). Promover uma mudança = abrir PR da `homolog`
  para `main` (as fases entram por PR revisado), e o deploy de prod segue o de sempre
  (`/opt/discador` + `docker service update discador_discador`).
- **Frontend:** os projetos Vercel de produção já existem; nada muda neles até o merge.

## 5. Como começar a Fase A (primeira fase da inversão)

Fase A = **espelhar Lista 02/03 e o registro completo da Lista 01 para leitura** — risco
quase zero, nada no caminho ativo muda. Passos, todos na branch `homolog`, aplicados no
schema `hml_` do homolog:

1. **Migração `sql/escala/06_ligacoes.sql`** — tabela `ligacoes` (materializa a Lista 02),
   com os índices de fila/lote/timeline e o `UNIQUE` parcial de dedup por telefone
   (spec em [inversao-supabase-fonte-da-verdade.md](inversao-supabase-fonte-da-verdade.md) §2.1).
   Em homolog, criar como `hml_ligacoes` (o mesmo padrão das outras hml_).
2. **Migração `07_audios_envios.sql`** e **`08_leads_full.sql`** (§2.2/§2.3 do design).
3. **Generalizar o espelho:** `src/mastra/espelho.ts::sincronizarEspelhoLeads` →
   `sincronizarEspelhoLigacoes()`/`sincronizarEspelhoAudios()` (upsert por `clickup_task_id`),
   reusando `listarTasks`. Rodar contra o ClickUp de produção (só-leitura, seguro) para
   popular as tabelas `hml_*` do homolog.
4. **Validar:** comparar contagens no Supabase homolog × painel de produção; conferir que
   a fila lida do `hml_ligacoes` bate com a fila real.
5. **Rollback:** dropar as tabelas `hml_*` novas; nada as lê ainda.

Fase B (inverter escrita+leitura de `ligacoes`, o que paga o incidente) só começa depois
do **portão do substrato transacional** (§0.1 do design: cliente `pg`/PgBouncer ou RPC
plpgsql). Ver o design para as pré-condições e a ordem completa.
