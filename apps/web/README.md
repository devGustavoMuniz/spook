# @spook/web

Front-end do Spook (React 19, Vite, TanStack Router/Query/Virtual, Tailwind, componentes no estilo shadcn em `src/components/ui`).

- `pnpm --filter @spook/web dev`: Vite na porta 5180 (proxy de `/api` para o backend em `:8090`).
- `pnpm --filter @spook/web test`: Vitest + React Testing Library + MSW (backend falso em `src/test/server.ts`).
- Medir a lista de mensagens: em desenvolvimento, abra `/channels/<servidor>/<canal>?perf=10000`. A rota injeta 10.000 mensagens falsas (só no `DEV`; o build de produção ignora o parâmetro).

## Design: capturas e referência dos componentes

Fora do CI e do `pnpm e2e` (Playwright próprio em `design/`; docs em `docs/design/`):

- `/dev/design-system` (só no `pnpm dev`): referência viva dos componentes, nos dois temas. Capturas: `DESIGN_BASE_URL=http://localhost:5180 pnpm --filter @spook/web exec playwright test -c design/playwright.config.ts design/design-system.spec.ts`.
- Capturar todas as telas (claro/escuro, 1440 e 390 px) contra o build servido pelo backend (mesmo passo a passo do E2E abaixo, com Garage liberando a origem e LiveKit local para o palco de voz): `DESIGN_OUT=antes|depois pnpm --filter @spook/web exec playwright test -c design/playwright.config.ts design/capture.spec.ts`. Saída em `docs/design/<DESIGN_OUT>/NN-tela-tema-viewport.png`; o que não deu para capturar fica em `_falhas.txt`. Cada execução cria contas e servidores novos. Se o Chromium do Playwright instalado não bater com a versão, aponte `CHROMIUM_PATH` para um Chromium completo.
- Acessibilidade e teclado (foco visível, `cursor: pointer`, `prefers-reduced-motion`; sem dependências novas): `A11Y_WRITE=1 pnpm --filter @spook/web exec playwright test -c design/playwright.config.ts design/a11y-check.spec.ts` (mesmos pré-requisitos da captura; grava `docs/design/a11y-check.txt`).
- O palco de voz da captura só mostra as outras pessoas se o webhook do LiveKit (`http://server:8090`) alcançar o backend usado: com um backend extra, dê a ele o alias de rede `server` e a porta 8090 dentro do container.
- Bundle: `scripts/bundle-size.sh` (raiz do repositório) lista bruto e gzip de cada chunk JS/CSS do `apps/web/dist`. Contraste dos tokens: `node scripts/contrast.mjs`.

## E2E (Playwright, RNF06)

O E2E roda contra o **build de produção** do front servido pelo próprio backend (`SPOOK_WEB_DIR`), com Postgres real. O fluxo crítico (`e2e/critical-flow.spec.ts`): cadastro, criar servidor, ver `geral`/`Geral`, enviar mensagem, recarregar, criar convite e uma segunda conta (outro contexto de navegador) entrar pelo convite. O tempo real (`e2e/gateway.spec.ts`, Fase 3): duas contas, mensagem sem recarregar, resume depois de ficar offline e perda de VIEW_CHANNEL no meio da sessão. A Fase 4 (`e2e/dms.spec.ts`) cobre DMs 1:1 e em grupo com 3 contas, presença (online, ausente com relógio falso e offline) e "digitando…"; ela precisa do backend com `SPOOK_PRESENCE_OFFLINE_GRACE=2s` (offline em 2 s em vez de 15 s; é só para o E2E, produção usa o padrão). A Fase 6 (`e2e/attachments-notifications.spec.ts`) cobre anexos com thumbnail, não lidas, menções, avisos in-app e a inscrição de push com `serviceWorker`/`PushManager` simulados (push real não dá para receber no Playwright: fica em `VALIDACAO-MANUAL.md`). Cada execução registra mais de 10 contas e o limite padrão de `/api/auth/*` é de 10 por minuto por IP; por isso o backend do E2E sobe com `SPOOK_AUTH_RATE_PER_MIN=1000` (só para o E2E; produção usa o padrão) e, sem essa variável, convém esperar cerca de um minuto entre execuções seguidas.

Contas e perfil (`e2e/account.spec.ts`): cadastro, troca de senha (a outra sessão cai), troca de e-mail com o diálogo "Confirme sua senha", login com a senha nova e exclusão da conta; não precisa de serviços extras.

O painel administrativo (`e2e/admin.spec.ts`) confere que quem não é admin é barrado (web e API) e que o admin abre o dashboard e a lista de usuários. Promover a conta exige o banco, então o teste do admin roda o comando de `E2E_PROMOTE_CMD` (com `{username}` no lugar do username) e é **pulado sem ele**. No CI: `psql` contra o Postgres do job. Local, com o Postgres do Compose: `E2E_PROMOTE_CMD="docker exec spook-postgres-1 psql -U spook -c \"UPDATE users SET is_admin = true WHERE username = '{username}'\""` (no container do Playwright não há `docker`; passe a variável ao `docker run` só se montar o socket, ou rode o spec do host com `E2E_BASE_URL=http://localhost:8090 pnpm --filter @spook/web e2e admin`).

Manter conectado (`e2e/remember-me.spec.ts`): o checkbox vem marcado; marcado, o cookie `spook_session` é persistente (~90 dias) e a sessão sobrevive a recarregar e a um contexto novo com `storageState`; desmarcado, é cookie de sessão (`expires = -1`) e some com o contexto. Não precisa de serviços extras.

E-mail e recuperação de senha (`e2e/email-recovery.spec.ts`): cadastro com faixa "Verifique seu e-mail", link de verificação aberto em outro navegador (uso único) e "Esqueci minha senha" até entrar com a senha nova. Precisa de um backend em **desenvolvimento** com o e-mail ligado (`SPOOK_ENV=development MAILER_DRIVER=log MAIL_FLOWS_ON_LOG=true PUBLIC_URL=<a URL do backend>`): o e-mail sai no log e em `GET /api/dev/mail/last?to=` (rota que **não existe** em produção), de onde o teste lê o link. Sem e-mail ligado o teste pula sozinho. Com a flag ligada, o teste de troca de e-mail do `account.spec.ts` muda de comportamento (a troca passa a pedir confirmação no endereço novo): rode as duas suítes em backends diferentes.

Moderação (`e2e/moderation.spec.ts`): banir e tentar reentrar, canal privado ao vivo, apelido, registro de auditoria e telas em 390 px; não precisa de serviços extras.

Social (`e2e/social.spec.ts`): pedir e aceitar amizade pela tela de Amigos, DM entre amigos sem servidor em comum, bloqueio (DM e mensagem nova recusadas sem revelar o bloqueio), convidar amigo para um servidor pela DM (cartão de convite) e, em 390 px, a tela de Amigos sem rolagem horizontal. A chamada em DM tocando, recusando, cancelando e atendendo só roda com **voz ligada no backend** (`LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET`; valores de desenvolvimento servem porque o toque não fala com o LiveKit) e pula sozinha sem elas (como no job `e2e` do CI; com elas o `voice-off.spec.ts` é que pula). Para o cartão de convite aparecer, `PUBLIC_URL` do backend precisa ser a mesma origem que o navegador usa (`E2E_BASE_URL`). Cada ligação conta no limite de 5 de rajada por usuário; o teste usa 5.

Variável: `E2E_BASE_URL` (padrão `http://localhost:8090`).

### Local, sem instalar nada global (Docker)

1. Infra e build do front: `pnpm infra:up && pnpm --filter @spook/web build`.
2. Backend servindo o build (o arquivo de override monta `apps/web/dist` em `/web`; ele pode ficar em qualquer pasta, só o caminho do volume precisa ser absoluto):

   ```sh
   cat > /tmp/spook-e2e.yml <<YML
   services:
     server:
       volumes:
         - $PWD/apps/web/dist:/web:ro
       environment:
         SPOOK_WEB_DIR: /web
         SPOOK_PRESENCE_OFFLINE_GRACE: 2s
         SPOOK_AUTH_RATE_PER_MIN: "1000"
   YML
   docker compose --env-file .env -f deploy/docker-compose.yml -f /tmp/spook-e2e.yml up -d --build server
   ```

3. A suíte, no container oficial do Playwright (a tag acompanha a versão do `@playwright/test`):

   ```sh
   docker run --rm --ipc=host -v "$PWD":/repo -w /repo/apps/web \
     -e CI=1 -e E2E_BASE_URL=http://host.docker.internal:8090 \
     mcr.microsoft.com/playwright:v1.64.1-noble node node_modules/@playwright/test/cli.js test
   ```

4. Para encerrar: `docker compose --env-file .env -f deploy/docker-compose.yml stop server`.

### Anexos no E2E (Garage e River)

O teste de anexos envia arquivos de verdade ao storage por URL pré-assinada e espera o `MESSAGE_UPDATE` do worker de thumbnails (River), então o backend precisa de Garage e o **navegador precisa alcançar o endpoint S3 que o backend assina**:

- No Docker (passo 2 acima), acrescente `S3_ENDPOINT: http://host.docker.internal:3900` ao `environment` do override (o container do backend e o do Playwright alcançam o Garage publicado no host) e libere a origem do front no CORS do bucket, uma vez: `COMPOSE_ENV_FILE=.env.e2e deploy/garage-init.sh`, onde `.env.e2e` é uma cópia do `.env` com `S3_CORS_ORIGINS=http://localhost:5180,http://localhost:8090,http://host.docker.internal:8090` (o script aceita lista separada por vírgulas; apague o arquivo depois). Atenção: `pnpm infra:up` (e o `scripts/verify.sh`) roda o `garage-init.sh` com o `.env` e **volta o CORS ao padrão**; refaça o passo antes do E2E. Também pare o `server` do override antes de rodar os testes de integração: o worker do River dele disputa os jobs (push e thumbnail) com o do teste.
- No CI o job `e2e` sobe o Garage pelo Compose, roda `deploy/garage-init.sh` com a origem `http://localhost:8090` e passa as variáveis `S3_*` ao backend.

### Com Playwright instalado (CI)

`pnpm --filter @spook/web exec playwright install --with-deps chromium` e depois `pnpm --filter @spook/web e2e` (o job `e2e` do `.github/workflows/ci.yml` faz isso, com o binário do backend em segundo plano e relatório/traces como artefato em caso de falha).

Cada execução cria contas com sufixo único; o banco local é reaproveitado.

### Voz com mídia real (Fase 5, só local)

`e2e/voice.spec.ts` não roda no job `e2e` do CI (não há LiveKit lá): é o projeto Playwright `voice`, ligado por `E2E_VOICE=1`. Duas contas em contextos separados entram no mesmo canal de voz com a câmera e o microfone falsos do Chromium (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`), e a mídia passa de verdade pelo LiveKit de desenvolvimento (áudio remoto, vídeo decodificado, tela compartilhada, mudo, saída). O `e2e/voice-off.spec.ts` (backend sem LiveKit: aviso de voz indisponível) roda na suíte normal e pula sozinho quando o backend tem LiveKit.

O navegador do container precisa alcançar o LiveKit e o backend pela rede do Compose, e o backend precisa devolver ao navegador uma URL do LiveKit que ele alcance (`LIVEKIT_URL=ws://livekit:7880` em vez de `ws://localhost:7880`):

1. `pnpm infra:up && pnpm --filter @spook/web build`. Se o LiveKit já estava de pé antes de o `livekit.yaml` ganhar o `webhook`, reinicie-o: `docker restart spook-livekit-1`.
2. Backend servindo o build com a URL do LiveKit da rede do Compose (arquivo de override em qualquer pasta, caminho do volume absoluto):

   ```sh
   cat > /tmp/spook-e2e-voice.yml <<YML
   services:
     server:
       volumes:
         - $PWD/apps/web/dist:/web:ro
       environment:
         SPOOK_WEB_DIR: /web
         SPOOK_PRESENCE_OFFLINE_GRACE: 2s
         SPOOK_AUTH_RATE_PER_MIN: "1000"
         LIVEKIT_URL: ws://livekit:7880
   YML
   docker compose --env-file .env -f deploy/docker-compose.yml -f /tmp/spook-e2e-voice.yml up -d --build server
   ```

3. A suíte de voz, no container do Playwright **na rede do Compose** (`spook_default`), falando com o backend pelo nome do serviço:

   ```sh
   docker run --rm --ipc=host --network spook_default -v "$PWD":/repo -w /repo/apps/web \
     -e CI=1 -e E2E_VOICE=1 -e E2E_BASE_URL=http://server:8090 \
     mcr.microsoft.com/playwright:v1.64.1-noble node node_modules/@playwright/test/cli.js test
   ```

   O projeto usa `channel: "chromium"` e `--unsafely-treat-insecure-origin-as-secure=$E2E_BASE_URL`: `http://server:8090` não é um contexto seguro e, sem isso, o navegador esconde `getUserMedia`.
4. Ao terminar, volte o backend ao normal (`docker compose --env-file .env -f deploy/docker-compose.yml up -d server`) ou pare-o: `docker compose --env-file .env -f deploy/docker-compose.yml stop server`.

### Latência da entrada na voz

`e2e/voice-stream-stats.spec.ts` (projeto `voice`) mede a qualidade da tela compartilhada: A transmite uma "tela" falsa de 1920x1080 (canvas no lugar do `getDisplayMedia`) e B assiste em tile pequeno e em foco; o teste lê o `getStats()` real (resolução, fps e taxa recebidos e enviados), confere o tempo até o primeiro quadro, a imagem não preta, o painel "Estatísticas da transmissão" e a entrada tardia. `STATS_OUT=/caminho.json` grava a tabela medida e `STATS_ASSERT=0` desliga as asserções de qualidade (para medir um build antigo). Cuidado com o alias de rede: dois servidores com o alias `server` na mesma rede do Docker dividem o DNS e o E2E falha de forma enganosa (convite 404).

`JOIN_PERF_OUT=/repo/apps/web/e2e/lat.json pnpm --filter @spook/web e2e voice-join-perf` (mesmo ambiente do E2E de voz acima, projeto `voice`) entra e sai do canal 10 vezes por cenário (Padrão e Forte) e imprime a mediana de cada fase (`src/features/voice/join-perf.ts`); `JOIN_PERF_SIM=1` simula token e microfone lentos. Cada entrada gasta um token: o teste espera 2,3 s entre elas por causa do limite `voice.token` (30/min). As marcas também ficam na linha do tempo do navegador (`voice:*`) e em `window.__voiceJoinPerf`.

## Ruído e eco no microfone (voz, web)

O diálogo "Dispositivos de áudio e vídeo" tem a seção "Qualidade do microfone": redução de ruído em três níveis (Desligada, Padrão, Forte com IA), cancelamento de eco e ajuste automático de volume. Decisões e comparação em `SPEC.md` 5.5 ("Adicional: ruído e eco (web)").

- **Forte (IA)** usa o RNNoise em WASM num `AudioWorklet`, de `@sapphi-red/web-noise-suppressor` 0.4.1 (licença **MIT**; o RNNoise é BSD-3-Clause e o `rnnoise-wasm` embutido é Apache-2.0). Os arquivos de modelo (worklet e WASM, ~220 kB) saem do próprio pacote npm e são emitidos pelo build do Vite em `dist/assets/` (`?url`): **nenhum CDN em runtime**. Só são baixados quando alguém escolhe o nível Forte (`import()` em `src/features/voice/noise-processor.ts`).
- Sem `AudioWorklet`/WASM, com falha de download ou com processamento lento, a engine volta sozinha para "Padrão" e avisa.
- O teste `src/features/voice/noise-dsp.test.ts` roda o worklet e o WASM reais em Node (contexto `vm`), sem navegador: `pnpm --filter @spook/web exec vitest run src/features/voice/noise-dsp.test.ts`.
- O compartilhamento de tela abre antes um diálogo com "Incluir áudio" desligado por padrão (evita eco); `getDisplayMedia` usa `selfBrowserSurface: "exclude"`, `suppressLocalAudioPlayback` e `restrictOwnAudio`.

## Internacionalização (pt-BR e inglês)

Módulo próprio, sem biblioteca: `src/i18n/` (SPEC 5.5, "Adicional: internacionalização").

- **Catálogos** em `src/i18n/messages/pt-BR/<arquivo>.ts` (idioma-fonte) e `src/i18n/messages/en/<arquivo>.ts`, com chaves planas `ns.area.nome`. `MessageKey` deriva de pt-BR: `t("chave.inexistente")` não compila. Arquivos: `common`, `format` (padrões de data), `auth`, `shell`, `chat`, `people`, `guilds`, `voice`, `settings`, `system`.
- **Componentes**: `const { t } = useT();` e `t("chat.composer.placeholder", { channel })`. Fora de componentes (schemas Zod, handlers, toasts): `import { t } from "@/i18n"`, sempre dentro de funções (nunca em escopo de módulo, senão não troca ao vivo; use `{ error: () => t(...) }` no Zod).
- **Placeholders** `{nome}`; **plural** com `{ one: "{count} pessoa", other: "{count} pessoas" }` e `t(key, { count })` (`Intl.PluralRules`). Nada de concatenar frases.
- **Datas e números**: `lib/format.ts` (padrões em `format.*`), `formatNumber`, `formatBadge` (99+), `formatList`, `dateFnsLocale()` em `@/i18n`.
- **Idioma ativo**: `localStorage` (`spook-locale`) -> `navigator.language` -> pt-BR; troca ao vivo por `setLocale` (Configurações -> "Aparência e idioma" e menu do usuário); atualiza `<html lang>`. Só no navegador (não vai ao servidor).
- **Novo idioma**: adicione o código em `LOCALES` (`i18n/types.ts`) e em `LOCALE_NAMES`, crie `messages/<código>/` espelhando `en/`, registre em `catalogs` (`core.ts`) e no `dateFnsLocale`.
- **Nova chave**: crie em pt-BR e em en (mesmos placeholders). Os testes `catalog-parity.test.ts` (mesmas chaves, placeholders e formas) e `no-literal-pt.test.ts` (varre `src/**` atrás de texto pt-BR literal; fora dele: `i18n/`, testes, `pages/admin`, `features/admin`, `components/charts`, `pages/dev`) reprovam o esquecimento.
- **Fora**: o painel `/admin` fica só em pt-BR (ferramenta do dono). Erros do servidor sem `code` estável e o corpo dos push vêm em pt-BR (ver `lib/app-errors.ts`).

### Glossário pt-BR -> en

servidor = server; canal = channel; canal de voz/texto = voice/text channel; categoria = category; mensagem direta = direct message (DM); conversa em grupo = group DM; menção = mention; fixar = pin; silenciar = mute; ensurdecer = deafen; expulsar = kick; banir = ban; cargo = role; apelido = nickname; convite = invite; amigo = friend; bloquear = block; compartilhar tela = share screen; palco = stage; espectador = viewer; Ausente = Idle; Não perturbe = Do not disturb; Invisível = Invisible; entrar na conta = sign in; criar conta = create account; sair da conta = sign out. "Spook" não se traduz.

## Download do app e aviso de versão

- `/download` (pública, `features/download`): lê o último release pelo backend (`GET /api/downloads/latest`, com cache; se ele falhar, cai para a API do GitHub direto), destaca o instalador do seu sistema e mostra
  tamanho, versão, data e SHA-256. Testes com backend e GitHub mockados (MSW) em `features/download/download.test.tsx`.
- `vite-version-plugin.ts` embute `__APP_VERSION__/__APP_COMMIT__/__APP_BUILT_AT__` e publica `dist/version.json` (não no modo
  `desktop`). O sha vem de `SPOOK_COMMIT` (Docker/CI) ou do git. `lib/version-watcher.tsx` consulta o arquivo ao voltar o foco e a
  cada 10 min e mostra o banner "Nova versão disponível". Para ver o banner em um build local: `pnpm --filter @spook/web build`,
  sirva `dist/`, troque o `commit` em `dist/version.json` e volte o foco para a aba.
