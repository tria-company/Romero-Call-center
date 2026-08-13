# Backup + restore do Postgres self-hosted — pg_dump diário via cron do SO

Fase 10 Plano 06 (`escala-150-atendentes`, OBS-04). Este documento é para o **operador**
aplicar diretamente na VPS (fora deste repo) — Claude não tem acesso `psql`/`pg_dump` ao
Postgres self-hosted nem ao cron do sistema operacional, então a instalação e o restore
de teste (D-14) são inevitavelmente manuais.

## O que é

Um **cron do sistema operacional na VPS** (D-12 — fora do Docker Swarm, não um serviço/
container agendado) roda `pg_dump` do banco Postgres self-hosted **INTEIRO** (D-15 — não
só as tabelas operacionais deste repo em `sql/escala/*.sql`; inclui também
militantes/dossiê que vivem no mesmo Postgres) uma vez por dia, gravando o dump num
diretório **em disco local da VPS** (D-13), com retenção configurável (~30 dias — a
referência do plano-fonte `escala-150-atendentes.md` §5).

## Cobertura (por que backup local, não S3)

**Decisão D-13 (já resolvida com o usuário):** este backup **NÃO** vai para armazenamento
externo (S3/object storage) — fica em disco local da própria VPS. Isso parece contradizer a
redação do ROADMAP ("cobre a perda da VPS"), mas a leitura correta é:

- A cobertura de **"perda da VPS"** vem do **espelho ClickUp** (Lista 01/02 são a fonte da
  verdade operacional, fora da VPS) — se a VPS inteira for perdida, o ClickUp continua com
  os dados operacionais.
- O backup local do Postgres protege contra **corrupção lógica ou erro humano no banco**
  (ex.: `DELETE` sem `WHERE`, migração quebrada, bug que apaga dados) — não contra perda de
  host.

**NÃO propor S3 nem trocar o destino sem reconfirmar com o usuário** — a contradição já foi
levantada e resolvida conscientemente (ver `.planning/phases/10-observabilidade-backup-lgpd/10-CONTEXT.md`
D-13). Reconsiderar S3 só se a proteção via espelho ClickUp se mostrar insuficiente na
prática.

## Pré-requisito: acesso `psql`/`pg_dump` na VPS

O operador precisa de acesso direto (host/porta/credencial) ao Postgres self-hosted **próprio**
— **NUNCA** à instância gerenciada. A aplicação (`src/mastra/supabase.ts`) não usa
`DATABASE_URL`/conexão `psql` direta — ela fala com o Postgres via PostgREST
(`SUPABASE_URL`/`SUPABASE_SERVICE_KEY`, ver `src/mastra/config.ts` linhas ~222-231). Esse
acesso `psql`/`pg_dump` é **só do operador no host da VPS**, fora do código deste repo.

Variáveis a preencher no crontab (substituir pelos valores reais da instância):

- `PGHOST` / `PGPORT` — host e porta do Postgres self-hosted na VPS (normalmente
  `localhost`/`5432` se o Postgres roda no mesmo host, ou o nome do container Docker se
  roda em rede interna).
- `PGUSER` / `PGPASSWORD` (ou `.pgpass`) — credencial com permissão de leitura em todo o
  banco (não a `SUPABASE_SERVICE_KEY`, que é para PostgREST, não `psql`).
- `PGDATABASE` — nome do banco a dumpar (o banco INTEIRO, não uma lista de tabelas).

## Bloco de crontab — dump diário + retenção

Diretório de dumps sugerido: `/opt/discador/backups/postgres` (ajustar ao layout real da
VPS — o mesmo padrão de `/opt/discador` já usado por `deploy/worker-service.md`). O
diretório **e cada dump** precisam ficar restritos ao dono (o Postgres tem CPF/telefone/
metadados de gravação — PII).

```bash
## /etc/cron.d/discador-backup-postgres (ou `crontab -e` do usuário que roda o Postgres)
## Roda todo dia às 03:00 America/Sao_Paulo — fora do horário de pico de ligações.

## --- Variáveis de conexão (ajustar aos valores reais da instância self-hosted) ---
PGHOST=localhost
PGPORT=5432
PGUSER=discador_backup            ## usuário com permissão de leitura no banco inteiro
PGDATABASE=discador                ## nome do banco Postgres self-hosted (INTEIRO — D-15)
## PGPASSWORD via ~/.pgpass do usuário do cron (NUNCA em claro no crontab) —
## ver `man pgpass`; arquivo ~/.pgpass também precisa chmod 600.

## --- Diretório de dumps (disco LOCAL da VPS, D-13 — não S3) ---
BACKUP_DIR=/opt/discador/backups/postgres

0 3 * * * mkdir -p "$BACKUP_DIR" \
  && chmod 700 "$BACKUP_DIR" \
  && umask 0077 \
  && pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
       -F c -f "$BACKUP_DIR/discador-$(date +\%Y-\%m-\%d).dump" \
  && chmod 600 "$BACKUP_DIR/discador-$(date +\%Y-\%m-\%d).dump" \
  && find "$BACKUP_DIR" -name '*.dump' -mtime +30 -delete \
  >> /var/log/discador-backup-postgres.log 2>&1
```

Notas do bloco acima:

- `umask 0077` + `chmod 600` no arquivo final garantem que o dump **não é world-readable**
  — contém PII (cpf, telefone, metadados de gravação). `chmod 700` no diretório também
  restringe o dono.
- `-F c` (formato custom do `pg_dump`) permite restore seletivo/paralelo via `pg_restore`
  (ver seção de restore abaixo) e já vem comprimido, reduzindo o espaço em disco.
- `find ... -mtime +30 -delete` é a etapa de **retenção/limpeza**: remove dumps com mais de
  30 dias, evitando acúmulo indefinido no disco da VPS. Ajustar o `+30` se a retenção real
  escolhida for diferente (30 dias é a referência do plano-fonte, não travada).
- O log vai para `/var/log/discador-backup-postgres.log` — **nunca** logar a `PGPASSWORD`
  nem trechos do dump; só stdout/stderr do `pg_dump`/`find` (comandos, não dados).

## LGPD — dumps contêm PII

O dump do Postgres inteiro contém CPF, telefone e metadados de gravação de militantes/leads.
Regras não-negociáveis:

- **Nunca** copiar um dump para fora da VPS sem controle explícito (ex.: sem `scp`/upload
  informal para uma máquina pessoal ou serviço de nuvem não autorizado).
- **Nunca** deixar o diretório de dumps ou os arquivos `world-readable` (sempre `700`/`600`).
- **Nunca** commitar um dump neste repo (não existe `.gitignore` específico porque o
  diretório de dumps vive fora do repo, em `/opt/discador/backups/postgres` — mas se algum
  dump acabar dentro do checkout do repo por engano, ele NUNCA deve ser adicionado ao git).

## Restore testado (D-14)

Restore é **manual**, documentado aqui, e deve ser executado **1x nesta fase** pelo
operador para confirmar que o dump é utilizável (não é um script automatizado de restore —
essa automação foi avaliada e descartada nesta fase, ver Deferred Ideas do
`10-CONTEXT.md`). Passos:

1. Escolher um dump recente em `$BACKUP_DIR` (ex.: o de hoje, gerado pelo cron ou rodado à
   mão com o mesmo comando `pg_dump` da seção anterior).
2. Criar um banco de teste dedicado (NUNCA restaurar por cima do banco de produção):
   ```bash
   createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" discador_restore_teste
   ```
3. Restaurar o dump nesse banco de teste:
   ```bash
   pg_restore -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d discador_restore_teste \
     "$BACKUP_DIR/discador-<data-do-dump>.dump"
   ```
4. Verificar a integridade do restore contando linhas de uma tabela chave conhecida (ex.:
   `webhook_eventos`, ver `sql/escala/01_webhook_eventos.sql`, ou a tabela de militantes) e
   comparar com uma contagem equivalente no banco de produção:
   ```bash
   psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d discador_restore_teste \
     -c "SELECT count(*) FROM webhook_eventos;"
   ```
   Se a contagem bater (ou for plausivelmente próxima, dado o intervalo entre o dump e a
   consulta em produção), o restore está validado.
5. Descartar o banco de teste após a verificação:
   ```bash
   dropdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" discador_restore_teste
   ```

## Aplicar

1. Confirmar acesso `psql`/`pg_dump` na VPS ao Postgres self-hosted (host/porta/credencial
   próprios — nunca a instância gerenciada).
2. Criar o diretório de dumps com permissão restrita: `mkdir -p /opt/discador/backups/postgres
   && chmod 700 /opt/discador/backups/postgres`.
3. Instalar o crontab acima (via `crontab -e` do usuário responsável, ou um arquivo em
   `/etc/cron.d/discador-backup-postgres`), preenchendo `PGHOST`/`PGPORT`/`PGUSER`/
   `PGDATABASE` com os valores reais e configurando `~/.pgpass` (chmod 600) para a senha.
4. Rodar o comando de dump uma vez à mão (fora do cron, para validar antes de esperar até
   03:00) e confirmar com `ls -l "$BACKUP_DIR"` que o arquivo foi criado com permissão `600`
   (não world-readable).
5. Executar a seção "Restore testado (D-14)" acima 1x e confirmar que a contagem de
   verificação bate.
6. Confirmar no checkpoint humano (Task 3 deste plano) que os passos 3-5 foram concluídos
   com sucesso.
