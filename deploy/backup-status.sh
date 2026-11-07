#!/bin/sh
# Idade e tamanho do último backup. Sai com código != 0 se passou de 36 h (ou se nunca houve backup).
#   deploy/backup-status.sh [--verify]
# --verify (usado pelo check semanal): além de checar a idade, reabre o dump mais novo com pg_restore --list.
# Para monitoramento: BACKUP_MAX_AGE_HOURS muda o limite (padrão 36).
set -eu

# shellcheck source=backup-lib.sh
. "$(dirname "$0")/backup-lib.sh"
load_backup_dir

MAX_H="${BACKUP_MAX_AGE_HOURS:-36}"
VERIFY=0
[ "${1:-}" != --verify ] || VERIFY=1

ok="$BACKUP_DIR/LAST_OK"
[ -f "$ok" ] || { log "ERRO: nenhum backup concluído ainda ($ok não existe)" >&2; exit 1; }
field() { grep "^$1=" "$ok" | head -n1 | cut -d= -f2-; }
epoch="$(field epoch)"
case "$epoch" in ""|*[!0-9]*) log "ERRO: $ok corrompido" >&2; exit 1 ;; esac
age_s=$(( $(date -u +%s) - epoch ))
age_h=$(( age_s / 3600 ))
log "último backup: $(field time) (há ${age_h} h); db=$(field db_file) $(field db_bytes) bytes; arquivos=$(field files_count) objetos, $(field files_bytes) bytes; offsite=$(field offsite)"
if [ -f "$BACKUP_DIR/LAST_FAIL" ]; then log "AVISO: a última execução falhou ($(cat "$BACKUP_DIR/LAST_FAIL"))"; fi
if [ "$age_s" -gt $(( MAX_H * 3600 )) ]; then
  log "ERRO: último backup com mais de ${MAX_H} h" >&2
  exit 1
fi
if [ "$VERIFY" -eq 1 ]; then
  f="$BACKUP_DIR/db/$(field db_file)"
  [ -f "$f" ] || { log "ERRO: dump $f não existe" >&2; exit 1; }
  compose exec -T postgres pg_restore --list < "$f" > /dev/null || { log "ERRO: o dump $f não passa em pg_restore --list" >&2; exit 1; }
  log "verificação ok: $f"
fi
