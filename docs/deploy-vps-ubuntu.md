# Deploy em VPS Contabo (Docker Swarm + Traefik + sslip.io)

Status: approved — 2026-05-08

Guia adaptado ao cenario real da VPS `tria-server` (Contabo): Docker Swarm com Traefik
v3.4.0 ja rodando, network `public_network`, certResolver `letsencryptresolver`. O Roberth
e adicionado como uma stack nova ao lado de n8n, evolution_api, supabase, etc. — sem
mexer no que ja existe.

Loovi-agents antigo (porta 4111 do host) **nao e desligado** — Roberth fica em network
interna apenas, sem expor porta no host.

## Pre-requisitos (ja atendidos na VPS atual)

- Docker Swarm ativo (`node.role == manager`)
- Traefik rodando com:
  - `--providers.swarm=true`
  - Network `public_network` (overlay)
  - certResolver `letsencryptresolver` (HTTP challenge)
- Volumes externos: `volume_swarm_certificates` (Traefik usa)
- Acesso SSH como root

Quem segue o template SetupOrion (caso seja outra VPS) ja tem tudo isso.

## Passo a passo

### 1. SSH na VPS e descobrir o IP publico

```bash
ssh root@<IP-DA-VPS>
curl -s ifconfig.me
```

Anote o IP. Para sslip.io, troque os pontos por hifens. Ex: `203.0.113.45` → `203-0-113-45`.
URL final do agente: `https://roberth.203-0-113-45.sslip.io`

### 2. Clonar o repo

Coloque sob `/opt` (separa de `~/Loovi-Agents` antigo):

```bash
cd /opt
git clone https://github.com/tria-company/Agent-Roberth.git
cd Agent-Roberth
```

### 3. Build da imagem Docker

O `Dockerfile` ja faz multi-stage build (node:22-alpine → produz `.mastra/output/index.mjs`):

```bash
docker build -t agent-roberth:latest /opt/Agent-Roberth
```

Confira:

```bash
docker images | grep agent-roberth
```

A imagem fica disponivel localmente. Em single-node Swarm, isso basta — nao precisa registry.

### 4. Preparar o `roberth.yaml`

Copie o template do repo para a home:

```bash
cp /opt/Agent-Roberth/deploy/roberth.swarm.yaml ~/roberth.yaml
chmod 600 ~/roberth.yaml
nano ~/roberth.yaml
```

Substitua todos os `COLAR_AQUI_*` e o `IP_COM_HIFENS`:

| Placeholder | O que colocar |
|---|---|
| `COLAR_AQUI_AZURE_API_KEY` | API key do Azure OpenAI (em Azure Portal → recurso → Keys and Endpoint) |
| `AZURE_OPENAI_RESOURCE_NAME` | ja preenchido como `rober-mox7y720-eastus2` |
| `AZURE_OPENAI_DEPLOYMENT_*` | ja preenchidos com os deployments atuais (gpt-4.1, gpt-4.1-mini, text-embedding-3-large, gpt-4o-transcribe-diarize) |
| `COLAR_AQUI_EVOLUTION_KEY` | apikey da Evolution (`216e22d2...` ou da nova instancia) |
| `EVOLUTION_INSTANCE_NAME` | `agente_test_01` (nome da instancia que tem o grupo SUPORTE) |
| `COLAR_AQUI_PROJECT_ID` | subdominio Supabase (so a parte antes de `.supabase.co`) |
| `COLAR_AQUI_ANON_KEY` | `sb_publishable_...` |
| `COLAR_AQUI_SERVICE_ROLE_KEY` | `sb_secret_...` |
| `COLAR_AQUI_DB_PASSWORD_URL_ENCODED` | senha do Pg URL-encoded (`%` vira `%25`, `&` vira `%26`, etc.) |
| `COLAR_AQUI_IP_COM_HIFENS` | IP da VPS com hifens, ex: `203-0-113-45` |
| `CHECKOUT_URL_PRINCIPAL` | URL real do produto na Kiwify |

> **Atencao 1 — Evolution URL:** o `.env` local apontava pra `evo.triacompany.com.br`, mas
> a Evolution exposta com SSL no Traefik desta VPS e `evo.tc1.triacompany.com.br`. O yaml
> ja vem com o endereco da VPS. Se voce quer outra Evolution, troque la.
> 
> **Atencao 2 — Supabase Cloud vs self-hosted:** voce tem Supabase self-hosted rodando
> no Swarm desta VPS, mas o agente esta configurado pra usar Supabase Cloud (igual ao
> dev local). Mantenha como esta a menos que queira migrar dados pra base self-hosted.

### 5. Deploy da stack

```bash
docker stack deploy --resolve-image=never -c ~/roberth.yaml roberth
```

> O `--resolve-image=never` impede o Swarm de tentar puxar a imagem de um registry
> remoto — usa a imagem local que voce buildou no passo 3.

Verifique:

```bash
docker stack ls
docker service ls | grep roberth
docker service ps roberth_agent_roberth --no-trunc
docker service logs roberth_agent_roberth -f --tail 50
```

Quando o Traefik detectar o servico, vai pedir o cert ao Let's Encrypt. Acompanhe:

```bash
docker service logs traefik_traefik -f --tail 50 | grep -i roberth
```

### 6. Validar HTTPS + webhook

```bash
curl -i https://roberth.<IP-COM-HIFENS>.sslip.io/api/webhook/evolution \
  -X POST -H 'Content-Type: application/json' -d '{}'
```

Esperado: `HTTP/2 200` com body `{"status":"ignorado"}` (porque `event` nao e
`messages.upsert`).

### 7. Apontar webhook da Evolution para o Roberth

A apikey usada aqui e a da instancia `agente_test_01`:

```bash
curl -X POST "https://evo.tc1.triacompany.com.br/webhook/set/agente_test_01" \
  -H "apikey: E66F19720036-4BC1-8EDC-392EDD657658" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook": {
      "enabled": true,
      "url": "https://roberth.<IP-COM-HIFENS>.sslip.io/api/webhook/evolution",
      "events": ["MESSAGES_UPSERT"]
    }
  }'
```

Mande uma mensagem real no WhatsApp da instancia. Acompanhe:

```bash
docker service logs roberth_agent_roberth -f
```

## Como atualizar o agente depois (deploy de nova versao)

Quando voce comitar mudancas no GitHub:

```bash
cd /opt/Agent-Roberth
git pull
docker build -t agent-roberth:latest .
docker service update --image agent-roberth:latest --force roberth_agent_roberth
docker service logs roberth_agent_roberth -f --tail 30
```

O `--force` faz o Swarm restartar mesmo se a tag (`latest`) nao mudar — necessario
porque o conteudo da imagem `latest` mudou mas o nome nao.

## Como remover o agente (rollback total)

```bash
docker stack rm roberth
docker image rm agent-roberth:latest
rm ~/roberth.yaml
# se quiser remover o codigo:
# rm -rf /opt/Agent-Roberth
```

Nada mais alem da stack `roberth` e da imagem `agent-roberth:latest` e tocado. Loovi-agents,
Traefik, n8n, evolution, supabase continuam intactos.

## Troubleshooting

### Service nao sobe (`replicas: 0/1`)

```bash
docker service ps roberth_agent_roberth --no-trunc
```

Procure a coluna "ERROR". Causas comuns:

- **`No such image: agent-roberth:latest`**: voce buildou com outro nome ou nao buildou. Refaz: `docker build -t agent-roberth:latest /opt/Agent-Roberth`.
- **Imagem nao encontrada em outros nodes**: single-node Swarm com `--resolve-image=never` resolve. Se for multi-node, precisa registry.
- **Container reinicia em loop**: ver `docker service logs roberth_agent_roberth --tail 100`. Geralmente e var de ambiente errada (`SUPABASE_DB_URL` mal formada e o classico).

### HTTPS nao funciona / 404 do Traefik

```bash
docker service logs traefik_traefik --tail 50 | grep -i roberth
```

Causas:

- **Subdominio sslip.io errado**: confere se IP-com-hifens corresponde ao `curl ifconfig.me`. sslip.io aceita formato `<algo>.<IP>.sslip.io` ou direto `<IP>.sslip.io`.
- **Cert pendente**: na primeira vez demora 30-60s. `docker service logs traefik_traefik | grep -i acme`.
- **Service nao na network certa**: confirme que `agent_roberth` esta em `public_network`. `docker network inspect public_network | grep -i roberth`.

### Loovi antigo conflita

Confirme que o Roberth NAO tem `ports:` no yaml. Se tiver, o host vai dar conflito de
porta com o `loovi-agents`. O template ja vem sem `ports:` — Traefik acessa pela network
interna.

### Webhook Evolution nao chega

Da pra testar a Evolution mandando direto:

```bash
curl -i https://evo.tc1.triacompany.com.br/instance/connectionState/agente_test_01 \
  -H "apikey: <KEY>"
```

Se retornar `state: open`, a instancia ta conectada. Aí vai pra logs do Roberth pra ver
se chega request.

## Checklist pos-deploy

- [ ] `docker service ls` mostra `roberth_agent_roberth` com `1/1`
- [ ] `https://roberth.<IP>.sslip.io/api/webhook/evolution` responde 200 com `{"status":"ignorado"}`
- [ ] Cert Let's Encrypt obtido (sem warning de SSL no curl)
- [ ] Webhook na Evolution atualizado (`/webhook/find/agente_test_01` mostra a URL nova)
- [ ] Mensagem real no WhatsApp dispara resposta da Sofia
- [ ] `loovi-agents` ainda esta `Up` na porta 4111 (nao foi tocado)
- [ ] Traefik, n8n, supabase, evolution continuam funcionando
