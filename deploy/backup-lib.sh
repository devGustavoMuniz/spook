#!/bin/sh
# Funções comuns dos scripts de backup e restauração (backup.sh, restore.sh, restore-files.sh, backup-status.sh).
# Não é executável: é lido com `. deploy/backup-lib.sh`. Roda como o usuário `spook` (Docker rootless), sem sudo.
#
# Variáveis (todas opcionais; o .env da raiz do app também é lido para BACKUP_DIR, BACKUP_REMOTE, RCLONE_CONFIG_*,
# POSTGRES_* e S3_*):
#   BACKUP_DIR           destino local (padrão /srv/spook/backups)
#   COMPOSE_FILE         padrão deploy/docker-compose.prod.yml
#   COMPOSE_ENV_FILE     padrão .env
#   COMPOSE_PROJECT_NAME o compose respeita (o selftest usa spook-bkptest)

APP_DIR="${SPOOK_APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}" # SPOOK_APP_DIR: só para o selftest
cd "$APP_DIR" || exit 1

COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-.env}"
AWS_CLI_IMAGE="${AWS_CLI_IMAGE:-amazon/aws-cli:2.39.3}"
RCLONE_IMAGE="${RCLONE_IMAGE:-rclone/rclone:1.69.3}"

# Docker rootless do VPS: socket do usuário. Só define se o ambiente não definiu e o socket existe (cron não tem o env).
if [ -z "${DOCKER_HOST:-}" ]; then
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export XDG_RUNTIME_DIR
  if [ -S "$XDG_RUNTIME_DIR/docker.sock" ]; then DOCKER_HOST="unix://$XDG_RUNTIME_DIR/docker.sock"; export DOCKER_HOST; fi
fi

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
# log <mensagem>: stdout com timestamp (o journal/cron captura); BACKUP_LOG_FILE é opcional.
log() {
  line="$(ts) $*"
  printf '%s\n' "$line"
  if [ -n "${BACKUP_LOG_FILE:-}" ]; then printf '%s\n' "$line" >> "$BACKUP_LOG_FILE" 2>/dev/null || true; fi
}
die() { log "ERRO: $*" >&2; exit 1; }

# envget <NOME>: valor do ambiente ou, se ausente, da última linha NOME=valor do .env (sem executar o arquivo;
# remove aspas simples/duplas externas). Nunca imprime em log.
envget() {
  eval "cur=\${$1:-}"
  if [ -n "$cur" ]; then printf '%s' "$cur"; return 0; fi
  [ -f "$COMPOSE_ENV_FILE" ] || return 0
  v="$(grep -E "^$1=" "$COMPOSE_ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  case "$v" in
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
  esac
  printf '%s' "$v"
}

compose() { docker compose --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# Valida que um caminho é absoluto, não é a raiz nem um diretório de sistema (proteção para qualquer rm/escrita).
safe_dir() {
  case "$1" in
    /|""|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var) return 1 ;;
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in *..*|*' '*) return 1 ;; esac
  return 0
}

load_backup_dir() {
  BACKUP_DIR="$(envget BACKUP_DIR)"
  BACKUP_DIR="${BACKUP_DIR:-/srv/spook/backups}"
  safe_dir "$BACKUP_DIR" || die "BACKUP_DIR inválido ('$BACKUP_DIR'): use um caminho absoluto, sem espaços, que não seja um diretório de sistema"
  export BACKUP_DIR
}

# Rede do Compose onde o garage está (containers descartáveis entram nela para falar com http://garage:3900).
garage_network() {
  cid="$(compose ps -q garage)"
  [ -n "$cid" ] || die "o serviço garage não está rodando"
  # shellcheck disable=SC2016  # template do docker inspect, não do shell
  docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$cid"
}

# s3_cli <args do aws s3...>: container descartável do aws-cli na rede do Garage. As chaves vão por variável de
# ambiente exportada (-e NOME, sem valor na linha de comando), então não aparecem no `ps`.
# Extras de docker run (ex.: -v) vêm em S3_CLI_DOCKER_ARGS.
s3_cli() {
  AWS_ACCESS_KEY_ID="$(envget S3_ACCESS_KEY_ID)"
  AWS_SECRET_ACCESS_KEY="$(envget S3_SECRET_ACCESS_KEY)"
  AWS_DEFAULT_REGION="$(envget S3_REGION)"
  AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-garage}"
  [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ] || die "S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY ausentes no $COMPOSE_ENV_FILE"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
  net="$(garage_network)"
  # shellcheck disable=SC2086  # S3_CLI_DOCKER_ARGS é uma lista de flags
  docker run --rm --network "$net" -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
    ${S3_CLI_DOCKER_ARGS:-} "$AWS_CLI_IMAGE" --endpoint-url http://garage:3900 "$@"
}

s3_bucket() { b="$(envget S3_BUCKET)"; printf '%s' "${b:-spook}"; }
db_user() { u="$(envget POSTGRES_USER)"; printf '%s' "${u:-spook}"; }
db_name() { d="$(envget POSTGRES_DB)"; printf '%s' "${d:-spook}"; }

# Nome seguro de banco/identificador (vai para SQL entre aspas duplas).
valid_ident() { case "$1" in ""|*[!a-z0-9_]*|[0-9]*) return 1 ;; esac; [ "${#1}" -le 60 ]; }

file_size() { wc -c < "$1" | tr -d ' '; }
