#!/usr/bin/env bash
# Deploy idempotente, executado NO servidor como o usuário `spook` (Docker rootless, sem root).
# Uso:  deploy/deploy.sh ghcr.io/<dono>/spook:<tag>
# GHCR: o usuário vem de GHCR_USER e o token do stdin (vazio = pula o login, p.ex. rollback com a imagem em cache).
# Ganchos só para teste local: DEPLOY_SERVICES (limita o `up`) e DEPLOY_PULL_FLAGS (ex.: --ignore-pull-failures).
# Raiz do app: a pasta acima de deploy/, ou seja /srv/spook/prod em produção. Lá ficam o .env (600, escrito por
# `write-env`) e o .image-history. Os dados vivem em volumes nomeados do Docker. Este script só ajusta SPOOK_IMAGE.
set -euo pipefail

IMAGE="${1:?uso: deploy.sh ghcr.io/<dono>/spook:<tag>}"

cd "$(dirname "$0")/.."
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DOCKER_HOST="${DOCKER_HOST:-unix://$XDG_RUNTIME_DIR/docker.sock}"
export COMPOSE_FILE="deploy/docker-compose.prod.yml"
export COMPOSE_ENV_FILE=".env"

[ -f "$COMPOSE_ENV_FILE" ] || { echo "erro: $COMPOSE_ENV_FILE não existe (o workflow o escreve antes do deploy)" >&2; exit 1; }
compose() { docker compose --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# 1. Login no GHCR: token pelo stdin, usuário em GHCR_USER. Sem token (stdin vazio ou terminal) não há login.
token=""
if [ ! -t 0 ]; then token="$(cat)"; fi
if [ -n "${GHCR_USER:-}" ] && [ -n "$token" ]; then
  printf '%s' "$token" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT # não deixa o token salvo no servidor
fi
unset token

# 1b. Renderiza a config do LiveKit: o template tem __LIVEKIT_API_KEY__ (a chave da API vem do .env do servidor e
#     não está no git); o webhook do LiveKit para o backend precisa dela. O arquivo renderizado é o que o compose monta.
lk_key="$(grep -E '^LIVEKIT_API_KEY=' "$COMPOSE_ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
case "$lk_key" in
  ""|*[!A-Za-z0-9_-]*) echo "erro: LIVEKIT_API_KEY ausente ou com caracteres fora de [A-Za-z0-9_-] no $COMPOSE_ENV_FILE" >&2; exit 1 ;;
esac
sed "s/__LIVEKIT_API_KEY__/$lk_key/g" deploy/livekit/livekit.prod.yaml.tmpl > deploy/livekit/livekit.prod.yaml.tmp
mv deploy/livekit/livekit.prod.yaml.tmp deploy/livekit/livekit.prod.yaml
unset lk_key

# 1c. Hash das configs montadas (força recriar o container quando mudam, já que o receive-deploy troca
#     deploy/ por um diretório novo e o container manteria o arquivo antigo). Cobre o arquivo RENDERIZADO do LiveKit:
#     trocar a LIVEKIT_API_KEY no .env também recria o container.
if command -v sha256sum >/dev/null 2>&1; then hasher="sha256sum"; else hasher="shasum -a 256"; fi
# shellcheck disable=SC2086
CONFIG_HASH="$(cat deploy/garage/garage.toml deploy/livekit/livekit.prod.yaml | $hasher | cut -c1-16)"
export CONFIG_HASH

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

# 6. Espera todo serviço que tem healthcheck ficar saudável (um LiveKit ou Garage quebrado não passa em silêncio)
unhealthy=""
for cid in $(compose ps -q); do
  name="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$cid")"
  state="none"
  for _ in $(seq 1 60); do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")"
    { [ "$state" = healthy ] || [ "$state" = none ]; } && break
    sleep 2
  done
  if [ "$state" != healthy ] && [ "$state" != none ]; then
    echo "erro: $name não ficou saudável (estado: $state)" >&2
    compose logs --tail 50 "$name" >&2
    unhealthy="$unhealthy $name"
  fi
done
[ -z "$unhealthy" ] || exit 1
cid="$(compose ps -q spook)"

# 7. Confirma /healthz pela rede interna do Compose (a imagem é distroless; usa o próprio binário)
docker exec "$cid" /app/spook healthcheck

compose ps
echo "Deploy concluído: $IMAGE"
