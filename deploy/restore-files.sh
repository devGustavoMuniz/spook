#!/bin/sh
# Devolve os arquivos do espelho local (${BACKUP_DIR}/files/) ao bucket S3 do Garage, pela API S3.
#   deploy/restore-files.sh [--mirror]
# Por padrão só ADICIONA/atualiza objetos (não apaga nada no bucket). --mirror deixa o bucket idêntico ao espelho
# (apaga no bucket o que não estiver no backup). O Garage precisa estar de pé e inicializado (deploy/garage-init.sh).
set -eu

# shellcheck source=backup-lib.sh
. "$(dirname "$0")/backup-lib.sh"
load_backup_dir

flags="--only-show-errors"
case "${1:-}" in
  "") ;;
  --mirror) flags="$flags --delete" ;;
  *) echo "uso: deploy/restore-files.sh [--mirror]" >&2; exit 2 ;;
esac

[ -d "$BACKUP_DIR/files" ] || die "não existe $BACKUP_DIR/files (traga o backup de volta antes; veja deploy/README.md)"
bucket="$(s3_bucket)"
log "restaurando $BACKUP_DIR/files para s3://$bucket"
# shellcheck disable=SC2086
S3_CLI_DOCKER_ARGS="-v $BACKUP_DIR/files:/backup:ro" s3_cli s3 sync $flags /backup "s3://$bucket" || die "sync para o bucket falhou"
log "arquivos restaurados em s3://$bucket"
