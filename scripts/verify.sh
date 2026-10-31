#!/usr/bin/env bash
# Reproduz localmente os passos do CI (.github/workflows/ci.yml), para não descobrir falhas só depois do push:
# instalação com lockfile congelado, lint/testes/build de tudo, drift de OpenAPI, sqlc e orval, fixtures do gateway
# e (com INTEGRATION=1, padrão) os testes de integração contra Postgres e Garage do Compose.
# Uso: scripts/verify.sh            (tudo)      INTEGRATION=0 scripts/verify.sh   (sem integração)
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$*"; }

step "pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile >/dev/null

step "OpenAPI sem drift"
scripts/go.sh run ./cmd/spook openapi | diff -u server/api/openapi.yaml - >/dev/null || { echo "openapi.yaml desatualizado"; exit 1; }

step "sqlc sem drift"
hash_dir() { find "$1" -type f -print0 | sort -z | xargs -0 cat | (md5 -q 2>/dev/null || md5sum); }
before="$(hash_dir server/internal/platform/dbgen)"
docker run --rm -v "$PWD/server":/src -w /src sqlc/sqlc:1.31.1 generate
[ "$before" = "$(hash_dir server/internal/platform/dbgen)" ] || { echo "sqlc gerou diferenças em dbgen (rode e commite)"; exit 1; }

step "fixtures do gateway"
scripts/go.sh test ./internal/gateway -run Fixtures >/dev/null || { echo "fixture do gateway desatualizado (use -update)"; exit 1; }

step "client da API (orval) sem drift"
before="$(hash_dir packages/shared/src/api)"
pnpm --filter @spook/shared generate >/dev/null
[ "$before" = "$(hash_dir packages/shared/src/api)" ] || { echo "orval gerou diferenças em packages/shared/src/api (rode e commite)"; exit 1; }

step "lint, testes e build (turbo)"
pnpm turbo run lint test build --force 2>&1 | grep -E "Tasks:|FAIL|ERROR|error TS|issues" || true
pnpm turbo run lint test build >/dev/null

step "Biome"
pnpm biome check . >/dev/null

if [ "${INTEGRATION:-1}" = 1 ]; then
  step "testes de integração (Postgres e Garage do Compose)"
  pnpm infra:up >/dev/null 2>&1
  scripts/test-integration.sh 2>&1 | grep -E "^(ok|FAIL|--- FAIL|panic)" || true
  scripts/test-integration.sh >/dev/null
fi
printf '\nTUDO OK (equivalente ao CI, exceto o job e2e)\n'
