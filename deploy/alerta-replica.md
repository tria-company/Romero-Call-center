# Alerta de saúde de réplica/deploy do Swarm — cron do SO

Fase 10 Plano 06 (`escala-150-atendentes`, OBS-02, D-08). Este documento é para o
**operador** aplicar diretamente na VPS (fora deste repo) — instala o cron que roda
`deploy/alerta-replica.sh`. Claude não tem acesso ao daemon do Docker Swarm nem ao cron da
VPS, então a instalação é inevitavelmente manual.

## O que é

`deploy/alerta-replica.sh` + um cron do sistema operacional detectam quando uma réplica do
serviço `discador` no Docker Swarm fica instável (task em `Failed`/`Rejected`/`Shutdown`
recente) e/ou quando o rollback automático já configurado em `deploy/discador.swarm.yaml`
(`failure_action: rollback`, `update_config`/`rollback_config`) é acionado. Quando detecta
essa condição, o script avisa no **mesmo canal Slack** já usado pelo alerta de DLQ
(`ALERT_WEBHOOK_URL`, ver `src/mastra/fila.ts` `alertarDLQ()`) — D-08 confirmado pelo
usuário.

Este runbook **complementa** o rollback automático que já existe no Swarm; ele não muda o
comportamento de deploy, só adiciona a notificação externa quando algo dá errado.

## Pré-requisito

- **Docker CLI acessível ao daemon do Swarm** na VPS (o mesmo host onde `docker stack
  deploy -c ~/discador.yaml discador` já roda, ver `deploy/worker-service.md`) — o script
  chama `docker service ps <serviço>`.
- **`ALERT_WEBHOOK_URL`** exportado no ambiente do cron (o mesmo Slack incoming webhook já
  usado pelo alerta de DLQ do worker, D-05). Sem essa env o script só loga localmente
  (`[alerta-replica] ALERT_WEBHOOK_URL vazio — sem canal configurado, so log`) — nunca
  quebra o cron.
- **`curl`** disponível no host do cron (para o POST best-effort ao Slack).
- Nome real do serviço no Swarm — por padrão o script assume `discador_discador` (padrão
  `<nome-da-stack>_<nome-do-serviço>` quando a stack é `discador` e o serviço é `discador`,
  ver `deploy/discador.swarm.yaml`). Ajustar via `DISCADOR_SWARM_SERVICO` se o nome real da
  stack for diferente.

## Bloco de crontab

```bash
## /etc/cron.d/discador-alerta-replica (ou `crontab -e` do usuário com acesso ao Docker)
## Roda a cada 1-2 minutos — detecção rápida sem sobrecarregar o daemon do Swarm.

ALERT_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ  ## mesmo webhook do alerta de DLQ (D-05)
DISCADOR_SWARM_SERVICO=discador_discador                         ## ajustar ao nome real da stack, se diferente

*/2 * * * * /opt/discador/deploy/alerta-replica.sh >> /var/log/discador-alerta-replica.log 2>&1
```

Notas:

- O script é **idempotente/anti-flood**: só envia o alerta Slack na **transição** de
  estável para instável (marca o estado num arquivo temporário,
  `/tmp/alerta-replica-discador.estado` por padrão, sobrescrevível via
  `ALERTA_REPLICA_ESTADO_FILE`) — não reenvia a cada tick de 2 minutos enquanto a réplica
  continuar instável.
- O script **sai 0 sempre** — falha ao consultar o Docker, falha ao enviar o Slack, ou
  ausência de `ALERT_WEBHOOK_URL` degradam para "só log", nunca travam o cron.
- O payload Slack é `{ "text": "⚠️ Réplica instável\n..." }` — texto simples, mesmo canal
  do alerta de DLQ, **sem PII** (só nome de serviço/task e status, nunca telefone/cpf).
- Copiar `deploy/alerta-replica.sh` para o mesmo diretório onde já vive
  `deploy/worker-service.md`/o restante do deploy na VPS (ex.: `/opt/discador/deploy/`) e
  garantir que está executável (`chmod +x`).

## Aplicar

1. Copiar `deploy/alerta-replica.sh` para a VPS (ex.: `/opt/discador/deploy/alerta-replica.sh`)
   e garantir permissão de execução: `chmod +x /opt/discador/deploy/alerta-replica.sh`.
2. Confirmar que o usuário do cron tem acesso ao `docker` CLI do daemon do Swarm (mesmo
   usuário que já roda `docker stack deploy`).
3. Instalar o cron acima (via `/etc/cron.d/discador-alerta-replica` ou `crontab -e`),
   preenchendo `ALERT_WEBHOOK_URL` com o Slack incoming webhook real (o mesmo já usado para
   o alerta de DLQ do worker, D-05) e ajustando `DISCADOR_SWARM_SERVICO` se o nome da stack
   for diferente de `discador_discador`.
4. Testar manualmente rodando o script uma vez à mão:
   `ALERT_WEBHOOK_URL=... /opt/discador/deploy/alerta-replica.sh` — com o serviço saudável,
   não deve haver POST (sem alerta); para confirmar que o canal Slack funciona, é possível
   forçar um teste temporário (ex.: rodar `docker service scale discador_discador=0` por
   alguns segundos numa janela de manutenção, ou simplesmente confiar no comportamento do
   script e revisar o log em `/var/log/discador-alerta-replica.log`).
5. Confirmar no checkpoint humano (Task 3 deste plano) que o cron está instalado e que uma
   mensagem de teste chegou no canal Slack.
