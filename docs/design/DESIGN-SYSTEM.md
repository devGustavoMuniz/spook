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
| `Avatar` | `size`: xs 20, sm 28, md 40, lg 64, xl 96, 2xl 128 ou número. `fallback`: `initials` (padrão: iniciais sobre gradiente derivado de `seed`/nome por hash, sempre com texto branco AA) ou `logo` (mini logo; só casos de marca). `speaking` acende o anel verde; `status` põe a bolinha de presença com anel. Helpers: `avatarColor`, `initialsOf`, `StatusDot`. `components/avatar.tsx` re-exporta. |
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

## Configurações

Código em `apps/web/src/features/settings/` e `pages/` (`profile`, `notifications`, `settings-voice`, `settings-appearance`, `app-settings`). Rotas em `router.tsx` (`/settings` + `profile|notifications|voice|appearance|app`; `/profile` redireciona).

- **Layout.** Tela cheia, sem barra de servidores (o `Frame` de `authed-layout.tsx` só renderiza o `Outlet` em `/settings*`). Desktop: navegação à esquerda (`w-72`/`lg:w-80`, fundo `sidebar`, cartão do usuário no topo, item ativo com `aria-current="page"` em `accent`, "Sair" no rodapé) + conteúdo (`max-w-[44rem]`) que rola por dentro; botão fechar redondo com `Kbd` Esc no canto superior direito. < 768 px: `/settings` é a lista (h1 "Configurações"), cada seção é uma tela com barra superior "voltar às configurações" + fechar.
- **Acessibilidade.** Um `h1` por tela (título da seção, recebe o foco ao entrar e a cada troca de seção), `nav` "Seções das configurações", `main` rotulado pelo `h1`, grupos com `h2`. Esc e fechar voltam para a rota anterior (`return-path.ts`; fallback `/`).
- **Peças** (`features/settings/ui.tsx`): `SettingsGroup` (cartão com ícone, `h2`, ajuda e conteúdo), `SettingRow` (rótulo + ajuda + controle), `ChoiceCard` (opção em radio nativo com `has-[:checked]`), `Hint`, `selectClass`. Use-as para qualquer configuração nova; `CardTitle` ganhou a prop `as` (`h1` padrão) para virar `h2`.
- **Aparência.** Cartões de tema com prévia em miniatura; as cores da prévia são os valores literais de `tokens.css` (a prévia precisa mostrar o tema ESCOLHIDO, não o ativo): atualize se os tokens mudarem.

## Chat e lista de membros

Código em `apps/web/src/features/messages/`, `features/members/` e `features/attachments/`.

- **Mensagens.** Agrupamento em `rows.ts` (mesmo autor em até 7 min, quebra por dia, resposta e "Novas mensagens"). Cabeçalho: nome na cor do cargo ajustada por `lib/role-color.ts` (`readableRoleColor` clareia/escurece até 4,7:1 sobre `surface-1` do tema; `textOn` escolhe preto/branco por luminância), hora tabular com tooltip de data completa. Separador de dia = pílula entre linhas; "Novas mensagens" = linha + pílula `danger-soft`. Menção: `@usuário` de quem está na conversa vira pílula (`mark`, a minha com realce forte); mensagem que me menciona ganha fundo `brand-500/10` e marcador lateral.
- **Ações.** Barra flutuante no canto superior direito (`role="toolbar"`, `opacity` no hover e no `focus-within`; Tab alcança) com responder, fixar, editar, excluir e "Mais" (copiar texto/ID), tooltips com `Kbd` (R, P, E). Em telas sem hover (`@media (hover:none)`) a barra some e o botão "Ações da mensagem de X" fica sempre visível; toque longo (450 ms) na mensagem abre o mesmo menu completo.
- **Citação** com curva até o avatar, avatar mini, `@nome` e prévia truncada (clique pula para a original).
- **Anexos.** Imagens com proporção reservada, skeleton enquanto carregam e raio `xl`; cartão de arquivo com ícone por tipo e extensão. Visualizador (`lightbox.tsx` + `viewer-context.tsx`): um só por conversa, setas passam por todas as imagens carregadas, clique amplia a partir do ponto (só `transform`), baixar, `Esc`, foco preso e devolvido.
- **Composer.** Superfície `surface-2` com raio `2xl` e borda de foco; anexar à esquerda, campo auto-altura, enviar à direita (`secondary` quando desabilitado); contador `n/2000` só a partir de 1800 (`COUNTER_FROM`); faixa "Respondendo a…" no topo da superfície; chips de anexos com prévia; dica de atalhos (`Kbd`) só em telas largas; arrastar e soltar mostra área tracejada.
- **Estados.** Vazio com `EmptyChatIllustration` + ação "Escrever a primeira mensagem"; carregamento com skeleton de mensagens; botão "Pular para o presente" (conta as novas de outras pessoas enquanto você está longe); fixadas num diálogo com skeleton, vazio e erro com "Tentar de novo".
- **Membros.** `groups.ts`: cada cargo (maior posição primeiro) com quem está online e o tem como mais alto, depois "Online" e "Offline" (invisível conta como offline); título `text-xs` com contagem. Acima de 150 linhas a lista é virtualizada. Item: avatar + status com anel, nome na cor do cargo (AA), status personalizado em linha secundária, offline com avatar atenuado (o texto mantém contraste).
- **Cartão de perfil** (`profile-card.tsx`, hospedado por `MemberUiProvider` em `member-ui.tsx`, junto dos diálogos de cargos/expulsar): popover ancorado >= 640 px (Radix Dialog não modal, sem biblioteca nova) ou bottom sheet no celular. Só mostra o que a API tem: nome, `@username`, status, cargos, membro desde, enviar mensagem, copiar ID, gerenciar cargos e expulsar (com permissão).
- **Avatar.** Sem imagem = iniciais sobre cor derivada do id (as letras vêm de `attr(data-initials)` em CSS, fora do texto da página).

## Palco de voz

Código em `apps/web/src/features/voice/stage/` (usado por `voice-channel-view.tsx` e, em DM, por `call-panel.tsx`).

- **Grade** (`layout.ts`, `bestGrid`): tiles 16:9 `rounded-xl` com largura calculada pela área medida (`ResizeObserver`), centralizados, `gap` de 12 px; duas pessoas ficam lado a lado e, em < 600 px, uma coluna com rolagem. Recalcula ao entrar/sair gente.
- **Tile** (`participant-tile.tsx`): avatar grande (iniciais, `fallback="initials"`) sobre gradiente da cor dominante do avatar (`dominant-color.ts`: canvas 8x8, cache por URL, sem imagem ou com falha de CORS cai na cor derivada do id) com escurecimento embaixo; rodapé em pílula `bg-black/60` com nome e ícones (mudo/surdo em `destructive`, câmera, tela). Falando = anel `speaking` estático no tile + anel pulsante (`animate-speaking`, só `transform`/`opacity`) no avatar. Câmera ocupa o tile (`object-cover`); tela é um tile à parte "Tela de X" (`object-contain`).
- **Foco**: clicar/Enter no tile de vídeo o destaca (tile grande + tira inferior); de novo ou `Esc` volta; o foco do teclado acompanha o tile. Tela cheia (Fullscreen API) no tile e no botão do palco. Menu do tile ("⋯" ou clique direito): destacar, volume, janela flutuante (PiP), tela cheia.
- **Barra flutuante** (`control-bar.tsx`, `role="toolbar"`): microfone (`M`), câmera (`V`), tela, dispositivos e sair (redondo, vermelho). `use-auto-hide.ts`: some após 3 s sem movimento; fica visível com foco de teclado na barra, mouse sobre ela, menu/diálogo aberto (`useStageHold`), conectando/reconectando e, em toque, o toque no palco alterna (o primeiro toque na barra escondida só a mostra).
- **Convite** (`invite-tile.tsx`): com uma só pessoa, tile tracejado com `VoiceInviteIllustration` e "Convidar para voz", que abre as configurações do servidor na aba Convites (sem permissão: desabilitado com o motivo). Em DM não há tile de convite.
- **Estados**: conectando/reconectando (pílula com `Spinner`), áudio bloqueado ("Ativar áudio"), falha de mídia (faixa `role="alert"` com a mensagem de `media-errors.ts`, dispensável), voz desligada no servidor (`EmptyState` "Voz indisponível").

## Diálogos, DMs, estados e admin

Código em `components/ui/dialog.tsx`, `components/state-screen.tsx`, `components/error-boundary.tsx`, `features/guilds|channels|members|dms/`, `pages/home|invite|guild|dms.tsx` e `features/admin/`.

**Diálogos.** Padrão: `<DialogContent flush size=...>` com `DialogHead` (ladrilho de ícone `bg-accent`, título, descrição), `DialogBody` (rola; cabeçalho e rodapé ficam) e `DialogActions` (fundo `surface-1`, borda no topo). Hierarquia de botões: primário à direita, secundário (`ghost`/`outline`) à esquerda dele, destrutivo isolado em `start` ou em confirmação (`AlertDialog`, ação `destructive`). O "x" do `Dialog` tem 32 px, hover e foco. Tamanhos: `sm` confirmações curtas e formulários de um campo, `md` formulários, `xl` configurações do servidor (altura `min(44rem, 92svh)`). Formulários com erro inline (`Field`), `autoFocus` no primeiro campo e `loading` no botão de envio. Alterações não salvas: `features/guilds/dirty.tsx` (`useReportDirty`) faz o diálogo de configurações perguntar antes de fechar por Esc, clique fora ou "x".

**Cargos.** Desktop: lista (`w-64`) + detalhe. Abaixo de 768 px: lista → detalhe, com "Todos os cargos" no topo do detalhe. Permissões em `PERMISSION_GROUPS` (Geral, Texto, Voz, Moderação), cada grupo um cartão de linhas com rótulo, descrição e `Switch` alinhado à direita. Cor: nove amostras nomeadas (`aria-pressed`), cor personalizada e "Sem cor". Rodapé do detalhe: excluir à esquerda, "Alterações não salvas" e "Salvar cargo".

**Convites.** Cartão por convite (`li`): código em fonte mono, link, usos e validade com ícones, "Copiar link" que vira "Copiado" por 2 s e "Revogar" com confirmação. O convite recém-criado ganha selo "Novo".

**DMs.** `DmSidebar`: busca, avatar 36 px com status, título (negrito se não lida), `time` da última mensagem (do Snowflake; some no hover para dar lugar ao menu), selecionada com `brand-500/15` + filete lateral, hover distinto. Grupo mostra "N participantes". O cabeçalho da conversa leva avatar, nome e status/participantes, fixadas, ligar e (grupo) participantes.

**Estados.** `StateScreen` (dentro do shell, com `NavToggle`), `StatePage` (página inteira, cartão central como o 404) e `ErrorState`. Textos: título curto no que aconteceu, uma linha de como resolver, uma ação primária. Ilustrações: `NotFoundIllustration` (não encontrado), `ErrorIllustration` (rede/falha), `EmptyChatIllustration` (sem conversas), `VoiceInviteIllustration` ("já é membro"). `ErrorBoundary` (+ `errorComponent` do roteador) mostra `CrashScreen` e nunca o stack.

**Admin.** Barra lateral `w-64` com `Logo`, itens com ativo `brand-500/15`, recolhível (drawer animado por `transform` < 768 px). `StatCard` (ícone, número tabular, esqueleto), `Section`, `Facts`, `DataTable` (cabeçalho fixo, `scroll-shadow-x`, indicador de ordenação em `brand-text`, paginação com ícones, `TableSkeleton`/`TableEmpty`/erro com "Tentar de novo"). `LiveStatus` é uma pílula discreta com o ponto `online`. Gráficos: barras `brand-500`, hoje mais claro, linha de base e grade com `border`; `<title>` como tooltip nativo e a tabela por trás para leitores de tela.

## Pendências para as etapas seguintes

- (feito na etapa de chat) Avatar sem imagem agora usa iniciais coloridas por padrão em todo o app.
- Cores de cargo vêm do servidor (`color`): use `readableRoleColor`/`useReadableRoleColor` (`lib/role-color.ts`) ao exibir o nome (chat e membros já usam).
- Shell responsivo, chat, membros e fixadas já foram revistos para 390 px.
