# Imagem de produção do Spook: backend Go + build do front, num binário estático e distroless.
# Contexto de build = raiz do repositório:  docker build -f deploy/Dockerfile .
# Mantenha GO_VERSION igual ao `toolchain` de server/go.mod e ao go-version do CI.

ARG GO_VERSION=1.26.10
ARG NODE_VERSION=24
ARG PNPM_VERSION=10.33.0

# --- front -------------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS web
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @spook/web...
RUN pnpm --filter @spook/web build

# --- backend -----------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS server
ARG TARGETOS=linux
ARG TARGETARCH=amd64
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY server/ ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags "-s -w" -o /out/spook ./cmd/spook

# --- final -------------------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /out/spook /app/spook
COPY --from=web /repo/apps/web/dist /app/web
ENV SPOOK_ENV=production SPOOK_ADDR=:8090 SPOOK_WEB_DIR=/app/web
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=5 CMD ["/app/spook", "healthcheck"]
USER nonroot:nonroot
ENTRYPOINT ["/app/spook"]
