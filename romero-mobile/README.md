# Central Animal

Sistema de relacionamento direto do gabinete — web + PWA instalável, mobile-first.
Construído a partir do mockup `ROMERO/interfaces-mobile-central-animal.html`: mesmo design,
com as funcionalidades ligadas de verdade. A **Central de Campanha** vem de um segundo
mockup, `ROMERO/central-campanha-romero.html`, na disposição de celular dele — e mora no fim
do Início, não numa aba própria.

> A tela de **Equipe** foi removida a pedido. Com ela saiu o único lugar onde uma solicitação
> era assumida e resolvida: hoje o pedido é registrado e fica em aberto. Detalhes e o que
> isso implica estão em [AGENTS.md](AGENTS.md), em "O ciclo está ABERTO".

| Tela | O que faz |
|---|---|
| **Início** | Seguidores das duas contas, cadastros na base, apoiadores ativos, fila do dia e solicitações abertas. Embaixo, as duas urnas com o mesmo peso: Romero (40000) e Andreza (4020), cada uma com a coluna-foguete rumo à meta. Fechando a tela, a **Central de Campanha**. |
| **Fila de hoje** | O que fazer agora, ordenado pelo motor: **retorno de entrega** vem antes de aniversário, primeiro contato e reaquecimento. Barra de progresso, toque no avatar para marcar como feito, toque no nome para abrir a pessoa. |
| **Base → Perfil** | Busca e recortes (multiplicadoras, quem confirmou cada número, sem contato). No perfil: o pet em destaque, atendimentos, solicitações em aberto, sua última anotação — e dois canais, **WhatsApp** e **Ligar**, mais **Registrar interação**. O WhatsApp abre a conversa daquela pessoa com a mensagem certa para o motivo dela já digitada, pronta para editar. |
| **Linha do tempo** | Todo contato fica registrado, com visualização e resposta. É o que sustenta o **bloqueio de repetição**: houve contato hoje, o app avisa antes de deixar contatar de novo. |
| **Nova solicitação** | Tudo em botão, nada digitado além da observação: pediu algo · tipo · qual · prioridade (24h / 72h / 7 dias). Ao enviar, o pedido é registrado com prazo e você volta para a ficha da pessoa, onde ele aparece em aberto. |
| **Central de Campanha** *(no fim do Início, não é aba)* | O painel da operação de telemarketing: votos acumulados contra a meta em toda a campanha, produção diária de ligações e contatos, tendências, comparativo semanal, tempo médio de ligação, intenção de voto, **ranking dos telefonistas com ordenação** por seis métricas, votos por cidade, motivos de não-contato e SLA de retornos. |
| **Perfil** | Operador, instalação do app, exportar dados, recarregar a base de exemplo, sair. |

## Rodar

```bash
npm install
cp .env.example .env.local   # ajuste LOGIN_USERS e AUTH_SECRET
npm run dev                  # http://localhost:3011
```

Credenciais de desenvolvimento: **admin@admin.com** / **admin**.

## Deploy

Em produção: **https://romero-mobile.vercel.app**

O `.env.local` **não vai para o repositório** — logo, um deploy novo sobe sem nenhuma
variável e o login responde `503 · Nenhum usuário configurado`. Configure no ambiente do
host (na Vercel: Settings → Environment Variables) antes do primeiro acesso:

| Variável | Valor |
|---|---|
| `LOGIN_USERS` | `email:senha:Nome de Exibição` — vários separados por vírgula |
| `AUTH_SECRET` | 32+ caracteres aleatórios: `node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"` |
| `AUTH_TTL_HORAS` | `12` |

Sem `AUTH_SECRET` forte o app é **fail-closed** em produção: ninguém entra, de propósito,
em vez de cair silenciosamente num segredo padrão comitado. E variável só passa a valer a
partir de um **build novo** — depois de configurar, redeploy.

## Base real (ClickUp)

A base de exemplo pode ser substituída pelos dados reais do gabinete:

```bash
CLICKUP_TOKEN=pk_...            # em .env.local
npm run puxar:clickup           # --leads=600 por padrão
```

O script lê o folder **Telemarketing 2.0** (space `RELATÓRIOS DIÁRIOS`, workspace
`9014971829 · Gabinete 509`) e grava `lib/db/reais.json`. Se o arquivo existir e
tiver leads, `inicializar()` usa ele; senão cai na semente fictícia de sempre.

As **estatísticas** varrem os 38 mil leads inteiros; só os primeiros `--leads=N`
são embarcados, porque o banco é um blob único em `localStorage` e a lista toda
não cabe. É a mesma distinção que a tela de Base já fazia: *"X cadastros · Y
carregados no aparelho"*.

> `lib/db/reais.json` tem nome, telefone e CPF de eleitores. Está no
> `.gitignore` — **não comitar**.

O que o ClickUp **não** tem, e por isso fica vazio em vez de inventado: **pets,
aniversário, idade, indicações e atendimentos**. Com a base real, o perfil mostra
menos coisa — a ficha do pet some e o motivo "aniversário" nunca entra na fila.
Seguidores de Instagram, meta e `apoioHoje` seguem vindo do mockup, marcados um
a um em [lib/db/reais.ts](lib/db/reais.ts).

## Dados

Ficam **no aparelho**, no armazenamento do navegador — nada é enviado para servidor. A base
de exemplo reproduz os números do mockup e traz 96 pessoas, uma fila de 47 (12 feitas), 12
solicitações abertas e a linha do tempo completa da Maria das Graças. Nomes e telefones são
fictícios. Todo acesso passa por um repositório (`lib/db/index.ts`), então migrar para um
banco de verdade é trocar um arquivo.

> `150.000 cadastros na base` é o número do CRM, guardado à parte. A tela de Base mostra
> quantos desses estão carregados neste aparelho.

## PWA

O convite de instalação está em **dois lugares**: um cartão logo abaixo do seu nome em
**Perfil**, e uma faixa dispensável no **Início**. No iPhone o botão abre o passo a passo
(Safari → Compartilhar → Adicionar à Tela de Início), porque o Safari não tem instalação
automática.

> **Em `npm run dev` não existe botão de instalar.** O service worker só é registrado em
> produção — sem ele o Chrome não considera o app instalável e nunca dispara o convite. Para
> instalar de verdade: `npm run build && npm run start`, e aí abra http://localhost:3011.

Instalado, o app abre em tela cheia, com ícone próprio e dois atalhos no toque longo (Fila e
Base). **E funciona sem internet**: como os dados ficam no aparelho, as quatro abas são
pré-carregadas na instalação e abrem normalmente no modo avião — o que não estiver em cache
cai numa tela de "sem conexão".

> Uma ressalva honesta: o service worker só é registrado **depois do login**, porque é ele
> que pré-carrega as telas protegidas. O primeiro acesso do dia, portanto, precisa de rede.

Arquitetura, decisões e armadilhas: **[AGENTS.md](AGENTS.md)**.
