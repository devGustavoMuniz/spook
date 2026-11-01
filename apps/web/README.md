# @spook/web

Front-end do Spook (React 19, Vite, TanStack Router/Query/Virtual, Tailwind, componentes no estilo shadcn em `src/components/ui`).

- `pnpm --filter @spook/web dev`: Vite na porta 5180 (proxy de `/api` para o backend em `:8090`).
- `pnpm --filter @spook/web test`: Vitest + React Testing Library + MSW (backend falso em `src/test/server.ts`).
- Medir a lista de mensagens: em desenvolvimento, abra `/channels/<servidor>/<canal>?perf=10000`. A rota injeta 10.000 mensagens falsas (só no `DEV`; o build de produção ignora o parâmetro).

## E2E (Playwright, RNF06)

O E2E roda contra o **build de produção** do front servido pelo próprio backend (`SPOOK_WEB_DIR`), com Postgres real. O fluxo crítico (`e2e/critical-flow.spec.ts`): cadastro, criar servidor, ver `geral`/`Geral`, enviar mensagem, recarregar, criar convite e uma segunda conta (outro contexto de navegador) entrar pelo convite. O tempo real (`e2e/gateway.spec.ts`, Fase 3): duas contas, mensagem sem recarregar, resume depois de ficar offline e perda de VIEW_CHANNEL no meio da sessão. A Fase 4 (`e2e/dms.spec.ts`) cobre DMs 1:1 e em grupo com 3 contas, presença (online, ausente com relógio falso e offline) e "digitando…"; ela precisa do backend com `SPOOK_PRESENCE_OFFLINE_GRACE=2s` (offline em 2 s em vez de 15 s; é só para o E2E, produção usa o padrão). A Fase 6 (`e2e/attachments-notifications.spec.ts`) cobre anexos com thumbnail, não lidas, menções, avisos in-app e a inscrição de push com `serviceWorker`/`PushManager` simulados (push real não dá para receber no Playwright: fica em `VALIDACAO-MANUAL.md`). Cada execução registra 10 contas; o cadastro tem limite por IP, então espere cerca de um minuto entre execuções seguidas.

O painel administrativo (`e2e/admin.spec.ts`) confere que quem não é admin é barrado (web e API) e que o admin abre o dashboard e a lista de usuários. Promover a conta exige o banco, então o teste do admin roda o comando de `E2E_PROMOTE_CMD` (com `{username}` no lugar do username) e é **pulado sem ele**. No CI: `psql` contra o Postgres do job. Local, com o Postgres do Compose: `E2E_PROMOTE_CMD="docker exec spook-postgres-1 psql -U spook -c \"UPDATE users SET is_admin = true WHERE username = '{username}'\""` (no container do Playwright não há `docker`; passe a variável ao `docker run` só se montar o socket, ou rode o spec do host com `E2E_BASE_URL=http://localhost:8090 pnpm --filter @spook/web e2e admin`).

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

## Ruído e eco no microfone (voz, web)

O diálogo "Dispositivos de áudio e vídeo" tem a seção "Qualidade do microfone": redução de ruído em três níveis (Desligada, Padrão, Forte com IA), cancelamento de eco e ajuste automático de volume. Decisões e comparação em `SPEC.md` 5.5 ("Adicional: ruído e eco (web)").

- **Forte (IA)** usa o RNNoise em WASM num `AudioWorklet`, de `@sapphi-red/web-noise-suppressor` 0.4.1 (licença **MIT**; o RNNoise é BSD-3-Clause e o `rnnoise-wasm` embutido é Apache-2.0). Os arquivos de modelo (worklet e WASM, ~220 kB) saem do próprio pacote npm e são emitidos pelo build do Vite em `dist/assets/` (`?url`): **nenhum CDN em runtime**. Só são baixados quando alguém escolhe o nível Forte (`import()` em `src/features/voice/noise-processor.ts`).
- Sem `AudioWorklet`/WASM, com falha de download ou com processamento lento, a engine volta sozinha para "Padrão" e avisa.
- O teste `src/features/voice/noise-dsp.test.ts` roda o worklet e o WASM reais em Node (contexto `vm`), sem navegador: `pnpm --filter @spook/web exec vitest run src/features/voice/noise-dsp.test.ts`.
- O compartilhamento de tela abre antes um diálogo com "Incluir áudio" desligado por padrão (evita eco); `getDisplayMedia` usa `selfBrowserSurface: "exclude"`, `suppressLocalAudioPlayback` e `restrictOwnAudio`.
