# @spook/web

Front-end do Spook (React 19, Vite, TanStack Router/Query/Virtual, Tailwind, componentes no estilo shadcn em `src/components/ui`).

- `pnpm --filter @spook/web dev`: Vite na porta 5180 (proxy de `/api` para o backend em `:8090`).
- `pnpm --filter @spook/web test`: Vitest + React Testing Library + MSW (backend falso em `src/test/server.ts`).
- Medir a lista de mensagens: em desenvolvimento, abra `/channels/<servidor>/<canal>?perf=10000`. A rota injeta 10.000 mensagens falsas (só no `DEV`; o build de produção ignora o parâmetro).

## E2E (Playwright, RNF06)

O E2E roda contra o **build de produção** do front servido pelo próprio backend (`SPOOK_WEB_DIR`), com Postgres real. O fluxo crítico (`e2e/critical-flow.spec.ts`): cadastro, criar servidor, ver `geral`/`Geral`, enviar mensagem, recarregar, criar convite e uma segunda conta (outro contexto de navegador) entrar pelo convite.

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
