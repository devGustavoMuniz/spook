#!/usr/bin/env sh
# Testes de integração do backend contra a infra do Compose (`pnpm infra:up` antes).
set -eu
cd "$(dirname "$0")/.."
set -a && . ./.env && set +a
network="$(docker compose -f deploy/docker-compose.yml ps -q garage | xargs docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
DOCKER_ARGS="--network $network \
  -e S3_ENDPOINT=http://garage:3900 -e S3_REGION -e S3_BUCKET -e S3_ACCESS_KEY_ID -e S3_SECRET_ACCESS_KEY -e S3_CORS_ORIGINS" \
  scripts/go.sh test -tags integration -count=1 -v ./internal/platform/storage/... "$@"
