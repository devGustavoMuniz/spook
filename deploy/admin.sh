#!/usr/bin/env sh
# Gerencia administradores do painel /admin direto no VPS (sem redeploy).
#   deploy/admin.sh grant <username>    promove
#   deploy/admin.sh revoke <username>   rebaixa (vale na hora)
#   deploy/admin.sh list                lista os administradores
#   deploy/admin.sh reset-password <username>   imprime um link de redefinição de senha (30 min, uso único) para repassar à pessoa
# Roda como o usuário `spook`, ex.: ssh <vps> "sudo -iu spook /srv/spook/prod/deploy/admin.sh grant nyak"
set -eu
cd "$(dirname "$0")/.."
exec docker compose --env-file .env -f deploy/docker-compose.prod.yml exec -T spook /app/spook admin "$@"
