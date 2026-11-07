#!/bin/sh
# Backup do Spook: Postgres (pg_dump -Fc) + arquivos do bucket S3 do Garage + retenção + cópia offsite opcional.
# Roda como o usuário `spook` (timer systemd --user ou cron; nunca pela chave de CI). Uso: deploy/backup.sh
#
#   ${BACKUP_DIR}/db/spook-AAAAMMDD-HHMMSS.dump   dumps (600), verificados com pg_restore --list
#   ${BACKUP_DIR}/files/                          espelho incremental do bucket (via API S3 do Garage)
#   ${BACKUP_DIR}/LAST_OK                         escrito só quando o backup local terminou bem
#
# Saída: 0 ok; 1 falha no backup local; 2 backup local ok mas a cópia offsite falhou. Detalhes: deploy/README.md.
set -eu

# shellcheck source=backup-lib.sh
. "$(dirname "$0")/backup-lib.sh"
load_backup_dir

# Retenção (SPEC 5.5): diários, semanais (domingo) e mensais (primeiro dump do mês).
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-3}"
DISK_WARN_PCT=85

umask 077
mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/files" 2>/dev/null ||
  die "não consegui criar $BACKUP_DIR (como admin: sudo install -d -o spook -m 700 $BACKUP_DIR)"
chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/db" "$BACKUP_DIR/files" 2>/dev/null || true
BACKUP_LOG_FILE="$BACKUP_DIR/backup.log"
if [ -f "$BACKUP_LOG_FILE" ] && [ "$(file_size "$BACKUP_LOG_FILE")" -gt 1048576 ]; then mv -f "$BACKUP_LOG_FILE" "$BACKUP_LOG_FILE.1"; fi

# --- lock: uma execução por vez (mkdir é atômico; PID guardado para detectar lock órfão) ---
LOCK="$BACKUP_DIR/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  oldpid="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
    log "outro backup está rodando (pid $oldpid); saindo sem fazer nada"
    exit 0
  fi
  log "lock órfão (pid '$oldpid' não existe mais); assumindo"
  rm -f "$LOCK/pid"
  rmdir "$LOCK" 2>/dev/null || die "não consegui remover o lock $LOCK"
  mkdir "$LOCK" || die "não consegui criar o lock $LOCK"
fi
echo "$$" > "$LOCK/pid"
TMP_DUMP=""
# shellcheck disable=SC2329  # chamada pelo trap EXIT
cleanup() {
  rc=$?
  [ -z "$TMP_DUMP" ] || rm -f "$TMP_DUMP"
  rm -f "$LOCK/pid"
  rmdir "$LOCK" 2>/dev/null || true
  if [ "$rc" -ne 0 ]; then
    log "FALHA: backup terminou com código $rc (veja as linhas acima)" >&2
    printf '%s exit=%s\n' "$(ts)" "$rc" > "$BACKUP_DIR/LAST_FAIL" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "backup iniciado (BACKUP_DIR=$BACKUP_DIR)"

# --- espaço em disco ---
last_dump=""
for f in "$BACKUP_DIR"/db/spook-????????-??????.dump; do [ -f "$f" ] && last_dump="$f"; done
need=0
[ -z "$last_dump" ] || need=$(( $(file_size "$last_dump") * 2 ))
avail_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
use_pct="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {gsub("%","",$5); print $5}')"
if [ $(( avail_kb * 1024 )) -lt "$need" ]; then
  die "pouco espaço em $BACKUP_DIR: $((avail_kb / 1024)) MB livres, preciso de pelo menos $((need / 1048576)) MB (2x o último dump)"
fi
if [ "${use_pct:-0}" -gt "$DISK_WARN_PCT" ]; then log "AVISO: disco de $BACKUP_DIR em ${use_pct}% (limite de aviso: ${DISK_WARN_PCT}%)"; fi

# --- (a) Postgres ---
stamp="$(date -u +%Y%m%d-%H%M%S)"
dump="$BACKUP_DIR/db/spook-$stamp.dump"
TMP_DUMP="$BACKUP_DIR/db/.spook-$stamp.dump.tmp"
rm -f "$BACKUP_DIR"/db/.spook-*.dump.tmp
[ ! -e "$dump" ] || die "$dump já existe"
log "pg_dump -Fc iniciado"
# O usuário/banco vêm do ambiente do próprio container; a conexão é pelo socket local (sem senha em argv/ps).
# shellcheck disable=SC2016  # expande dentro do container
compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner' > "$TMP_DUMP" ||
  die "pg_dump falhou"
[ -s "$TMP_DUMP" ] || die "pg_dump gerou arquivo vazio"
compose exec -T postgres pg_restore --list < "$TMP_DUMP" > /dev/null || die "verificação (pg_restore --list) do dump falhou"
chmod 600 "$TMP_DUMP"
mv "$TMP_DUMP" "$dump"
TMP_DUMP=""
db_bytes="$(file_size "$dump")"
log "dump ok: $dump ($db_bytes bytes, verificado)"

# --- (b) arquivos do bucket, via API S3 (consistente; nunca copia os arquivos internos do Garage) ---
bucket="$(s3_bucket)"
sync_flags="--only-show-errors"
[ "${BACKUP_FILES_DELETE:-0}" != 1 ] || sync_flags="$sync_flags --delete"
log "sync do bucket '$bucket' para $BACKUP_DIR/files (incremental)"
# shellcheck disable=SC2086
S3_CLI_DOCKER_ARGS="-v $BACKUP_DIR/files:/backup" s3_cli s3 sync $sync_flags "s3://$bucket" /backup ||
  die "sync do bucket falhou"
files_count="$(find "$BACKUP_DIR/files" -type f | wc -l | tr -d ' ')"
files_kb="$(du -sk "$BACKUP_DIR/files" | cut -f1)"
log "arquivos ok: $files_count objetos, $((files_kb * 1024)) bytes"

# --- (c) retenção ---
# dias desde 1970-01-01 (algoritmo de Howard Hinnant), portátil (sem date -d): dow 0 = domingo.
dow() {
  y=${1%????}; rest=${1#????}; m=${rest%??}; d=${rest#??}
  m=${m#0}; d=${d#0}
  [ "$m" -le 2 ] && y=$((y - 1))
  era=$((y / 400)); yoe=$((y - era * 400))
  if [ "$m" -gt 2 ]; then mp=$((m - 3)); else mp=$((m + 9)); fi
  doy=$(((153 * mp + 2) / 5 + d - 1))
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  days=$((era * 146097 + doe - 719468))
  echo $(((days + 4) % 7))
}

prune() {
  keepfile="$(mktemp)"
  list="$(mktemp)"
  # só nomes no padrão exato; ordenados do mais novo ao mais antigo
  for f in "$BACKUP_DIR"/db/spook-????????-??????.dump; do [ -f "$f" ] && basename "$f"; done | sort -r > "$list"
  total="$(wc -l < "$list" | tr -d ' ')"
  if [ "$total" -eq 0 ]; then rm -f "$keepfile" "$list"; return 0; fi
  {
    # mantém sempre o mais novo (acabou de ser verificado)
    head -n1 "$list"
    # diários: o mais novo de cada um dos KEEP_DAILY dias mais recentes
    awk '{d=substr($0,7,8); if(d!=p){print; p=d}}' "$list" | head -n "$KEEP_DAILY"
    # semanais: o mais novo de cada domingo, dos KEEP_WEEKLY domingos mais recentes
    awk '{d=substr($0,7,8); if(d!=p){print; p=d}}' "$list" | while read -r name; do
      day="${name#spook-}"; day="${day%%-*}"
      [ "$(dow "$day")" -eq 0 ] && echo "$name"
    done | head -n "$KEEP_WEEKLY"
    # mensais: o primeiro dump de cada um dos KEEP_MONTHLY meses mais recentes
    sort "$list" | awk '{m=substr($0,7,6); if(m!=p){print; p=m}}' | sort -r | head -n "$KEEP_MONTHLY"
  } >> "$keepfile"
  sort -u "$keepfile" -o "$keepfile"
  removed=0
  while read -r name; do
    grep -qx "$name" "$keepfile" && continue
    # nome já validado pelo glob/padrão acima; confere de novo antes de apagar
    case "$name" in spook-????????-??????.dump) ;; *) continue ;; esac
    [ -n "$name" ] && [ -f "$BACKUP_DIR/db/$name" ] || continue
    rm -f "$BACKUP_DIR/db/$name"
    removed=$((removed + 1))
  done < "$list"
  log "retenção: $(wc -l < "$keepfile" | tr -d ' ') dumps mantidos, $removed removidos (diários $KEEP_DAILY, semanais $KEEP_WEEKLY, mensais $KEEP_MONTHLY)"
  rm -f "$keepfile" "$list"
}
prune

# --- (d) offsite opcional (rclone em container descartável) ---
offsite="skipped"
rc_offsite=0
remote="$(envget BACKUP_REMOTE)"
if [ -n "$remote" ]; then
  log "offsite: enviando para o remote do rclone '${remote%%:*}:' (credenciais por RCLONE_CONFIG_*, não aparecem em log)"
  rc_env=""
  # só os NOMES vão na linha de comando; os valores são herdados do ambiente exportado
  for name in $( { env | cut -d= -f1; [ -f "$COMPOSE_ENV_FILE" ] && grep -oE '^RCLONE_CONFIG_[A-Za-z0-9_]+' "$COMPOSE_ENV_FILE"; } | grep -E '^RCLONE_CONFIG_' | sort -u); do
    val="$(envget "$name")"
    export "$name=$val"
    rc_env="$rc_env -e $name"
  done
  rclone_run() {
    # shellcheck disable=SC2086
    docker run --rm $rc_env ${BACKUP_RCLONE_DOCKER_ARGS:-} -v "$BACKUP_DIR:/data:ro" "$RCLONE_IMAGE" "$@"
  }
  # db: espelho do que a retenção local manteve (--max-delete limita estrago se o diretório local sumir);
  # files: só adiciona (nunca apaga no destino).
  if rclone_run sync --max-delete 10 /data/db "${remote%/}/db" -q &&
     rclone_run copy /data/files "${remote%/}/files" -q; then
    offsite="ok"
    log "offsite ok"
  else
    offsite="FAILED"
    rc_offsite=2
    log "ERRO: cópia offsite falhou (o backup local está ok); confira BACKUP_REMOTE e as RCLONE_CONFIG_*" >&2
  fi
fi

# --- (e) LAST_OK ---
{
  printf 'time=%s\nepoch=%s\ndb_file=%s\ndb_bytes=%s\nfiles_count=%s\nfiles_bytes=%s\noffsite=%s\n' \
    "$(ts)" "$(date -u +%s)" "$(basename "$dump")" "$db_bytes" "$files_count" "$((files_kb * 1024))" "$offsite"
} > "$BACKUP_DIR/LAST_OK.tmp"
mv "$BACKUP_DIR/LAST_OK.tmp" "$BACKUP_DIR/LAST_OK"
rm -f "$BACKUP_DIR/LAST_FAIL"
log "backup concluído: db=$db_bytes bytes, arquivos=$files_count objetos, offsite=$offsite, código de saída $rc_offsite"
exit "$rc_offsite"
