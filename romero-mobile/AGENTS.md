# Central Animal (romero-mobile)

App mobile-first e instalável (PWA) da operação do Romero: **gated single-tenant**
(só o acesso do Romero) sobre os dados do discador. Não é mais um app de base local —
todo dado operacional vem do **backend do discador RomeroCall** pelas pontes
`app/api/mobile/*`. O ciclo, na ordem em que as telas o percorrem:

```
login → Início (fila do dia + operação ao vivo) → Base (Lista 01) → Ficha do lead
      (dossiê · apoio · timeline · anotação) → registrar interação/voto
```

- **Rodar:** `npm run dev` → http://localhost:3011
- **Login:** `LOGIN_USERS` no `.env.local` — **um único** registro, o acesso do Romero
  (dev: `admin@admin.com` / `admin`). Ver `.env.example`.
- **Stack:** Next.js 16 (App Router) · React 19 · TypeScript estrito · Tailwind v4
  (CSS-first) · `lucide-react`
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

## A trava: gated single-tenant (só o Romero)

A operação é single-tenant. Duas camadas:

1. **`LOGIN_USERS`** (proxy/sessão) é um único registro Romero — o portão principal.
2. **`exigirRomero`** (`lib/autorizacao.ts`) é o endurecimento server-side, aplicado em
   TODAS as rotas `app/api/mobile/*` e em `app/api/callcenter/token` (login/logout não
   têm, correto). Sem sessão → 401. Se `ROMERO_LOGINS` estiver definida, só os logins da
   lista passam (senão 403); vazia/ausente, qualquer sessão válida passa — o `LOGIN_USERS`
   único já é o portão, a lista é endurecimento opcional.

**LGPD:** nunca logar telefone/CPF/token/usuário em claro.

---

## Telas

| Rota | Tela | O que responde | Fonte |
|---|---|---|---|
| `/` | 01 · Início | Fila do dia + operação ao vivo (métricas), e a Central de Campanha no fim da coluna | `api/mobile/fila`, `api/mobile/metricas` |
| `/fila` | 02 · Fila de hoje | O que fazer agora, na ordem do motor do discador | `api/mobile/fila` |
| `/base` + `/base/[id]` | 03 · Base / Ficha do lead | Lista 01 de leads; ficha com dossiê, apoio, timeline e anotação | `api/mobile/leads`, `api/mobile/lead/[id]` |
| `/base/[id]/linha-do-tempo` | 04 · Linha do tempo | Todo registro do lead | `api/mobile/timeline/[taskId]` |
| `/perfil` | — | Operador, instalação e dados. Única tela fora de mockup | sessão |

> **O que saiu:** as telas de Equipe e de Nova Solicitação, o ciclo de tarefas da equipe,
> o botão de WhatsApp e o store localStorage com semente. Não há mais base local para
> alimentar — os dados vivem no backend do discador.

---

## Mapa

```
app/
  globals.css          design system (paleta + classes do mockup)
  motion.css           keyframes: pulso, foguete, entradas, folha
  (app)/               casca autenticada: page.tsx monta Início + SecaoCampanha,
                       layout com PageTransition, TabBar, BootDados, RegisterSW
  login/ offline/ manifest.ts icon.tsx icones/[size]/
  api/
    auth/              login, logout
    callcenter/token/  troca sessão por token do discador (exigirRomero)
    mobile/            PONTES para o backend do discador (todas exigirRomero):
      fila/            fila do dia
      leads/           Lista 01 (Base)
      lead/[id]/       ficha; + /voto e /anotacao
      timeline/[taskId]/  linha do tempo
      metricas/        operação ao vivo
proxy.ts               gate de sessão (era `middleware.ts` — Next 16 renomeou)
components/
  telas/               uma tela por arquivo + blocos, Folha, Foguete
                       Inicio.tsx (cliente) · Base.tsx · Fila.tsx · PerfilLead.tsx ·
                       LinhaDoTempo.tsx · Perfil.tsx
                       Campanha.tsx → SecaoCampanha (SERVIDOR, seção do Início) +
                       CampanhaGraficos.tsx (SVG à mão) + RankingCampanha.tsx (ilha cliente)
  shell/               TabBar, PageTransition, BootDados, RegisterSW, InstallPrompt
  brand/               patinha (SVG na UI, DIVs para o satori dos ícones)
lib/
  autorizacao.ts       exigirRomero — a trava server-side
  sessao.ts            cookie de sessão (HMAC, fail-closed em prod)
  fila-real.ts leads-real.ts metricas-real.ts   hooks que pedem às pontes mobile
  leads-util.ts        helpers PUROS (ex.: `iniciais`) — sobrevivente do antigo schema
  discador-servidor.ts contato.ts               integração com o discador
  campanha.ts          telemetria da campanha — hoje VAZIA (sem fonte ao vivo)
  campanha-config.ts   meta, calendário e equipe — CONSTANTE, decisão de campanha
  format.ts texto.ts fotos.ts
public/sw.js           service worker escrito à mão
```

> **Sem `lib/db/`**: o store localStorage, a semente e o `reais.json` foram removidos.
> Não há mais `npm run puxar:clickup`, `predev`/`prebuild` nem `VERSAO_BANCO`.

---

## Decisões que valem conhecer

### Dados vêm do backend do discador, não de base local

Não há mais repositório localStorage nem semente. Cada tela pede à sua ponte
`app/api/mobile/*`, que repassa ao backend do discador com Bearer server-side e devolve o
status TAL QUAL — em especial `403` quando o backend não tem `DISCADOR_LEAD_BROWSE=1`, caso
em que a Base mostra "acesso não habilitado" (ver `lib/leads-real.ts` / `Base.tsx`). O
`localStorage` que ainda existe é só cache de cliente (fila, foto, operador) e preferência
(banner de instalação) — não é fonte da verdade.

### A Central de Campanha é SEÇÃO do Início, e não passa por rede

Ela **não é rota**: entra no fim da coluna do Início, depois dos tiles. É componente de
SERVIDOR; a única ilha cliente é `RankingCampanha.tsx` (seletor de ordenação). Tudo o que
tem fonte fixa vem de **`lib/campanha.ts` + `lib/campanha-config.ts`**: meta de votos,
calendário e tamanho da equipe são decisão de campanha (constante). **Todo o resto
(ligações, contatos, tempo médio, ranking, cobertura, SLA) está VAZIO hoje** — a extração
periódica em arquivo foi desacoplada e a tela diz "sem dados ainda" (via `SemDados`, const
`VAZIO`). Voltará quando existir uma rota de agregação ao vivo; aí `real` vira um `fetch`.

**O `children` de `Inicio` não é enfeite.** `Inicio` é cliente e `SecaoCampanha` é servidor;
cliente não pode IMPORTAR servidor, mas pode RECEBÊ-LO como `children`. Quem monta o par é
`app/(app)/page.tsx`. Importar a seção dentro do `Inicio` a arrastaria para o cliente. Por
isso `{children}` fica SEMPRE no último índice do `.view`, FORA de qualquer condicional de
carregamento: enquanto os tiles reais hidratam/pedem dados, só eles viram barras; a campanha
já está desenhada embaixo e não pisca junto.

### Só a navegação sobreviveu da versão anterior

`components/shell/TabBar.tsx` é a única peça herdada: ilha flutuante que recolhe ao rolar,
rail lateral em ≥900px. Lê tokens de nome antigo (`--accentSoft`, `--muted`, `--radius-pill`…)
e as classes `ds-chrome`/`ds-count`/`ds-truncate`, que viram **aliases** para a paleta nova
num bloco marcado em `globals.css`. É a única compatibilidade que existe. **A barra tem 4
abas:** Início · Fila · Base · Perfil.

### PWA — instalável, shell offline

O service worker (`public/sw.js`, à mão, sem workbox) pré-carrega as quatro abas na
instalação, então a casca do app abre sem rede. **Mas os dados operacionais vêm do backend**
— offline, as telas abrem e mostram o cache/"sem conexão" conforme o caso, não uma base
local completa como na versão anterior.

- **Onde fica o botão**: cartão em `/perfil` + faixa dispensável no Início (`InstallBanner`).
  Ambos saem de `InstallPrompt.tsx`.
- **Ícones** (`app/icones/[size]`, `app/icon.tsx`, `app/apple-icon.tsx`): gerados em build
  com `next/og`. Nenhum binário versionado.
- **`RegisterSW` mora em `app/(app)/layout.tsx`, não no layout raiz.** No raiz ele registrava
  já em `/login`, e o precache das rotas protegidas pegava só redirecionamento. Registrar
  depois da sessão resolve.
- **Nunca cachear resposta redirecionada** (`cacheavel()` em `sw.js`): sessão expirada
  responde 307 para `/login`; guardar isso prende o usuário no login.
- **Subir `VERSAO` invalida todos os caches antigos** no `activate`. Hoje `central-animal-v7`.

---

## Armadilhas já pagas (não reintroduzir)

1. **CSS sem camada vence CSS em camada, sempre.** `* { padding: 0 }` fora de camada anulava
   o gutter do `.view`; `button { background: none }` fora de camada apagava o fundo de
   `.act`/`.cta`/`.seg`. **Todo reset vive em `@layer base`**; overrides de `:root` ficam
   FORA de camada, porque o `:root` base também está.
2. **`:root` dentro de media query pode perder por especificidade** se o bloco base for uma
   lista com `:root[data-theme]`. Hoje o `:root` é simples, mas a regra vale se voltar a ter tema.
3. **O preflight do Tailwind faz `svg { display: block }`** — ícone no meio de texto cai para
   a linha de baixo. `globals.css` reverte para `inline-block`.
4. **`app/icon.*` é convenção de arquivo do Next.** Por isso os ícones do PWA moram em
   `app/icones/[size]`.
5. **Satori (`ImageResponse`) não suporta `transform` em `<ellipse>`.** A patinha dos ícones
   é desenhada com `<div>` em `components/brand/marcaOg.tsx`.
6. **O service worker não pode ser redirecionado.** O matcher do `proxy.ts` deixa passar
   `sw.js`, manifest, ícones e `/offline`.
7. **`useSearchParams` exige `<Suspense>`** na renderização estática. Vale para qualquer tela
   que leia query string.
8. **Conteúdo que não depende do estado fica FORA do condicional, no mesmo índice nos dois
   caminhos de `return`.** Filho sem `key` casa POR ÍNDICE — dois `return` de formas
   diferentes fazem o React ver tipos diferentes no mesmo índice e DELETAR/remontar a
   subárvore (a campanha inteira já foi reconstruída no quadro da hidratação por causa disso).
   Por isso o `{children}` da campanha fica sempre no último índice do `.view`.
9. **Escopo de classe NÃO protege contra a mesma classe definida fora.** `.cc .cbar .track`
   vence `.track` só nas propriedades que DECLARA; reusar nome do mockup que já existe no app
   exige ZERAR o que não se quer, como `.cc .seg` e `.cc .valrow .lab` já fazem.
10. **`@container` não é sinônimo de `@media`.** Condição de largura que fala do RAIL usa o
    critério que cria o rail (`@media (min-width: 900px)`), não `@container`.
11. **Opacidade portada de mockup claro escurece no escuro.** Trocar `opacity` das pastilhas
    por `color-mix(… , var(--bg-1))`, que mistura com fundo OPACO.
12. **Nome de classe do mockup pode ser UTILITÁRIO do Tailwind.** O anel do pódio chamava-se
    `.ring` (utilitário v4) e `@layer utilities` vence `@layer components`. Virou `.aro`. Antes
    de copiar um nome do mockup, confira se não é utilitário (`ring`, `border`, `shadow`,
    `truncate`, `container`, `transform`, `filter`, `blur`…).
13. **Não existe instalação em `npm run dev`.** `RegisterSW` só registra em produção, e sem
    service worker o Chrome não dispara `beforeinstallprompt`. Por isso `InstallPrompt` NUNCA
    renderiza só texto: sem o evento nativo, o botão abre o passo a passo da plataforma.

---

## Deploy

Produção: **https://romero-mobile.vercel.app** (Vercel, projeto `romero-mobile`, branch `main`).

**O ambiente do host não herda nada do `.env.local`.** Deploy sem `LOGIN_USERS` responde
`503 · Nenhum usuário configurado`, e depois cai em `503 · AUTH_SECRET ausente ou fraco`:
duas minas deliberadas (ver `lib/sessao.ts` — fail-closed em produção). Variável nova só vale
a partir de um **build novo**. As pontes `api/mobile/*` dependem do backend do discador ter
`DISCADOR_LEAD_BROWSE=1` para liberar a Lista 01.

## Verificação

```bash
npm run typecheck     # tsc --noEmit, estrito
npm run build         # sem ignoreBuildErrors (sem prebuild — nada gera base local)
npm run dev           # 3011
```
