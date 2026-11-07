#!/bin/sh
# Restaura um dump do Postgres (pg_dump -Fc) em um banco NOVO, sem tocar no banco em uso.
#   deploy/restore.sh <dump> [--into <nome-do-banco>]
#       cria o banco (padrão spook_restore_AAAAMMDD) e restaura nele. Recusa se o banco já existir.
#   deploy/restore.sh <dump> --confirm-replace
#       SUBSTITUI o banco real: restaura num banco novo, para o serviço `spook`, renomeia o banco real para
#       <banco>_pre_restore_<data> (fica guardado para desfazer), renomeia o novo para o nome real e sobe o `spook`.
# Roda como o usuário `spook`. Passo a passo de desastre: deploy/README.md ("Backup e restauração").
set -eu

# shellcheck source=backup-lib.sh
. "$(dirname "$0")/backup-lib.sh"

usage() { echo "uso: deploy/restore.sh <dump> [--into <nome-do-banco> | --confirm-replace]" >&2; exit 2; }

DUMP=""; INTO=""; REPLACE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --into) [ $# -ge 2 ] || usage; INTO="$2"; shift 2 ;;
    --confirm-replace) REPLACE=1; shift ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) [ -z "$DUMP" ] || usage; DUMP="$1"; shift ;;
  esac
done
[ -n "$DUMP" ] || usage
[ -f "$DUMP" ] && [ -s "$DUMP" ] || die "dump não encontrado ou vazio: $DUMP"
[ "$REPLACE" -eq 0 ] || [ -z "$INTO" ] || die "--into e --confirm-replace não combinam"

USER_DB="$(db_user)"
REAL_DB="$(db_name)"
NEW_DB="${INTO:-spook_restore_$(date -u +%Y%m%d)}"
[ "$REPLACE" -eq 0 ] || NEW_DB="spook_restore_$(date -u +%Y%m%d%H%M%S)"
valid_ident "$NEW_DB" || die "nome de banco inválido '$NEW_DB' (use a-z, 0-9 e _, começando por letra)"
[ "$NEW_DB" != "$REAL_DB" ] || die "o destino é o banco em uso ($REAL_DB); para substituí-lo use --confirm-replace"
valid_ident "$REAL_DB" || die "POSTGRES_DB inválido para esta operação: $REAL_DB"

# psql no container; usuário informado explicitamente (socket local, sem senha em argv).
psql_c() { compose exec -T postgres psql -U "$USER_DB" -d postgres -v ON_ERROR_STOP=1 -tA "$@"; }

compose ps -q postgres | grep -q . || die "o serviço postgres não está rodando"
log "pg_restore --list do dump"
compose exec -T postgres pg_restore --list < "$DUMP" > /dev/null || die "o dump não é um arquivo pg_dump -Fc válido"

exists="$(psql_c -c "SELECT 1 FROM pg_database WHERE datname = '$NEW_DB'")"
[ -z "$exists" ] || die "o banco '$NEW_DB' já existe (escolha outro com --into ou remova-o: DROP DATABASE \"$NEW_DB\")"

log "criando o banco $NEW_DB e restaurando $DUMP"
psql_c -c "CREATE DATABASE \"$NEW_DB\" OWNER \"$USER_DB\"" > /dev/null
if ! compose exec -T postgres pg_restore -U "$USER_DB" -d "$NEW_DB" --no-owner --no-privileges --exit-on-error < "$DUMP"; then
  psql_c -c "DROP DATABASE IF EXISTS \"$NEW_DB\"" > /dev/null || true
  die "pg_restore falhou; o banco $NEW_DB foi removido e o banco em uso ($REAL_DB) não foi tocado"
fi
tables="$(compose exec -T postgres psql -U "$USER_DB" -d "$NEW_DB" -tA -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
log "restauração ok em $NEW_DB ($tables tabelas em public)"

if [ "$REPLACE" -eq 0 ]; then
  log "o banco em uso ($REAL_DB) não foi alterado. Para conferir: docker compose exec postgres psql -U $USER_DB -d $NEW_DB"
  exit 0
fi

# --- substituição do banco real ---
was_running="$(compose ps -q --status running spook 2>/dev/null || true)"
restart_spook() {
  if [ -n "$was_running" ]; then log "subindo o spook"; compose start spook > /dev/null || log "ERRO: não consegui subir o spook (compose start spook)" >&2; fi
}
log "parando o spook"
compose stop spook > /dev/null 2>&1 || true
trap restart_spook EXIT
OLD_DB="${REAL_DB}_pre_restore_$(date -u +%Y%m%d%H%M%S)"
valid_ident "$OLD_DB" || die "nome derivado inválido: $OLD_DB"
psql_c -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$REAL_DB','$NEW_DB') AND pid <> pg_backend_pid()" > /dev/null
psql_c -c "ALTER DATABASE \"$REAL_DB\" RENAME TO \"$OLD_DB\"" > /dev/null
if ! psql_c -c "ALTER DATABASE \"$NEW_DB\" RENAME TO \"$REAL_DB\"" > /dev/null; then
  psql_c -c "ALTER DATABASE \"$OLD_DB\" RENAME TO \"$REAL_DB\"" > /dev/null || true
  die "renomear falhou; o banco original foi mantido"
fi
log "banco $REAL_DB substituído. O anterior ficou em $OLD_DB (apague quando tiver certeza: DROP DATABASE \"$OLD_DB\")"
