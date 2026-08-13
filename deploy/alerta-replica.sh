#!/bin/bash
# alerta-replica.sh — detecta réplica instável/rollback do serviço `discador` no
# Docker Swarm e avisa no Slack (Fase 10 Plano 06, OBS-02, D-08).
#
# Roda via cron do SO na VPS (fora do Docker Swarm) — complementa o rollback
# automático já configurado em deploy/discador.swarm.yaml (failure_action:
# rollback). Este script SÓ adiciona a notificação externa; não altera o
# comportamento do Swarm.
#
# Contrato (mesma disciplina de alertarDLQ em src/mastra/fila.ts):
#   - Lê ALERT_WEBHOOK_URL do ambiente; vazio = só loga (sem canal configurado).
#   - NUNCA inclui PII no payload — só nome de serviço/task/status.
#   - Anti-flood: só alerta na TRANSIÇÃO para instável (marca de estado em
#     arquivo temporário), não a cada tick do cron.
#   - Sai 0 SEMPRE — best-effort, nunca quebra o cron.

set -u

## Nome do serviço no Docker Swarm a monitorar (ajustar se o stack usar outro
## prefixo — ex.: "discador_discador" quando a stack se chama "discador").
SERVICO="${DISCADOR_SWARM_SERVICO:-discador_discador}"

## Arquivo de estado para anti-flood — grava o último status conhecido e só
## dispara alerta quando o status MUDA de estável para instável.
ESTADO_FILE="${ALERTA_REPLICA_ESTADO_FILE:-/tmp/alerta-replica-discador.estado}"

log() {
  echo "[alerta-replica] $*"
}

## docker service ps: lista as tasks do serviço (desired-state / current-state).
## --no-trunc evita cortar IDs/mensagens de erro; --format simplifica o parse.
## Best-effort: se o comando falhar (docker indisponível, serviço não existe
## ainda), loga e sai 0 sem alertar — nunca quebra o cron.
SAIDA=$(docker service ps "$SERVICO" --no-trunc \
  --format '{{.Name}}\t{{.CurrentState}}\t{{.DesiredState}}\t{{.Error}}' 2>&1)
STATUS_CMD=$?

if [ "$STATUS_CMD" -ne 0 ]; then
  log "falha ao consultar docker service ps para $SERVICO (degradando p/ so-log): $SAIDA"
  exit 0
fi

## Detecta tasks em Failed/Rejected/Shutdown recente — indício de réplica
## instável e/ou de que o Swarm pode ter disparado (ou vai disparar) rollback
## automático (failure_action: rollback, já em deploy/discador.swarm.yaml).
LINHAS_INSTAVEIS=$(echo "$SAIDA" | grep -Ei 'Failed|Rejected|Shutdown' || true)

ESTADO_ANTERIOR="estavel"
if [ -f "$ESTADO_FILE" ]; then
  ESTADO_ANTERIOR=$(cat "$ESTADO_FILE" 2>/dev/null || echo "estavel")
fi

if [ -z "$LINHAS_INSTAVEIS" ]; then
  ## Réplica estável agora — reseta o marcador de estado (permite alertar de
  ## novo numa PRÓXIMA transição, sem reenviar o alerta atual repetidamente).
  echo "estavel" > "$ESTADO_FILE" 2>/dev/null || true
  exit 0
fi

if [ "$ESTADO_ANTERIOR" = "instavel" ]; then
  ## Já estava instável no tick anterior — anti-flood, não reenvia o mesmo
  ## alerta a cada execução do cron.
  log "réplica $SERVICO segue instável (alerta já enviado nesta transição) — sem novo POST"
  exit 0
fi

## Transição estável -> instável: registra e dispara o alerta.
echo "instavel" > "$ESTADO_FILE" 2>/dev/null || true

## Resumo sem PII — só nome de serviço/task e status (nunca telefone/cpf/token).
RESUMO=$(echo "$LINHAS_INSTAVEIS" | awk -F'\t' '{printf "- %s: %s (desired=%s)\\n", $1, $2, $3}')
log "réplica instável detectada em $SERVICO:"
log "$RESUMO"

if [ -z "${ALERT_WEBHOOK_URL:-}" ]; then
  log "ALERT_WEBHOOK_URL vazio — sem canal configurado, so log"
  exit 0
fi

TEXTO="⚠️ Réplica instável\nServiço: ${SERVICO}\n${RESUMO}\n(rollback automático do Swarm pode já ter sido acionado — ver deploy/discador.swarm.yaml)"

## curl best-effort — nunca quebra o cron mesmo se o Slack estiver fora do ar.
curl -fsS -X POST -H 'Content-Type: application/json' \
  -d "$(printf '{"text": "%s"}' "$TEXTO")" \
  "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 \
  || log "falha ao enviar POST ao ALERT_WEBHOOK_URL (degradando p/ so-log)"

exit 0
