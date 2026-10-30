# Spook

Clone do Discord feito para estudo (Go, LiveKit, Tauri) e engenharia de performance.
**A fonte de verdade é o [SPEC.md](./SPEC.md)**: stack (seção 5), modelo de dados (6), regras de negócio (7), critérios de aceite por fase (8) e identidade visual (9). Em conflito, o SPEC.md prevalece; se uma decisão mudar, atualize o SPEC.md no mesmo commit. Itens em "Questões em aberto" (seção 10) não estão decididos: não assuma.

Escopo: implemente uma fase por vez, só o que os critérios de aceite dela pedem. Fora de escopo está na seção 2.2.

## Estrutura

Monorepo pnpm + Turborepo: `apps/web`, `apps/desktop`, `packages/shared`, `packages/brand`, `server/` (Go), `bench/` (k6), `deploy/` (Compose, Caddy, LiveKit, observabilidade). Detalhes na seção 5.1.

## Arquitetura do backend (Go)

- Monólito modular: API REST e gateway WebSocket no mesmo binário.
- Cada feature em `server/internal/<feature>` com três camadas: `handler` (HTTP) → `service` (regra de negócio) → `store` (SQL).
- Uma feature não importa o `store` de outra; comunicação via `service` ou eventos.
- `service` não conhece HTTP nem SQL. Só o pacote `gateway` conhece WebSocket; services publicam eventos num barramento interno.
- Interfaces são definidas por quem consome e só onde há troca real (banco, LiveKit, storage, push).
- Injeção de dependência manual em `cmd/spook/main.go`, sem framework.
- `voice` usa arquitetura hexagonal completa (exercício de estudo).
- Stack: chi + huma (OpenAPI code-first), sqlc + pgx (sem ORM), goose (SQL puro), River (jobs no Postgres), coder/websocket.
- IDs são Snowflake (bigint); timestamps em `timestamptz`. Toda ação é autorizada no backend.
- Todo endpoint e evento do gateway é instrumentado com OpenTelemetry.

## Convenções

- Idioma: texto de produto, docs e comentários em pt-br; identificadores de código em inglês.
- Go: `gofmt` + golangci-lint. Erros com `%w`, `context.Context` como primeiro parâmetro, logs estruturados (`log/slog`).
- TypeScript: Biome para lint e formatação; React 19 + Vite + TanStack Router/Query, Zustand, React Hook Form + Zod, Tailwind + shadcn/ui. Cliente da API é gerado (huma → OpenAPI → orval); não escreva tipos de API à mão.
- Cores e tokens vêm de `packages/brand` (seção 9); a ficha em PDF prevalece sobre o SPEC.md em divergência visual.
- SQL em `server/db/queries` e migrations em `server/db/migrations`; nunca edite código gerado pelo sqlc/orval.
- `scripts/go.sh` usa o Go local se existir (a diretiva `toolchain` de `server/go.mod` baixa a versão certa) e cai para Docker se não houver Go; golangci-lint e k6 rodam em Docker. A versão do Go é a mesma no `go.mod`, no CI e no `Dockerfile.server-dev`: altere os três juntos.
- Storage é S3 genérico (Garage, fixado por tag): o código de domínio só usa `internal/platform/storage` e nunca depende do Garage. Testes de integração: `pnpm --filter @spook/server test:integration` (exige `pnpm infra:up`).
- Config por variáveis de ambiente; segredos nunca entram no repositório (use `.env.example`).
- Testes acompanham o código. CI roda lint, testes e build a cada push.
- Cada fase termina com benchmark k6 versionado em `bench/`, com resultados registrados.

## Contrato da API (código gerado, não edite à mão)

Fluxo: handlers huma → `server/api/openapi.yaml` → orval → `packages/shared/src/api`. Depois de mudar a API ou o SQL, regenere tudo e commite junto (o CI falha se houver diferença):

- OpenAPI: `scripts/go.sh run ./cmd/spook openapi > server/api/openapi.yaml`
- sqlc: `docker run --rm -v "$PWD/server":/src -w /src sqlc/sqlc:1.31.1 generate`
- Client TS: `pnpm --filter @spook/shared generate`

Rotas da API ficam sob `/api` (o `/healthz` também existe na raiz). IDs Snowflake trafegam como string no JSON. Sessão: cookie `spook_session` (web) ou `Authorization: Bearer` (desktop, que pede o token com `X-Spook-Client: desktop`).

## Deploy

Produção no VPS segue o padrão do antrax: usuário `spook`, Docker rootless, entrada só por Cloudflare Tunnel, imagens no GHCR, deploy por GitHub Actions via SSH (`.github/workflows/deploy.yml`). Preparação única do servidor e secrets: `deploy/README.md`. Medições a partir da Fase 1 são contra produção.

## Comandos

- `pnpm dev`: sobe web, backend, Postgres, Garage (S3) e LiveKit localmente.
- `pnpm lint` / `pnpm test` / `pnpm build`: via Turborepo (lado Go incluído).
