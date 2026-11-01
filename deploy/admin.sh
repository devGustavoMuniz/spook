#!/usr/bin/env sh
# Gerencia administradores do painel /admin direto no VPS (sem redeploy).
#   deploy/admin.sh grant <username>    promove
#   deploy/admin.sh revoke <username>   rebaixa (vale na hora)
#   deploy/admin.sh list                lista os administradores
# Roda como o usuário `spook`, ex.: ssh <vps> "sudo -iu spook /srv/spook/prod/deploy/admin.sh grant nyak"
set -eu
cd "$(dirname "$0")/.."
exec docker compose --env-file .env -f deploy/docker-compose.prod.yml exec -T spook /app/spook admin "$@"
