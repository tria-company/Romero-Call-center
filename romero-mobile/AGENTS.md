# Central Animal

Sistema de **relacionamento direto** do gabinete, mobile-first e instalável (PWA).
O ciclo, na ordem em que as telas o percorrem:

```
candidato → fila do dia → lead (pet, atendimentos) → linha do tempo → solicitação
```

> O ciclo era fechado: a solicitação virava tarefa da **equipe**, e resolver devolvia um
> **retorno** para a fila. A tela de Equipe foi removida a pedido e o ciclo ficou aberto —
> ver "O ciclo está ABERTO" mais abaixo.

- **Rodar:** `npm run dev` → http://localhost:3011
- **Login:** `LOGIN_USERS` no `.env.local` (dev: `admin@admin.com` / `admin`)
- **Stack:** Next.js 16 (App Router) · React 19 · TypeScript estrito · Tailwind v4 (CSS-first) · `lucide-react`
- **Sem** lib de estado, de gráficos ou de UI: tudo é CSS e código próprio.

**A referência visual é `ROMERO/interfaces-mobile-central-animal.html`.** O design system
usa os MESMOS nomes de classe do mockup (`.m`, `.ig`, `.cand`, `.rocket`, `.task`, `.qbar`,
`.lblk`, `.tl`, `.seg`, `.act`, `.cta`, `.autobox`, `.prof`, `.pet`, `.tag`) — manter os
nomes é o que garante que a tela seja a mesma coisa que o mockup, e não uma releitura.
Mudou o mockup? Mude `app/globals.css` primeiro.

**A Central de Campanha tem uma segunda referência**, `ROMERO/central-campanha-romero.html`,
e a mesma regra vale lá — só que aquele arquivo traz nomes que já existem aqui com outro
sentido (`.row`, `.stack`, `.seg`, `.card`). Por isso o vocabulário dele inteiro vive **dentro
de `.cc`**, o `<section>` que embrulha a seção no fim do Início. Como `.cc` não é a `.view`,
ele traz a própria coluna flex; o container de `@container` e `cqi` continua sendo a `.view`.

---

## Telas

| Rota | Tela do mockup | O que responde |
|---|---|---|
| `/` | 01 · Início | Seguidores, base, fila do dia, as duas urnas — e, no fim da coluna, a Central de Campanha |
| `/fila` | 02 · Fila de hoje | O que fazer agora, na ordem do motor |
| `/base` + `/base/[id]` | 03 · Perfil do lead | Quem é, qual o pet, o que já recebeu — e os canais (WhatsApp, Ligar) |
| `/base/[id]/linha-do-tempo` | 04 · Linha do tempo | Todo envio, com visualização e resposta |
| `/base/[id]/solicitacao` | 05 · Nova solicitação | O pedido virando tarefa da equipe |
| `/perfil` | — | Operador, instalação e dados. Única tela fora de mockup |

> A tela 06 · Equipe **foi removida a pedido**. Ver "O ciclo está aberto" abaixo.

---

## Mapa

```
app/
  globals.css          design system (paleta + classes do mockup)
  motion.css           keyframes: pulso, foguete, entradas, folha
  (app)/               casca autenticada: PageTransition + TabBar
  login/ offline/ manifest.ts icon.tsx icones/[size]/ api/auth/
proxy.ts               gate de sessão (era `middleware.ts` — Next 16 renomeou)
components/
  telas/               uma tela por arquivo + blocos, Folha, Foguete
                       Campanha.tsx → SecaoCampanha, seção do Início e não
                       tela (servidor) + CampanhaGraficos.tsx (SVG à mão, sem
                       lib) + RankingCampanha.tsx (única ilha cliente)
  shell/               TabBar, PageTransition, BootDados, RegisterSW, InstallPrompt
  brand/               patinha (SVG na UI, DIVs para o satori dos ícones)
lib/
  db/                  schema, seed, store (localStorage), hooks
  campanha.ts          números da Central de Campanha — CONSTANTE, fora do db
  contato.ts format.ts texto.ts sessao.ts fotos.ts
public/sw.js           service worker escrito à mão
```

---

## Decisões que valem conhecer

### Só a navegação sobreviveu da versão anterior

`components/shell/TabBar.tsx` é a única peça herdada (foi o pedido): ilha flutuante que
recolhe ao rolar para baixo, rail lateral em ≥900px. Ela lê alguns tokens de nome antigo
(`--accentSoft`, `--muted`, `--radius-pill`…) e as classes `ds-chrome`/`ds-count`/
`ds-truncate`. Em vez de reescrevê-la, esses nomes viram **aliases** para a paleta nova, num
bloco marcado em `globals.css`. É a única compatibilidade que existe.

A versão anterior inteira está em `../central-animal.v1-backup` (só o código-fonte).

### Dados no aparelho, atrás de um repositório

`lib/db/store.ts` é o **único** arquivo que toca `localStorage`. Toda função é `async` —
trocar por Postgres/Supabase é reescrever aquele arquivo, sem tocar em tela.

- Chave versionada; **mexeu em `seed.ts`, suba `VERSAO_BANCO` NA MESMA EDIÇÃO — no ÚLTIMO
  passo, nunca no primeiro.** Quem já abriu o app fica com a base antiga para sempre: o
  store só re-semeia quando a versão gravada difere. Já aconteceu **duas vezes**, e a
  segunda foi pior: o número subiu para 5 antes de o campo novo existir, o dev recarregou no
  meio, e o navegador gravou um banco "v5" SEM o campo. Dali em diante `versao` batia, o
  store devolvia aquele banco, e a tela que lia o campo ficou em esqueleto permanente —
  sem erro nenhum, no navegador ou no terminal.
  **Aba anônima e teste automatizado não pegam isso** — começam com localStorage vazio e a
  semente nova sempre roda. Para reproduzir, grave a versão antiga à mão e recarregue.
- Reatividade por `useSyncExternalStore`. **Toda mutação cria um snapshot novo** (objeto raiz
  e coleções) — mutar no lugar deixaria `Object.is` sem ver mudança e a tela não repintaria.
- A semente é determinística, mas as **datas** são relativas ao primeiro boot: é isso que faz
  existir aniversariante hoje, solicitação vencendo hoje e retorno de ontem.
- Os números de tela do mockup são reproduzidos exatamente (84.312 / 61.847 seguidores,
  150.000 cadastros, 18.427 ativos, fila 12/47, 12 solicitações, 14.208 e 13.940 de apoio).
- `cadastros: 150.000` é um número do CRM, guardado em `painel`. A base LOCAL tem 96 pessoas
  — a tela de Base diz as duas coisas, para o número grande não virar mentira.

### PWA — instalável e offline de verdade

Como os dados vivem no `localStorage`, o app **funciona inteiro sem rede**. Por isso o
service worker (`public/sw.js`, escrito à mão, sem workbox) pré-carrega as quatro abas na
instalação — sem isso, abrir uma aba ainda não visitada no avião cairia em `/offline` mesmo
com todos os dados na mão.

- **Onde fica o botão**: cartão em `/perfil` (logo abaixo da identidade) + faixa dispensável
  no Início (`InstallBanner`, some com `ca.instalar.oculto`). Ambos saem de `InstallPrompt.tsx`.
- **Ícones** (`app/icones/[size]`, `app/icon.tsx`, `app/apple-icon.tsx`): gerados em build
  com `next/og`. Nenhum binário versionado, e o desenho acompanha os tokens da marca.
- **Screenshots do manifest** (`public/telas/*.jpg`): capturas REAIS do app, não pôsteres.
  Regeradas com o script de screenshot apontando para `public/telas`.
- **`RegisterSW` mora em `app/(app)/layout.tsx`, não no layout raiz.** No raiz ele registrava
  já em `/login`, e aí o precache das rotas protegidas pegava só redirecionamento para o
  próprio login — o app não abria offline. Registrar depois da sessão resolve.
- **Nunca cachear resposta redirecionada** (`cacheavel()` em `sw.js`): sessão expirada
  responde 307 para `/login`; guardar isso prende o usuário no login mesmo depois de entrar,
  e o navegador recusa servir resposta redirecionada para pedido de navegação.

### O ciclo está ABERTO: a Equipe foi removida

A tela de Equipe saiu a pedido, e com ela o único lugar do app onde uma solicitação era
**assumida** e **resolvida**. O ciclo do topo deste arquivo hoje termina em `solicitação`:

```
candidato → fila do dia → lead (pet, atendimentos) → linha do tempo → solicitação → ⌀
```

O que isso significa na prática, e não é bug, é consequência:

- uma solicitação criada fica **aberta para sempre** — nada a move de `aberta` para
  `assumida` ou `resolvida`;
- a **regra de domínio 3** (`resolverSolicitacao` devolve a tarefa de retorno para o topo da
  fila) ficou inalcançável, então a fila só recebe retorno pelo que a semente já criou;
- o número "Solicitações abertas" do Início continua contando, mas **deixou de ser link** —
  não há mais destino;
- `NovaSolicitacao` passou a voltar para a ficha do lead (`/base/[id]`) em vez de
  `/equipe?novo=…`; é lá que a solicitação recém-criada aparece.

O código de domínio ficou de pé em `lib/db/store.ts` (marcado como sem chamador), justamente
para que devolver a tela seja religar duas funções — e não reescrever a regra.

### A Central de Campanha é SEÇÃO do Início, e não passa pelo banco

Ela **não é rota**: entra no fim da coluna do Início, depois das duas urnas. Não há sexta
aba — houve por algumas horas, e saiu junto com a rota quando a seção mudou de lugar.

Ela fala de urnas, telefonistas e ritmo; o resto do app fala de leads e pets. Os números
NÃO se cruzam de propósito, e agora ficam na MESMA tela, um abaixo do outro: as urnas
mostram `apoio confirmado` da base local (14.208 do Romero), a campanha mostra `votos
confirmados` pelo telemarketing (18.240 de 40.000). É por isso que a seção abre com
cabeçalho próprio e o dobro do respiro — sem essa quebra, dois números diferentes com o
mesmo nome ficariam colados.

Tudo vem de **`lib/campanha.ts`, uma constante fora de `lib/db`** — e a seção é componente
de SERVIDOR. A única ilha cliente é `RankingCampanha.tsx`, pelo seletor de ordenação.

**O `children` de `Inicio` não é enfeite de API.** `Inicio` é cliente (lê o localStorage) e
`SecaoCampanha` é servidor; cliente não pode IMPORTAR servidor, mas pode RECEBÊ-LO como
`children`. Quem monta o par é `app/(app)/page.tsx`. Importar a seção dentro do `Inicio` a
arrastaria para o cliente e ela voltaria a esperar a hidratação — que é o problema que tirar
aqueles números do localStorage resolveu. Por isso também o esqueleto do Início é PARCIAL:
enquanto a base hidrata, só os blocos locais viram barras; a campanha já está desenhada.

**Isso já foi feito errado uma vez.** Os números moraram dentro do `Banco` por algumas
horas (a v5 da semente). Custou: a tela virou cliente, passou a exibir esqueleto até o
localStorage hidratar e, quando um navegador gravou um banco marcado como v5 **antes** de o
campo `campanha` existir, o esqueleto virou permanente — `versao` batia, o store devolvia o
banco velho e a tela esperava um dado que nunca chegaria. Regra que fica: **dado que nunca
muda não vai para o repositório.** Quando a telemetria for real, vira `fetch`, e aí o
repositório volta a fazer sentido.

- **A abertura do mockup foi RETIRADA a pedido**: o alternador Campanha/Semana/Hoje, as
  pílulas "demonstração" e "ao vivo", a linha "Dia 12 de 30" e os dois cartões de meta das
  urnas. A tela abre no título e vai direto ao gráfico acumulado. Os números daqueles
  cartões continuam em `lib/campanha.ts` (`metas`, `dia`, `inicio`, `eleicao`), marcados
  como sem consumidor — devolver o bloco é remontar a marcação, não redigitar o mockup.
  O CSS deles (`.top-meta`, `.seg`, `.chip`, `.diasep`, `.pill`, `.mark`, `.marca`) segue no
  bloco `.cc` pelo mesmo motivo.
- Três desvios do mockup, todos anotados no código: o eixo dos gráficos vale 14 unidades em
  vez de 9 (9 dá 4,6px de tela num celular), a etiqueta "meta 40k" desceu para debaixo da
  própria linha, e a lista do ranking só rola dentro do cartão no rail — no celular, rolável
  dentro de rolável prende o toque.

### As três regras de domínio

1. **Ordem da fila** (`MOTIVO_PESO`): retorno de entrega > aniversário > primeiro contato >
   reaquecimento. Quem acabou de receber algo do gabinete é quem mais perde se esperar.
2. **Bloqueio de repetição** (`useBloqueioRepeticao`): houve QUALQUER contato hoje — inclusive
   uma entrega da equipe — a tela avisa antes de deixar enviar de novo.
3. **Retorno automático** (`resolverSolicitacao`): resolver grava o atendimento na ficha,
   registra na linha do tempo e **devolve uma tarefa de retorno para o topo da fila**. É o
   gancho que fecha o ciclo.

---

## Armadilhas já pagas (não reintroduzir)

1. **CSS sem camada vence CSS em camada, sempre.** Pagamos isso três vezes:
   `* { padding: 0 }` fora de camada anulava o gutter do `.view` (telas encostando nas
   bordas), e `button { background: none }` fora de camada apagava o fundo de `.act`, `.cta`
   e `.seg`. **Todo reset vive em `@layer base`**; overrides de `:root` ficam FORA de camada,
   porque o `:root` base também está.
2. **`:root` dentro de media query pode perder por especificidade** se o bloco base for uma
   lista com `:root[data-theme]`. Hoje o `:root` é simples, mas a regra vale se voltar a ter
   tema.
3. **O preflight do Tailwind faz `svg { display: block }`** — ícone no meio de texto cai para
   a linha de baixo. `globals.css` reverte para `inline-block`.
4. **`app/icon.*` é convenção de arquivo do Next.** Por isso os ícones do PWA moram em
   `app/icones/[size]`.
5. **Satori (`ImageResponse`) não suporta `transform` em `<ellipse>`.** A patinha dos ícones
   é desenhada com `<div>` em `components/brand/marcaOg.tsx`.
6. **O service worker não pode ser redirecionado.** O matcher do `proxy.ts` deixa passar
   `sw.js`, manifest, ícones e `/offline`.
7. **`useSearchParams` exige `<Suspense>`** na renderização estática. O exemplo vivo era
   `app/(app)/equipe`, que saiu junto com a tela — vale na próxima que ler query string.
8. **Screenshots mobile precisam de CDP.** `--window-size` não produz viewport de celular
   neste Windows; use `page.setViewport({ isMobile: true, hasTouch: true })`. E o `clip` do
   puppeteer é relativo ao DOCUMENTO — some `window.scrollY` ao `getBoundingClientRect()`.
   Gravar o arquivo por `writeFileSync(await page.screenshot({ encoding: "binary" }))`: o
   `path:` do puppeteer falha em silêncio dentro do OneDrive.
9. **`page.setOfflineMode()` NÃO deixa o service worker offline.** O SW tem contexto de rede
   próprio e continua buscando normalmente, então um teste baseado nisso passa sem provar
   nada. Para testar offline de verdade, **derrube o servidor** e navegue
   (`scratchpad/offline-real.mjs` faz isso: sobe `next start`, loga, mata o processo e
   confere as quatro abas). **O script não está versionado** — vive no scratchpad da sessão.
10. **Filho sem `key` casa POR ÍNDICE — e dois `return` de formas diferentes destroem a
    subárvore.** O `Inicio` tinha um `return` de esqueleto (`[Skels, children]`) e um de
    conteúdo (`[Vhead, igrow, mrow, banner, urnas, children]`). Na virada, o React comparava
    o `<section class="cc">` que estava no índice 1 com o `<div class="igrow">` que passou a
    ocupá-lo, via tipos diferentes e DELETAVA a campanha inteira, remontando-a três posições
    adiante — 577 elementos e 17 SVGs reconstruídos no quadro da hidratação, e a escolha do
    `<select>` do ranking perdida. **Conteúdo que não depende do estado fica FORA do
    condicional, no mesmo índice nos dois caminhos.** Regressão silenciosa: nada quebra na
    tela, só pisca. Para testar, um `MutationObserver` instalado antes da hidratação contando
    remoções de `section.cc` (`scratchpad/remonta.mjs`) — sem controle negativo esse teste
    passa igual com e sem o defeito.
11. **Escopo de classe NÃO protege contra a mesma classe definida fora.** `.cc .cbar .track`
    vence `.track` só nas propriedades que DECLARA; o `margin-top: 11px` do `.track` global
    (medidor da Fila) continuava valendo dentro da campanha e, num grid com
    `align-items:center`, descia a barra 5,5px em relação ao rótulo. Reusar nome do mockup
    que já existe no app exige ZERAR o que não se quer, como `.cc .seg` e `.cc .valrow .lab`
    já fazem.
12. **`@container` não é sinônimo de `@media`.** O rolável interno do ranking devia valer só
    onde há rail (`@media (min-width: 900px)`), mas estava escrito como
    `@container (min-width: 560px)` — que a caixa de conteúdo da `.view` cruza com ~608px de
    janela. iPad em pé, tablet e iPhone deitado ganhavam o rolável-dentro-de-rolável que a
    regra existia para evitar. Condição de largura que fala do RAIL usa o critério que cria
    o rail.
13. **Opacidade portada de mockup claro escurece no escuro.** As pastilhas da legenda vinham
    com `opacity: .4/.5` sobre cor cheia: no cartão branco do mockup isso clareia, no cartão
    quase preto daqui escurece até sumir — e a pastilha da projeção ficava mais fraca que a
    de "meta ideal", invertendo a hierarquia do gráfico. Trocar opacidade por
    `color-mix(… , var(--bg-1))`, que mistura com fundo OPACO.
14. **Nome de classe do mockup pode ser UTILITÁRIO do Tailwind.** O anel do pódio do
    ranking chama-se `.ring` no mockup — e `ring` é utilitário do Tailwind v4
    (`box-shadow: 0 0 0 1px #fff`). O scanner o gera só de vê-lo na marcação, e
    `@layer utilities` vence `@layer components`: os três primeiros do ranking saíam com um
    quadrado branco em volta do retrato, e o CSS da tela parecia certo em toda inspeção.
    Virou `.aro`. Antes de copiar um nome do mockup, confira se ele não é utilitário
    (`ring`, `border`, `shadow`, `truncate`, `container`, `transform`, `filter`, `blur`…).
15. **Não existe instalação em `npm run dev`.** `RegisterSW` só registra em produção, e sem
    service worker o Chrome não dispara `beforeinstallprompt` — o convite simplesmente não
    aparece. Por isso `InstallPrompt` **nunca** renderiza só texto: sem o evento nativo, o
    botão abre o passo a passo da plataforma (é o único caminho no iPhone de qualquer jeito).
    Um estado sem botão vira "cadê o botão de instalar?", e já virou.

---

## Deploy

Produção: **https://romero-mobile.vercel.app** (Vercel, projeto `romero-mobile`, ligado ao
branch `main` deste repo).

**O ambiente do host não herda nada do `.env.local`** — ele é ignorado pelo git, como deve
ser. Deploy sem `LOGIN_USERS` responde `503 · Nenhum usuário configurado`, e depois de
resolver esse cai em `503 · AUTH_SECRET ausente ou fraco`: são duas minas em sequência, e
as duas são deliberadas (ver `lib/sessao.ts` — fail-closed em produção). A lista de
variáveis está no README. Variável nova só vale a partir de um **build novo**.

## Verificação

```bash
npm run typecheck     # tsc --noEmit, estrito
npm run build         # sem ignoreBuildErrors
npm run dev           # 3011
```

Central de Campanha validada dentro do Início, em 390px, **com o JavaScript desligado**: os
10 cartões, os 2 gráficos e as 12 linhas do ranking já ordenadas saem do HTML enquanto os
blocos locais ainda são 5 barras de esqueleto — é a prova de que a seção é de servidor. Com
JavaScript: esqueleto zerado, a seção depois das duas urnas, `select.sort` reordenando, e
`/campanha` respondendo 404. Sem erro de console. **A barra tem 4 abas** desde que a Equipe
saiu: Início · Fila · Base · Perfil.

Fluxo ponta a ponta já validado: login → Início (números do mockup, foguetes subindo) →
Fila (12/47, ordem por motivo) → tocar no lead → Perfil (pet, atendimentos, **WhatsApp +
Ligar + Registrar interação**) → Linha do tempo (5 registros, selos) → Nova solicitação (tudo em
botão) → Enviar → volta para a ficha do lead, onde ela aparece em aberto. **Daí em diante o
fluxo para**: assumir e resolver moravam na Equipe, que não existe mais.
