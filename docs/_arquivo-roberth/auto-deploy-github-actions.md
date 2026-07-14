# Auto-deploy via GitHub Actions

Status: approved — 2026-05-08

Configuracao do auto-deploy automatico: cada push pra `main` no repo
[`tria-company/Agent-Roberth`](https://github.com/tria-company/Agent-Roberth) dispara um
workflow que faz SSH na VPS, da `git pull`, rebuilds da imagem Docker e atualiza a stack
no Swarm.

> **Pre-requisito obrigatorio:** o primeiro deploy precisa ter sido feito MANUALMENTE
> seguindo [docs/deploy-vps-ubuntu.md](deploy-vps-ubuntu.md). O workflow assume que ja
> existe `/opt/Agent-Roberth`, `~/roberth.yaml` (com secrets reais editados) e que a
> stack `roberth` foi deployada pelo menos uma vez.

## Por que precisa do primeiro deploy manual

O workflow nao cria infra, so atualiza. Ele faz `git pull` num diretorio que precisa
existir, e usa um yaml em `~/roberth.yaml` que contem os secrets de producao
(OpenAI, Supabase, Evolution, etc.). Esses secrets nao ficam no repo — ficam SO no yaml
da VPS, editado uma unica vez no primeiro deploy.

Se voce ainda nao fez o primeiro deploy: rode os comandos do `deploy-vps-ubuntu.md`
ate o final da Fase 5 (deploy da stack). So depois configure os secrets do Actions
abaixo.

## 1. Gerar chave SSH dedicada para GitHub Actions

Por seguranca, **nao reutilize** sua chave SSH pessoal. Gera uma chave nova so pra esse
deploy (sem passphrase, porque o Actions roda sem interacao):

No SEU PC:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/agent_roberth_deploy -C "github-actions-roberth" -N ""
```

Vai criar dois arquivos:

- `~/.ssh/agent_roberth_deploy` — chave **privada** (vai pro GitHub)
- `~/.ssh/agent_roberth_deploy.pub` — chave **publica** (vai pra VPS)

## 2. Autorizar a chave publica na VPS

Cole o conteudo de `agent_roberth_deploy.pub` em `~/.ssh/authorized_keys` do usuario
que vai fazer o deploy (geralmente `root`).

Comando rapido (do seu PC, vai pedir a senha do root da VPS):

```bash
ssh-copy-id -i ~/.ssh/agent_roberth_deploy.pub root@<IP-DA-VPS>
```

Ou manualmente: `cat ~/.ssh/agent_roberth_deploy.pub`, copia, e cola no fim de
`~/.ssh/authorized_keys` da VPS.

Testa que a chave funciona:

```bash
ssh -i ~/.ssh/agent_roberth_deploy root@<IP-DA-VPS> 'echo ok'
```

Tem que retornar `ok` sem pedir senha.

## 3. Adicionar os 3 secrets no GitHub

Abra <https://github.com/tria-company/Agent-Roberth/settings/secrets/actions>
(ou no repo: Settings → Secrets and variables → Actions → New repository secret).

Adicione 3 secrets:

| Nome | Valor |
|---|---|
| `VPS_HOST` | IP publico da VPS (ex: `203.0.113.45`) |
| `VPS_USER` | `root` (ou outro usuario que voce autorizou no passo 2) |
| `VPS_SSH_KEY` | **conteudo completo** do arquivo `~/.ssh/agent_roberth_deploy` (privada). Comeca com `-----BEGIN OPENSSH PRIVATE KEY-----` e termina com `-----END OPENSSH PRIVATE KEY-----`. |

> **Importante para `VPS_SSH_KEY`:** copie o arquivo INTEIRO, incluindo as linhas
> BEGIN e END e a quebra de linha final. Mais facil:
> 
> No seu PC: `cat ~/.ssh/agent_roberth_deploy | clip` (Windows com WSL/Git Bash) ou
> `cat ~/.ssh/agent_roberth_deploy | pbcopy` (Mac). Cola direto no campo do GitHub.

## 4. Testar o auto-deploy

Va em <https://github.com/tria-company/Agent-Roberth/actions>, clique no workflow
**Deploy na VPS (Docker Swarm)** e em **Run workflow → Run workflow**. Ele vai
disparar manualmente, sem precisar fazer push.

Saida esperada (ultimas linhas):

```
======= CLI Version Information =======
Drone SSH version 1.8.2
=======================================
ID         IMAGE                        CURRENT STATE             ERROR
abc123...  agent-roberth:latest         Running 2 seconds ago
```

Se aparecer `Failed`, va pra Troubleshooting.

## 5. Como o auto-deploy funciona dali pra frente

Toda vez que voce fizer push pra `main`:

1. GitHub Actions abre o workflow `docker-build.yml`.
2. Faz SSH na VPS com a chave do passo 1.
3. Roda na VPS:
   ```bash
   cd /opt/Agent-Roberth
   git pull --ff-only
   docker build -t agent-roberth:latest .
   docker stack deploy --resolve-image=never -c ~/roberth.yaml roberth
   ```
4. Lista o estado do service.

O `~/roberth.yaml` (com secrets reais) NAO e tocado — voce edita na VPS quando precisa
mudar `.env` de prod, e o auto-deploy nunca sobrescreve.

## Como mudar variaveis de ambiente da VPS depois

Quando precisar mudar `OPENAI_API_KEY`, `SUPORTE_GRUPO_JID`, etc.:

```bash
ssh root@<IP-DA-VPS>
nano ~/roberth.yaml          # edita os environment:
docker stack deploy --resolve-image=never -c ~/roberth.yaml roberth   # reaplica
docker service logs roberth_agent_roberth -f --tail 30
```

Nao precisa mexer no GitHub. O proximo push tambem nao quebra nada — o yaml na VPS e
soberano.

## Como desativar o auto-deploy (se quiser pausar)

Tres opcoes:

1. **Mais rapido**: Settings → Actions → Disable Actions for this repository.
2. **Manter Actions ativo, so esse workflow nao**: edita `.github/workflows/docker-build.yml`
   e tira o trigger `push`, deixa so `workflow_dispatch:` (deploy fica manual em
   Actions → Run workflow).
3. **Tirar de vez**: deleta o arquivo `.github/workflows/docker-build.yml`.

## Troubleshooting

### `error: missing server host`

Os 3 secrets nao foram criados ou estao com nome errado. Confere em
Settings → Secrets and variables → Actions. Os nomes precisam bater **exatamente**:
`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (case-sensitive).

### `Permission denied (publickey)`

A chave publica nao foi autorizada na VPS. Refaz o passo 2:

```bash
ssh-copy-id -i ~/.ssh/agent_roberth_deploy.pub root@<IP-DA-VPS>
```

Confere em `~/.ssh/authorized_keys` na VPS — a chave do GitHub Actions tem que estar la.

### `Could not open a connection to your authentication agent`

O conteudo do `VPS_SSH_KEY` foi colado errado. Provavel falta a primeira linha
(`-----BEGIN OPENSSH PRIVATE KEY-----`) ou a ultima (`-----END OPENSSH PRIVATE KEY-----`),
ou veio sem quebra de linha final. Recopia o arquivo inteiro e atualiza o secret.

### `cd: /opt/Agent-Roberth: No such file or directory`

Voce ainda nao fez o primeiro deploy manual. Roda
`docs/deploy-vps-ubuntu.md` ate Fase 5 antes de tentar o auto-deploy.

### `service roberth_agent_roberth: rejected: invalid mount config`

O `~/roberth.yaml` na VPS esta mal-formado (provavelmente erro de indentacao apos
edicao manual). Edita la e valida com `docker stack deploy --resolve-image=never -c ~/roberth.yaml roberth`
manualmente.

### Build da imagem demora muito / falha por memoria

A VPS tem 23 GB de RAM, mas o Docker pode ter limite. Se quebrar:

```bash
ssh root@<IP-DA-VPS>
docker system prune -a --volumes -f   # CUIDADO: apaga imagens nao usadas
```

E refaz o auto-deploy.

## Seguranca — boas praticas adicionais

- **Limitar permissoes do usuario SSH**: em vez de `root`, criar um `deploy` user com
  permissao so pra rodar `docker` (membro do grupo `docker`). Reduz blast radius.
- **Rotacionar a chave SSH**: trocar a `agent_roberth_deploy` a cada 6-12 meses.
- **Habilitar branch protection**: exigir PR review antes de merge em `main`. O
  auto-deploy so dispara apos merge, dando uma camada de revisao.
- **Logs de auditoria**: GitHub Actions guarda historico de quem disparou cada deploy
  em Actions → workflow runs.
