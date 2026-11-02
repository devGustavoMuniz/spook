# Design system do Spook

Etapa 1 da repaginação. Fonte de verdade dos valores: `packages/brand/src/tokens.css` (cores, sombras, z-index, durações) e `apps/web/src/styles.css` (mapa para o Tailwind, raios, curvas, escala tipográfica, animações, CSS base). Os valores finais e o contraste calculado estão no [SPEC 9.2](../../SPEC.md). Antes e depois: `docs/design/antes/` (telas atuais), `docs/design/AUDITORIA.md` (problemas) e `docs/design/design-system/` (capturas dos componentes nos dois temas).

Página viva: `pnpm --filter @spook/web dev` e abra `http://localhost:5180/dev/design-system`. A rota só existe com `import.meta.env.DEV`; o build de produção não a inclui (conferido: o texto da página não aparece em `dist/assets`). Para regerar as capturas: `DESIGN_BASE_URL=http://localhost:5180 pnpm --filter @spook/web exec playwright test -c design/playwright.config.ts design/design-system.spec.ts`.

## Princípios

1. **Token, nunca valor solto.** Cor, raio, sombra, duração e z-index vêm de variável. Nada de `#hex`, `emerald-500`, `z-50` nas telas.
2. **Superfícies em camadas.** `background` (fundo) < `surface-1`/`sidebar` (painéis) < `surface-2`/`card`/`popover` (cartões, diálogos) < `surface-3` (elevado, hover forte). Cada degrau muda a luminosidade; a borda (`border`) separa o que a cor não separa.
3. **Roxo com função.** `primary` (#7C5CC4) é botão e destaque; para texto roxo use `text-brand-text` (mais escuro no claro, mais claro no escuro, para passar de 4.5:1).
4. **Tudo que é clicável tem cursor pointer e estados** (hover, active, focus-visible, disabled). Isso é CSS base: componente novo não precisa repetir (veja abaixo).
5. **Movimento só com `transform` e `opacity`**, com os tokens `--ease-*` e `--dur-*`; com `prefers-reduced-motion` tudo vira instantâneo (exceto `.motion-essential`, como o spinner).
6. **Nada de cor sozinha para estado.** Erro, sucesso e presença também têm ícone, texto ou forma.

## Tokens

### Cores

| Grupo | Tokens (classe Tailwind) |
| --- | --- |
| Marca | `brand-50` … `brand-950` (`bg-brand-500`, `text-brand-300`…); 500 = #7C5CC4 do logo |
| Superfícies | `background`, `surface-1`, `surface-2`, `surface-3`, `card`, `popover`, `sidebar`, `muted`, `secondary`, `accent`, `overlay` |
| Texto | `foreground`, `muted-foreground`, `brand-text`, `destructive-text`, `success-text`, `warning-text`, `info-text` |
| Ação | `primary`, `primary-foreground`, `destructive`, `destructive-foreground` |
| Semânticas | `success`, `warning`, `info` (+ `-foreground`, `-text`, `-soft` para fundos suaves); `danger-soft` |
| Campos e foco | `border`, `input` (borda de campo, 3:1), `field` (fundo do campo), `ring` |
| Presença e voz | `online`, `idle`, `dnd`, `invisible`, `offline`, `speaking` (anel de quem fala) |
| Rolagem | `scroll-thumb`, `scroll-thumb-hover` |
| Mascote (ilustrações) | `ghost-body`, `ghost-line`, `ghost-eye`, `ghost-accent`, `ghost-cup` |

Os nomes do shadcn (`background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`, `sidebar`) continuam existindo e significando o mesmo.

### Raios, sombras e brilho

- Raios (`rounded-*`): `xs` 4, `sm` 6, `md` 8 (controles), `lg` 12 (menus, toasts), `xl` 16 (cartões, diálogos), `2xl` 20, `full`.
- Sombras (`shadow-*`): `xs`, `sm`, `md`, `lg`, `xl`; no escuro ficam mais densas e ganham um filete de luz. `shadow-glow` é o brilho neon do mascote, **só para realces** (hover do botão primário no escuro, foco de destaque). `shadow-speaking` é o anel verde de fala.

### Espaçamento

Escala do Tailwind (múltiplos de 4 px). Convenção: 4 e 8 entre elementos íntimos, 12 e 16 dentro de controles/linhas, 24 dentro de cartões e diálogos, 32+ entre seções. Gutter lateral de página: 16 px no celular, 24 px de 640 px em diante.

### Tipografia

Instrument Sans, auto-hospedada (`@fontsource/instrument-sans`, pesos 400, 500 e 600; confirmado em `styles.css` e `package.json`). A interface usa `text-sm` (14/22) como corpo.

| Uso | Classe | Tamanho / entrelinha |
| --- | --- | --- |
| Display | `text-4xl font-semibold tracking-tighter` | 38 / 44 |
| Título de página | `text-3xl` / `text-2xl font-semibold tracking-tight` | 30 / 36, 24 / 32 |
| Seção, título de diálogo | `text-xl` / `text-lg font-semibold` | 20 / 28, 18 / 26 |
| Corpo | `text-base` (16/24) para leitura longa, `text-sm` (14/22) na interface | |
| Legenda | `text-xs` | 12 / 16 |
| Mínimo (selos, contadores) | `text-2xs` | 11 / 16 |

Títulos (`h1`–`h4`) já recebem `text-wrap: balance` e `letter-spacing` apertado; parágrafos, `text-wrap: pretty`. **Números tabulares** (`font-variant-numeric: tabular-nums`) em `<time>`, `[data-numeric]` e na classe `.tabular`: use em horários, contadores, tamanhos e tabelas.

### Z-index

`--z-sticky` 10, `--z-dropdown` 40, `--z-overlay` 50, `--z-modal` 60, `--z-popover` 70 (menus e selects abrem acima de diálogos), `--z-toast` 80, `--z-tooltip` 90. Use `z-[var(--z-modal)]`, nunca números soltos.

### Movimento

Curvas: `--ease-standard` (cubic-bezier .2,0,0,1; trocas de estado), `--ease-out` (.16,1,.3,1; entradas), `--ease-in` (.4,0,1,1; saídas), `--ease-spring` (.34,1.56,.64,1; polegar do switch e microinterações). Durações: `--dur-instant` 80 ms, `--dur-fast` 120, `--dur-base` 180, `--dur-slow` 260, `--dur-slower` 400. Animações prontas (`animate-*`): `overlay-in/out`, `dialog-in/out`, `pop-in/out` (menus, selects, tooltips), `slide-in`, `shimmer` (skeleton), `speaking` (pulso do anel de fala). Todas só mexem em `transform` e `opacity`.

## CSS base (camada `base`, `apps/web/src/styles.css`)

Fica no CSS para que **nenhuma tela nova esqueça**:

- **Cursor**: `cursor: pointer` em `button`, `[role=button|tab|menuitem*|option|switch|checkbox|radio|link|slider]`, `a[href]`, `summary`, `select`, checkbox/radio/range/file/color e em `label` que envolve checkbox, radio ou switch. `[data-clickable]` liga o mesmo comportamento a um elemento sem papel semântico (mas prefira `<button>`).
- **Desativado**: `:disabled`, `[aria-disabled=true]`, `[data-disabled]` e `fieldset:disabled *` ganham `cursor: not-allowed`; botões, campos, switches, abas e itens de menu ficam com opacidade .5. Não use `pointer-events-none` em controle desativado (o cursor deixaria de aparecer).
- **Hover e active**: cada componente define a cor do hover; o CSS base dá a transição (cor, fundo, borda, sombra, opacidade) e o `:active` (`scale: .98`) em botões, abas, switches e links.
- **Foco**: `:focus-visible` desenha um anel de 2 px (`ring`) com offset de 2 px; em campos, o offset é 0 e a borda vira `ring`. Nunca use `outline-none` sem substituto; item de menu usa `data-highlighted`.
- **Seleção de texto** em roxo translúcido; **rolagem fina** (`scrollbar-width: thin` e `scrollbar-color`, com fallback WebKit); **`color-scheme`** por tema; `text-size-adjust`, `text-rendering`, imagens e SVG como bloco.
- **`prefers-reduced-motion`**: zera animações e transições; exceção: `.motion-essential` (spinner).
- **Links** dentro de texto (`a[href]` sem classe) saem em `brand-text` com sublinhado no hover.

Utilitários: `bg-brand-glow` (fundo com brilho roxo difuso no topo, para telas de entrada, vazios e o palco de voz), `bg-brand-wash` (versão discreta para painéis), `scrollbar-none`, `motion-essential`.

## Componentes (`apps/web/src/components/ui/`)

Todos aceitam `className` (mesclado com `cn`) e repassam as props nativas. Variantes tipadas com `cva`. Foco, cursor e desativado vêm do CSS base.

| Componente | Variantes e notas |
| --- | --- |
| `Button` | `variant`: default, destructive, outline, secondary, **soft**, ghost, link. `size`: sm, default, lg, **xl**, icon, **icon-sm**, **icon-lg**. `loading` mostra o spinner no lugar do conteúdo, bloqueia o clique e põe `aria-busy`. `asChild` mantém o Slot (sem `loading`). |
| `Input`, `Textarea` | `Input size`: sm, default, lg. Hover com borda de marca, foco com borda `ring`, `aria-invalid` vermelho, `read-only` com fundo `muted`. |
| `Label` | `required` acrescenta o asterisco (decorativo). |
| `Field` (`components/form-field.tsx`) | rótulo + controle + `hint` + `error` com ícone (`role="alert"`) + `required`. Mesma API de antes. |
| `Select` | mesmo visual dos campos; conteúdo com animação `pop`. |
| `Dialog` | `DialogContent size`: sm, md (padrão), lg, xl, full. Entrada/saída `dialog-in/out` + `overlay-in/out`. `AlertDialog` igual (confirmações). Rodapé empilha no celular. |
| `DropdownMenu`, `ContextMenu` | itens (`destructive`), `CheckboxItem`, `RadioItem`, `Label`, `Separator`, `Shortcut`, submenu. Visual único em `menu-styles.ts`. |
| `Tooltip` | `TooltipProvider` com atraso de 300 ms; combina com `Kbd`. |
| `Tabs` | `variant`: pill (padrão), underline (em `TabsList` e `TabsTrigger`). |
| `Toaster` (sonner) | superfície `popover`, raio `lg`, cores semânticas (sucesso, erro, aviso, info) por tokens. Texto de toast: verbo no passado, uma linha. |
| `Avatar` | `size`: xs 20, sm 28, md 40, lg 64, xl 96, 2xl 128 ou número. `fallback`: `logo` (padrão, SPEC 9.4) ou `initials` (iniciais sobre gradiente derivado de `seed`/nome por hash, sempre com texto branco AA). `speaking` acende o anel verde; `status` põe a bolinha de presença com anel. Helpers: `avatarColor`, `initialsOf`, `StatusDot`. `components/avatar.tsx` re-exporta. |
| `Badge` | `variant`: default, brand, secondary, outline, success, warning, destructive, info. `CountBadge`: "99+" acima de `max`, números tabulares, `tone` mention (vermelho) ou brand. |
| `Switch` | `size`: default, sm; polegar com `--ease-spring`. |
| `Slider` | Radix; 1 valor ou intervalo; polegar com anel de foco. |
| `Skeleton` | bloco com brilho deslizante (só `transform`); estático com movimento reduzido. |
| `Separator` | horizontal/vertical, decorativo por padrão. |
| `ScrollArea` | barras finas do Radix para listas internas. |
| `Kbd` | tecla de atalho. |
| `EmptyState` | `illustration` (slot), `title`, `description`, `action`. |
| `Spinner` | `motion-essential`; use dentro de `Button loading` ou isolado. |
| `Card` | refinado (borda, raio `xl`, `shadow-sm`). |

Ilustrações (`components/illustrations/`, cada uma bem abaixo de 4 KB): `EmptyChatIllustration` (canal sem mensagens), `VoiceInviteIllustration` (convite para a voz), `NotFoundIllustration` (404 e erros). São SVG próprios derivados do corpo do mascote do logo, coloridos pelos tokens `ghost-*` (trocam com o tema), `aria-hidden`. Uso: `<EmptyState illustration={<EmptyChatIllustration />} title="..." />`.

## Como usar nas próximas etapas

- Troque `bg-black/60`, `emerald-500`, `zinc-*` e cores soltas pelos tokens acima ao tocar numa tela.
- Elemento clicável novo: use `<button>` ou `<a href>` (ganha tudo do CSS base). Se for `div`, dê `role` e `tabIndex`.
- Estado de carregamento de botão: `loading`, não texto "Salvando...".
- Estado vazio: `EmptyState` com ilustração e uma ação.
- Antes de subir: `node scripts/contrast.mjs` (falha se algum par dos tokens ficar abaixo de AA).

## Shell (barra de servidores, canais e responsividade)

Código em `apps/web/src/components/shell.tsx` e `components/authed-layout.tsx`. Desktop (>= 768 px) é o fluxo de sempre: barra de servidores (72 px) + lista lateral (240 px) + conteúdo + membros (>= 1024 px). Abaixo disso o app é usável assim:

- **< 768 px: drawer de navegação.** Barra de servidores e lista lateral (canais ou DMs) ficam num único painel que desliza pela esquerda (`Drawer`, `role="dialog"`, `aria-modal`, foco preso e devolvido ao botão, Esc, toque no fundo e navegação para um canal fecham; `inert` quando fechado e `inert` no conteúdo quando aberto). Escolher um **servidor** na barra mantém o drawer aberto para mostrar os canais dele (`holdNav`). Só `transform` e `opacity` animam; `100dvh` e `env(safe-area-inset-*)` já estão aplicados (`viewport-fit=cover`).
- **< 1024 px: membros viram sheet pela direita**, aberto por `MembersToggle` (`lg:hidden`).
- Sem `matchMedia` (jsdom) vale o layout de desktop; os testes simulam a largura (veja `src/shell.test.tsx`).

Como as próximas etapas devem usar (nenhuma reimplementa drawer, medição ou foco):

| Âncora | Uso |
| --- | --- |
| `NavToggle` | Primeiro item do **cabeçalho** de toda tela do app (`<header>` do canal, da DM, da voz, páginas). Só aparece < 768 px. Telas sem cabeçalho (avisos, vazios) usam `<NavToggle className="absolute top-2 left-4" />` (`Notice` já faz). |
| `MembersToggle` | Botão do cabeçalho do canal de servidor que abre o painel de membros < 1024 px. |
| `ShellSidebar` | Envolve a lista lateral esquerda de uma tela (`ChannelSidebar`, `DmSidebar`). Em desktop é no fluxo; em tela estreita é montado dentro do drawer (portal). A largura/borda continuam no elemento filho. |
| `SideSheet label className` | Painel lateral direito (membros; fixadas/detalhes no futuro). `className` é o visual de desktop (largura, borda, fundo); abaixo de 1024 px o conteúdo vai para um `Drawer` à direita. O conteúdo deve preencher a altura (`min-h-0 flex-1`, lista com `overflow-y-auto`). |
| `Drawer open onClose side label` | Primitiva para novos painéis modais laterais; use no lugar de criar outro. |
| `useShell()` | `compact`, `navOpen/setNavOpen`, `membersOpen/setMembersOpen`. `null` fora da área autenticada. |
| `useMediaQuery(NAV_COMPACT_QUERY \| SIDE_COMPACT_QUERY)` | Para decisões de layout em JS; prefira classes `md:`/`lg:` quando bastar CSS. |

Regras do conteúdo: o contêiner do conteúdo é `min-w-0 flex-1` com altura da tela (`h-dvh`); telas devem rolar **por dentro** (lista de mensagens, painéis), nunca a página. Cabeçalho do canal: `h-12`, `NavToggle` à esquerda, ações à direita (`ml-auto`), `truncate` no título.

Barra de servidores: pílula lateral (ativo alto; hover/foco médio; não lidas ponto), ícone circular que vira quadrado arredondado, dica à direita (120 ms), badge vermelho de menções (99+), servidor silenciado atenuado com sino, cor/iniciais derivadas do id quando não há ícone, ação "+" em verde. Lista de canais: categorias recolhíveis (estado por servidor em `localStorage` `spook:collapsed-categories:<id>`, com try/catch; recolhida mantém visíveis o canal aberto, os com novidades e a voz com gente), ativo em `brand-500/15`, não lidas em semibold + marcador lateral, participantes de voz aninhados com anel `speaking` animado.

## Pendências para as etapas seguintes

- Avatar sem imagem continua com a mini logo (SPEC 9.4); a troca para iniciais coloridas é uma decisão por tela (a API já suporta).
- Cores de cargo vêm do servidor (`color`) e não passam por garantia de contraste; as telas devem escolher texto/fundo conforme a luminância.
- Shell responsivo feito (seção "Shell"); o conteúdo do chat, membros e fixadas ainda precisa ser revisto para 390 px nas etapas seguintes.
