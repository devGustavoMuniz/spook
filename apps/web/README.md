# @spook/web

Front-end do Spook (React 19, Vite, TanStack Router/Query/Virtual, Tailwind, componentes no estilo shadcn em `src/components/ui`).

- `pnpm --filter @spook/web dev`: Vite na porta 5180 (proxy de `/api` para o backend em `:8090`).
- `pnpm --filter @spook/web test`: Vitest + React Testing Library + MSW (backend falso em `src/test/server.ts`).
- Medir a lista de mensagens: em desenvolvimento, abra `/channels/<servidor>/<canal>?perf=10000`. A rota injeta 10.000 mensagens falsas (só no `DEV`; o build de produção ignora o parâmetro).

## E2E (Playwright, RNF06)

O E2E roda contra o **build de produção** do front servido pelo próprio backend (`SPOOK_WEB_DIR`), com Postgres real. O fluxo crítico (`e2e/critical-flow.spec.ts`): cadastro, criar servidor, ver `geral`/`Geral`, enviar mensagem, recarregar, criar convite e uma segunda conta (outro contexto de navegador) entrar pelo convite. O tempo real (`e2e/gateway.spec.ts`, Fase 3): duas contas, mensagem sem recarregar, resume depois de ficar offline e perda de VIEW_CHANNEL no meio da sessão. A Fase 4 (`e2e/dms.spec.ts`) cobre DMs 1:1 e em grupo com 3 contas, presença (online, ausente com relógio falso e offline) e "digitando…"; ela precisa do backend com `SPOOK_PRESENCE_OFFLINE_GRACE=2s` (offline em 2 s em vez de 15 s; é só para o E2E, produção usa o padrão). Cada execução registra 8 contas; o cadastro tem limite por IP, então espere cerca de um minuto entre execuções seguidas.

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
