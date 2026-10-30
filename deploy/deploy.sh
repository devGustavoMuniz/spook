#!/usr/bin/env bash
# Deploy idempotente, executado NO servidor como o usuário `spook` (Docker rootless, sem root).
# Uso:  deploy/deploy.sh ghcr.io/<dono>/spook:<tag>
# Variáveis opcionais: GHCR_USER (com o token do GHCR lido do stdin).
# Ganchos só para teste local: DEPLOY_SERVICES (limita o `up`) e DEPLOY_PULL_FLAGS (ex.: --ignore-pull-failures).
# Pré-requisito: ~/spook/.env já escrito (ver deploy/README.md); este script só ajusta SPOOK_IMAGE.
set -euo pipefail

IMAGE="${1:?uso: deploy.sh ghcr.io/<dono>/spook:<tag>}"

cd "$(dirname "$0")/.."
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DOCKER_HOST="${DOCKER_HOST:-unix://$XDG_RUNTIME_DIR/docker.sock}"
export COMPOSE_FILE="deploy/docker-compose.prod.yml"
export COMPOSE_ENV_FILE=".env"

[ -f "$COMPOSE_ENV_FILE" ] || { echo "erro: $COMPOSE_ENV_FILE não existe (o workflow o escreve antes do deploy)" >&2; exit 1; }
compose() { docker compose --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# 1. Login no GHCR (token pelo stdin; pulado se não houver usuário, p.ex. pacote público)
if [ -n "${GHCR_USER:-}" ] && [ ! -t 0 ]; then
  docker login ghcr.io -u "$GHCR_USER" --password-stdin
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT # não deixa o token salvo no servidor
fi

# 2. Registra a imagem (histórico serve para rollback) e grava SPOOK_IMAGE no .env
previous="$(grep -E '^SPOOK_IMAGE=' "$COMPOSE_ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
if [ -n "$previous" ] && [ "$previous" != "$IMAGE" ]; then echo "$previous" >> .image-history; fi
umask 077
{ grep -v -E '^SPOOK_IMAGE=' "$COMPOSE_ENV_FILE" || true; echo "SPOOK_IMAGE=$IMAGE"; } > "$COMPOSE_ENV_FILE.tmp"
mv "$COMPOSE_ENV_FILE.tmp" "$COMPOSE_ENV_FILE"

# 3. Baixa as imagens (nada é buildado aqui)
# shellcheck disable=SC2086  # flags separadas por espaço de propósito
compose pull ${DEPLOY_PULL_FLAGS:-}

# 4. Storage primeiro: layout, bucket, chave e CORS (idempotente)
compose up -d --wait postgres garage
sh deploy/garage-init.sh

# 5. Resto da stack
# shellcheck disable=SC2086
compose up -d --remove-orphans ${DEPLOY_SERVICES:-}

# 6. Espera o backend ficar saudável (HEALTHCHECK da imagem)
cid="$(compose ps -q spook)"
for _ in $(seq 1 60); do
  state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")"
  [ "$state" = healthy ] && break
  sleep 2
done
if [ "${state:-}" != healthy ]; then
  echo "erro: spook não ficou saudável (estado: ${state:-?})" >&2
  compose logs --tail 50 spook >&2
  exit 1
fi

# 7. Confirma /healthz pela rede interna do Compose (a imagem é distroless; usa o próprio binário)
docker exec "$cid" /app/spook healthcheck

compose ps
echo "Deploy concluído: $IMAGE"
